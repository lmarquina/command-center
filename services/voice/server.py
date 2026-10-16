"""Voice service: our own STT/TTS pipeline, hybrid local/cloud. Listens on 127.0.0.1 only.

  POST /stt   body = 16 kHz mono s16le PCM (the G2 mic format) or a WAV file; ?engine=local|cloud
              → {"text", "engine", "model", "ms", "fallback"?}
  POST /tts   {"text", "engine"?} → audio/wav (24 kHz); headers X-Engine, X-Model, X-Ms
  GET  /health → engines, models, whether a cloud key is configured (never the key)

Local engines: open models via MLX on this Mac (kept warm). Cloud engine: OpenAI speech API, key read from the macOS
Keychain at call time (never stored in files, never logged). Engines, routing, voices and the Keychain item name
come from the `voice` section of the repo config. No LLM in this path: it only converts speech <-> text.
"""
import io, json, subprocess, threading, time, uuid, wave
import urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import numpy as np

from settings import load_config, run_dir, pick_engine, engine_order

HERE = Path(__file__).parent
CFG = load_config()["voice"]
GPU = threading.Lock()   # one MLX job at a time
_models = {}

def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)

# ---------- helpers ----------
def pcm_or_wav_to_float(body: bytes) -> np.ndarray:
    if body[:4] == b"RIFF":
        with wave.open(io.BytesIO(body)) as w:
            sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
            a = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768
            if ch > 1: a = a.reshape(-1, ch).mean(axis=1)
            if sr != 16000: a = np.interp(np.linspace(0, len(a) - 1, int(len(a) * 16000 / sr)), np.arange(len(a)), a).astype(np.float32)
            return a
    return np.frombuffer(body[: len(body) // 2 * 2], dtype=np.int16).astype(np.float32) / 32768

def to_wav(a: np.ndarray, sr: int) -> bytes:
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype(np.int16).tobytes())
    return b.getvalue()

def openai_key():
    r = subprocess.run(["security", "find-generic-password", "-s", CFG["cloud"]["keychain_service"], "-w"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None

# ---------- local engines (MLX) ----------
def local_model(kind):
    repo = CFG[kind]["local_model"]
    if repo not in _models:
        t = time.time()
        if kind == "stt":
            from mlx_audio.stt.utils import load_model
        else:
            from mlx_audio.tts.utils import load_model
        _models[repo] = load_model(repo); log("loaded", kind, repo, f"{time.time() - t:.1f}s")
    return _models[repo]

def stt_local(req):
    import tempfile
    audio, context = req
    with GPU:
        m = local_model("stt")
        with tempfile.NamedTemporaryFile(suffix=".wav") as f:   # mlx-audio STT takes a path
            f.write(to_wav(audio, 16000)); f.flush()
            out = m.generate(f.name, **({"system_prompt": context} if context else {}))   # Qwen3-ASR: context biasing
    return getattr(out, "text", str(out)).strip(), CFG["stt"]["local_model"]

def voice_for(who):
    v = CFG["tts"]["voices"]; return v.get(who) or v["system"]

def tts_local(req):
    text, who = req
    with GPU:
        m = local_model("tts"); chunks = []; sr = 24000
        for r in m.generate(text=text, verbose=False, **voice_for(who)["local"]):
            chunks.append(np.array(r.audio)); sr = r.sample_rate
    return to_wav(np.concatenate(chunks), sr), CFG["tts"]["local_model"]

# ---------- cloud engine (OpenAI speech API) ----------
def _openai(path, data, headers, timeout=30):
    key = openai_key()
    if not key: raise RuntimeError("no OpenAI key in Keychain item " + CFG["cloud"]["keychain_service"])
    req = urllib.request.Request("https://api.openai.com/v1/" + path, data=data, headers={**headers, "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"OpenAI {path} HTTP {e.code}: {e.read()[:200].decode(errors='replace')}") from None

def stt_cloud(req):
    audio, context = req
    model = CFG["stt"]["cloud_model"]; bnd = uuid.uuid4().hex
    parts = [f'--{bnd}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{model}\r\n'.encode(),
             f'--{bnd}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode() + to_wav(audio, 16000) + b"\r\n",
             *([f'--{bnd}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n{context}\r\n'.encode()] if context else []),
             f"--{bnd}--\r\n".encode()]
    secs = len(audio) / 16000   # long dictation (up to 5 min) needs more than the default 30 s
    out = json.loads(_openai("audio/transcriptions", b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={bnd}"}, timeout=max(30, int(secs * 0.6) + 30)))
    return out.get("text", "").strip(), model

def tts_cloud(req):
    text, who = req
    c = CFG["tts"]; body = json.dumps({"model": c["cloud_model"], "voice": voice_for(who)["cloud"], "input": text, "response_format": "wav"}).encode()
    return _openai("audio/speech", body, {"Content-Type": "application/json"}), c["cloud_model"]

ENGINES = {"stt": {"local": stt_local, "cloud": stt_cloud}, "tts": {"local": tts_local, "cloud": tts_cloud}}

def run(kind, payload, engine=None):
    first = engine or pick_engine(kind, CFG, len(payload[0]) / 16000 if kind == "stt" else 0.0)
    order = engine_order(kind, CFG, first, forced=bool(engine))
    errs = []
    for e in order:
        t = time.time()
        try:
            out, model = ENGINES[kind][e](payload)
            meta = {"engine": e, "model": model, "ms": int((time.time() - t) * 1000), **({"fallback": errs} if errs else {})}
            if kind == "stt": meta["audio_s"] = round(len(payload[0]) / 16000, 1)
            return out, meta
        except Exception as ex:
            errs.append(f"{e}: {ex}"[:200]); log(kind, e, "failed:", errs[-1])
    raise RuntimeError("; ".join(errs))

# ---------- HTTP ----------
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype="application/json", extra=None):
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items(): self.send_header(k, str(v))
        self.end_headers(); self.wfile.write(body)
    def host_ok(self):
        # Only this computer's own pages: blocks DNS rebinding (a web page that renames itself to 127.0.0.1).
        port = CFG.get("port", 3200)
        return self.headers.get("Host", "") in (f"127.0.0.1:{port}", f"localhost:{port}")
    def do_GET(self):
        if not self.host_ok(): return self.send(421, b'{"error":"bad host"}')
        if self.path in ("/", "/test"):   # local test page (mic via the browser; localhost is a secure context)
            return self.send(200, (HERE / "test.html").read_bytes(), "text/html; charset=utf-8")
        if self.path == "/health":
            return self.send(200, json.dumps({"stt": CFG["stt"], "tts": {k: v for k, v in CFG["tts"].items()}, "cloud_key": bool(openai_key()), "loaded": list(_models)}).encode())
        self.send(404, b"{}")
    def do_POST(self):
        from urllib.parse import urlparse, parse_qs
        u = urlparse(self.path); q = parse_qs(u.query); eng = (q.get("engine") or [None])[0]
        if not self.host_ok(): return self.send(421, b'{"error":"bad host"}')
        # Content types a web page can't send cross-origin without a preflight (which this server never answers), so
        # no other site can make the browser spend cloud credit or write recordings.
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        need = {"/stt": ("application/octet-stream", "audio/wav", "audio/x-wav"), "/tts": ("application/json",)}.get(u.path)
        if need and ctype not in need: return self.send(415, json.dumps({"error": f"{u.path} needs Content-Type {need[0]}"}).encode())
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        try:
            if u.path == "/stt":
                audio = pcm_or_wav_to_float(body)
                pk = float(np.abs(audio).max()) if len(audio) else 0.0
                if 0.002 < pk < 0.5: audio = audio * min(0.9 / pk, 30.0)   # quiet input: normalize level (max 30x gain)
                # Optional vocabulary hint (project names, session titles, harness names) to bias recognition.
                context = (q.get("context") or [""])[0][: CFG.get("hintMaxChars", 1000)]
                text, meta = run("stt", (audio, context), eng); log("stt", meta["engine"], meta["ms"], "ms", "ctx" if context else "")
                rms = float(np.sqrt(np.mean(audio ** 2))) if len(audio) else 0.0
                if context and not text.strip() and rms > 0.01:   # hints can derail the model: retry without them
                    text, meta2 = run("stt", (audio, ""), eng); meta = {**meta2, "retried_without_context": True}; log("stt retry without context ->", repr(text[:40]))
                if (q.get("save") or ["0"])[0] == "1":   # test page only: keep the user's recordings locally for model comparison
                    d = run_dir() / "voice-recordings"; d.mkdir(parents=True, exist_ok=True); stem = d / time.strftime("%Y%m%d-%H%M%S")
                    for old in sorted(d.glob("*.wav"))[:-CFG.get("keepRecordings", 500)]:   # keep the newest ones only
                        old.unlink(missing_ok=True); old.with_suffix(".json").unlink(missing_ok=True)
                    (stem.with_suffix(".wav")).write_bytes(to_wav(audio, 16000))
                    (stem.with_suffix(".json")).write_text(json.dumps({"ref": (q.get("ref") or [""])[0], "hyp": text, **meta}))
                return self.send(200, json.dumps({"text": text, **meta}).encode())
            if u.path == "/tts":
                j = json.loads(body or b"{}"); text = (j.get("text") or "").strip()[: CFG["tts"].get("max_chars", 600)]
                if not text: return self.send(400, b'{"error":"text required"}')
                who = j.get("provider") or "system"   # one voice per harness (config tts.voices)
                wav, meta = run("tts", (text, who), j.get("engine") or eng); log("tts", meta["engine"], who, meta["ms"], "ms", len(text), "chars")
                return self.send(200, wav, "audio/wav", {"X-Engine": meta["engine"], "X-Model": meta["model"], "X-Ms": meta["ms"], "X-Voice": who})
            self.send(404, b"{}")
        except Exception as e:
            self.send(502, json.dumps({"error": str(e)[:300]}).encode())

if __name__ == "__main__":
    for k in ("stt", "tts"):   # warm both (Kokoro is tiny); Qwen3-TTS only if selected as local_model
        if CFG[k]["engine"] in ("local", "auto"):
            try:
                local_model(k)
                # The first synthesis also fetches the pronunciation data it needs (seconds, once per machine);
                # do it now so the first real reply is not the slow one.
                if k == "tts": tts_local(("Ready.", "system"))
            except Exception as e: log("warm-up failed", k, e)
    port = CFG.get("port", 3200)
    log(f"voice service on http://127.0.0.1:{port}  stt={CFG['stt']['engine']} tts={CFG['tts']['engine']}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
