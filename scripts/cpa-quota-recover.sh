#!/usr/bin/bash -p
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
# Optional environment setting:
#   CPA_LOG_DIR  host-visible CPA response-log directory; profile association
#                is not inferred or verified
set +x
if [[ $- != *p* ]]; then
  exec /usr/bin/env \
    -u BASH_ENV \
    -u ENV \
    -u SHELLOPTS \
    /usr/bin/bash -p "$0" "$@"
fi
set -euo pipefail

export PATH='/usr/bin:/bin'
readonly PATH

unset ALL_PROXY CURL_HOME DOCKER_API_VERSION DOCKER_CERT_PATH DOCKER_CONFIG
unset DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY HTTP_PROXY HTTPS_PROXY
unset NO_PROXY all_proxy http_proxy https_proxy no_proxy

readonly COOLDOWN_MARKER='are cooling down via provider codex'
readonly CONTAINER_INSPECT_FORMAT='{{.Id}}|{{range (index .NetworkSettings.Ports "8317/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}'
readonly DOCKER_HOST_URI='unix:///var/run/docker.sock'
readonly HEALTH_REQUEST_TIMEOUT_SECONDS=5
readonly RESTART_TIMEOUT_SECONDS=60
readonly POLL_INTERVAL_SECONDS=2
readonly RECENT_LOG_SECONDS=86400

log() { printf '[cpa-recover] %s\n' "$*"; }
fail() { printf '[cpa-recover] ERROR: %s\n' "$*" >&2; exit 1; }
print_usage() {
  cat <<EOF
Usage: $0 <primary|shaka> [check|restart]

Profiles:
  primary  cpa-server       http://172.17.0.1:8317
  shaka    cpa-server-shaka http://172.17.0.1:8318
EOF
}
usage_error() {
  print_usage >&2
  exit 1
}

case "${1:-}" in
  -h|--help)
    print_usage
    exit 0
    ;;
esac

PROFILE="${1:-}"
ACTION="${2:-check}"
[ "$#" -le 2 ] || usage_error

case "$PROFILE" in
  primary)
    CPA_URL='http://172.17.0.1:8317'
    CPA_CONTAINER='cpa-server'
    CPA_EXPECTED_BINDING='172.17.0.1:8317'
    ;;
  shaka)
    CPA_URL='http://172.17.0.1:8318'
    CPA_CONTAINER='cpa-server-shaka'
    CPA_EXPECTED_BINDING='172.17.0.1:8318'
    ;;
  *) usage_error ;;
esac
readonly PROFILE ACTION CPA_URL CPA_CONTAINER CPA_EXPECTED_BINDING

case "$ACTION" in
  check|restart) ;;
  *) usage_error ;;
esac

configured_log_dir="${CPA_LOG_DIR:-}"
if [ -n "$configured_log_dir" ]; then
  if ! CPA_LOG_DIR="$(realpath -e -- "$configured_log_dir" 2>/dev/null)" \
    || [ ! -d "$CPA_LOG_DIR" ]; then
    fail "CPA_LOG_DIR is not a directory: $configured_log_dir"
  fi
  [ -r "$CPA_LOG_DIR" ] && [ -x "$CPA_LOG_DIR" ] \
    || fail "CPA_LOG_DIR is not readable and searchable: $configured_log_dir"
else
  CPA_LOG_DIR=''
fi
readonly CPA_LOG_DIR
unset configured_log_dir

now_seconds() {
  date +%s
}

docker_local() {
  docker --host "$DOCKER_HOST_URI" "$@"
}

require_docker_access() {
  command -v docker >/dev/null 2>&1 || fail 'Docker CLI is not available'
  docker_local info >/dev/null 2>&1 \
    || fail "Cannot access the local Docker daemon at $DOCKER_HOST_URI"
}

resolve_container_id() {
  require_docker_access

  local identity
  if ! identity="$(
    docker_local container inspect \
      --format "$CONTAINER_INSPECT_FORMAT" \
      "$CPA_CONTAINER" 2>/dev/null
  )"; then
    fail "Unable to inspect required CPA container for profile $PROFILE: $CPA_CONTAINER (missing or inaccessible)"
  fi

  case "$identity" in
    *'|'*) ;;
    *) fail "Docker returned an invalid identity for profile $PROFILE" ;;
  esac

  local container_id="${identity%%|*}"
  local actual_binding="${identity#*|}"
  [[ "$container_id" =~ ^[0-9a-f]{64}$ ]] \
    || fail "Docker returned an invalid container ID for profile $PROFILE"
  [ "$actual_binding" = "$CPA_EXPECTED_BINDING" ] \
    || fail "CPA container port binding mismatch for profile $PROFILE: expected $CPA_EXPECTED_BINDING, got ${actual_binding:-none}"

  printf '%s\n' "$container_id"
}

health_ok() {
  local timeout_seconds="${1:-$HEALTH_REQUEST_TIMEOUT_SECONDS}"
  local code
  if ! code="$(
    curl --disable \
      --noproxy '*' \
      --proto '=http' \
      --silent \
      --show-error \
      --max-time "$timeout_seconds" \
      --output /dev/null \
      --write-out '%{http_code}' \
      -- "$CPA_URL/" 2>/dev/null
  )"; then
    return 1
  fi
  [ "$code" = '200' ]
}

