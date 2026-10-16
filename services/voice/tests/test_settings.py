import json, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from settings import load_config, merge, pick_engine, engine_order

class Settings(unittest.TestCase):
    def test_local_overrides_default_key_by_key(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "default.json").write_text(json.dumps({"voice": {"port": 3200, "stt": {"engine": "auto", "fallback": True}}}))
            self.assertEqual(load_config(d)["voice"]["port"], 3200)
            Path(d, "local.json").write_text(json.dumps({"voice": {"stt": {"engine": "cloud"}}}))
            self.assertEqual(load_config(d)["voice"], {"port": 3200, "stt": {"engine": "cloud", "fallback": True}})
        self.assertEqual(merge({"a": [1, 2]}, {"a": [3]}), {"a": [3]})

    def test_checked_in_config_has_a_voice_for_every_harness(self):
        v = load_config()["voice"]["tts"]["voices"]
        self.assertEqual(sorted(v), ["chatgpt", "claude-code", "codex", "cowork", "system"])

    def test_short_recordings_go_local_long_ones_to_the_cloud(self):
        cfg = {"stt": {"engine": "auto", "fallback": True, "route_by_length": {"threshold_s": 15, "short": "local", "long": "cloud"}}, "tts": {"engine": "local", "fallback": False}}
        self.assertEqual([pick_engine("stt", cfg, 3), pick_engine("stt", cfg, 15), pick_engine("stt", cfg, 170)], ["local", "cloud", "cloud"])
        self.assertEqual(pick_engine("tts", cfg), "local")

    def test_fallback_tries_the_other_engine_unless_one_was_forced(self):
        cfg = {"stt": {"fallback": True}, "tts": {"fallback": False}}
        self.assertEqual(engine_order("stt", cfg, "cloud"), ["cloud", "local"])
        self.assertEqual(engine_order("stt", cfg, "cloud", forced=True), ["cloud"])
        self.assertEqual(engine_order("tts", cfg, "local"), ["local"])

if __name__ == "__main__":
    unittest.main()
