#!/bin/bash
# Visual & accessibility regression suite entry point.
#
# Subcommands:
#   (default)         run the full capture+diff (drops+seeds the test DB
#                     and starts Indico inside docker)
#   setup             pre-build the indico + runner images (optional warm-up)
#   review            launch the host-side Flask review UI on port 8002
#   accept-all [--browser <name>]
#                     bulk-accept every open diff (optionally one browser only)
#   backfill [filter flags]
#                     capture only the (page, persona, browser, modality)
#                     combos that have no baseline yet, and write them
#                     straight to *_baselines. Use it for the very first run
#                     (empty DB) and for incremental backfill after adding new
#                     pages/personas/scenarios. Accepts the same filter flags
#                     as the default run.
#   revert [--browser <name>] [--kind visual|a11y]
#                     undo the most recently captured run's accepts (every row
#                     carries its capture run), restoring their pending diffs
#   wipe-baselines    drop both baseline tables (with confirmation)
#   shell             open a bash shell in the runner container
#   logs              tail the Indico server logs
#   down              tear down the compose stack
#
# Default-subcommand flags forwarded to the runner:
#   --filter <module>, --persona <name>, --page <id>,
#   --only-visual, --only-a11y,
#   --browser <list>   comma-separated; default 'chromium,firefox'.
#                      A11y is captured in chromium only regardless of this flag
#                      (firefox has no CDP-equivalent for the AT tree).
#
# Environment:
#   INDICO_SRC       path to the Indico source checkout (default: ../indico)
#   INDICO_PYTHON    host-side Python wrapper (default: indico-python)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker/docker-compose.yml"
PY="${INDICO_PYTHON:-indico-python}"

DEFAULT_INDICO_SRC="$(cd "$SCRIPT_DIR/.." && pwd)/indico"
export INDICO_SRC="${INDICO_SRC:-$DEFAULT_INDICO_SRC}"
export INDICO_REGRESSIONS_DOCKERFILE="$SCRIPT_DIR/docker/Dockerfile.indico"

DC=(docker compose -f "$COMPOSE_FILE")

color() {
  case "$1" in
    info) printf '\033[0;36m%s\033[0m\n' "$2" ;;
    ok)   printf '\033[0;32m%s\033[0m\n' "$2" ;;
    warn) printf '\033[0;33m%s\033[0m\n' "$2" ;;
    err)  printf '\033[0;31m%s\033[0m\n' "$2" ;;
    *)    printf '%s\n' "$2" ;;
  esac
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    color err "docker not found on PATH"
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    color err "docker compose v2 not available"
    exit 1
  fi
}

require_indico_src() {
  if [[ ! -d "$INDICO_SRC" ]]; then
    color err "INDICO_SRC=$INDICO_SRC does not exist"
    color err "Set INDICO_SRC to the Indico source checkout, or place it at ../indico"
    exit 1
  fi
  if [[ ! -f "$INDICO_SRC/Dockerfile" ]]; then
    color err "INDICO_SRC=$INDICO_SRC has no Dockerfile"
    exit 1
  fi
}

require_py() {
  if ! command -v "$PY" >/dev/null 2>&1; then
    color err "$PY not found on PATH — expected indico-python wrapper"
    exit 1
  fi
}

ensure_baselines_db() {
  # Create the SQLite file with schema applied so the bind-mount target
  # exists before the runner tries to write to it. Idempotent.
  "$PY" "$SCRIPT_DIR/storage/db.py" >/dev/null
}

cmd_setup() {
  require_docker
  require_indico_src
  color info "building indico image (this can take a few minutes)"
  "${DC[@]}" build indico
  color info "building runner image"
  "${DC[@]}" build runner
  ensure_baselines_db
  color ok "setup complete"
}

cmd_default() {
  require_docker
  require_indico_src

  local runner_args=()
  while (( $# > 0 )); do
    case "$1" in
      --filter|--persona|--page|--browser)
        runner_args+=("$1" "$2"); shift ;;
      --only-visual|--only-a11y)
        runner_args+=("$1") ;;
      *) color err "unknown flag $1"; exit 1 ;;
    esac
    shift
  done

  ensure_baselines_db

  color info "starting indico stack (drops+seeds indico_visual on boot)"
  "${DC[@]}" up -d --wait indico

  color info "running snapshot + diff"
  set +e
  "${DC[@]}" run --rm --build runner "${runner_args[@]}"
  local rc=$?
  set -e

  color info "tearing down stack"
  "${DC[@]}" down --remove-orphans >/dev/null

  if (( rc == 0 )); then
    color ok "no diffs — exit 0"
  else
    color warn "diffs present — review with: $0 review"
  fi
  exit "$rc"
}

