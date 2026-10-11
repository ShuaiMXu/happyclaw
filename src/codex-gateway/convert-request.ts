// Ported from CLIProxyAPI a2976eb8; see docs/licenses/CLIProxyAPI-MIT.txt.
// Anthropic Messages → Codex Responses request compatibility.
// Reference: CLIProxyAPI's Codex/Claude translator (MIT); keep tool identity,
// multimodal order, and tool-result adjacency consistent across both protocols.
// The request shape (Responses Lite, tool JSON, schema subset, body order)
// follows the official openai/codex client; see
// docs/codex-protocol-compatibility.md.

import { createHash } from 'node:crypto';

import {
  CODEX_DEFAULT_MODEL,
  clampCodexEffortWithCatalog,
  getCodexModelTraits,
  lowestCodexEffortWithCatalog,
  resolveCodexDefaultEffort,
  type CodexModelCatalogEntry,
  type CodexVerbosity,
} from './model-catalog.js';
import { decodeReasoningSignature } from './reasoning-signature.js';

type Json = Record<string, unknown>;

/**
 * PDFs go upstream as `input_file`. The official client never sends files,
 * so this single switch can fall back to a visible placeholder if the
 * backend stops accepting them.
 */
export const CODEX_SEND_PDF_AS_INPUT_FILE = true;

export interface AnthropicRequestSubset {
  model?: string;
  system?: string | Array<Json>;
  messages?: Array<Json>;
  tools?: Array<Json>;
  tool_choice?: Json;
  thinking?: Json;
  output_config?: Json;
  service_tier?: string;
  speed?: string;
}

/** Field order mirrors the official ResponsesApiRequest (codex-api common.rs). */
export interface ResponsesRequest {
  model: string;
  stream: true;
  service_tier?: 'priority';
  input: Array<Json>;
  /** Classic shape only; Responses Lite carries tools in an input item. */
  tools?: Array<Json>;
  tool_choice: Json | 'auto' | 'none' | 'required';
  parallel_tool_calls: boolean;
  reasoning: {
    effort: string;
    summary?: 'auto';
    context?: 'all_turns';
  };
  store: false;
  include: string[];
  prompt_cache_key?: string;
  text?: { verbosity?: CodexVerbosity; format?: Json };
  /**
   * Never set: official clients removed top-level instructions and send the
   * system prompt as a developer input item.
   */
  instructions?: string;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentBlocks(content: unknown): Array<Json> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function systemTextParts(content: unknown): string[] {
  return contentBlocks(content)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .filter(
      (text) =>
        text.length > 0 &&
        !text.trimStart().startsWith('x-anthropic-billing-header:'),
    );
}

function truncateUtf8(value: string, limit: number): string {
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) break;
    result += char;
    bytes += size;
  }
  return result;
}

function shortenToolName(name: string): string {
  if (Buffer.byteLength(name) <= 64) return name;
  if (name.startsWith('mcp__')) {
    const separator = name.lastIndexOf('__');
    if (separator > 0)
      return truncateUtf8(`mcp__${name.slice(separator + 2)}`, 64);
  }
  return truncateUtf8(name, 64);
}

/** The response converter must invert this same request-local mapping. */
export function buildCodexToolNameMap(
  tools?: Array<Json>,
): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const tool of tools ?? []) {
    if (typeof tool.name !== 'string' || !tool.name || names.has(tool.name))
      continue;
    const base = shortenToolName(tool.name);
    let candidate = base;
    for (let suffix = 1; used.has(candidate); suffix++) {
      const ending = `_${suffix}`;
      candidate = `${truncateUtf8(base, 64 - Buffer.byteLength(ending))}${ending}`;
    }
    names.set(tool.name, candidate);
    used.add(candidate);
  }
  return names;
}

