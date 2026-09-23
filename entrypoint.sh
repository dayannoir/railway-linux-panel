#!/usr/bin/env bash
set -Eeuo pipefail

MODE="${MODE:-web}"
START_CMD="${START_CMD:-}"
APP_ROOT="${APP_ROOT:-/app}"
if [[ ! -d "$APP_ROOT" ]]; then
  APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
cd "$APP_ROOT"

log() { printf '[railway-entrypoint] %s\n' "$*"; }

if [[ -z "$START_CMD" ]]; then
  if [[ "$MODE" == "worker" ]]; then
    log 'MODE=worker but START_CMD is empty; running the sample worker.'
    exec python3 "$APP_ROOT/examples/worker/worker.py"
  fi
  log "No START_CMD provided; running the built-in web starter on port ${PORT:-8080}."
  exec node "$APP_ROOT/app/server.js"
fi

log "Starting ${MODE} command: ${START_CMD}"
exec bash -lc "$START_CMD"
