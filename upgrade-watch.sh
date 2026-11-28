#!/usr/bin/env bash
# =============================================================================
# PodSovereign: the one-click updater (runs on the server itself)
#
# The "Update now" button in Site settings can't rebuild its own container, so it leaves a request
# file in data/control/. This watcher (installed as the `podsovereign-updater` service by
# install-updater.sh) notices it, runs ./update.sh, and writes the progress back for the dashboard.
# It touches data/control/watcher.alive every few seconds so the dashboard knows it is running.
#
#   ./upgrade-watch.sh           watch forever (what the service does)
#   ./upgrade-watch.sh --once    one pass, for cron
# =============================================================================
set -uo pipefail

# Everything is inside one function, so bash has read the whole script before update.sh replaces it on disk.
main() {
  local APP_DIR
  APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
  cd "$APP_DIR" || exit 1

  local DATA
  DATA="$(sed -n 's/^FEEDHOST_DATA_DIR=//p' .env 2>/dev/null | tail -n1)"
  DATA="${DATA:-./data}"
  case "$DATA" in /*) ;; *) DATA="$APP_DIR/${DATA#./}" ;; esac
  local CONTROL="$DATA/control"
  local REQ="$CONTROL/upgrade.request" STATUS="$CONTROL/upgrade.status" HEARTBEAT="$CONTROL/watcher.alive" LOG="$CONTROL/upgrade.log"
  local INTERVAL="${WATCH_INTERVAL:-5}"

  mkdir -p "$CONTROL"
  chmod 777 "$CONTROL" 2>/dev/null || true
  iso() { date -u '+%Y-%m-%dT%H:%M:%S+00:00'; }
  beat() { iso > "$HEARTBEAT"; chmod 666 "$HEARTBEAT" 2>/dev/null || true; }
  # The app (user 1000 in Docker) and this service (root) both write here: replace files by rename, keep them world-writable.
  write_status() { local tmp="$STATUS.tmp.$$"; cat > "$tmp" && chmod 666 "$tmp" && mv -f "$tmp" "$STATUS"; }
  json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r'; }

  run_once() {
    [ -f "$REQ" ] || return 1
    local by before after started
    by="$(sed -n 's/.*"requested_by" *: *"\([^"]*\)".*/\1/p' "$REQ" | head -n1)"
    started="$(iso)"
    before="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
    printf '{"state":"running","message":"Updating. The dashboard will be unavailable for a minute while the app restarts.","requested_by":"%s","started_at":"%s","revision_before":"%s"}\n' \
      "$(json_escape "$by")" "$started" "$before" | write_status
    rm -f "$REQ"
    ./update.sh --yes > "$LOG" 2>&1 &
    local pid=$!
    while kill -0 "$pid" 2>/dev/null; do beat; sleep 3; done
    if wait "$pid"; then
      after="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
      printf '{"state":"success","message":"%s","requested_by":"%s","started_at":"%s","finished_at":"%s","revision_before":"%s","revision_after":"%s"}\n' \
        "$([ "$before" = "$after" ] && echo 'Already up to date.' || echo 'Update complete.')" "$(json_escape "$by")" "$started" "$(iso)" "$before" "$after" | write_status
    else
      printf '{"state":"failed","message":"The update did not finish. The log is in data/control/upgrade.log on the server.","requested_by":"%s","started_at":"%s","finished_at":"%s","revision_before":"%s"}\n' \
        "$(json_escape "$by")" "$started" "$(iso)" "$before" | write_status
    fi
    chmod 666 "$LOG" 2>/dev/null || true
    return 0
  }

  if [ "${1:-}" = "--once" ]; then
    beat
    run_once || true
    exit 0
  fi

  echo "[PodSovereign updater] watching $CONTROL every ${INTERVAL}s"
  while true; do
    beat
    if run_once; then
      # update.sh may have replaced this very script: start again from the new copy.
      exec bash "$APP_DIR/upgrade-watch.sh"
    fi
    sleep "$INTERVAL"
  done
}

main "$@"
exit $?
