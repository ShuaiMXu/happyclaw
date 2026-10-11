# Built-in Codex protocol compatibility

The reference is CLIProxyAPI commit
`a2976eb8a303f11b4ea5177bce9f9ff752634dfc`. The HappyClaw starting commit was
`930b7874e4d597e5f81cdb179a8a47ce168e2f02`. The implementation remains
TypeScript inside the HappyClaw host service; it uses Claude Agent SDK for the
agent loop and adds no Go runtime or external gateway process.

The port and derived compatibility fixtures retain the original
[CLIProxyAPI MIT notice](licenses/CLIProxyAPI-MIT.txt).

## Request mapping

| Input                          | Previous behavior                                 | Aligned behavior                                                                                         | Reference                                                               |
| ------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| System and reminders           | Combined all system text into global instructions | Developer input for top-level system; timed user reminders after matching tool feedback                  | `codex_claude_request.go`, `common/claude_system.go`                    |
| Long MCP tool names            | Sent unchanged                                    | Unique names at most 64 bytes, restored using the original request's tool map                            | `buildShortNameMap`, `buildReverseMapFromClaudeOriginalShortToOriginal` |
| Long call IDs                  | Sent unchanged                                    | Stable SHA-256 suffix shared by calls and results                                                        | `shortenCodexCallIDIfNeeded`                                            |
| Tool schemas                   | Sent unchanged                                    | Official keyword subset after sanitize/prune; schemas over 5,000 bytes compacted (see below)             | openai/codex `tools/src/json_schema*`                                   |
| Parallel tool opt-out          | Dropped                                           | `disable_parallel_tool_use` maps to `parallel_tool_calls` (always `false` for Responses Lite)            | `ConvertClaudeRequestToCodex`, openai/codex `core/src/client.rs`        |
| Images interspersed with text  | Text combined before images                       | Preserve block ordering                                                                                  | `ConvertClaudeRequestToCodex`                                           |
| Image in tool feedback         | Moved into an adjacent user message               | Structured output remains attached to the call ID                                                        | `ConvertClaudeRequestToCodex`                                           |
| PDF document                   | Rejected                                          | Base64 PDF maps to `input_file` while `CODEX_SEND_PDF_AS_INPUT_FILE`; otherwise a visible placeholder    | `ConvertClaudeRequestToCodex`                                           |
| Thinking and structured output | Dropped SDK settings                              | Budget/adaptive effort and JSON-schema output mapped to Responses; optional schemas downgrade strictness | `ConvertClaudeRequestToCodex`, `thinking/convert.go`                    |
| Native web search              | Unsupported                                       | Official hosted `web_search` (live access, allowed domains, location); server tool history accepted      | openai/codex `core/src/tools/hosted_spec.rs`                            |
| Reasoning replay               | Only private HappyClaw envelopes recognized       | Native GPT transport signatures and legacy envelopes accepted; replay omits the upstream reasoning ID    | `signature/gpt_validation.go`, `CompatibleSignatureForProvider`         |

## Official Codex client request shape

The request body follows the official openai/codex client (CLI 0.162.1,
`codex-rs/core/src/client.rs` `build_responses_request`); where it and the
reference translator differ, the official client wins.

- **Body**: keys in `ResponsesApiRequest` order (`model`, `stream`,
  `service_tier`, `input`, `tools`, `tool_choice`, `parallel_tool_calls`,
  `reasoning`, `store`, `include`, `prompt_cache_key`, `text`) via
  `serializeCodexResponsesRequest`. No top-level `instructions`: the system
  prompt is a developer input item. `tool_choice` is always sent (`auto`
  unless the caller forces a choice). `include` is only
  `reasoning.encrypted_content`, plus `web_search_call.action.sources` when
  the request carries hosted web search (Claude Code builds WebSearch result
  links from the sources).
- **Responses Lite** (catalog `use_responses_lite`, every current gpt-6 and
  gpt-5.6 model): no top-level `tools`; an input-prefix
  `{ type: "additional_tools", id: "at_<uuid>", role: "developer", tools }`
  item whose tools are one `functions` namespace
  (`create_tools_json_for_responses_lite`). The id is the uuid-v5 of the
  compact tool JSON inside a uuid-v5(OID, thread) namespace; the thread is the
  caller-supplied session identity, else a hash of the system prompt.
  `parallel_tool_calls: false`, `reasoning.context: "all_turns"`, image
  `detail` stripped, replayed calls carry `namespace: "functions"`, and a
  forced single tool becomes `required`. `codexRequestUsesResponsesLite`
  decides the shape per request; the Lite HTTP header must follow it.
