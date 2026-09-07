#!/bin/sh
set -eu

profile="${1:?image profile is required}"
if command -v headroom >/dev/null 2>&1; then
  headroom_version="$(python3 -c "from importlib.metadata import version; print(version('headroom-ai'))")"
else
  headroom_version='not-installed'
fi

{
  printf 'tool_refresh=%s\n' "$(cat /etc/happyclaw-tool-refresh)"
  printf 'image-profile=%s\n' "$profile"
  printf 'node=%s\n' "$(node --version)"
  printf 'npm=%s\n' "$(npm --version)"
  printf 'uv=%s\n' "$(uv --version | awk '{print $2}')"
  node -e "const fs=require('node:fs'); for (const p of ['@anthropic-ai/claude-agent-sdk','@anthropic-ai/claude-code','agent-browser']) { const j=JSON.parse(fs.readFileSync('/app/node_modules/'+p+'/package.json','utf8')); console.log(p+'='+j.version); }"
  printf 'feishu-cli=%s\n' "$(cat /usr/local/share/feishu-cli-version)"
  printf 'headroom=%s\n' "$headroom_version"
  printf 'chromium=%s\n' "$(chromium --version | awk '{print $2}')"
  printf 'agent-browser-binary=%s\n' "$(cat /usr/local/share/happyclaw-agent-browser-binary)"
  printf 'agent-runner-sha256=%s\n' "$(sha256sum /opt/happyclaw-agent/dist/index.js | awk '{print $1}')"
  printf 'oh-my-zsh=%s\n' "$(cat /usr/local/share/oh-my-zsh-version)"
} > /usr/local/share/happyclaw-tool-versions.txt
cat /usr/local/share/happyclaw-tool-versions.txt
