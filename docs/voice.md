# Voice service

Python (uv, project-local) on `127.0.0.1:3200`. `POST /stt` (16 kHz mono s16le or WAV; optional `context`
vocabulary) → text. `POST /tts` `{text, provider}` → WAV. Never reachable from the network; the gateway calls it.

## Engines
- **STT**: recordings < 15 s → local Qwen3-ASR 1.7B (MLX); ≥ 15 s → OpenAI `gpt-4o-transcribe`; each falls back
  to the other. Up to 5 minutes per recording.
- **TTS**: always the fastest: local Kokoro-82M (~0.2 s per sentence warm). OpenAI `gpt-4o-mini-tts` as fallback.
- One voice per harness, plus a system voice (see the service config).

## Lessons
- Vocabulary hints fix names ("Hartwell Kramer") but must be short and name-like (≤ ~300 chars). A long,
  prompt-like hint made the local model return nothing; on an empty result, retry without hints.
- Discard transcripts with no Latin letters (noise gets "transcribed" into other scripts).
- Load one large model per process; several in one process pushed the machine into swap.
- The OpenAI key is read from the macOS Keychain per call. `security add-generic-password … -w` (interactive)
  truncates at 128 characters: store long keys with `-w "$(pbpaste)"`.