- **Hosted tools and Lite**: official Lite sends no hosted tools and replaces
  web search with a client-executed `web.run` tool backed by
  `/backend-api/codex/alpha/search`. That executor does not exist here, so a
  request carrying Claude's server web search stays in the classic shape
  (`{ type: "web_search", external_web_access: true, filters?,
user_location? }`). `blocked_domains` and `max_uses` have no official field
  and are dropped.
- **Classic shape** (`gpt-5.5` and unknown models): top-level function tools
  `{ type, name, description, strict: false, parameters }`, image
  `detail: "high"` (official `DEFAULT_IMAGE_DETAIL`).
- **Model traits** come from the catalog: `text.verbosity` is the model's
  `default_verbosity` when it supports verbosity (merged with
  `output_config.format` as `text.format`); `service_tier: "priority"` is sent
  only when the request asks for fast/priority and the model lists that tier.
  `reasoning.summary: "auto"` is sent unless thinking is explicitly disabled
  (product choice; official clients default to no summary).
- **Tool schemas**: `parse_tool_input_schema` semantics — missing root
  `properties` inserted, boolean schemas become strings, `const` becomes a
  one-value `enum`, missing types inferred, object/array children defaulted,
  unreachable root definitions pruned. Only `$ref`, `type`, `description`,
  `encrypted`, `enum`, `items`, `minItems`, `properties`, `required`,
  `additionalProperties`, `anyOf`, `oneOf`, `allOf`, `$defs` and
  `definitions` are kept, in that order with sorted maps. Schemas whose
  normalized JSON exceeds 5,000 bytes go through the official compaction
  passes (descriptions, definitions, objects below depth 3, compositions)
  until they fit. Invalid keyword values are dropped rather than failing the
  request.
- **Assistant content** only carries `output_text`: assistant-side images and
  documents become text placeholders.
- **Tool search** (`ENABLE_TOOL_SEARCH`): `tool_search_tool_*` server tools
  are dropped, `defer_loading` tools are declared upfront, `tool_reference`
  blocks become `[Tool available: <name>]` text and server tool-search history
  is skipped.
- **Model catalog**: entries carry `use_responses_lite`, verbosity,
  `context_window`, `minimal_client_version`, `available_in_plans` and service
  tiers. Models requiring a newer client than 0.162.1 are dropped. Each
  provider also has a live catalog from
  `GET /backend-api/codex/models?client_version=0.162.1` (official headers,
  1 h cache, refreshed when `x-models-etag` changes; never awaited by
  requests). Official clients send no `If-None-Match` there, so neither does
  the gateway.
