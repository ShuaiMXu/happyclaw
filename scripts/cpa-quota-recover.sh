#!/usr/bin/env bash
# Recover CLIProxyAPI (CPA) from a stale upstream-quota cooldown.
#
# CPA records upstream usage_limit_reached responses in process memory. After
# the upstream quota has genuinely reset, restarting the affected CPA instance
# clears that stale local cooldown so the next request reaches the provider.
#
# Usage:
#   scripts/cpa-quota-recover.sh <primary|shaka> [check|restart]
#
# Examples:
#   scripts/cpa-quota-recover.sh shaka check
#   scripts/cpa-quota-recover.sh shaka restart
#
# Environment overrides (only for an intentional nonstandard deployment):
#   CPA_URL          CPA base URL for the selected profile
#   CPA_CONTAINER    Docker container for the selected profile
#   CPA_LOG_DIR      CPA error-log directory for the selected profile
#   COOLDOWN_MARKER  fixed text marking a local quota cooldown
set -euo pipefail

log() { printf '[cpa-recover] %s\n' "$*"; }
fail() { printf '[cpa-recover] ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat >&2 <<EOF
Usage: $0 <primary|shaka> [check|restart]

Profiles:
  primary  cpa-server       http://172.17.0.1:8317
  shaka    cpa-server-shaka http://172.17.0.1:8318
EOF
  exit 1
}

PROFILE="${1:-}"
ACTION="${2:-check}"
[ "$#" -le 2 ] || usage

case "$PROFILE" in
  primary)
    default_url="http://172.17.0.1:8317"
    default_container="cpa-server"
    default_log_dir="/home/ubuntu/cpa/auths/logs"
    ;;
  shaka)
    default_url="http://172.17.0.1:8318"
    default_container="cpa-server-shaka"
    default_log_dir="/home/ubuntu/cpa/auths-shaka/logs"
    ;;
  *) usage ;;
esac

case "$ACTION" in
  check|restart) ;;
  *) usage ;;
esac

CPA_URL="${CPA_URL:-$default_url}"
CPA_CONTAINER="${CPA_CONTAINER:-$default_container}"
CPA_LOG_DIR="${CPA_LOG_DIR:-$default_log_dir}"
COOLDOWN_MARKER="${COOLDOWN_MARKER:-are cooling down via provider codex}"

[[ "$CPA_CONTAINER" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] \
  || fail "CPA_CONTAINER must be a Docker container name"
[ -d "$CPA_LOG_DIR" ] || fail "CPA_LOG_DIR is not a directory: $CPA_LOG_DIR"

health_ok() {
  local code
  code="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$CPA_URL/" || true)"
  [ "$code" = "200" ]
}

last_cooldown_line() {
  {
    docker logs --since 24h -- "$CPA_CONTAINER" 2>&1 || true
    find "$CPA_LOG_DIR" -maxdepth 1 -type f -name '*.log' -mmin -1440 \
      -exec grep -H -F -- "$COOLDOWN_MARKER" {} + 2>/dev/null || true
  } | grep -F -- "$COOLDOWN_MARKER" | tail -n 1 || true
}

check() {
  health_ok || fail "CPA profile $PROFILE is not healthy at $CPA_URL"
  log "CPA profile $PROFILE is healthy at $CPA_URL ($CPA_CONTAINER)"

  local line
  line="$(last_cooldown_line)"
  if [ -z "$line" ]; then
    log "No local quota-cooldown entry was found in the last 24h."
    log "This does not verify upstream quota availability."
    return 0
  fi

  log "Latest local quota-cooldown entry:"
  log "  $line"
  log "Only after confirming that the upstream quota has reset, run: $0 $PROFILE restart"
}

restart() {
  health_ok || fail "CPA profile $PROFILE is not reachable at $CPA_URL; refusing to restart blindly"
  log "Restarting $CPA_CONTAINER for profile $PROFILE to clear its local cooldown..."
  docker restart -- "$CPA_CONTAINER" >/dev/null

  local waited=0
  while ! health_ok; do
    waited=$((waited + 2))
    [ "$waited" -ge 60 ] && fail "CPA profile $PROFILE did not become healthy within 60s"
    sleep 2
  done

  log "CPA profile $PROFILE is healthy again (waited ${waited}s)."
  log "Send one real model request to verify the upstream quota. A new usage_limit_reached response means the quota has not reset."
}

case "$ACTION" in
  check) check ;;
  restart) restart ;;
esac