/** Both function_call and function_call_output must share this stable identity. */
export function shortenCodexCallId(id: string): string {
  if (Buffer.byteLength(id) <= 64) return id;
  const suffix = `_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
  return `${truncateUtf8(id, 64 - suffix.length)}${suffix}`;
}

const SCHEMA_MAP_KEYS = [
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
];
const SCHEMA_VALUE_KEYS = [
  'items',
  'prefixItems',
  'contains',
  'additionalProperties',
  'propertyNames',
  'unevaluatedProperties',
  'unevaluatedItems',
  'additionalItems',
  'contentSchema',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
];

/** Visit schema positions only: property names and default/enum literals are data. */
function visitSchemas(root: Json, visitor: (schema: Json) => void): void {
  const pending: unknown[] = [root];
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    if (!isRecord(current)) continue;
    visitor(current);
    for (const key of SCHEMA_MAP_KEYS) {
      const children = current[key];
      if (isRecord(children)) {
        for (const child of Object.values(children)) pending.push(child);
      }
    }
    for (const key of SCHEMA_VALUE_KEYS) pending.push(current[key]);
  }
}

// ─── Tool input schemas (official codex-rs/tools json_schema) ─────────
//
// Tool parameters are reduced to the JSON Schema subset the official client
// serializes (json_schema/types.rs) after the same sanitize, prune and
// large-schema compaction passes (json_schema.rs, json_schema/compaction.rs).
// Invalid keyword values are dropped instead of failing the whole request.

const DEFINITION_TABLE_KEYS = ['$defs', 'definitions'] as const;
const SCHEMA_CHILD_KEYS = ['items', 'anyOf', 'oneOf', 'allOf'] as const;
const COMPOSITION_SCHEMA_KEYS = ['anyOf', 'oneOf', 'allOf'] as const;
const PRIMITIVE_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'integer',
  'object',
  'array',
  'null',
]);
const COMPACT_TOOL_SCHEMA_BYTES = 5_000;
const MAX_COMPACT_TOOL_SCHEMA_DEPTH = 3;
/**
 * Recursion guard, counting objects and arrays. Every kept level adds at
 * least 6 normalized bytes, so anything deeper is over the compaction budget
 * and official compaction collapses it below depth 3 anyway: truncating here
 * never changes the result, it only bounds the stack.
 */
const MAX_TOOL_SCHEMA_DEPTH = 1024;

const DEFAULT_TOOL_PARAMETERS = (): Json => ({
  type: 'object',
  properties: {},
});

function hasCompositionKeyword(map: Json): boolean {
  return COMPOSITION_SCHEMA_KEYS.some((key) => Object.hasOwn(map, key));
}

function clearRecord(map: Json): void {
  for (const key of Object.keys(map)) delete map[key];
}

/** Replace every schema-valued child (for_each_schema_child_mut). */
function mapSchemaChildren(
  map: Json,
  includeDefinitions: boolean,
  visit: (child: unknown) => unknown,
): void {
  if (isRecord(map.properties)) {
    const properties = map.properties;
    for (const key of Object.keys(properties))
      properties[key] = visit(properties[key]);
  }
  for (const key of SCHEMA_CHILD_KEYS) {
    if (Object.hasOwn(map, key)) map[key] = visit(map[key]);
  }
  if (
    Object.hasOwn(map, 'additionalProperties') &&
    typeof map.additionalProperties !== 'boolean'
  )
    map.additionalProperties = visit(map.additionalProperties);
  if (!includeDefinitions) return;
  for (const table of DEFINITION_TABLE_KEYS) {
    const definitions = map[table];
    if (!isRecord(definitions)) continue;
    for (const key of Object.keys(definitions))
      definitions[key] = visit(definitions[key]);
  }
}

/** Apply `visit` to a schema or to each element of a schema array. */
function eachSchema(
  value: unknown,
  visit: (schema: unknown) => unknown,
): unknown {
  if (!Array.isArray(value)) return visit(value);
  for (let index = 0; index < value.length; index++)
    value[index] = visit(value[index]);
  return value;
}

function truncateDeepSchema(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    if (depth >= MAX_TOOL_SCHEMA_DEPTH) return [];
    for (let index = 0; index < value.length; index++)
      value[index] = truncateDeepSchema(value[index], depth + 1);
    return value;
  }
  if (!isRecord(value)) return value;
  if (depth >= MAX_TOOL_SCHEMA_DEPTH) return {};
  mapSchemaChildren(value, true, (child) =>
    truncateDeepSchema(child, depth + 1),
  );
  if (Object.hasOwn(value, 'prefixItems'))
    value.prefixItems = truncateDeepSchema(value.prefixItems, depth + 1);
  return value;
}

function normalizedSchemaTypes(map: Json): string[] {
  const type = map.type;
  if (typeof type === 'string')
    return PRIMITIVE_SCHEMA_TYPES.has(type) ? [type] : [];
  if (Array.isArray(type))
    return type.filter(
      (item): item is string =>
        typeof item === 'string' && PRIMITIVE_SCHEMA_TYPES.has(item),
    );
  return [];
}

/** sanitize_json_schema: infer types, const → enum, required child defaults. */
function sanitizeJsonSchema(value: unknown): unknown {
  if (typeof value === 'boolean') return { type: 'string' };
  if (Array.isArray(value)) return eachSchema(value, sanitizeJsonSchema);
  if (!isRecord(value)) return value;
  const map = value;
  if (isRecord(map.properties)) {
    const properties = map.properties;
    for (const key of Object.keys(properties))
      properties[key] = sanitizeJsonSchema(properties[key]);
  }
  if (Object.hasOwn(map, 'items')) map.items = sanitizeJsonSchema(map.items);
  if (
    Object.hasOwn(map, 'additionalProperties') &&
    typeof map.additionalProperties !== 'boolean'
  )
    map.additionalProperties = sanitizeJsonSchema(map.additionalProperties);
  if (Object.hasOwn(map, 'prefixItems'))
    map.prefixItems = sanitizeJsonSchema(map.prefixItems);
  for (const key of COMPOSITION_SCHEMA_KEYS) {
    if (Object.hasOwn(map, key)) map[key] = sanitizeJsonSchema(map[key]);
  }
  for (const table of DEFINITION_TABLE_KEYS) {
    if (!Object.hasOwn(map, table)) continue;
    const definitions = map[table];
    if (!isRecord(definitions)) {
      delete map[table];
      continue;
    }
    for (const key of Object.keys(definitions))
      definitions[key] = sanitizeJsonSchema(definitions[key]);
  }
  if (Object.hasOwn(map, 'const')) {
    const constant = map.const;
    delete map.const;
    map.enum = [constant];
  }

  const types = normalizedSchemaTypes(map);
  if (
    !types.length &&
    (Object.hasOwn(map, '$ref') || hasCompositionKeyword(map))
  )
    return map;
  if (!types.length) {
    const has = (...keys: string[]): boolean =>
      keys.some((key) => Object.hasOwn(map, key));
    if (has('properties', 'required', 'additionalProperties'))
      types.push('object');
    else if (has('items', 'prefixItems')) types.push('array');
    else if (has('enum', 'format')) types.push('string');
    else if (
      has(
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'multipleOf',
      )
    )
      types.push('number');
    else {
      clearRecord(map);
      return map;
    }
  }
  map.type = types.length === 1 ? types[0] : types;
  if (types.includes('object') && !Object.hasOwn(map, 'properties'))
    map.properties = {};
  if (types.includes('array') && !Object.hasOwn(map, 'items'))
    map.items = { type: 'string' };
  return map;
}

/** `#/$defs/Name/...` → [table, Name] (parse_local_definition_ref). */
function localDefinitionRef(ref: unknown): [string, string] | undefined {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(ref.slice(1));
  } catch {
    return undefined;
  }
  if (!pointer.startsWith('/') || /~(?![01])/.test(pointer)) return undefined;
  const tokens = pointer
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (tokens.length < 2) return undefined;
  const table = DEFINITION_TABLE_KEYS.find((key) => key === tokens[0]);
  return table ? [table, tokens[1]] : undefined;
}

