# HappyClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with full toolchain.

# Resolve and compile the Agent runtime outside the final image. Production
# containers execute this immutable output directly; the final image retains
# TypeScript only so an explicitly requested development hot mount can still be
# compiled by entrypoint.sh.
FROM node:24-slim AS agent-build

ARG TOOL_REFRESH=manual
ARG TARGETARCH

WORKDIR /build/agent-runner
COPY agent-runner/package.json agent-runner/package-lock.json ./

RUN set -eu; \
    printf '%s\n' "$TOOL_REFRESH" > /build/happyclaw-tool-refresh; \
    npm ci; \
    npm cache clean --force; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) AGENT_BROWSER_ARCH=x64 ;; \
      arm64) AGENT_BROWSER_ARCH=arm64 ;; \
      *) echo "Unsupported Agent runtime architecture: ${TARGETARCH:-unknown}" >&2; exit 1 ;; \
    esac; \
    AGENT_BROWSER_BINARY="agent-browser-linux-${AGENT_BROWSER_ARCH}"; \
    test -x "node_modules/agent-browser/bin/${AGENT_BROWSER_BINARY}"; \
    find node_modules/agent-browser/bin -maxdepth 1 -type f \
      -name 'agent-browser-*' ! -name "$AGENT_BROWSER_BINARY" -delete; \
    find node_modules/@anthropic-ai -mindepth 1 -maxdepth 1 -type d \
      \( -name 'claude-agent-sdk-*' -o -name 'claude-code-*' \) \
      -exec rm -rf {} +; \
    test "$(find node_modules/agent-browser/bin -maxdepth 1 -type f \
      -name 'agent-browser-*' | wc -l)" -eq 1; \
    node --input-type=module -e \
      "const sdk=await import('@anthropic-ai/claude-agent-sdk'); if(typeof sdk.query!=='function') process.exit(1)"; \
    node_modules/.bin/claude --version; \
    node_modules/.bin/agent-browser --version; \
    printf '%s\n' "$AGENT_BROWSER_BINARY" \
      > /build/happyclaw-agent-browser-binary

COPY agent-runner/ ./
RUN npm run build \
    && chown -R root:root dist prompts \
    && find dist prompts -type d -exec chmod 0555 {} + \
    && find dist prompts -type f -exec chmod 0444 {} +

FROM node:24-slim AS runtime-base

# The publish workflow sets this to the main-branch commit SHA. Writing it into
# the first layer intentionally invalidates all downstream "latest" tool
# installs on every main push, while still allowing exact-version overrides for
# local or incident-response builds.
ARG TOOL_REFRESH=manual
ARG TARGETARCH

