// Ported from CLIProxyAPI a2976eb8; see docs/licenses/CLIProxyAPI-MIT.txt.
import { z } from 'zod';

const text = z
  .object({ type: z.literal('text'), text: z.string() })
  .passthrough();
// A base64 source must carry its bytes; every other source shape (URL, Files
// API, inline text, unsupported media types) is accepted so the converter can
// degrade it to a visible placeholder. Rejecting it would 400 every later
// turn of a session that once contained such a block.
const mediaSource = z
  .object({
    type: z.string().min(1),
    media_type: z.string().optional(),
    data: z.string().optional(),
  })
  .passthrough()
  .superRefine((source, context) => {
    if (source.type !== 'base64') return;
    for (const field of ['media_type', 'data'] as const) {
      if (!source[field])
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `base64 sources require ${field}`,
        });
    }
  });
const image = z
  .object({ type: z.literal('image'), source: mediaSource })
  .passthrough();
const document = z
  .object({ type: z.literal('document'), source: mediaSource })
  .passthrough();
const toolUseShape = {
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
};
const searchResult = z
  .object({
    type: z.literal('web_search_result'),
    title: z.string(),
    url: z.string(),
    page_age: z.string().nullable().optional(),
  })
  .passthrough();
/** Content types the converter translates; anything else is degraded. */
const KNOWN_BLOCK_TYPES = new Set([
  'text',
  'image',
  'document',
  'tool_use',
  'tool_result',
  'thinking',
  'redacted_thinking',
  'server_tool_use',
  'web_search_tool_result',
]);
/**
 * Newer or server-side block types (search results, MCP connector blocks,
 * code execution results …) from session history. Known types never fall
 * through to this shape, so their own validation stays strict.
 */
const unsupportedBlock = z
  .object({
    type: z
      .string()
      .min(1)
      // Aborting, so a malformed known block reports its own issue instead.
      .refine((type) => !KNOWN_BLOCK_TYPES.has(type), { abort: true }),
  })
  .passthrough();