/** Drop root definitions no reference outside the tables reaches. */
function pruneUnreachableDefinitions(root: Json): void {
  const pending: Array<[string, string]> = [];
  const outside: unknown[] = [root];
  while (outside.length) {
    const value = outside.pop();
    if (Array.isArray(value)) {
      outside.push(...value);
      continue;
    }
    if (!isRecord(value)) continue;
    const ref = localDefinitionRef(value.$ref);
    if (ref) pending.push(ref);
    mapSchemaChildren(value, false, (child) => {
      outside.push(child);
      return child;
    });
  }
  const reachable = new Set<string>();
  while (pending.length) {
    const [table, name] = pending.pop()!;
    const key = `${table}\u0000${name}`;
    if (reachable.has(key)) continue;
    reachable.add(key);
    const definitions = root[table];
    if (!isRecord(definitions) || !Object.hasOwn(definitions, name)) continue;
    // Any nested value may hold a ref (collect_refs walks everything).
    const stack: unknown[] = [definitions[name]];
    while (stack.length) {
      const value = stack.pop();
      if (Array.isArray(value)) stack.push(...value);
      else if (isRecord(value)) {
        const nested = localDefinitionRef(value.$ref);
        if (nested) pending.push(nested);
        stack.push(...Object.values(value));
      }
    }
  }
  for (const table of DEFINITION_TABLE_KEYS) {
    const definitions = root[table];
    if (!isRecord(definitions)) continue;
    for (const name of Object.keys(definitions)) {
      if (!reachable.has(`${table}\u0000${name}`)) delete definitions[name];
    }
    if (!Object.keys(definitions).length) delete root[table];
  }
}

/** BTreeMap key order: byte-wise UTF-8 comparison. */
function sortedKeys(map: Json): string[] {
  return Object.keys(map).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
}

function normalizeSchemaMap(value: unknown): Json | undefined {
  if (!isRecord(value)) return undefined;
  const result: Json = {};
  for (const key of sortedKeys(value))
    result[key] = normalizeSchema(value[key]);
  return result;
}

function normalizeSchemaList(value: unknown): Json[] | undefined {
  return Array.isArray(value) ? value.map(normalizeSchema) : undefined;
}

/**
 * Serialize like the official JsonSchema struct: only its keywords, in its
 * field order, with sorted property/definition maps. (JS objects still list
 * integer-like property names first; such names do not occur in practice.)
 */
function normalizeSchema(value: unknown): Json {
  if (!isRecord(value)) return {};
  const schema: Json = {};
  if (typeof value.$ref === 'string') schema.$ref = value.$ref;
  const types = normalizedSchemaTypes(value);
  if (typeof value.type === 'string' && types.length) schema.type = types[0];
  else if (Array.isArray(value.type) && types.length === value.type.length)
    schema.type = types;
  if (typeof value.description === 'string')
    schema.description = value.description;
  if (typeof value.encrypted === 'boolean') schema.encrypted = value.encrypted;
  if (Array.isArray(value.enum)) schema.enum = value.enum;
  if (isRecord(value.items)) schema.items = normalizeSchema(value.items);
  else if (Array.isArray(value.items)) schema.items = {};
  if (
    typeof value.minItems === 'number' &&
    Number.isSafeInteger(value.minItems) &&
    value.minItems >= 0
  )
    schema.minItems = value.minItems;
  const properties = normalizeSchemaMap(value.properties);
  if (properties) schema.properties = properties;
  if (Array.isArray(value.required))
    schema.required = value.required.filter(
      (name): name is string => typeof name === 'string',
    );
  if (typeof value.additionalProperties === 'boolean')
    schema.additionalProperties = value.additionalProperties;
  else if (isRecord(value.additionalProperties))
    schema.additionalProperties = normalizeSchema(value.additionalProperties);
  for (const key of COMPOSITION_SCHEMA_KEYS) {
    const list = normalizeSchemaList(value[key]);
    if (list) schema[key] = list;
  }
  for (const table of DEFINITION_TABLE_KEYS) {
    const definitions = normalizeSchemaMap(value[table]);
    if (definitions) schema[table] = definitions;
  }
  return schema;
}

function stripSchemaDescriptions(value: unknown): unknown {
  return eachSchema(value, (schema) => {
    if (!isRecord(schema)) return schema;
    delete schema.description;
    mapSchemaChildren(schema, true, stripSchemaDescriptions);
    return schema;
  });
}

function rewriteDefinitionRefs(value: unknown): unknown {
  return eachSchema(value, (schema) => {
    if (!isRecord(schema)) return schema;
    if (localDefinitionRef(schema.$ref)) return {};
    mapSchemaChildren(schema, false, rewriteDefinitionRefs);
    return schema;
  });
}

function dropSchemaDefinitions(value: unknown): unknown {
  const result = rewriteDefinitionRefs(value);
  if (isRecord(result))
    for (const table of DEFINITION_TABLE_KEYS) delete result[table];
  return result;
}

function collapseDeepSchemaObjects(value: unknown, depth = 0): unknown {
  return eachSchema(value, (schema) => {
    if (!isRecord(schema)) return schema;
    if (
      depth >= MAX_COMPACT_TOOL_SCHEMA_DEPTH &&
      (SCHEMA_CHILD_KEYS.some((key) => Object.hasOwn(schema, key)) ||
        ['properties', 'additionalProperties', '$ref'].some((key) =>
          Object.hasOwn(schema, key),
        ))
    )
      return {};
    mapSchemaChildren(schema, false, (child) =>
      collapseDeepSchemaObjects(child, depth + 1),
    );
    return schema;
  });
}

function pruneSchemaCompositions(value: unknown): unknown {
  return eachSchema(value, (schema) => {
    if (!isRecord(schema)) return schema;
    if (hasCompositionKeyword(schema)) return {};
    mapSchemaChildren(schema, false, pruneSchemaCompositions);
    return schema;
  });
}