container_has_cooldown_evidence() {
  local container_id="$1"
  local -a pipeline_status

  set +e
  docker_local logs --since 24h -- "$container_id" 2>&1 \
    | awk -v marker="$COOLDOWN_MARKER" '
        index($0, marker) { found = 1 }
        END { exit(found ? 0 : 1) }
      '
  pipeline_status=("${PIPESTATUS[@]}")
  set -e

  [ "${pipeline_status[0]}" -eq 0 ] \
    || fail "Unable to read Docker logs for profile $PROFILE ($CPA_CONTAINER)"
  case "${pipeline_status[1]}" in
    0) return 0 ;;
    1) return 1 ;;
    *) fail "Unable to scan Docker logs for profile $PROFILE ($CPA_CONTAINER)" ;;
  esac
}

host_has_cooldown_evidence() {
  local now
  if ! now="$(now_seconds)"; then
    printf '[cpa-recover] ERROR: Unable to read the current time\n' >&2
    return 2
  fi

  local nullglob_was_set=0
  local dotglob_was_set=0
  shopt -q nullglob && nullglob_was_set=1
  shopt -q dotglob && dotglob_was_set=1
  shopt -s nullglob dotglob
  local -a log_files=("$CPA_LOG_DIR"/*.log)
  [ "$nullglob_was_set" -eq 1 ] || shopt -u nullglob
  [ "$dotglob_was_set" -eq 1 ] || shopt -u dotglob

  local file modified_seconds grep_status
  for file in "${log_files[@]}"; do
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    if ! modified_seconds="$(stat --format '%Y' -- "$file" 2>/dev/null)"; then
      printf '[cpa-recover] ERROR: Unable to inspect a CPA response-log file\n' >&2
      return 2
    fi
    if [ $((now - modified_seconds)) -gt "$RECENT_LOG_SECONDS" ]; then
      continue
    fi

    if grep -Fq -- "$COOLDOWN_MARKER" "$file"; then
      return 0
    else
      grep_status=$?
      if [ "$grep_status" -ne 1 ]; then
        printf '[cpa-recover] ERROR: Unable to read a CPA response-log file\n' >&2
        return 2
      fi
    fi
  done

  return 1
}

check() {
  local container_id
  container_id="$(resolve_container_id)"
  health_ok || fail "CPA profile $PROFILE is not healthy at $CPA_URL"
  log "CPA profile $PROFILE is healthy at $CPA_URL ($CPA_CONTAINER)"

  if container_has_cooldown_evidence "$container_id"; then
    log "Found quota-cooldown evidence in the selected profile's Docker logs."
    log "Only after confirming that the upstream quota has reset, run: $0 $PROFILE restart"
    return 0
  fi

  if [ -n "$CPA_LOG_DIR" ]; then
    local host_status
    if host_has_cooldown_evidence; then
      log 'Found quota-cooldown evidence in the explicitly configured host log directory (profile association not verified).'
      log 'Do not use host-log evidence alone to choose a profile to restart.'
      return 0
    else
      host_status=$?
    fi
    [ "$host_status" -eq 1 ] \
      || fail "Unable to scan CPA response logs in $CPA_LOG_DIR"
  fi

  log 'No quota-cooldown evidence was found in Docker logs from the last 24h or eligible response-log files.'
  log 'This does not verify upstream quota availability.'
}

restart() {
  local container_id
  container_id="$(resolve_container_id)"
  health_ok \
    || fail "CPA profile $PROFILE is not reachable at $CPA_URL; refusing to restart blindly"
  log "Restarting $CPA_CONTAINER for profile $PROFILE to clear its local cooldown..."
  if ! docker_local restart -- "$container_id" >/dev/null; then
    fail "Failed to restart CPA profile $PROFILE ($CPA_CONTAINER)"
  fi

  local started_at
  if ! started_at="$(now_seconds)"; then
    fail 'Unable to start the restart health-check timer'
  fi
  local deadline=$((started_at + RESTART_TIMEOUT_SECONDS))
  local current_time remaining_seconds probe_timeout sleep_seconds
  while true; do
    if ! current_time="$(now_seconds)"; then
      fail 'Unable to read the restart health-check timer'
    fi
    remaining_seconds=$((deadline - current_time))
    [ "$remaining_seconds" -gt 0 ] \
      || fail "CPA profile $PROFILE did not become healthy within ${RESTART_TIMEOUT_SECONDS}s"

    probe_timeout="$HEALTH_REQUEST_TIMEOUT_SECONDS"
    if [ "$probe_timeout" -gt "$remaining_seconds" ]; then
      probe_timeout="$remaining_seconds"
    fi
    if health_ok "$probe_timeout"; then
      break
    fi

    if ! current_time="$(now_seconds)"; then
      fail 'Unable to read the restart health-check timer'
    fi
    remaining_seconds=$((deadline - current_time))
    [ "$remaining_seconds" -gt 0 ] \
      || fail "CPA profile $PROFILE did not become healthy within ${RESTART_TIMEOUT_SECONDS}s"
    sleep_seconds="$POLL_INTERVAL_SECONDS"
    if [ "$sleep_seconds" -gt "$remaining_seconds" ]; then
      sleep_seconds="$remaining_seconds"
    fi
    sleep "$sleep_seconds"
  done

  if ! current_time="$(now_seconds)"; then
    fail 'Unable to finish the restart health-check timer'
  fi
  local waited=$((current_time - started_at))
  log "CPA profile $PROFILE is healthy again (waited ${waited}s)."
  log 'Send one real model request to verify the upstream quota. A new usage_limit_reached response means the quota has not reset.'
}

case "$ACTION" in
  check) check ;;
  restart) restart ;;
esac
