#!/bin/sh
# Usage: run.sh setup | start | test
V="$(cd "$(dirname "$0")" && pwd)"; . "$V/env.sh"; cd "$V"
case "$1" in
  setup) exec uv sync ;;
  start) exec uv run --no-sync python server.py ;;
  test)  exec python3 -m unittest discover -s tests -v ;;
  *) echo "usage: run.sh setup|start|test" >&2; exit 2 ;;
esac