const LARGE_SCHEMA_COMPACTION_PASSES: Array<(value: unknown) => unknown> = [
  stripSchemaDescriptions,
  dropSchemaDefinitions,
  (value) => collapseDeepSchemaObjects(value),
  pruneSchemaCompositions,
];

/**
 * Official tool-schema pipeline for one Anthropic `input_schema`: MCP root
 * `properties` default, sanitize, prune unreachable definitions, compact
 * schemas whose normalized JSON exceeds 5,000 bytes, then serialize the
 * supported keyword subset.
 */
export function sanitizeCodexToolSchema(input: unknown): Json {
  if (!isRecord(input)) return DEFAULT_TOOL_PARAMETERS();
  let schema: unknown = JSON.parse(JSON.stringify(input));
  const root = schema as Json;
  // OpenAI models require `properties`; the official MCP path inserts it.
  if (root.properties == null) root.properties = {};
  schema = sanitizeJsonSchema(truncateDeepSchema(root, 0));
  if (!isRecord(schema) || schema.type === 'null')
    return DEFAULT_TOOL_PARAMETERS();
  pruneUnreachableDefinitions(schema);
  for (const pass of LARGE_SCHEMA_COMPACTION_PASSES) {
    if (
      Buffer.byteLength(JSON.stringify(normalizeSchema(schema))) <=
      COMPACT_TOOL_SCHEMA_BYTES
    )
      break;
    schema = pass(schema);
  }
  return normalizeSchema(schema);
}

/** Per-request conversion settings shared by every content helper. */
interface ConversionContext {
  /** Request-local Anthropic → upstream tool names. */
  names: Map<string, string>;
  /** Responses Lite request: no image detail, namespaced function calls. */
  lite: boolean;
  sendPdfAsInputFile: boolean;
}

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * Official image preparation: classic requests default `detail` to high
 * (DEFAULT_IMAGE_DETAIL); Responses Lite strips it (client_common.rs).
 */
function imageToInputImage(
  source: unknown,
  context: ConversionContext,
): Json | null {
  if (
    !isRecord(source) ||
    source.type !== 'base64' ||
    typeof source.data !== 'string' ||
    typeof source.media_type !== 'string' ||
    !SUPPORTED_IMAGE_MEDIA_TYPES.has(source.media_type)
  )
    return null;
  return {
    type: 'input_image',
    image_url: `data:${source.media_type};base64,${source.data}`,
    ...(context.lite ? {} : { detail: 'high' }),
  };
}

/** Request strings echoed into placeholders stay short and single-line. */
function placeholderValue(value: unknown, limit = 200): string {
  return truncateUtf8(String(value ?? 'unknown').replace(/\s+/g, ' '), limit);
}

/**
 * Images the backend cannot take are replaced by a visible note instead of a
 * 400: the block usually sits in session history and would otherwise fail
 * every later turn. The model still learns that something was omitted.
 */
function omittedImageText(source: unknown): string {
  const record = isRecord(source) ? source : {};
  if (record.type === 'url')
    return `[Image omitted: the ChatGPT backend does not fetch image URLs (${placeholderValue(record.url)})]`;
  if (record.type === 'base64')
    return `[Image omitted: unsupported image type ${placeholderValue(record.media_type, 64)}]`;
  return `[Image omitted: ${placeholderValue(record.type, 64)} image sources are not supported by the ChatGPT backend]`;
}

function documentToInputFile(
  source: unknown,
  context: ConversionContext,
): Json | null {
  if (
    !context.sendPdfAsInputFile ||
    !isRecord(source) ||
    source.type !== 'base64' ||
    source.media_type !== 'application/pdf' ||
    typeof source.data !== 'string'
  )
    return null;
  return {
    type: 'input_file',
    file_data: `data:application/pdf;base64,${source.data}`,
    filename: 'document.pdf',
  };
}

function textBlocksOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter(
      (block): block is Json =>
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => block.text as string);
  return texts.length ? texts.join('\n') : null;
}

/** Plain-text documents become text input; binary non-PDF documents do not. */
function documentText(block: Json): string | null {
  const source = isRecord(block.source) ? block.source : {};
  let text: string | null = null;
  if (source.type === 'text' && typeof source.data === 'string')
    text = source.data;
  else if (
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    source.media_type.startsWith('text/') &&
    typeof source.data === 'string'
  )
    text = Buffer.from(source.data, 'base64').toString('utf8');
  else if (source.type === 'content') text = textBlocksOf(source.content);
  if (text === null) return null;
  const title =
    typeof block.title === 'string' && block.title.trim()
      ? block.title.trim()
      : '';
  return title ? `${title}\n\n${text}` : text;
}

function omittedDocumentText(block: Json, context = ''): string {
  const source = isRecord(block.source) ? block.source : {};
  const kind =
    source.type === 'base64'
      ? placeholderValue(source.media_type, 64)
      : `${placeholderValue(source.type, 64)} source`;
  return `[Document omitted${context}: ${kind} documents are not supported by the ChatGPT backend]`;
}

/**
 * Claude Code's tool search returns `tool_reference` blocks naming tools
 * that are now loaded. Every tool is declared upfront here, so the reference
 * only tells the model which (request-local) name to call.
 */
function toolReferenceText(block: Json, context: ConversionContext): string {
  const name = typeof block.tool_name === 'string' ? block.tool_name : '';
  if (!name) return '[Tool reference omitted]';
  return `[Tool available: ${placeholderValue(
    context.names.get(name) ?? shortenToolName(name),
    128,
  )}]`;
}

