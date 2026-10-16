# Chrome bridge

Lets the daemon read and drive Cowork (claude.ai) and ChatGPT (chatgpt.com) sessions in your own Chrome.
Local only: the extension talks to a native host on this computer, never to a server. See `docs/bridge.md`
for the page contracts it relies on.

## Install (once)
1. `npm install` in the repo root.
2. Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → choose `extension/chrome`.
3. Copy the extension id shown there, then:
   `npm run install-host -w @command-center/extension -- <extension-id>`
4. Reload the extension, open claude.ai and/or chatgpt.com, then check: `npm run bridge -- doctor`

To remove it: delete the extension in Chrome and the file the install script printed.

## Layout
- `chrome/`: the extension (service worker, content scripts, selectors)
- `native-host/`: process Chrome starts; relays to `run/bridge.sock`
- `cli/bridge.mjs`: debugging CLI (`doctor`, `sessions`, `read`, `watch`, `snapshot` …)
- `fixtures/`, `tests/`: sanitized page captures and the tests that run against them

After editing anything in `chrome/`, reload the extension and refresh the open claude.ai / chatgpt.com tabs.
