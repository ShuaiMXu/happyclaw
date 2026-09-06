#!/usr/bin/env bash

set -Eeuo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 <image-reference> [expected-architecture]" >&2
  exit 2
fi

IMAGE_REF="$1"
EXPECTED_ARCHITECTURE="${2:-}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-120}"
SMOKE_CONTAINER_NAME="${SMOKE_CONTAINER_NAME:-happyclaw-image-smoke-${GITHUB_RUN_ID:-local}-${RANDOM}}"

# shellcheck disable=SC2317 # invoked indirectly by trap
cleanup() {
  docker rm -f "$SMOKE_CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# A digest reference is immutable. Prefer an already loaded local image for
# developer use; CI's digest candidate is not loaded, so this performs a real
# registry pull before the runtime probe.
if ! docker image inspect "$IMAGE_REF" >/dev/null 2>&1; then
  docker pull "$IMAGE_REF"
fi

if [ -n "$EXPECTED_ARCHITECTURE" ]; then
  actual_architecture="$(
    docker image inspect --format '{{.Architecture}}' "$IMAGE_REF"
  )"
  if [ "$actual_architecture" != "$EXPECTED_ARCHITECTURE" ]; then
    echo "Expected $EXPECTED_ARCHITECTURE image, pulled $actual_architecture" >&2
    exit 1
  fi
fi

# GitHub's native Linux runners use a rootful Docker daemon, so the process
# invoking docker is the authoritative host identity for this no-bind-mount
# smoke. Pass the same explicit contract as the production container runner:
# align node to a non-root host uid/gid, or use host-root when the caller is
# actually root. Leaving the mode unset must remain fail-closed in entrypoint.
smoke_host_uid="$(id -u)"
smoke_host_gid="$(id -g)"
case "$smoke_host_uid:$smoke_host_gid" in
  *[!0-9:]* | *:*:*)
    echo "Could not determine a numeric smoke host uid/gid" >&2
    exit 1
    ;;
esac

if [ "$smoke_host_uid" -eq 0 ]; then
  smoke_identity_args=(
    --env HAPPYCLAW_HOST_IDENTITY_MODE=host-root
  )
else
  smoke_identity_args=(
    --env HAPPYCLAW_HOST_IDENTITY_MODE=direct
    --env "HAPPYCLAW_HOST_UID=$smoke_host_uid"
    --env "HAPPYCLAW_HOST_GID=$smoke_host_gid"
  )
fi

runner_preflight="$({
  printf '%s' '{"prompt":"image preflight","groupFolder":"smoke","chatJid":"web:smoke","isMain":false}' |
    docker run --rm --interactive \
      "${smoke_identity_args[@]}" \
      --env HAPPYCLAW_IMAGE_PREFLIGHT=1 \
      --tmpfs /home/node/.claude:rw,nosuid,nodev,noexec \
      --tmpfs /workspace/ipc:rw,nosuid,nodev,noexec \
      --tmpfs /workspace/group:rw,nosuid,nodev \
      --tmpfs /workspace/extra:rw,nosuid,nodev \
      "$IMAGE_REF"
} 2>&1)"
printf '%s\n' "$runner_preflight"
grep -q 'IMAGE_RUNNER_PREFLIGHT_OK' <<<"$runner_preflight"
grep -q 'phase=runner_exec' <<<"$runner_preflight"

# -i keeps stdin open while detached. The production entrypoint validates the
# immutable Agent artifact, installs the lazy browser wrapper, and then waits
# for task JSON on stdin. The smoke invokes that real wrapper explicitly.
docker run --detach --interactive \
  --name "$SMOKE_CONTAINER_NAME" \
  "${smoke_identity_args[@]}" \
  --tmpfs /home/node/.claude:rw,nosuid,nodev,noexec \
  --tmpfs /workspace/ipc:rw,nosuid,nodev,noexec \
  --tmpfs /workspace/group:rw,nosuid,nodev \
  --tmpfs /workspace/extra:rw,nosuid,nodev \
  "$IMAGE_REF" >/dev/null

for ((attempt = 1; attempt <= SMOKE_TIMEOUT_SECONDS; attempt++)); do
  if ! docker inspect --format '{{.State.Running}}' "$SMOKE_CONTAINER_NAME" |
    grep -qx true; then
    echo "Container exited before the immutable runner became ready" >&2
    docker logs "$SMOKE_CONTAINER_NAME" >&2 || true
    exit 1
  fi

  if docker logs "$SMOKE_CONTAINER_NAME" 2>&1 |
    grep -q 'phase=browser_deferred'; then
    break
  fi

  if [ "$attempt" -eq "$SMOKE_TIMEOUT_SECONDS" ]; then
    echo "Timed out waiting for immutable runner readiness" >&2
    docker logs "$SMOKE_CONTAINER_NAME" >&2 || true
    exit 1
  fi
  sleep 1
done

docker exec "$SMOKE_CONTAINER_NAME" \
  test -f /opt/happyclaw-agent/dist/index.js
docker exec "$SMOKE_CONTAINER_NAME" \
  test ! -e /tmp/dist/index.js
docker exec "$SMOKE_CONTAINER_NAME" \
  /app/node_modules/.bin/claude --version
docker exec --user node "$SMOKE_CONTAINER_NAME" \
  env HOME=/home/node node \
  /opt/happyclaw-agent/smoke/image-sdk-query-smoke.mjs

# Chromium must consume no resources before a browser tool is actually used.
if docker exec "$SMOKE_CONTAINER_NAME" \
  curl --noproxy '*' -fsS http://127.0.0.1:9222/json/version \
  >/dev/null 2>&1; then
  echo "Chromium started eagerly instead of waiting for agent-browser" >&2
  exit 1
fi

browser_output="$(
  docker exec --user node "$SMOKE_CONTAINER_NAME" \
    env HOME=/home/node /app/node_modules/.bin/agent-browser open about:blank 2>&1
)"
printf '%s\n' "$browser_output"
grep -q 'phase=chromium_ready' <<<"$browser_output"

response="$(
  docker exec "$SMOKE_CONTAINER_NAME" \
    curl --noproxy '*' -fsS http://127.0.0.1:9222/json/version
)"
jq -e '
  type == "object" and
  (.Browser | type == "string" and length > 0) and
  (.webSocketDebuggerUrl | type == "string" and startswith("ws://"))
' <<<"$response" >/dev/null
printf '%s\n' "$response" | jq .
echo "Immutable runner and lazy Chromium smoke test passed for $IMAGE_REF"
