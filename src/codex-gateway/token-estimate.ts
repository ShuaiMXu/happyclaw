// ─── ChatGPT/Codex 订阅网关 — 本地 count_tokens 估算 ─────────────────
//
// Codex 后端没有 count_tokens 接口。与 CLIProxyAPI codex_executor_tokens.go
// 一样，先把请求翻译成 Responses 形态，再统计 instructions、消息文本、
// function_call 名称与参数、function_call_output、工具定义和结构化输出
// schema。CLIProxyAPI 用 tiktoken 计数；这里没有分词器依赖，按字符估算：
// ASCII 约 4 字符 1 token，其它字符（CJK 等）按 1 字符 1 token 偏保守估计，
// 图片和文件按固定值计入。结果只用于上下文预算，不用于计费。

import type { ResponsesRequest } from './convert-request.js';

type Json = Record<string, unknown>;

/** Flat allowance for each image or file part; their real cost is unknown here. */
const ATTACHMENT_TOKEN_ESTIMATE = 1_000;
/** Role/framing overhead per input item. */
const ITEM_OVERHEAD_TOKENS = 3;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

function partTokens(part: unknown): number {
  if (typeof part === 'string') return estimateTextTokens(part);
  if (!isRecord(part)) return 0;
  if (typeof part.text === 'string') return estimateTextTokens(part.text);
  if (part.type === 'input_image' || part.type === 'input_file')
    return ATTACHMENT_TOKEN_ESTIMATE;
  return 0;
}

function contentTokens(content: unknown): number {
  if (Array.isArray(content))
    return content.reduce<number>((sum, part) => sum + partTokens(part), 0);
  return partTokens(content);
}

export function estimateCodexInputTokens(request: ResponsesRequest): number {
  let total = estimateTextTokens(request.instructions ?? '');
  for (const item of request.input) {
    total += ITEM_OVERHEAD_TOKENS;
    switch (item.type) {
      case 'message':
        total += contentTokens(item.content);
        break;
      case 'function_call':
        total += estimateTextTokens(String(item.name ?? ''));
        total += estimateTextTokens(String(item.arguments ?? ''));
        break;
      case 'function_call_output':
        total += contentTokens(item.output);
        break;
      default:
        // Replayed reasoning is opaque ciphertext the model does not re-read
        // as text; other items contribute any plain text they carry.
        if (typeof item.text === 'string')
          total += estimateTextTokens(item.text);
    }
  }
  for (const tool of request.tools ?? []) {
    total += estimateTextTokens(
      [
        typeof tool.name === 'string' ? tool.name : '',
        typeof tool.description === 'string' ? tool.description : '',
        tool.parameters ? JSON.stringify(tool.parameters) : '',
      ].join('\n'),
    );
  }
  const format = request.text?.format;
  if (isRecord(format)) {
    total += estimateTextTokens(
      `${typeof format.name === 'string' ? format.name : ''}\n${
        format.schema ? JSON.stringify(format.schema) : ''
      }`,
    );
  }
  return total;
}