/** Flatten a block type this translator does not know into visible text. */
function unsupportedBlockText(block: Json, context: ConversionContext): string {
  if (block.type === 'tool_reference') return toolReferenceText(block, context);
  const type = placeholderValue(block.type, 64);
  const title =
    typeof block.title === 'string' && block.title.trim()
      ? `: ${placeholderValue(block.title)}`
      : '';
  const text =
    (typeof block.text === 'string' ? block.text : null) ??
    textBlocksOf(block.content) ??
    (isRecord(block.source) ? textBlocksOf(block.source.content) : null);
  return text
    ? `[${type}${title}]\n${text}`
    : `[Unsupported ${type} content omitted${title}]`;
}

function alignToolResults(
  blocks: Array<Json>,
  pendingIds: string[],
): Array<Json> {
  const results = blocks.filter((block) => block.type === 'tool_result');
  if (!pendingIds.length || results.length !== pendingIds.length) return blocks;
  const byId = new Map<string, Json>();
  for (const result of results) {
    if (typeof result.tool_use_id !== 'string' || byId.has(result.tool_use_id))
      return blocks;
    byId.set(result.tool_use_id, result);
  }
  if (
    new Set(pendingIds).size !== pendingIds.length ||
    pendingIds.some((id) => !byId.has(id))
  )
    return blocks;
  let index = 0;
  return blocks.map((block) =>
    block.type === 'tool_result' ? byId.get(pendingIds[index++])! : block,
  );
}

function toolResultOutput(
  content: unknown,
  context: ConversionContext,
): unknown {
  if (typeof content === 'string') return content;
  const converted: Json[] = [];
  for (const block of contentBlocks(content)) {
    if (block.type === 'text') {
      if (typeof block.text === 'string')
        converted.push({ type: 'input_text', text: block.text });
    } else if (block.type === 'image') {
      converted.push(
        imageToInputImage(block.source, context) ?? {
          type: 'input_text',
          text: omittedImageText(block.source),
        },
      );
    } else if (block.type === 'document') {
      // Files are not accepted inside function_call_output; keep text.
      converted.push({
        type: 'input_text',
        text:
          documentText(block) ??
          omittedDocumentText(block, ' from tool result'),
      });
    } else {
      converted.push({
        type: 'input_text',
        text: unsupportedBlockText(block, context),
      });
    }
  }
  return converted.length ? converted : '';
}

function messageToInputItems(
  message: Json,
  blocks: Array<Json>,
  context: ConversionContext,
  reminders: Json[],
): Array<Json> {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const items: Json[] = [];
  let content: Json[] = [];
  const flush = (): void => {
    if (!content.length) return;
    items.push({ type: 'message', role, content });
    content = [];
  };
  const flushReminders = (): void => {
    if (!reminders.length) return;
    flush();
    items.push(...reminders.splice(0));
  };
  // Responses assistant content accepts only output_text/refusal parts.
  const textPart = (text: string): Json => ({
    type: role === 'assistant' ? 'output_text' : 'input_text',
    text,
  });
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (Array.isArray(message.content)) flushReminders();
        if (typeof block.text === 'string') content.push(textPart(block.text));
        break;
      case 'image': {
        flushReminders();
        content.push(
          role === 'assistant'
            ? textPart(
                '[Image omitted: assistant messages cannot carry images on the ChatGPT backend]',
              )
            : (imageToInputImage(block.source, context) ??
                textPart(omittedImageText(block.source))),
        );
        break;
      }
      case 'document': {
        flushReminders();
        const text = documentText(block);
        const file =
          role === 'assistant'
            ? null
            : documentToInputFile(block.source, context);
        content.push(
          file ??
            textPart(
              text ??
                omittedDocumentText(
                  block,
                  role === 'assistant' ? ' from assistant message' : '',
                ),
            ),
        );
        break;
      }
      case 'thinking': {
        if (role !== 'assistant') break;
        const signature = decodeReasoningSignature(block.signature);
        if (!signature) break;
        flush();
        // Stateless encrypted reasoning is replayed without stale item IDs.
        items.push({
          type: 'reasoning',
          summary: [],
          content: null,
          encrypted_content: signature.encryptedContent,
        });
        break;
      }
      case 'tool_use':
        flush();
        if (typeof block.name !== 'string' || typeof block.id !== 'string')
          break;
        // Field order and the Lite `functions` namespace follow official
        // FunctionCall items, which replay the call as the model emitted it.
        items.push({
          type: 'function_call',
          name: context.names.get(block.name) ?? shortenToolName(block.name),
          ...(context.lite ? { namespace: DEFAULT_FUNCTION_NAMESPACE } : {}),
          arguments: JSON.stringify(block.input ?? {}),
          call_id: shortenCodexCallId(block.id),
        });
        break;
      case 'tool_result':
        flush();
        if (typeof block.tool_use_id !== 'string') break;
        items.push({
          type: 'function_call_output',
          call_id: shortenCodexCallId(block.tool_use_id),
          output: toolResultOutput(block.content, context),
        });
        break;
      // Server-executed search/tool search and foreign/redacted thinking are
      // not client calls.
      case 'server_tool_use':
      case 'web_search_tool_result':
      case 'tool_search_tool_result':
      case 'redacted_thinking':
        break;
      default:
        // Server-side blocks in assistant history were never client output;
        // user-side content is kept visible rather than dropped.
        if (role === 'assistant' || typeof block.type !== 'string') break;
        flushReminders();
        content.push(textPart(unsupportedBlockText(block, context)));
    }
  }
  flush();
  flushReminders();
  return items;
}

/** codex_protocol::DEFAULT_FUNCTION_NAMESPACE. */
const DEFAULT_FUNCTION_NAMESPACE = 'functions';

function isWebSearchTool(tool: Json): boolean {
  return (
    tool.type === 'web_search_20250305' || tool.type === 'web_search_20260209'
  );
}

/**
 * Anthropic server tools with no Responses equivalent. Tool search exists to
 * load `defer_loading` tools; this translator declares every tool upfront.
 */
function isDroppedServerTool(tool: Json): boolean {
  return (
    typeof tool.type === 'string' && tool.type.startsWith('tool_search_tool_')
  );
}

