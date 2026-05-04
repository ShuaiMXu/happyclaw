#!/usr/bin/env bash
# Verify that all prompt files referenced from agent-runner source code actually exist.
#
# Background: agent-runner loads `.md` prompt files via `path.join(..., 'prompts', '<name>.md')`,
# read at module-load time with readFileSync. If src references a file that no longer
# exists in container/agent-runner/prompts/, the container crashes at startup with
# `ENOENT '/tmp/prompts/<name>.md'` — but only when the container actually runs.
# This check moves the failure earlier, into typecheck.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT/container/agent-runner/src"
PROMPTS_DIR="$ROOT/container/agent-runner/prompts"

if [ ! -d "$SRC_DIR" ]; then
  echo "ERROR: agent-runner src dir not found: $SRC_DIR"
  exit 1
fi

if [ ! -d "$PROMPTS_DIR" ]; then
  echo "ERROR: agent-runner prompts dir not found: $PROMPTS_DIR"
  exit 1
fi

python3 - "$SRC_DIR" "$PROMPTS_DIR" <<'PY'
import os, re, sys, glob

src_dir, prompts_dir = sys.argv[1], sys.argv[2]

# Match the .md filename that appears within ~200 chars after a 'prompts' string literal.
# Covers both:
#   path.join(..., 'prompts', 'foo.md')  — multiline path.join args
#   'prompts/foo.md', "prompts/foo.md"   — direct concatenation
PATTERN = re.compile(
    r"""(?:['"]prompts['"][\s,]{1,200}?['"]([a-z0-9_-]+\.md)['"])"""
    r"""|(?:['"]prompts/([a-z0-9_-]+\.md)['"])""",
    re.DOTALL,
)

referenced = set()
for path in glob.glob(os.path.join(src_dir, "**/*.ts"), recursive=True):
    with open(path, encoding="utf-8") as f:
        content = f.read()
    for m in PATTERN.finditer(content):
        name = m.group(1) or m.group(2)
        if name:
            referenced.add(name)

if not referenced:
    print("✓ No prompt-file references found in agent-runner src (prompts may be inlined).")
    sys.exit(0)

missing = sorted(f for f in referenced if not os.path.isfile(os.path.join(prompts_dir, f)))

if missing:
    print(f"✗ Agent-runner src references prompt files that DO NOT exist in {prompts_dir}:")
    for f in missing:
        print(f"   - {f}")
    print()
    print("Container will fail to start with 'ENOENT /tmp/prompts/<name>.md' when it runs.")
    print("Either restore the missing files, or remove the references from src/.")
    sys.exit(1)

print(f"✓ All {len(referenced)} referenced prompt file(s) exist in {prompts_dir}")
for f in sorted(referenced):
    print(f"   - {f}")
PY
