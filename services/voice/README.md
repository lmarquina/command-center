# Voice service

Speech-to-text and text-to-speech for the glasses, on `127.0.0.1` only. The gateway is its only client.
Engines, routing, voices and the Keychain item for the cloud key are in the `voice` section of
`config/default.json`. Background and lessons: `docs/voice.md`.

## Run it
- `npm run voice:setup`: create the Python environment (uv, kept inside this folder)
- `npm run voice`: start the service; a test page with a microphone button is at http://127.0.0.1:3200
- `npm run test:voice`: unit tests (standard library only)

The first start downloads the local models (a few GB) into `services/voice/models`. To reuse models you
already have, set `CC_VOICE_MODELS` to that Hugging Face cache folder before starting.

## Cloud fallback (optional)
Store an OpenAI API key in the macOS Keychain under the name in `voice.cloud.keychain_service`:
`security add-generic-password -U -s command-center-openai -a "$USER" -w "$(pbpaste)"` (copy the key first;
the interactive `-w` prompt cuts keys off at 128 characters). Without a key, everything stays local.