function isFunctionTool(tool: Json): boolean {
  return !isWebSearchTool(tool) && !isDroppedServerTool(tool);
}

/** Official ResponsesApiTool field order; `defer_loading` is never sent. */
function functionToolJson(tool: Json, names: Map<string, string>): Json {
  const name = tool.name as string;
  return {
    type: 'function',
    name: names.get(name) ?? shortenToolName(name),
    description: typeof tool.description === 'string' ? tool.description : '',
    strict: false,
    parameters: sanitizeCodexToolSchema(tool.input_schema),
  };
}

/**
 * Official hosted web_search (core/src/tools/hosted_spec.rs). Claude's tool
 * searches the live web, i.e. WebSearchMode::Live → external_web_access true.
 * `blocked_domains` and `max_uses` have no field in the official tool and are
 * dropped.
 */
function webSearchToolJson(
  tool: Json,
  contentTypes: readonly string[] | null,
): Json {
  const converted: Json = { type: 'web_search', external_web_access: true };
  if (
    Array.isArray(tool.allowed_domains) &&
    tool.allowed_domains.every((domain) => typeof domain === 'string')
  )
    converted.filters = { allowed_domains: tool.allowed_domains };
  if (isRecord(tool.user_location)) {
    const location = tool.user_location;
    const user_location: Json = { type: 'approximate' };
    for (const key of ['country', 'region', 'city', 'timezone']) {
      if (typeof location[key] === 'string') user_location[key] = location[key];
    }
    converted.user_location = user_location;
  }
  if (contentTypes) converted.search_content_types = [...contentTypes];
  return converted;
}

function convertTools(
  tools: Array<Json>,
  names: Map<string, string>,
  webSearchContentTypes: readonly string[] | null,
): Array<Json> {
  return tools
    .filter((tool) => !isDroppedServerTool(tool))
    .map((tool) =>
      isWebSearchTool(tool)
        ? webSearchToolJson(tool, webSearchContentTypes)
        : functionToolJson(tool, names),
    );
}

/** UUID v5 (RFC 4122), as uuid::Uuid::new_v5. */
export function codexUuidV5(namespace: string, name: string | Buffer): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_NAMESPACE_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8';

/**
 * Namespace for the ids of prompt-only prefix items, which are rebuilt on
 * every request: uuid-v5 of the thread id (client.rs prefix_namespace).
 */
function prefixNamespace(threadId: string): string {
  return codexUuidV5(UUID_NAMESPACE_OID, threadId);
}

/**
 * Responses Lite tool prefix (client.rs build_responses_request): every
 * function goes into one `functions` namespace
 * (create_tools_json_for_responses_lite), carried by an `additional_tools`
 * developer item whose id hashes the tool JSON within the thread namespace.
 */
function additionalToolsItem(
  tools: Array<Json>,
  names: Map<string, string>,
  namespace: string,
): Json | null {
  const functions = tools
    .filter(isFunctionTool)
    .map((tool) => functionToolJson(tool, names));
  if (!functions.length) return null;
  const toolsJson = [
    {
      type: 'namespace',
      name: DEFAULT_FUNCTION_NAMESPACE,
      description: '',
      tools: functions,
    },
  ];
  return {
    type: 'additional_tools',
    id: `at_${codexUuidV5(namespace, JSON.stringify(toolsJson))}`,
    role: 'developer',
    tools: toolsJson,
  };
}

function convertToolChoice(
  choice: Json | undefined,
  names: Map<string, string>,
  tools: Array<Json>,
  lite: boolean,
): Json | 'auto' | 'none' | 'required' {
  switch (choice?.type) {
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool': {
      if (
        tools.some((tool) => isWebSearchTool(tool) && tool.name === choice.name)
      )
        return { type: 'web_search' };
      const name = typeof choice.name === 'string' ? choice.name : '';
      const tool = tools.find((candidate) => candidate.name === name);
      if (!name || !tool || !isFunctionTool(tool)) return 'auto';
      // Namespaced Lite tools cannot be named by a function choice; forcing
      // some tool call is the closest supported intent.
      if (lite) return 'required';
      return {
        type: 'function',
        name: names.get(name) ?? shortenToolName(name),
      };
    }
    default:
      return 'auto';
  }
}

export interface AnthropicToResponsesOptions {
  targetModel: string;
  /** Effective request effort, already clamped against the provider catalog. */
  reasoningEffort?: string;
  requestTools?: boolean;
  /**
   * Stable per-session identity standing in for the official thread id: it
   * namespaces the uuid-v5 id of the Responses Lite tool prefix so retries
   * and later turns of one session reuse the same item id.
   */
  threadId?: string;
  /** Provider (account) catalog for the request shape; see getCodexModelTraits. */
  catalog?: readonly CodexModelCatalogEntry[];
  /** Override CODEX_SEND_PDF_AS_INPUT_FILE (tests). */
  sendPdfAsInputFile?: boolean;
}

/**
 * Whether this request goes upstream in the Responses Lite shape: the model
 * is Lite in the catalog and the request carries no hosted tool. Official
 * Lite accepts only client-executed tools (spec_plan.rs
 * hosted_model_tool_specs); Claude's server web search has no client-side
 * executor here, so such requests keep the classic shape the backend still
 * serves. The HTTP layer must derive the Lite header from this, per request.
 */
export function codexRequestUsesResponsesLite(
  request: AnthropicRequestSubset,
  model: string,
  catalog?: readonly CodexModelCatalogEntry[],
): boolean {
  return (
    getCodexModelTraits(model, catalog).useResponsesLite &&
    !request.tools?.some(isWebSearchTool)
  );
}

export function normalizeCodexEffort(effort: string | undefined): string {
  if (!effort) return 'medium';
  return effort === 'minimal' ? 'low' : effort;
}

/**
 * Reference (CLIProxyAPI) mapping of the SDK's thinking intent to a Responses
 * effort, used by the pure translator. An explicit override wins. The gateway
 * applies HappyClaw's precedence first via resolveGatewayReasoningEffort and
 * passes the final value in as that override.
 */
