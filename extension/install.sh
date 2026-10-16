#!/bin/sh
# Registers the native messaging host with Google Chrome for the current macOS user (no admin rights needed).
# Usage: npm run install-host -w @command-center/extension -- <extension-id>
#   The extension id is shown on chrome://extensions after "Load unpacked" → extension/chrome.
#   Undo: delete the JSON file this prints.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
EXT_ID="${1:-$CC_EXTENSION_ID}"
case "$EXT_ID" in
  [a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p]) ;;
  *) echo "usage: install.sh <32-letter extension id from chrome://extensions>" >&2; exit 2 ;;
esac
NM_DIR="${CC_NM_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
chmod +x "$ROOT/native-host/host.sh"
mkdir -p "$NM_DIR"
cat > "$NM_DIR/com.commandcenter.bridge.json" <<JSON
{
  "name": "com.commandcenter.bridge",
  "description": "Command Center bridge native host",
  "path": "$ROOT/native-host/host.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
JSON
echo "installed: $NM_DIR/com.commandcenter.bridge.json (extension $EXT_ID)"
