// ─── ChatGPT/Codex 订阅网关 — 本地 count_tokens 估算 ─────────────────
//
// Codex 后端没有 count_tokens 接口。与 CLIProxyAPI codex_executor_tokens.go
// 一样，先把请求翻译成 Responses 形态，再统计 instructions、消息文本、
// function_call 名称与参数、function_call_output、工具定义和结构化输出
// schema。CLIProxyAPI 用 tiktoken 计数；这里没有分词器依赖，按字符估算：
// 自然语言 ASCII 约 4 字符 1 token，JSON/代码这类符号密集的文本约 3.2 字符
// 1 token，其它字符（CJK 等）按 1 字符 1 token 偏保守估计，图片和文件按固定
// 值计入。回放的加密 reasoning 按官方 Codex CLI 的长度公式折算。结果只用于
// 上下文预算和 message_start 的输入预估，不用于计费。

import type { ResponsesRequest } from './convert-request.js';

type Json = Record<string, unknown>;

/** Flat allowance for each image or file part; their real cost is unknown here. */
const ATTACHMENT_TOKEN_ESTIMATE = 1_000;
/** Role/framing overhead per input item. */
const ITEM_OVERHEAD_TOKENS = 3;
const PROSE_CHARS_PER_TOKEN = 4;
/** o200k tokenizes JSON and source code into noticeably shorter pieces. */
const CODE_CHARS_PER_TOKEN = 3.2;
/** Share of ASCII punctuation above which text reads as JSON/code. */
const CODE_SYMBOL_DENSITY = 0.1;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAsciiSymbol(code: number): boolean {
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

/**
 * @param code Force the JSON/code ratio for text known to be serialized
 * structure (tool arguments, schemas); otherwise symbol density decides.
 */
export function estimateTextTokens(text: string, code = false): number {
  let ascii = 0;
  let symbols = 0;
  let other = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point < 0x80) {
      ascii += 1;
      if (isAsciiSymbol(point)) symbols += 1;
    } else other += 1;
  }
  const codeLike =
    code || (ascii > 0 && symbols / ascii >= CODE_SYMBOL_DENSITY);
  return (
    Math.ceil(
      ascii / (codeLike ? CODE_CHARS_PER_TOKEN : PROSE_CHARS_PER_TOKEN),
    ) + other
  );
}

/**
 * Official estimate_reasoning_length (context_manager/history.rs): base64
 * ciphertext decodes to 3/4 of its length, minus a fixed 650-byte envelope,
 * at 4 bytes per token.
 */
export function estimateEncryptedReasoningTokens(encrypted: string): number {
  return Math.ceil(
    Math.max(0, Math.floor((encrypted.length * 3) / 4) - 650) / 4,
  );
}

function partTokens(part: unknown, code: boolean): number {
  if (typeof part === 'string') return estimateTextTokens(part, code);
  if (!isRecord(part)) return 0;
  if (typeof part.text === 'string') return estimateTextTokens(part.text, code);
  if (part.type === 'input_image' || part.type === 'input_file')
    return ATTACHMENT_TOKEN_ESTIMATE;
  return 0;
}

function contentTokens(content: unknown, code = false): number {
  if (Array.isArray(content))
    return content.reduce<number>(
      (sum, part) => sum + partTokens(part, code),
      0,
    );
  return partTokens(content, code);
}

/** Tool definitions, including the functions nested in a Lite namespace. */
function toolsTokens(tools: unknown, depth = 0): number {
  if (!Array.isArray(tools) || depth > 2) return 0;
  let total = 0;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    total += estimateTextTokens(
      [
        typeof tool.name === 'string' ? tool.name : '',
        typeof tool.description === 'string' ? tool.description : '',
      ].join('\n'),
    );
    if (tool.parameters)
      total += estimateTextTokens(JSON.stringify(tool.parameters), true);
    total += toolsTokens(tool.tools, depth + 1);
  }
  return total;
}

export function estimateCodexInputTokens(request: ResponsesRequest): number {
  // The system prompt travels as a developer message; top-level
  // instructions only appear in older request shapes.
  let total = estimateTextTokens(request.instructions ?? '');
  for (const item of request.input) {
    total += ITEM_OVERHEAD_TOKENS;
    switch (item.type) {
      case 'message':
        total += contentTokens(item.content);
        break;
      case 'function_call':
        total += estimateTextTokens(String(item.name ?? ''));
        total += estimateTextTokens(String(item.arguments ?? ''), true);
        break;
      case 'function_call_output':
        total += contentTokens(item.output);
        break;
      case 'reasoning':
        // Replayed reasoning reaches the model as decrypted context; without
        // ciphertext only its summary text remains.
        total +=
          typeof item.encrypted_content === 'string'
            ? estimateEncryptedReasoningTokens(item.encrypted_content)
            : contentTokens(item.summary);
        break;
      case 'additional_tools':
        // Responses Lite has no top-level tools: they ride in this item.
        total += toolsTokens(item.tools);
        break;
      default:
        // Other items contribute any plain text they carry.
        if (typeof item.text === 'string')
          total += estimateTextTokens(item.text);
    }
  }
  total += toolsTokens(request.tools);
  const format = request.text?.format;
  if (isRecord(format)) {
    total += estimateTextTokens(
      typeof format.name === 'string' ? format.name : '',
    );
    if (format.schema)
      total += estimateTextTokens(JSON.stringify(format.schema), true);
  }
  return total;
}