export function resolveCodexRequestEffort(
  request: AnthropicRequestSubset,
  configuredOverride?: string,
): string {
  if (configuredOverride?.trim())
    return normalizeCodexEffort(configuredOverride.trim().toLowerCase());
  switch (request.thinking?.type) {
    case 'disabled':
      return 'none';
    case 'adaptive':
    case 'auto': {
      const effort = request.output_config?.effort;
      return typeof effort === 'string' && effort.trim()
        ? effort.trim().toLowerCase()
        : 'xhigh';
    }
    case 'enabled': {
      const budget = request.thinking.budget_tokens;
      if (typeof budget !== 'number') break;
      if (budget === -1) return 'auto';
      if (budget === 0) return 'none';
      if (budget <= 512) return 'minimal';
      if (budget <= 1024) return 'low';
      if (budget <= 8192) return 'medium';
      if (budget <= 24576) return 'high';
      return 'xhigh';
    }
  }
  return 'medium';
}

export interface GatewayEffortPolicy {
  catalog: readonly CodexModelCatalogEntry[];
  /** Upstream model this request will run on. */
  model: string;
  /** Provider-level CODEX_REASONING_EFFORT, if configured. */
  providerEffort?: string;
  /** Explicit Agent effort of the calling runner; undefined = inherit. */
  agentEffort?: string;
}

/**
 * Whether a request is one of Claude Code's background/utility queries
 * (titles, summaries, small-fast model calls) rather than the agent turn.
 * Shared contract: the effort policy lowers these, and the HTTP layer marks
 * them like the official client's internal sub-requests. Claude Code sends
 * them on its haiku tier, which runtime-config keeps on a Claude haiku id for
 * Codex gateway providers (every other tier is the Codex model).
 */
export function isCodexBackgroundRequest(
  request: AnthropicRequestSubset,
): boolean {
  return typeof request.model === 'string' && /haiku/i.test(request.model);
}

/**
 * HappyClaw's effort precedence for one gateway request, already clamped to
 * the model's supported levels:
 * 1. thinking disabled → the lowest level the model supports (never `none`,
 *    which the current catalog rejects);
 * 2. background/haiku-tier requests → low;
 * 3. an explicit Agent effort → the SDK's requested effort for this call,
 *    else the Agent's own level (sub-agents may ask for a different level);
 * 4. otherwise the provider default: CODEX_REASONING_EFFORT, else the model's
 *    catalog default. Claude Code's own output_config.effort is ignored here:
 *    for inheriting Agents it only mirrors the third-party CLAUDE_CODE_EFFORT_LEVEL
 *    default, not a user choice, and the settings page shows the provider default.
 */
export function resolveGatewayReasoningEffort(
  request: AnthropicRequestSubset,
  policy: GatewayEffortPolicy,
): string {
  const { catalog, model } = policy;
  const thinking = request.thinking;
  if (
    thinking?.type === 'disabled' ||
    (thinking?.type === 'enabled' && thinking.budget_tokens === 0)
  )
    return lowestCodexEffortWithCatalog(catalog, model);
  if (isCodexBackgroundRequest(request)) {
    const entry = catalog.find((candidate) => candidate.value === model);
    return !entry || entry.efforts.includes('low')
      ? 'low'
      : lowestCodexEffortWithCatalog(catalog, model);
  }
  if (policy.agentEffort) {
    const requested = request.output_config?.effort;
    const effort =
      typeof requested === 'string' && requested.trim()
        ? requested.trim().toLowerCase()
        : policy.agentEffort;
    return clampCodexEffortWithCatalog(
      catalog,
      model,
      normalizeCodexEffort(effort),
    )!;
  }
  return resolveCodexDefaultEffort(catalog, model, policy.providerEffort);
}

/** Official TextFormat field order: type, strict, schema, name. */
function convertOutputFormat(config: Json | undefined): Json | undefined {
  const format = config?.format;
  if (
    !isRecord(format) ||
    format.type !== 'json_schema' ||
    !isRecord(format.schema)
  )
    return undefined;
  let strict = format.strict !== false;
  visitSchemas(format.schema, (schema) => {
    if (!isRecord(schema.properties)) return;
    const required = new Set(
      Array.isArray(schema.required) ? schema.required : [],
    );
    if (Object.keys(schema.properties).some((key) => !required.has(key)))
      strict = false;
  });
  return {
    type: 'json_schema',
    strict,
    schema: JSON.parse(JSON.stringify(format.schema)),
    name:
      typeof format.name === 'string' && format.name
        ? format.name
        : 'codex_output_schema',
  };
}

/** Thinking explicitly turned off by the caller (no summary is requested). */
function thinkingDisabled(request: AnthropicRequestSubset): boolean {
  const thinking = request.thinking;
  return (
    thinking?.type === 'disabled' ||
    (thinking?.type === 'enabled' && thinking.budget_tokens === 0)
  );
}

/** Thread fallback when the caller has no session identity: the system prompt. */
function fallbackThreadId(systemParts: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(['happyclaw:codex:thread', systemParts]))
    .digest('hex');
}