cmd_review() {
  require_py
  ensure_baselines_db
  color info "review UI on http://127.0.0.1:8002 (Ctrl-C to stop)"
  "$PY" "$SCRIPT_DIR/review/app.py"
}

cmd_accept_all() {
  require_py
  local browser=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --browser) browser="${2:-}"; shift 2 ;;
      *) color err "usage: $0 accept-all [--browser <name>]"; exit 1 ;;
    esac
  done
  PYTHONPATH="$SCRIPT_DIR" "$PY" -c "
import sys
from storage.db import connect, accept_all
conn = connect()
counts = accept_all(conn, browser=(sys.argv[1] or None))
print(f'accepted: visual={counts[\"visual\"]} a11y={counts[\"a11y\"]}')
conn.close()
" "$browser"
}

cmd_backfill() {
  require_docker
  require_indico_src

  local runner_args=(--only-missing)
  while (( $# > 0 )); do
    case "$1" in
      --filter|--persona|--page|--browser)
        runner_args+=("$1" "$2"); shift ;;
      --only-visual|--only-a11y)
        runner_args+=("$1") ;;
      *) color err "unknown flag $1"; exit 1 ;;
    esac
    shift
  done

  ensure_baselines_db

  color info "starting indico stack (drops+seeds indico_visual on boot)"
  "${DC[@]}" up -d --wait indico

  color info "capturing baselines for missing entries only"
  set +e
  "${DC[@]}" run --rm --build runner "${runner_args[@]}"
  local rc=$?
  set -e

  color info "tearing down stack"
  "${DC[@]}" down --remove-orphans >/dev/null

  exit "$rc"
}

cmd_revert() {
  require_py
  local browser="" kind=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --browser) browser="${2:-}"; shift 2 ;;
      --kind)    kind="${2:-}"; shift 2 ;;
      *) color err "usage: $0 revert [--browser <name>] [--kind visual|a11y]"; exit 1 ;;
    esac
  done
  PYTHONPATH="$SCRIPT_DIR" "$PY" -c "
import sys
from storage.db import connect, revert_all
conn = connect()
counts = revert_all(conn, kind=(sys.argv[1] or None), browser=(sys.argv[2] or None))
print(f'reverted: visual={counts[\"visual\"]} a11y={counts[\"a11y\"]}')
conn.close()
" "$kind" "$browser"
}

cmd_wipe_baselines() {
  require_py
  read -r -p "Drop all baselines? [y/N] " ans
  if [[ "$ans" != "y" && "$ans" != "Y" ]]; then
    color warn "aborted"
    exit 0
  fi
  PYTHONPATH="$SCRIPT_DIR" "$PY" -c "
from storage.db import connect, wipe_baselines
conn = connect()
wipe_baselines(conn)
conn.close()
print('baselines dropped')
"
}

cmd_shell() {
  require_docker
  require_indico_src
  "${DC[@]}" run --rm --entrypoint bash runner
}

cmd_logs() {
  require_docker
  "${DC[@]}" logs -f indico
}

cmd_down() {
  require_docker
  "${DC[@]}" down --remove-orphans
}

main() {
  if [[ $# -eq 0 ]]; then
    cmd_default
    return
  fi
  case "$1" in
    setup)          shift; cmd_setup "$@" ;;
    review)         shift; cmd_review "$@" ;;
    accept-all)     shift; cmd_accept_all "$@" ;;
    backfill)       shift; cmd_backfill "$@" ;;
    revert)         shift; cmd_revert "$@" ;;
    wipe-baselines) shift; cmd_wipe_baselines "$@" ;;
    shell)          shift; cmd_shell "$@" ;;
    logs)           shift; cmd_logs "$@" ;;
    down)           shift; cmd_down "$@" ;;
    --help|-h)
      sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
      ;;
    *) cmd_default "$@" ;;
  esac
}

main "$@"
