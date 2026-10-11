import { describe, expect, test } from 'vitest';
import corpus from './fixtures/codex-cliproxy-a2976.json';
import {
  anthropicToResponses,
  sanitizeCodexToolSchema,
} from '../src/codex-gateway/convert-request.js';
import {
  ResponsesToAnthropicConverter,
  aggregateResponsesStream,
} from '../src/codex-gateway/convert-response.js';

type Json = Record<string, any>;

// Normalize only documented runtime differences from the pure Go translator:
// summaries are explicitly enabled by HappyClaw, and the Codex executor removes
// unused tool fields after translation. Request cases run on a classic-shape
// model; the official-client differences documented in
// docs/codex-protocol-compatibility.md (system item id, image detail,
// verbosity, tool schema subset, always-sent tool controls, hosted search
// fields, no instructions/search sources) are normalized on both sides. All
// remaining message/tool/schema values compare.
function requestBusinessPayload(request: Json): Json {
  const payload = structuredClone(request);
  // The reference ran on gpt-6-sol; the classic shape is checked on gpt-5.5.
  delete payload.model;
  delete payload.reasoning.summary;
  delete payload.instructions;
  payload.include = payload.include.filter(
    (field: string) => field !== 'web_search_call.action.sources',
  );
  if (!payload.tools?.length) {
    delete payload.tools;
    delete payload.tool_choice;
    delete payload.parallel_tool_calls;
  }
  // HappyClaw's current model catalog normalizes removed minimal to low.
  if (payload.reasoning.effort === 'minimal') payload.reasoning.effort = 'low';
  if (payload.text) {
    delete payload.text.verbosity;
    if (payload.text.format) payload.text.format.name = 'structured_output';
    if (!Object.keys(payload.text).length) delete payload.text;
  }
  for (const tool of payload.tools ?? []) {
    if (tool.type === 'web_search') {
      delete tool.external_web_access;
      delete tool.search_content_types;
    } else {
      if (!tool.description) delete tool.description;
      tool.parameters = sanitizeCodexToolSchema(tool.parameters);
    }
  }
  // URL images become a visible placeholder; the reference drops them.
  payload.input = payload.input.filter(
    (item: Json) =>
      !(
        item.type === 'message' &&
        item.content?.length &&
        item.content.every((part: Json) =>
          String(part.text ?? '').startsWith('[Image omitted:'),
        )
      ),
  );
  for (const item of payload.input) {
    delete item.id;
    if (item.type === 'message' && item.role === 'developer')
      item.content = [
        {
          type: 'input_text',
          text: item.content.map((part: Json) => part.text).join('\n\n'),
        },
      ];
    for (const part of [
      ...(Array.isArray(item.content) ? item.content : []),
      ...(Array.isArray(item.output) ? item.output : []),
    ])
      delete part.detail;
  }
  return payload;
}

function streamMessage(events: Json[]): Json {
  const blocks = new Map<number, Json>();
  const argumentsByIndex = new Map<number, string>();
  let result: Json = {};
  for (const event of events) {
    if (event.type === 'content_block_start') {
      blocks.set(event.index, structuredClone(event.content_block));
    } else if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index);
      if (!block) throw new Error('Delta precedes block start');
      const delta = event.delta;
      if (delta.type === 'text_delta') block.text += delta.text;
      if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
      if (delta.type === 'signature_delta')
        block.signature = (block.signature ?? '') + delta.signature;
      if (delta.type === 'input_json_delta')
        argumentsByIndex.set(
          event.index,
          (argumentsByIndex.get(event.index) ?? '') + delta.partial_json,
        );
    } else if (event.type === 'message_delta') {
      const usage = { ...event.usage };
      if (!usage.cache_read_input_tokens) delete usage.cache_read_input_tokens;
      if (!usage.cache_creation_input_tokens)
        delete usage.cache_creation_input_tokens;
      result = {
        stop_reason: event.delta.stop_reason,
        stop_sequence: event.delta.stop_sequence ?? null,
        usage,
      };
    } else if (event.type === 'error') {
      throw new Error(
        'Unexpected error in reference-compatible success stream',
      );
    }
  }
  result.content = [...blocks]
    .sort(([a], [b]) => a - b)
    .map(([index, block]) => {
      if (argumentsByIndex.has(index))
        block.input = JSON.parse(argumentsByIndex.get(index)!);
      return block;
    });
  return result;
}

// The CPA executor compacts pure const unions into an enum; the official client
// keeps the union (each const becomes a one-value enum). This case compares
// every other field and takes the tool schema from the official pipeline.
const OFFICIAL_SCHEMA_DIVERGENCE = new Set(['executor-const-union-enum']);

describe('pinned CLIProxyAPI Go implementation differential corpus', () => {
  test('pins the independently executed reference commit', () => {
    expect(corpus.commit).toBe('a2976eb8a303f11b4ea5177bce9f9ff752634dfc');
    expect(corpus.fixtures).toHaveLength(34);
  });

  for (const fixture of corpus.fixtures) {
    test(`request: ${fixture.name}`, () => {
      const actual = anthropicToResponses(fixture.request, {
        targetModel: 'gpt-5.5',
      });
      const expected = requestBusinessPayload(fixture.expectedRequest);
      if (OFFICIAL_SCHEMA_DIVERGENCE.has(fixture.name))
        expected.tools.forEach((tool: Json, index: number) => {
          tool.parameters = sanitizeCodexToolSchema(
            (fixture.request.tools as Json[])[index].input_schema,
          );
        });
      expect(requestBusinessPayload(actual)).toEqual(expected);
    });
    if (fixture.events) {
      test(`stream: ${fixture.name}`, () => {
        const expectedEvents = fixture.expectedStream!.flatMap((chunk) =>
          chunk
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => JSON.parse(line.slice(5))),
        );
        const converter = new ResponsesToAnthropicConverter('gpt-6-sol', {
          tools: fixture.request.tools,
        });
        const actual = fixture
          .events!.flatMap((event) => converter.handleEvent(event))
          .map((event) => event.data);
        expect(
          actual.filter((event) => event.type === 'message_stop'),
        ).toHaveLength(1);
        expect(streamMessage(actual)).toEqual(streamMessage(expectedEvents));
      });
      test(`nonstream: ${fixture.name}`, () => {
        const actual = aggregateResponsesStream(fixture.events!, 'gpt-6-sol', {
          tools: fixture.request.tools,
        });
        const expected = structuredClone(fixture.expectedResponse!) as Json;
        const usage: Json = { ...actual.usage };
        if (!usage.cache_read_input_tokens)
          delete usage.cache_read_input_tokens;
        // Both output paths deliberately share multipart thinking separators.
        if (fixture.name === 'stream-reasoning-multipart') {
          expected.content[0].thinking = 'first\n\nsecond';
        }
        expect({
          content: actual.content,
          stop_reason: actual.stopReason,
          stop_sequence: actual.stopSequence,
          usage,
        }).toEqual({
          content: expected.content,
          stop_reason: expected.stop_reason,
          stop_sequence: expected.stop_sequence,
          usage: expected.usage,
        });
      });
    }
  }
});