# Install system packages (organized by category)
# Debian packages intentionally follow the current signed stable repositories,
# so a refreshed build receives the newest security and bug-fix packages.
RUN printf '%s\n' "$TOOL_REFRESH" > /etc/happyclaw-tool-refresh \
    && apt-get update && apt-get install -y --no-install-recommends \
    # --- Browser & fonts ---
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    # --- Chromium shared library deps ---
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    # --- Build tools & compilers ---
    build-essential \
    cmake \
    pkg-config \
    # --- Python ecosystem ---
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    # --- Core CLI tools ---
    curl \
    wget \
    git \
    zsh \
    jq \
    tree \
    file \
    less \
    bc \
    patch \
    rsync \
    # --- Compression ---
    zip \
    unzip \
    xz-utils \
    bzip2 \
    # --- Network ---
    openssh-client \
    dnsutils \
    iputils-ping \
    # --- Process & system ---
    procps \
    lsof \
    # --- Text search & dev ---
    ripgrep \
    fd-find \
    shellcheck \
    # --- Multimedia ---
    ffmpeg \
    imagemagick \
    ghostscript \
    graphviz \
    # --- Document & PDF ---
    poppler-utils \
    pandoc \
    # --- Database clients ---
    sqlite3 \
    default-mysql-client \
    postgresql-client \
    redis-tools \
    # --- Locale ---
    locales \
    && rm -rf /var/lib/apt/lists/* \
    # Set up UTF-8 locale
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen \
    # Symlink fd-find → fd (Debian names it fdfind)
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd

# Keep the multi-arch uv toolchain pinned; updates move through reviewed source.
COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /usr/local/bin/uv
COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uvx /usr/local/bin/uvx

# Locale environment
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Set Chromium path for agent-browser. A root-owned wrapper starts the managed
# headless Chromium instance on this container-local CDP port only when the
# agent first invokes agent-browser.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV HAPPYCLAW_CHROMIUM_CDP_HOST=127.0.0.1
ENV HAPPYCLAW_CHROMIUM_CDP_PORT=9222
ENV AGENT_BROWSER_CDP=9222
ENV HAPPYCLAW_AGENT_RUNNER_MODE=image
ENV HAPPYCLAW_REQUIRE_BUNDLED_CLAUDE=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Allow pip install without venv (Debian 12+ PEP 668) and add user bin to PATH
ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV PATH="/home/node/.local/bin:${PATH}"

# Runtime dependencies stay under /app so the development hot-compile path
# and CLI PATH remain backwards compatible. Immutable production code and
# prompts live under /opt, outside the host's /app/src and /app/prompts mounts.
WORKDIR /app
COPY --from=agent-build /build/agent-runner/node_modules ./node_modules
COPY --from=agent-build /build/agent-runner/package.json /build/agent-runner/package-lock.json /build/agent-runner/tsconfig.json ./
COPY --from=agent-build /build/happyclaw-agent-browser-binary /usr/local/share/happyclaw-agent-browser-binary
COPY --from=agent-build /build/agent-runner/dist /opt/happyclaw-agent/dist
COPY --from=agent-build /build/agent-runner/prompts /opt/happyclaw-agent/prompts
COPY image-sdk-query-smoke.mjs /opt/happyclaw-agent/smoke/image-sdk-query-smoke.mjs
RUN ln -s /app/node_modules /opt/happyclaw-agent/node_modules \
    && test -f /opt/happyclaw-agent/dist/index.js \
    && test -f /opt/happyclaw-agent/prompts/security-rules.md \
    && chown -R root:root /opt/happyclaw-agent/smoke \
    && chmod 0555 /opt/happyclaw-agent/smoke \
    && chmod 0444 /opt/happyclaw-agent/smoke/image-sdk-query-smoke.mjs

# Resolve the pinned feishu-cli release and verify it against the publisher's
# checksums. FEISHU_CLI_VERSION remains an explicit upgrade/rollback input.
ARG FEISHU_CLI_VERSION=v1.38.4
RUN set -eu && \
    ARCH="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    case "$ARCH" in \
      amd64|arm64) ;; \
      *) echo "ERROR: unsupported feishu-cli architecture: $ARCH" >&2; exit 1 ;; \
    esac && \
    DOWNLOAD_TMP="$(mktemp -d)" && \
    if [ "$FEISHU_CLI_VERSION" = latest ]; then \
      RELEASE_URL='https://github.com/riba2534/feishu-cli/releases/latest/download'; \
    else \
      RELEASE_URL="https://github.com/riba2534/feishu-cli/releases/download/${FEISHU_CLI_VERSION}"; \
    fi && \
    curl -fsSL --retry 3 \
      -o "$DOWNLOAD_TMP/checksums.txt" "$RELEASE_URL/checksums.txt" && \
    if [ "$FEISHU_CLI_VERSION" = latest ]; then \
      ARCHIVE="$(awk -v arch="$ARCH" \
        '$2 ~ ("^feishu-cli_v[0-9.]+_linux-" arch "\\.tar\\.gz$") { print $2; exit }' \
        "$DOWNLOAD_TMP/checksums.txt")"; \
      test -n "$ARCHIVE"; \
      RELEASE_TAG="${ARCHIVE#feishu-cli_}"; \
      RELEASE_TAG="${RELEASE_TAG%_linux-*}"; \
    else \
      RELEASE_TAG="$FEISHU_CLI_VERSION"; \
      ARCHIVE="feishu-cli_${RELEASE_TAG}_linux-${ARCH}.tar.gz"; \
    fi && \
    echo "Installing feishu-cli $RELEASE_TAG for $ARCH" && \
    curl -fsSL --retry 3 \
      -o "$DOWNLOAD_TMP/$ARCHIVE" "$RELEASE_URL/$ARCHIVE" && \
    grep -F "  $ARCHIVE" "$DOWNLOAD_TMP/checksums.txt" \
      > "$DOWNLOAD_TMP/checksum.txt" && \
    (cd "$DOWNLOAD_TMP" && sha256sum -c checksum.txt) && \
    tar -xzf "$DOWNLOAD_TMP/$ARCHIVE" --strip-components=1 -C /usr/local/bin && \
    chown root:root /usr/local/bin/feishu-cli && \
    chmod 755 /usr/local/bin/feishu-cli && \
    feishu-cli --version && \
    printf '%s\n' "$RELEASE_TAG" > /usr/local/share/feishu-cli-version && \
    rm -rf "$DOWNLOAD_TMP"

# Create workspace directories. Long-term memory is host-managed and workspace
# scoped; legacy global/memory filesystem roots must not exist in the runtime.
RUN mkdir -p /workspace/group /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Copy entrypoint scripts (run as root, then drop to node via runuser)
COPY entrypoint.sh session-permissions.sh session-permissions-mount.mjs session-permissions-rescan-queue.mjs session-permissions-watcher.mjs session-generated-paths.mjs session-prompts-copy.mjs /app/
COPY write-tool-audit.sh /app/write-tool-audit.sh
RUN chmod +x /app/entrypoint.sh /app/write-tool-audit.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Install the reviewed oh-my-zsh commit. Updates change this source-controlled
# ref instead of making the same HappyClaw commit resolve different snapshots.
ARG OH_MY_ZSH_REF=97e11051e2f8053b1d694788d1cb4b0dbb1e2365
RUN set -eu; \
    mkdir -p /home/node/.oh-my-zsh; \
    git -C /home/node/.oh-my-zsh init; \
    git -C /home/node/.oh-my-zsh remote add origin \
      https://github.com/ohmyzsh/ohmyzsh.git; \
    git -C /home/node/.oh-my-zsh fetch --depth 1 origin "$OH_MY_ZSH_REF"; \
    git -C /home/node/.oh-my-zsh checkout --detach FETCH_HEAD; \
    git -C /home/node/.oh-my-zsh rev-parse HEAD \
      > /usr/local/share/oh-my-zsh-version; \
    rm -rf /home/node/.oh-my-zsh/.git; \
    cp /home/node/.oh-my-zsh/templates/zshrc.zsh-template /home/node/.zshrc; \
    sed -i 's/ZSH_THEME="robbyrussell"/ZSH_THEME="ys"/' /home/node/.zshrc; \
    chown -R node:node /home/node/.oh-my-zsh /home/node/.zshrc; \
    chsh -s /bin/zsh node

# Entrypoint runs as root to fix volume permissions, then drops to node user.
# Do NOT add USER node here — entrypoint handles the privilege drop.
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]

FROM runtime-base AS runtime-core
ENV HAPPYCLAW_IMAGE_PROFILE=core
RUN /app/write-tool-audit.sh core

# Headroom is a separate capability profile because its Python dependency tree
# adds roughly 0.5GB while no process runs unless an MCP definition requests it.
FROM runtime-base AS runtime-headroom
ARG HEADROOM_VERSION=0.35.0
ENV HAPPYCLAW_IMAGE_PROFILE=headroom
RUN set -eu; \
    HEADROOM_SPEC="headroom-ai[code,mcp]==${HEADROOM_VERSION}"; \
    pip install --no-cache-dir --upgrade "$HEADROOM_SPEC"; \
    python3 -c "from importlib.metadata import version; print('headroom-ai', version('headroom-ai'))"; \
    /app/write-tool-audit.sh headroom

# Local/default builds remain the lean production profile. CI explicitly
# targets and publishes both runtime-core and runtime-headroom.
FROM runtime-core AS runtime