- **Background requests**: Codex gateway providers default
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` to `claude-haiku-5-5`, so Claude Code's
  haiku-tier calls stay recognizable and run at low effort.

## Response and transport mapping

| Output or condition                      | Previous behavior                                        | Aligned behavior                                                             | Reference                                                                       |
| ---------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Tool argument deltas                     | Ignored until item done; initial arguments could be lost | Buffer by item/call/output identity; emit each argument byte once            | `codexFunctionCallStream`, `appendCodexFunctionCallQueue`                       |
| Parallel calls                           | Multiple blocks could remain open                        | Serial Anthropic blocks with deferred content                                | `codex_claude_parallel_function_calls_test.go`                                  |
| Multiple text parts                      | Shared one text block                                    | Track item/content identity with correct block boundaries                    | `ConvertCodexResponseToClaude`                                                  |
| Multipart thinking                       | Parts ran together; early signatures could be used       | One block per reasoning item, blank-line separators and the final signature  | `finalizeCodexThinkingBlock`                                                    |
| Final-only response output               | Missing content or tool call                             | Hydrate missing final content without duplicating streamed bytes             | `appendCodexFunctionCallsFromTerminal`, `ConvertCodexResponseToClaudeNonStream` |
| Stop and usage fields                    | Basic end/limit/tool reasons; cache reads only           | Preserve refusal/sequence/context reasons, cache writes and reasoning detail | `codexStopReason`, `extractResponsesUsage`, `setClaudeReasoningUsage`           |
| Successful terminal with open connection | Waited for HTTP EOF and could time out                   | Finish at the Responses terminal and cancel the reader                       | `codex_executor_execute.go`, `codex_executor_stream.go`                         |
| SSE fragments and malformed data         | Incomplete framing; malformed JSON was skipped           | Handle UTF-8 fragments, CR/LF and multiline data; fail malformed frames      | Codex executors and compatibility tests                                         |
| HTTP failures                            | Generic `api_error`                                      | Status-specific Anthropic errors and valid retry hints                       | Executor/Anthropic compatibility boundary                                       |
| Late reasoning signature                 | Could close thinking before the final cipher arrived     | Final cipher takes priority; added cipher is a fallback only at terminal     | `finalizeCodexThinkingBlock`                                                    |
| Empty aborted or cancelled response      | Could return empty successful output                     | Reject reference-defined empty aborts and explicit unsuccessful terminals    | `helps/IsCodexTerminalEmptyIncomplete`, Codex executor terminal handling        |
| SDK session identity                     | No stable cache hint                                     | Model/session/agent cache identity with provider/account isolation           | `helps/claude_code_session.go`, `cacheHelper`                                   |

## Intentional runtime differences

- HappyClaw requests `reasoning.summary: auto` for its thinking UI unless
  thinking is disabled.
- Empty tools are removed; `tool_choice` and `parallel_tool_calls` are always
  sent, as the official client does.
- HappyClaw resolves the final reasoning effort itself (disabled thinking →
  lowest supported level, haiku-tier → low, explicit Agent effort, then the
  provider's `CODEX_REASONING_EFFORT` or catalog default) and clamps it to the
  current model catalog; a removed `minimal` level is normalized to `low`.
- URL images become a visible `[Image omitted: …]` placeholder. The pinned
  reference translator drops them silently; rejecting them would fail every
  later turn of a session that contains one.
- Streams buffer their first frames until content starts, so a failure before
  any content returns a real HTTP status (as CLIProxyAPI's optional bootstrap
  buffering does), and `count_tokens` is answered with a local estimate.
- Gateway authentication, bounded rate/body/event/aggregation budgets,
  backpressure, cancellation and idle deadlines remain in force. CLIProxyAPI's
  account pools, WebSocket continuation, distributed replay cache and management
  service are separate capabilities, outside this Messages-to-Responses port.
- Native reasoning replay travels in the SDK conversation. The actual SDK
  regression checks that the next request carries the original encrypted
  content. No shared server history cache is created.
- Streaming and nonstream thinking use the same blank-line summary separators;
  the reference's separate nonstream converter concatenates those parts.
- Malformed final tool JSON and conflicting already streamed snapshots fail
  explicitly, instead of becoming an empty tool invocation or partial success.

## Verification

`tests/fixtures/codex-cliproxy-a2976.json` contains independently generated
request payloads and original Go SSE output for 34 cases. The differential test
compares all business fields after only the documented runtime normalizations;
request cases run on the classic shape and normalize the official-client
differences listed above (schema subset, image detail, verbosity, always-sent
tool controls, no `instructions`).
Golden data is generated with `scripts/reference/codex-claude-reference.go`
inside a disposable checkout of the pinned CLIProxyAPI commit. Feed the existing
corpus to the harness's standard input to regenerate it; the Go implementation
is never loaded by the HappyClaw application.

Additional tests cover interleaved tools, final-only snapshots, signatures,
schema literals, transport cancellation/failures and session isolation.
`tests/e2e/codex-gateway-sdk.mjs` runs the installed SDK and CLI against a real
local HTTP gateway and a controlled Responses SSE server. It executes Bash and
a long-name SDK MCP tool, writes actual files, replays encrypted reasoning and
checks cache-exclusive usage on the second turn. Its network boundary rejects
any request to the real subscription backend.
The second turn also exercises native search result blocks through the actual SDK.

Local/CI and Mac mini results are reported separately in the deployment evidence.
A controlled upstream is evidence of SDK/protocol compatibility; live ChatGPT
subscription access still requires a valid provider OAuth login.
