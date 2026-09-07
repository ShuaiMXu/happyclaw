# HappyClaw Runtime Architecture

HappyClaw is a modular monolith with one control-plane process and isolated
Agent runtimes. The process boundary is intentional: HTTP, scheduling, durable
state and channel routing share one SQLite transaction domain, while Host and
Docker Agent execution remain independently supervised.

```text
Web / Channel Adapter
        │
        ▼
Application services
        │
        ▼
SQLite durable state ──► Conversation lane / GroupQueue
                               │
                               ▼
                         Runner supervisor
                         ├─ Host Agent
                         └─ Docker Agent
                               │
                               ▼
                     Web + channel projections
```

## Module boundaries

- `src/web.ts` owns HTTP, WebSocket connections and browser projections. Route
  and channel modules receive projection callbacks through `WebDeps`; they must
  not import the Web gateway.
- `src/channel-registry.ts` owns lazy loading for optional channel providers.
  `src/channel-contracts.ts` contains provider-neutral Host callbacks and
  `src/im-channel.ts` owns adapters. Provider SDKs load only when an enabled
  account connects.
- `src/group-acl.ts` owns workspace/channel authorization. Domain services do
  not import the Web gateway to make authorization decisions.
- `src/im-manager.ts` owns connected account instances and routing to the exact
  account. Provider connectors own only provider protocol behavior.
- `src/group-queue.ts` owns per-conversation serialization and runner lifecycle.
  Durable messages, cursors, task runs and delivery state remain in SQLite.
- `src/container-runner.ts` prepares one Host or Docker launch. The production
  Docker image runs the immutable precompiled Agent artifact; source compilation
  is an explicit development mode. One launch snapshot supplies mounts, Skills,
  plugins, MCP provenance and the selected capability image.
- `container/agent-runner/` owns Claude SDK interaction. Chromium starts only
  when `agent-browser` is first invoked.
- The core Agent image excludes Headroom's optional Python dependency tree.
  A runtime with an explicit `headroom` MCP command selects the matching signed
  `-headroom` image for the same source revision.
- `web/src/components/chat/MarkdownRenderer.tsx` keeps ordinary Markdown on a
  small synchronous path and lazy-loads code, math, raw HTML and Mermaid as
  separate feature chunks.

## Dependency rules

1. Provider connectors may depend on channel/domain contracts, never on the Web
   gateway or another provider implementation.
2. Routes may call application/database services and injected projections, but
   must not create reverse imports into `src/web.ts`.
3. Optional provider SDKs must be reached through the lazy channel registry.
4. Runtime control values come from the trusted launch environment, not
   workspace-controlled environment files.
5. Production containers execute versioned build artifacts. Runtime compilation
   is reserved for explicit development hot mounts.
6. New shared Host/Runner messages should use typed contracts instead of adding
   unrelated optional fields to a generic payload.

## Performance budgets

- Importing channel contracts must not initialize provider SDKs.
- Ordinary chat navigation must not fetch the enhanced Markdown pipeline.
- A non-browser Agent turn must not start Chromium.
- Container startup must not run TypeScript compilation in production mode.
- CI must build and smoke the exact multi-architecture image before it can be
  promoted to `latest`. The smoke starts the immutable Runner and completes a
  credential-free SDK/CLI query against an in-container fake provider.

These rules are enforced by type checks, channel lazy-loading tests, Markdown
bundle tests and the Agent image smoke workflow.
