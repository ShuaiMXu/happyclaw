#!/usr/bin/env bash
# Recover CLIProxyAPI (CPA) from a stale upstream-quota cooldown.
#
# Background: when the upstream ChatGPT account answers usage_limit_reached,
# CPA keeps an in-memory cooldown timer (roughly one upstream quota window).
# If the quota is reset on the provider side while the timer is still running,
# CPA keeps rejecting requests locally with 429 (milliseconds, never reaching
# the upstream). Restarting the container clears the in-memory state and the
# next request hits the upstream again. Verified on 2026-10-06 with
# cpa-server (eceasy/cli-proxy-api) serving gpt-5.6-sol.
#
# Usage:
#   scripts/cpa-quota-recover.sh check     # report only (default)
#   scripts/cpa-quota-recover.sh restart   # restart container and wait for health
#
# Environment overrides:
#   CPA_URL          upstream base URL (default http://172.17.0.1:8317)
#   CPA_CONTAINER    docker container name (default cpa-server)
#   COOLDOWN_MARKER  log marker for quota cooldown lines (default "reason=quota")
set -euo pipefail

CPA_URL="${CPA_URL:-http://172.17.0.1:8317}"
CPA_CONTAINER="${CPA_CONTAINER:-cpa-server}"
COOLDOWN_MARKER="${COOLDOWN_MARKER:-reason=quota}"

log() { printf '[cpa-recover] %s\n' "$*"; }
fail() { printf '[cpa-recover] ERROR: %s\n' "$*" >&2; exit 1; }

health_ok() {
  local code
  code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$CPA_URL/" || true)"
  [ "$code" = "200" ]
}

last_cooldown_line() {
  docker logs --since 24h "$CPA_CONTAINER" 2>&1 \
    | grep "$COOLDOWN_MARKER" | tail -n 1 || true
}

check() {
  health_ok || fail "CPA not healthy at $CPA_URL"
  log "CPA healthy at $CPA_URL"
  local line
  line="$(last_cooldown_line)"
  if [ -z "$line" ]; then
    log "No quota cooldown entries in the last 24h. Nothing to do."
    return 0
  fi
  log "Latest cooldown entry:"
  log "  $line"
  log "If the upstream quota has been reset, run: $0 restart"
}

restart() {
  health_ok || fail "CPA not reachable at $CPA_URL; refusing to restart blindly"
  log "Restarting container $CPA_CONTAINER to clear in-memory cooldown..."
  docker restart "$CPA_CONTAINER" >/dev/null
  local waited=0
  while ! health_ok; do
    waited=$((waited + 2))
    [ "$waited" -ge 60 ] && fail "CPA did not become healthy within 60s"
    sleep 2
  done
  log "CPA healthy again (waited ${waited}s)."
  log "Send one real model request to confirm the upstream quota; if it still"
  log "answers usage_limit_reached, the quota itself is not reset yet."
}

case "${1:-check}" in
  check) check ;;
  restart) restart ;;
  *) fail "Usage: $0 [check|restart]" ;;
esac
