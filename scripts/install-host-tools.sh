#!/usr/bin/env bash
# install-host-tools.sh — Install external tools required by host-mode agents.
#
# This script brings the host environment closer to what the Docker container
# provides (feishu-cli, agent-browser, uv).  It is safe to re-run — it skips
# tools that are already installed and updates the builtin-skills cache.
#
# Usage:
#   ./scripts/install-host-tools.sh          # install everything
#   ./scripts/install-host-tools.sh skills   # only refresh builtin-skills cache

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/data"
BUILTIN_SKILLS_DIR="$DATA_DIR/builtin-skills"
FEISHU_CLI_VERSION="v1.35.0"
FEISHU_CLI_SOURCE_SHA256="91b5575833f003527c7b60a26f08703ebfdb348098deecfa9ceed1dcf230f253"
# JimLiu/baoyu-skills is a multi-Skill monorepo; only skills/baoyu-image-gen/
# is extracted below — the repo also ships several "danger-*" Skills that must
# not become available to every Workspace by mounting the whole tree.
# Keep this pair in sync with scripts/builtin-skill-catalog.mjs's
# BUILTIN_SKILL_SOURCES; a mismatch fails
# tests/builtin-skill-bootstrap-contract.test.ts.
BAOYU_SKILLS_VERSION="v2.5.2"
BAOYU_SKILLS_SOURCE_SHA256="b7e88f4183289cc1e5e4635e3746fac3ccd5db4e0beb25e38bb84c01aad885cb"

# ── Helpers ──────────────────────────────────────────────────

info()  { echo "  [INFO]  $*"; }
ok()    { echo "  [OK]    $*"; }
skip()  { echo "  [SKIP]  $*"; }
warn()  { echo "  [WARN]  $*" >&2; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }
verify_sha256() {
  local expected="$1"
  local file="$2"
  if has_cmd sha256sum; then
    echo "$expected  $file" | sha256sum -c -
  else
    echo "$expected  $file" | shasum -a 256 -c -
  fi
}

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH_GO="amd64" ;;
  aarch64|arm64) ARCH_GO="arm64" ;;
  *) warn "Unsupported architecture: $ARCH"; exit 1 ;;
esac
case "$OS" in
  Darwin) OS_GO="Darwin" ;;
  Linux)  OS_GO="linux" ;;
  *) warn "Unsupported OS: $OS"; exit 1 ;;
esac

# ── feishu-cli ───────────────────────────────────────────────

install_feishu_cli() {
  CURRENT_VERSION="$(feishu-cli --version 2>/dev/null || true)"
  if has_cmd feishu-cli && [[ "$CURRENT_VERSION" == *"$FEISHU_CLI_VERSION"* || "$CURRENT_VERSION" == *"${FEISHU_CLI_VERSION#v}"* ]]; then
    skip "feishu-cli already installed ($CURRENT_VERSION)"
  else
    info "Installing feishu-cli $FEISHU_CLI_VERSION..."
    VERSION="$FEISHU_CLI_VERSION"
    curl -fsSL "https://github.com/riba2534/feishu-cli/releases/download/${VERSION}/feishu-cli_${VERSION}_${OS_GO}-${ARCH_GO}.tar.gz" \
      | tar -xz --strip-components=1 -C /usr/local/bin 2>/dev/null \
      || tar -xzf <(curl -fsSL "https://github.com/riba2534/feishu-cli/releases/download/${VERSION}/feishu-cli_${VERSION}_${OS_GO}-${ARCH_GO}.tar.gz") -C /usr/local/bin
    ok "feishu-cli $VERSION installed"
  fi
}

# ── feishu-cli builtin skills cache ──────────────────────────

refresh_builtin_skills() {
  info "Refreshing builtin-skills cache in $BUILTIN_SKILLS_DIR ..."
  VERSION="$FEISHU_CLI_VERSION"

  TMP=$(mktemp -d)
  mkdir -p "$DATA_DIR"
  STAGING=$(mktemp -d "$DATA_DIR/.builtin-skills-staging.XXXXXX")
  PREVIOUS="$DATA_DIR/.builtin-skills-previous.$$"
  trap 'rm -rf "$TMP" "$STAGING" "$PREVIOUS"' RETURN
  curl -fsSL \
    -o "$TMP/feishu-cli-source.tar.gz" \
    "https://github.com/riba2534/feishu-cli/archive/refs/tags/${VERSION}.tar.gz"
  verify_sha256 "$FEISHU_CLI_SOURCE_SHA256" "$TMP/feishu-cli-source.tar.gz"
  tar -xzf "$TMP/feishu-cli-source.tar.gz" -C "$TMP"

  cp -r "$TMP"/*/skills/. "$STAGING"/

  # baoyu-skills is a multi-Skill monorepo (article illustration, WeChat/X
  # posting, a couple of Skills literally named "danger-*", ...). Only
  # skills/baoyu-image-gen/ is pulled in — everything else in that repo stays
  # out of every Workspace's reach.
  info "Fetching baoyu-image-gen $BAOYU_SKILLS_VERSION..."
  curl -fsSL \
    -o "$TMP/baoyu-skills-source.tar.gz" \
    "https://github.com/JimLiu/baoyu-skills/archive/refs/tags/${BAOYU_SKILLS_VERSION}.tar.gz"
  verify_sha256 "$BAOYU_SKILLS_SOURCE_SHA256" "$TMP/baoyu-skills-source.tar.gz"
  BAOYU_EXTRACT="$TMP/baoyu-skills"
  mkdir -p "$BAOYU_EXTRACT"
  tar -xzf "$TMP/baoyu-skills-source.tar.gz" -C "$BAOYU_EXTRACT"
  cp -r "$BAOYU_EXTRACT"/*/skills/baoyu-image-gen "$STAGING"/baoyu-image-gen

  node "$PROJECT_ROOT/scripts/builtin-skill-catalog.mjs" write "$STAGING"

  # Build completely in a same-filesystem staging directory, then swap. If
  # publication fails, restore the previous valid catalog.
  if [ -e "$BUILTIN_SKILLS_DIR" ]; then
    mv "$BUILTIN_SKILLS_DIR" "$PREVIOUS"
  fi
  if ! mv "$STAGING" "$BUILTIN_SKILLS_DIR"; then
    if [ -e "$PREVIOUS" ]; then mv "$PREVIOUS" "$BUILTIN_SKILLS_DIR"; fi
    return 1
  fi
  rm -rf "$PREVIOUS"
  ok "Cached $(find "$BUILTIN_SKILLS_DIR" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ') builtin skills (feishu-cli $VERSION)"
}

# ── agent-browser ────────────────────────────────────────────

install_agent_browser() {
  if has_cmd agent-browser; then
    skip "agent-browser already installed"
  else
    info "Installing agent-browser..."
    npm install -g agent-browser
    ok "agent-browser installed"
  fi
}

# ── uv ───────────────────────────────────────────────────────

install_uv() {
  if has_cmd uv; then
    skip "uv already installed ($(uv --version 2>/dev/null || echo 'unknown'))"
  else
    info "Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    ok "uv installed"
  fi
}

# ── Main ─────────────────────────────────────────────────────

echo "=== HappyClaw Host Tools Installer ==="
echo "    OS=$OS  ARCH=$ARCH"
echo ""

if [ "${1:-}" = "skills" ]; then
  refresh_builtin_skills
  exit 0
fi

install_feishu_cli
refresh_builtin_skills
install_agent_browser
install_uv

echo ""
echo "=== Done ==="
echo "Restart HappyClaw to pick up the new tools."