const toolResultItem = z.union([
  z.discriminatedUnion('type', [text, image, document]),
  unsupportedBlock,
]);
const knownBlock = z.discriminatedUnion('type', [
  text,
  image,
  document,
  z.object({ type: z.literal('tool_use'), ...toolUseShape }).passthrough(),
  z
    .object({
      type: z.literal('tool_result'),
      tool_use_id: z.string().min(1),
      content: z.union([z.string(), z.array(toolResultItem)]).optional(),
      is_error: z.boolean().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('thinking'),
      thinking: z.string(),
      signature: z.string().optional(),
    })
    .passthrough(),
  z
    .object({ type: z.literal('redacted_thinking'), data: z.string() })
    .passthrough(),
  // Native search is already executed by the upstream server. Accept its
  // response history without replaying it as a client-side function call.
  z
    .object({ type: z.literal('server_tool_use'), ...toolUseShape })
    .passthrough(),
  z
    .object({
      type: z.literal('web_search_tool_result'),
      tool_use_id: z.string().min(1),
      content: z.union([
        z.array(searchResult),
        z
          .object({
            type: z.literal('web_search_tool_result_error'),
            error_code: z.string(),
          })
          .passthrough(),
      ]),
    })
    .passthrough(),
]);
const block = z.union([knownBlock, unsupportedBlock]);
const parallelChoice = { disable_parallel_tool_use: z.boolean().optional() };
const toolChoice = z.union([
  z
    .object({ type: z.literal('auto').optional(), ...parallelChoice })
    .passthrough(),
  z.object({ type: z.literal('any'), ...parallelChoice }).passthrough(),
  z.object({ type: z.literal('none'), ...parallelChoice }).passthrough(),
  z
    .object({
      type: z.literal('tool'),
      name: z.string().min(1),
      ...parallelChoice,
    })
    .passthrough(),
]);
const functionTool = z
  .object({
    type: z.enum(['function', 'custom']).optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const webSearchTool = z
  .object({
    type: z.enum(['web_search_20250305', 'web_search_20260209']),
    name: z.string().min(1).optional(),
    allowed_domains: z.array(z.string().min(1)).optional(),
    user_location: z
      .object({
        type: z.literal('approximate'),
        city: z.string().optional(),
        region: z.string().optional(),
        country: z.string().optional(),
        timezone: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
// Claude Code's tool search (ENABLE_TOOL_SEARCH) declares an Anthropic server
// tool and marks other tools `defer_loading`. The converter declares every
// tool upfront and drops the search tool, so only its identity is checked.
const toolSearchTool = z
  .object({
    type: z.string().regex(/^tool_search_tool_/),
    name: z.string().min(1).optional(),
  })
  .passthrough();

// Validate every consumed shape; unrelated SDK options remain passthrough and
// are deliberately omitted from the Codex payload.
export const CodexMessagesRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    system: z.union([z.string(), z.array(text)]).optional(),
    messages: z
      .array(
        z.discriminatedUnion('role', [
          z
            .object({
              role: z.enum(['user', 'assistant']),
              content: z.union([z.string(), z.array(block)]),
            })
            .passthrough(),
          z
            .object({
              role: z.literal('system'),
              content: z.union([z.string(), z.array(text)]),
            })
            .passthrough(),
        ]),
      )
      .min(1),
    tools: z
      .array(z.union([webSearchTool, toolSearchTool, functionTool]))
      .optional(),
    tool_choice: toolChoice.optional(),
    thinking: z
      .discriminatedUnion('type', [
        z
          .object({
            type: z.literal('enabled'),
            budget_tokens: z.number().int().min(-1).optional(),
          })
          .passthrough(),
        z.object({ type: z.literal('adaptive') }).passthrough(),
        z.object({ type: z.literal('auto') }).passthrough(),
        z.object({ type: z.literal('disabled') }).passthrough(),
      ])
      .optional(),
    output_config: z
      .object({
        effort: z.string().min(1).optional(),
        format: z
          .object({
            type: z.literal('json_schema'),
            schema: z.record(z.string(), z.unknown()),
            name: z.string().min(1).optional(),
            strict: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    service_tier: z.string().optional(),
    speed: z.string().optional(),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
  })
  .passthrough()
  .superRefine((request, context) => {
    const names = new Set<string>();
    for (const [index, tool] of (request.tools ?? []).entries()) {
      if (!tool.name) continue;
      if (names.has(tool.name))
        context.addIssue({
          code: 'custom',
          path: ['tools', index, 'name'],
          message: 'Tool names must be unique within a request',
        });
      names.add(tool.name);
    }
    if (
      request.tool_choice?.type === 'tool' &&
      !names.has(request.tool_choice.name)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['tool_choice', 'name'],
        message: 'The selected tool must be declared in tools',
      });
    }
  });

/**
 * Name the offending field path of a validation failure without echoing any
 * request value. A union failure reports its deepest branch issue: the branch
 * that got furthest is the shape the caller was attempting.
 */
export function describeCodexRequestIssue(error: z.ZodError): string {
  const deepest = (
    issue: z.core.$ZodIssue,
  ): { path: PropertyKey[]; code: string } => {
    let best: { path: PropertyKey[]; code: string } | null = null;
    if (issue.code === 'invalid_union') {
      for (const branch of issue.errors) {
        for (const nested of branch) {
          const candidate = deepest(nested);
          if (!best || candidate.path.length > best.path.length)
            best = candidate;
        }
      }
    }
    return best
      ? { path: [...issue.path, ...best.path], code: best.code }
      : { path: issue.path, code: issue.code };
  };
  const first = error.issues[0];
  const { path, code } = first ? deepest(first) : { path: [], code: 'invalid' };
  const location = path.length
    ? path.map((segment) => String(segment)).join('.')
    : '(root)';
  return `Invalid messages request at ${location} (${code})`;
}
