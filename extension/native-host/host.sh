#!/bin/sh
# Started by Chrome (native messaging). Chrome's PATH is minimal, so prefer the repo's own Node.
DIR="$(cd "$(dirname "$0")" && pwd)"
for NODE in "$DIR/../../node_modules/.bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -x "$NODE" ] && exec "$NODE" "$DIR/host.mjs" "$@"
done
echo "command-center bridge: no node binary found (run npm install in the repo)" >&2
exit 1