export function anthropicToResponses(
  request: AnthropicRequestSubset,
  options: AnthropicToResponsesOptions,
): ResponsesRequest {
  const model = options.targetModel;
  const traits = getCodexModelTraits(model, options.catalog);
  const lite = codexRequestUsesResponsesLite(request, model, options.catalog);
  const names = buildCodexToolNameMap(request.tools);
  const context: ConversionContext = {
    names,
    lite,
    sendPdfAsInputFile:
      options.sendPdfAsInputFile ?? CODEX_SEND_PDF_AS_INPUT_FILE,
  };
  const input: Json[] = [];
  const systemParts = systemTextParts(request.system);
  const namespace = prefixNamespace(
    options.threadId?.trim() || fallbackThreadId(systemParts),
  );
  if (lite && request.tools?.length) {
    const prefix = additionalToolsItem(request.tools, names, namespace);
    if (prefix) input.push(prefix);
  }
  if (systemParts.length) {
    // Official base instructions: one developer message whose id hashes the
    // text within the thread namespace.
    const instructions = systemParts.join('\n\n');
    input.push({
      type: 'message',
      id: `msg_${codexUuidV5(namespace, instructions)}`,
      role: 'developer',
      content: [{ type: 'input_text', text: instructions }],
    });
  }
  const reminders: Json[] = [];
  let pendingToolUseIds: string[] = [];
  for (const message of request.messages ?? []) {
    if (message.role === 'system') {
      const text = systemTextParts(message.content).join('\n');
      if (!text.trim()) continue;
      const reminder = {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `<system-reminder>\n${text}\n</system-reminder>`,
          },
        ],
      };
      if (pendingToolUseIds.length) reminders.push(reminder);
      else input.push(reminder);
      continue;
    }
    let blocks = contentBlocks(message.content);
    if (message.role === 'user')
      blocks = alignToolResults(blocks, pendingToolUseIds);
    pendingToolUseIds = blocks
      .filter(
        (block) => block.type === 'tool_use' && typeof block.id === 'string',
      )
      .map((block) => block.id as string);
    input.push(...messageToInputItems(message, blocks, context, reminders));
  }
  input.push(...reminders);

  const tools =
    !lite && request.tools?.length
      ? convertTools(request.tools, names, traits.webSearchContentTypes)
      : undefined;
  // Official clients always send tool_choice ("auto"); an explicit Anthropic
  // choice is translated only when there is a tool it can apply to.
  const choosable = lite
    ? !!request.tools?.some(isFunctionTool)
    : !!tools?.length;
  const fast =
    request.speed === 'fast' ||
    ['fast', 'priority'].includes(
      request.service_tier?.trim().toLowerCase() ?? '',
    );
  const format = convertOutputFormat(request.output_config);
  const verbosity = traits.defaultVerbosity;
  // Keys in official ResponsesApiRequest order; prompt_cache_key slots in
  // via serializeCodexResponsesRequest.
  return {
    model,
    stream: true,
    ...(fast && traits.serviceTiers.includes('priority')
      ? { service_tier: 'priority' as const }
      : {}),
    input,
    ...(tools?.length ? { tools } : {}),
    tool_choice: choosable
      ? convertToolChoice(request.tool_choice, names, request.tools!, lite)
      : 'auto',
    // Lite never runs tools in parallel (client.rs); classic follows the
    // caller's disable_parallel_tool_use.
    parallel_tool_calls:
      !lite && request.tool_choice?.disable_parallel_tool_use !== true,
    reasoning: {
      effort: resolveCodexRequestEffort(request, options.reasoningEffort),
      // Product choice: show thinking whenever the caller has not turned it
      // off (official clients default to no summary).
      ...(thinkingDisabled(request) ? {} : { summary: 'auto' as const }),
      ...(lite ? { context: 'all_turns' as const } : {}),
    },
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(verbosity || format
      ? {
          text: {
            ...(verbosity ? { verbosity } : {}),
            ...(format ? { format } : {}),
          },
        }
      : {}),
  };
}

/** Official ResponsesApiRequest field order (codex-api/src/common.rs). */
const RESPONSES_REQUEST_KEY_ORDER = [
  'model',
  'stream',
  'service_tier',
  'input',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'store',
  'stream_options',
  'include',
  'prompt_cache_key',
  'text',
  'client_metadata',
];

/**
 * Serialize a converted request with its keys in official order — routing
 * fields first, prompt_cache_key between include and text, client_metadata
 * last — so the body reads like the official client's after the HTTP layer
 * adds its per-request fields. Unknown keys keep their relative order at the
 * end.
 */
export function serializeCodexResponsesRequest(
  request: ResponsesRequest,
  extra: {
    promptCacheKey?: string;
    clientMetadata?: Record<string, string>;
  } = {},
): string {
  const source: Json = {
    ...request,
    ...(extra.promptCacheKey ? { prompt_cache_key: extra.promptCacheKey } : {}),
    ...(extra.clientMetadata ? { client_metadata: extra.clientMetadata } : {}),
  };
  const ordered: Json = {};
  for (const key of RESPONSES_REQUEST_KEY_ORDER) {
    if (source[key] !== undefined) ordered[key] = source[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !Object.hasOwn(ordered, key))
      ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

/**
 * 旧目录模型归一：gpt-5.1 系列已从上游目录移除（请求直接 400），
 * 存量 provider 配置里的旧值在请求时映射到 GPT-6 对应档
 * （映射语义对齐官方 gpt-5.4→sol / gpt-5.4-mini→luna 迁移）。
 */
const LEGACY_CODEX_MODELS: Readonly<Record<string, string>> = {
  'gpt-5.1': 'gpt-6-sol',
  'gpt-5.1-codex': 'gpt-6-sol',
  'gpt-5.1-codex-max': 'gpt-6-sol',
  'gpt-5.1-codex-mini': 'gpt-6-luna',
};

export function normalizeLegacyCodexModel(model: string): string {
  return LEGACY_CODEX_MODELS[model] ?? model;
}

/**
 * 模型名重写：SDK 可能硬编码请求 claude-* 系列（haiku 后台任务等），
 * 一律映射到 provider 配置的 Codex 模型，避免上游 404；
 * 旧目录模型（gpt-5.1-*）归一到现役 GPT-6 目录，存量配置无需手动迁移。
 */
export function resolveCodexModel(
  requestModel: string | undefined,
  configuredModel: string,
): string {
  const configured = normalizeLegacyCodexModel(
    configuredModel || CODEX_DEFAULT_MODEL,
  );
  if (!requestModel) return configured;
  if (/^claude/i.test(requestModel)) {
    return configured;
  }
  return normalizeLegacyCodexModel(requestModel);
}
