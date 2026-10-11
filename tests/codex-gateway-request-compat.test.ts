import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  anthropicToResponses,
  buildCodexToolNameMap,
  codexRequestUsesResponsesLite,
  codexUuidV5,
  resolveCodexRequestEffort,
  resolveGatewayReasoningEffort,
  sanitizeCodexToolSchema,
  serializeCodexResponsesRequest,
  shortenCodexCallId,
  type AnthropicRequestSubset,
} from '../src/codex-gateway/convert-request.js';
import { encodeReasoningSignature } from '../src/codex-gateway/reasoning-signature.js';
import {
  CodexMessagesRequestSchema,
  describeCodexRequestIssue,
} from '../src/codex-gateway/request-validation.js';

type Json = Record<string, any>;
// Classic Responses shape (catalog use_responses_lite=false); the Responses
// Lite cases further down run on gpt-6-sol.
const options = { targetModel: 'gpt-5.5' };
const user = (content: unknown): Json => ({ role: 'user', content });
const image = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'c2NyZWVu' },
};
const tool = (
  name: string,
  input_schema: Json = { type: 'object', properties: {} },
): Json => ({ name, input_schema });
const call = (id: string, name: string): Json => ({
  type: 'tool_use',
  id,
  name,
  input: { q: id },
});
const result = (id: string, content: unknown): Json => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
});
const convert = (request: AnthropicRequestSubset) =>
  anthropicToResponses(request, options);
const inputImage = {
  type: 'input_image',
  image_url: 'data:image/png;base64,c2NyZWVu',
  detail: 'high',
};

function rawReasoningSignature(): string {
  const bytes = Buffer.alloc(73);
  bytes[0] = 0x80;
  bytes[8] = 1;
  return bytes.toString('base64url');
}

describe('request-local tool identity compatibility', () => {
  test('maps colliding MCP suffixes identically in declarations, calls, and forced choice', () => {
    const one = `mcp__${'first_server_'.repeat(8)}__search`;
    const two = `mcp__${'other_server_'.repeat(8)}__search`;
    const tools = [tool(one), tool(two), tool('mcp__search')];
    const names = buildCodexToolNameMap(tools);
    expect([...names.values()]).toEqual([
      'mcp__search',
      'mcp__search_1',
      'mcp__search_2',
    ]);
    const converted = convert({
      tools,
      tool_choice: { type: 'tool', name: two },
      messages: [
        { role: 'assistant', content: [call('one', one), call('two', two)] },
      ],
    });
    expect(converted.tools!.map((definition) => definition.name)).toEqual([
      ...names.values(),
    ]);
    expect(converted.input.map((item) => item.name)).toEqual([
      'mcp__search',
      'mcp__search_1',
    ]);
    expect(converted.tool_choice).toEqual({
      type: 'function',
      name: 'mcp__search_1',
    });
    const reverse = new Map(
      [...names].map(([original, shortened]) => [shortened, original]),
    );
    expect(reverse.get('mcp__search_1')).toBe(two);
  });

  test('retains short names and does not split UTF-8 characters at the upstream byte limit', () => {
    const long = '界'.repeat(40);
    const names = buildCodexToolNameMap([
      tool('Bash'),
      tool(long),
      tool(`${long}other`),
    ]);
    expect(names.get('Bash')).toBe('Bash');
    for (const value of names.values()) {
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
      expect(Buffer.from(value).toString('utf8')).toBe(value);
    }
    expect(new Set(names.values()).size).toBe(3);
  });

  test('uses the reference hash shortening for both long call and result IDs', () => {
    const id = `toolu_${'x'.repeat(80)}`;
    const expected = `${id.slice(0, 47)}_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
    expect(shortenCodexCallId(id)).toBe(expected);
    expect(shortenCodexCallId('short')).toBe('short');
    const converted = convert({
      messages: [
        { role: 'assistant', content: [call(id, 'Bash')] },
        user([result(id, 'ok')]),
      ],
    });
    expect(converted.input.map((item) => item.call_id)).toEqual([
      expected,
      expected,
    ]);
    expect(shortenCodexCallId(`${id}different`)).not.toBe(expected);
  });

  test('rejects duplicate tools and selecting a tool that was not declared', () => {
    expect(
      CodexMessagesRequestSchema.safeParse({
        messages: [user('hi')],
        tools: [tool('same'), tool('same')],
      }).success,
    ).toBe(false);
    expect(
      CodexMessagesRequestSchema.safeParse({
        messages: [user('hi')],
        tools: [tool('Bash')],
        tool_choice: { type: 'tool', name: 'missing' },
      }).success,
    ).toBe(false);
  });

  test.each([
    [{ type: 'auto' }, 'auto', true],
    [{ type: 'any', disable_parallel_tool_use: true }, 'required', false],
    [{ type: 'none', disable_parallel_tool_use: false }, 'none', true],
    [{ disable_parallel_tool_use: true }, 'auto', false],
  ])(
    'preserves choice and parallel intent: %j',
    (choice, expectedChoice, parallel) => {
      const request = CodexMessagesRequestSchema.parse({
        messages: [user('hi')],
        tools: [tool('Bash')],
        tool_choice: choice,
      });
      const converted = convert(request);
      expect(converted.tool_choice).toBe(expectedChoice);
      expect(converted.parallel_tool_calls).toBe(parallel);
    },
  );

  test('always sends official tool controls and drops missing/empty tools', () => {
    expect(
      convert({ messages: [user('hi')], tools: [tool('Bash')] }).tool_choice,
    ).toBe('auto');
    for (const tools of [undefined, []]) {
      const converted = convert({
        messages: [user('hi')],
        tools,
        tool_choice: { type: 'any', disable_parallel_tool_use: true },
      });
      expect(converted).not.toHaveProperty('tools');
      expect(converted.tool_choice).toBe('auto');
      expect(converted.parallel_tool_calls).toBe(false);
    }
    expect(convert({ messages: [user('hi')] }).parallel_tool_calls).toBe(true);
  });
});

describe('official tool schema subset (codex-rs/tools json_schema)', () => {
  const parametersOf = (schema: unknown): Json =>
    convert({
      messages: [user('hi')],
      tools: [tool('schema', schema as Json)],
    }).tools![0].parameters as Json;

  test('keeps only official keywords in struct order with sorted maps, leaving literals and names intact', () => {
    const schema = {
      $schema: 'draft',
      $id: 'schema-id',
      title: 'Ignored',
      additionalProperties: false,
      required: ['zeta'],
      properties: {
        zeta: {
          type: 'string',
          pattern: String.raw`\p{L}+`,
          format: 'uri',
          default: { $id: 'literal' },
          description: 'Z',
        },
        $schema: { type: 'string', $schema: 'nested-draft' },
        alpha: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: { type: 'integer', minimum: 0 },
        },
      },
      patternProperties: { '^ok': { type: 'string' } },
      type: 'object',
    };
    const original = structuredClone(schema);
    const parameters = parametersOf(schema);
    expect(JSON.stringify(parameters)).toBe(
      JSON.stringify({
        type: 'object',
        properties: {
          $schema: { type: 'string' },
          alpha: { type: 'array', items: { type: 'integer' }, minItems: 1 },
          zeta: { type: 'string', description: 'Z' },
        },
        required: ['zeta'],
        additionalProperties: false,
      }),
    );
    expect(schema).toEqual(original);
  });

  test('lowers const, boolean schemas and missing types like sanitize_json_schema', () => {
    expect(
      sanitizeCodexToolSchema({
        properties: {
          mode: { const: 'fast', description: 'Mode' },
          anything: true,
          list: { items: { enum: ['a', 'b'] } },
          count: { maximum: 3 },
          map: { additionalProperties: { type: 'number' } },
          unknown: { title: 'only annotations' },
          union: { oneOf: [{ const: 'a' }, { const: 'b' }] },
          nullable: { type: ['object', 'null'] },
          array: { type: 'array' },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        anything: { type: 'string' },
        array: { type: 'array', items: { type: 'string' } },
        count: { type: 'number' },
        list: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
        map: {
          type: 'object',
          properties: {},
          additionalProperties: { type: 'number' },
        },
        mode: { type: 'string', description: 'Mode', enum: ['fast'] },
        nullable: { type: ['object', 'null'], properties: {} },
        union: {
          oneOf: [
            { type: 'string', enum: ['a'] },
            { type: 'string', enum: ['b'] },
          ],
        },
        unknown: {},
      },
    });
  });

  test('prunes unreachable root definitions and keeps referenced ones', () => {
    expect(
      sanitizeCodexToolSchema({
        type: 'object',
        properties: { user: { $ref: '#/$defs/User' } },
        $defs: {
          User: {
            type: 'object',
            properties: { address: { $ref: '#/definitions/Address' } },
          },
          Unused: { type: 'string' },
        },
        definitions: {
          Address: { type: 'string' },
          Orphan: { type: 'number' },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: { user: { $ref: '#/$defs/User' } },
      $defs: {
        User: {
          type: 'object',
          properties: { address: { $ref: '#/definitions/Address' } },
        },
      },
      definitions: { Address: { type: 'string' } },
    });
  });

  test('compacts schemas over 5,000 bytes with the official passes, in order', () => {
    const long = 'x'.repeat(200);
    const fields = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `field${index}`,
        { type: 'string', description: long },
      ]),
    );
    // Pass 1 alone fits: descriptions go, structure stays.
    expect(
      sanitizeCodexToolSchema({
        type: 'object',
        description: long,
        properties: fields,
      }),
    ).toEqual({
      type: 'object',
      properties: Object.fromEntries(
        Object.keys(fields)
          .sort()
          .map((key) => [key, { type: 'string' }]),
      ),
    });
    // Small schemas keep their descriptions.
    expect(
      sanitizeCodexToolSchema({
        type: 'object',
        properties: { a: { type: 'string', description: 'kept' } },
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'string', description: 'kept' } },
    });

    // Without descriptions to strip: definitions go (refs become {}), then
    // objects at depth 3 collapse, then compositions are pruned.
    const wide = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `p${index}`,
        { type: 'string' },
      ]),
    );
    const compacted = sanitizeCodexToolSchema({
      type: 'object',
      properties: {
        ref: { $ref: '#/$defs/Wide' },
        nested: {
          type: 'object',
          properties: {
            deeper: {
              type: 'object',
              properties: { deepest: { type: 'object', properties: wide } },
            },
          },
        },
        choice: { anyOf: [{ type: 'object', properties: wide }] },
      },
      $defs: { Wide: { type: 'object', properties: wide } },
    });
    expect(compacted).toEqual({
      type: 'object',
      properties: {
        choice: {},
        nested: {
          type: 'object',
          properties: {
            deeper: { type: 'object', properties: { deepest: {} } },
          },
        },
        ref: {},
      },
    });
  });

  test('bounds recursion on deeply nested schemas exactly like compaction would', () => {
    let schema: Json = { type: 'string', $schema: 'draft' };
    for (let depth = 0; depth < 2000; depth++) schema = { items: schema };
    const parameters = parametersOf({
      type: 'object',
      properties: { deep: schema },
    });
    expect(parameters).toEqual({
      type: 'object',
      properties: {
        deep: {
          type: 'array',
          items: { type: 'array', items: {} },
        },
      },
    });
  });

  test('supplies missing object properties and degrades invalid keyword values', () => {
    const converted = convert({
      messages: [user('hi')],
      tools: [
        tool('default', {}),
        tool('union', { type: ['object', 'null'] }),
        tool('optional', {
          type: 'object',
          properties: { value: { type: 'string' } },
        }),
        tool('invalid', {
          type: 'object',
          description: 42,
          properties: { items: { type: 'array', items: [{ type: 'string' }] } },
          required: ['items', 7],
          minItems: -1,
        }),
        tool('null-root', { type: 'null' }),
      ],
    });
    expect(converted.tools!.map((definition) => definition.parameters)).toEqual(
      [
        { type: 'object', properties: {} },
        { type: ['object', 'null'], properties: {} },
        { type: 'object', properties: { value: { type: 'string' } } },
        {
          type: 'object',
          properties: { items: { type: 'array', items: {} } },
          required: ['items'],
        },
        { type: 'object', properties: {} },
      ],
    );
    expect(converted.tools![2]).toMatchObject({
      type: 'function',
      name: 'optional',
      description: '',
      strict: false,
    });
  });
});

describe('ordered messages and multimodal tool results', () => {
  test('preserves alternating text, image, and PDF blocks in place', () => {
    const converted = convert({
      messages: [
        user([
          { type: 'text', text: 'before' },
          image,
          { type: 'text', text: 'between' },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'cGRm',
            },
          },
          { type: 'text', text: 'after' },
        ]),
      ],
    });
    expect(converted.input[0].content).toEqual([
      { type: 'input_text', text: 'before' },
      inputImage,
      { type: 'input_text', text: 'between' },
      {
        type: 'input_file',
        file_data: 'data:application/pdf;base64,cGRm',
        filename: 'document.pdf',
      },
      { type: 'input_text', text: 'after' },
    ]);
    expect(
      CodexMessagesRequestSchema.safeParse({
        messages: [
          user([
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: 'cGRm',
              },
            },
          ]),
        ],
      }).success,
    ).toBe(true);
  });

  test('keeps result images within the originating function output in their original order', () => {
    const converted = convert({
      messages: [
        { role: 'assistant', content: [call('screen', 'screenshot')] },
        user([
          result('screen', [
            { type: 'text', text: 'before' },
            image,
            { type: 'text', text: 'after' },
          ]),
        ]),
      ],
    });
    expect(converted.input).toHaveLength(2);
    expect(converted.input[1]).toEqual({
      type: 'function_call_output',
      call_id: 'screen',
      output: [
        { type: 'input_text', text: 'before' },
        inputImage,
        { type: 'input_text', text: 'after' },
      ],
    });
  });

  test('aligns complete parallel results while preserving the indexes of non-result text', () => {
    const converted = convert({
      messages: [
        {
          role: 'assistant',
          content: [call('one', 'Bash'), call('two', 'Read')],
        },
        user([
          result('two', '2'),
          { type: 'text', text: 'between' },
          result('one', '1'),
        ]),
      ],
    });
    expect(converted.input.slice(2)).toEqual([
      { type: 'function_call_output', call_id: 'one', output: '1' },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'between' }],
      },
      { type: 'function_call_output', call_id: 'two', output: '2' },
    ]);
  });

  test('leaves partial or unmatched result sets in their original order', () => {
    for (const feedback of [
      [result('two', '2')],
      [result('two', '2'), result('unknown', '?')],
    ]) {
      const converted = convert({
        messages: [
          {
            role: 'assistant',
            content: [call('one', 'Bash'), call('two', 'Read')],
          },
          user(feedback),
        ],
      });
      expect(converted.input.slice(2).map((item) => item.call_id)).toEqual(
        feedback.map((item) => item.tool_use_id),
      );
    }
  });

  test('sends the system prompt as the official base-instructions item and omits billing attribution', () => {
    const request = {
      system: [
        { type: 'text', text: ' \nx-anthropic-billing-header: fingerprint' },
        { type: 'text', text: 'Rules' },
        { type: 'text', text: 'More rules' },
      ],
      messages: [user('hello')],
    };
    const converted = anthropicToResponses(request, {
      ...options,
      threadId: 'thread-1',
    });
    expect(converted).not.toHaveProperty('instructions');
    const namespace = codexUuidV5(
      '6ba7b812-9dad-11d1-80b4-00c04fd430c8',
      'thread-1',
    );
    expect(converted.input[0]).toEqual({
      type: 'message',
      id: `msg_${codexUuidV5(namespace, 'Rules\n\nMore rules')}`,
      role: 'developer',
      content: [{ type: 'input_text', text: 'Rules\n\nMore rules' }],
    });
    expect(Object.keys(converted.input[0])).toEqual([
      'type',
      'id',
      'role',
      'content',
    ]);
    expect(converted.input[1].role).toBe('user');
    // Without a session identity the id stays stable for the same prompt.
    expect(convert(request).input[0].id).toBe(convert(request).input[0].id);
  });

  test('defers between-call system reminders until matching parallel results are emitted', () => {
    const converted = convert({
      messages: [
        {
          role: 'assistant',
          content: [call('one', 'Bash'), call('two', 'Read')],
        },
        { role: 'system', content: 'Use this repo' },
        {
          role: 'system',
          content: [{ type: 'text', text: 'Latest instructions' }],
        },
        user([
          result('two', '2'),
          result('one', '1'),
          { type: 'text', text: 'Summarize' },
        ]),
      ],
    });
    expect(converted.input.map((item) => item.type)).toEqual([
      'function_call',
      'function_call',
      'function_call_output',
      'function_call_output',
      'message',
      'message',
      'message',
    ]);
    expect(converted.input.slice(2, 4).map((item) => item.call_id)).toEqual([
      'one',
      'two',
    ]);
    expect((converted.input[4].content as Json[])[0].text).toBe(
      '<system-reminder>\nUse this repo\n</system-reminder>',
    );
    expect((converted.input[5].content as Json[])[0].text).toBe(
      '<system-reminder>\nLatest instructions\n</system-reminder>',
    );
    expect((converted.input[6].content as Json[])[0].text).toBe('Summarize');
  });

  test('matches reference string-message ordering and retains empty text blocks', () => {
    const converted = convert({
      messages: [
        { role: 'assistant', content: [call('one', 'Bash')] },
        { role: 'system', content: 'Current directive' },
        user('follow-up'),
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
      ],
    });
    expect((converted.input[1].content as Json[])[0].text).toBe('follow-up');
    expect((converted.input[2].content as Json[])[0].text).toBe(
      '<system-reminder>\nCurrent directive\n</system-reminder>',
    );
    expect(converted.input[3]).toMatchObject({
      content: [{ type: 'output_text', text: '' }],
    });
  });

  test('retains a trailing reminder even when no tool results follow', () => {
    const converted = convert({
      messages: [
        { role: 'assistant', content: [call('one', 'Bash')] },
        { role: 'system', content: 'Trailing directive' },
      ],
    });
    expect(converted.input[1]).toMatchObject({
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '<system-reminder>\nTrailing directive\n</system-reminder>',
        },
      ],
    });
  });
});

describe('reasoning replay and request intent', () => {
  test.each([
    rawReasoningSignature(),
    `gpt#${rawReasoningSignature()}`,
    encodeReasoningSignature({
      id: 'rs_legacy',
      encryptedContent: 'legacy-cipher',
    })!,
  ])('replays compatible reasoning without stale item ID: %s', (signature) => {
    const cipher = signature.startsWith('codexrs1_')
      ? 'legacy-cipher'
      : rawReasoningSignature();
    const converted = convert({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'before' },
            { type: 'thinking', thinking: 'summary', signature },
            call('next', 'Bash'),
          ],
        },
      ],
    });
    expect(converted.input[1]).toEqual({
      type: 'reasoning',
      summary: [],
      content: null,
      encrypted_content: cipher,
    });
    expect(converted.input[2].type).toBe('function_call');
    expect(converted.input[1]).not.toHaveProperty('id');
  });

  test('does not replay user-side, foreign, missing, or redacted thinking', () => {
    const converted = convert({
      messages: [
        user([
          {
            type: 'thinking',
            thinking: 'user supplied',
            signature: rawReasoningSignature(),
          },
        ]),
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'foreign',
              signature: 'claude#foreign',
            },
            { type: 'thinking', thinking: 'unsigned' },
            { type: 'redacted_thinking', data: 'foreign' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    });
    expect(converted.input).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }],
      },
    ]);
  });

  test.each([
    [-1, 'auto'],
    [0, 'none'],
    [512, 'minimal'],
    [513, 'low'],
    [1024, 'low'],
    [1025, 'medium'],
    [8192, 'medium'],
    [8193, 'high'],
    [24576, 'high'],
    [24577, 'xhigh'],
  ])(
    'maps SDK budget %i to reference effort %s before catalog clamping',
    (budget_tokens, effort) => {
      expect(
        resolveCodexRequestEffort({
          thinking: { type: 'enabled', budget_tokens },
        }),
      ).toBe(effort);
    },
  );

  test('uses explicit provider effort over adaptive SDK defaults', () => {
    const request = {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    };
    expect(resolveCodexRequestEffort(request)).toBe('high');
    expect(resolveCodexRequestEffort(request, 'low')).toBe('low');
    expect(resolveCodexRequestEffort({ thinking: { type: 'adaptive' } })).toBe(
      'xhigh',
    );
    expect(resolveCodexRequestEffort({ thinking: { type: 'disabled' } })).toBe(
      'none',
    );
    expect(resolveCodexRequestEffort({}, 'minimal')).toBe('low');
  });

  describe('gateway effort precedence', () => {
    const catalog = [
      {
        value: 'gpt-6-sol',
        label: 'sol',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultEffort: 'medium',
      },
      {
        value: 'capped',
        label: 'capped',
        efforts: ['medium', 'high'],
        defaultEffort: 'high',
      },
    ];
    const adaptive = {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
    };
    const resolve = (
      request: AnthropicRequestSubset,
      policy: {
        model?: string;
        providerEffort?: string;
        agentEffort?: string;
      } = {},
    ) =>
      resolveGatewayReasoningEffort(request, {
        catalog,
        model: policy.model ?? 'gpt-6-sol',
        providerEffort: policy.providerEffort,
        agentEffort: policy.agentEffort,
      });

    test('inheriting Agents get the provider effort or the catalog default', () => {
      expect(resolve(adaptive)).toBe('medium');
      expect(resolve(adaptive, { providerEffort: 'xhigh' })).toBe('xhigh');
      expect(resolve(adaptive, { providerEffort: 'minimal' })).toBe('low');
      expect(resolve(adaptive, { model: 'capped' })).toBe('high');
      expect(
        resolve(adaptive, { model: 'capped', providerEffort: 'ultra' }),
      ).toBe('high');
    });

    test('an explicit Agent effort wins over the provider effort', () => {
      expect(
        resolve(
          { thinking: { type: 'adaptive' } },
          { providerEffort: 'low', agentEffort: 'xhigh' },
        ),
      ).toBe('xhigh');
      expect(
        resolve(
          { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
          { providerEffort: 'low', agentEffort: 'xhigh' },
        ),
      ).toBe('high');
      expect(
        resolve(
          { thinking: { type: 'adaptive' } },
          { model: 'capped', agentEffort: 'max' },
        ),
      ).toBe('high');
    });

    test('disabled thinking maps to the lowest supported level, never none', () => {
      expect(resolve({ thinking: { type: 'disabled' } })).toBe('low');
      expect(
        resolve({ thinking: { type: 'disabled' } }, { model: 'capped' }),
      ).toBe('medium');
      expect(
        resolve(
          { thinking: { type: 'enabled', budget_tokens: 0 } },
          { agentEffort: 'max', providerEffort: 'high' },
        ),
      ).toBe('low');
    });

    test('haiku-tier background requests use low', () => {
      expect(
        resolve(
          { model: 'claude-3-5-haiku-latest', ...adaptive },
          { providerEffort: 'xhigh', agentEffort: 'max' },
        ),
      ).toBe('low');
      expect(
        resolve(
          { model: 'claude-haiku-4-5', ...adaptive },
          { model: 'capped' },
        ),
      ).toBe('medium');
    });
  });

  test('translates speed/service-tier priority without forwarding unsupported tier names', () => {
    expect(
      convert({ messages: [user('hi')], speed: 'fast' }).service_tier,
    ).toBe('priority');
    expect(
      convert({ messages: [user('hi')], service_tier: ' PRIORITY ' })
        .service_tier,
    ).toBe('priority');
    expect(
      convert({ messages: [user('hi')], service_tier: 'standard' }),
    ).not.toHaveProperty('service_tier');
  });
});

describe('structured output and native web search', () => {
  test('preserves fully required JSON output schemas and downgrades incomplete nested strict schemas', () => {
    const valid = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
    expect(
      convert({
        messages: [user('hi')],
        output_config: { format: { type: 'json_schema', schema: valid } },
      }).text,
    ).toEqual({
      verbosity: 'low',
      format: {
        type: 'json_schema',
        strict: true,
        schema: valid,
        name: 'codex_output_schema',
      },
    });
    const optional = {
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { value: { type: 'string' } } },
      },
      required: ['nested'],
    };
    expect(
      convert({
        messages: [user('hi')],
        output_config: {
          format: { type: 'json_schema', name: 'custom', schema: optional },
        },
      }).text!.format,
    ).toMatchObject({ name: 'custom', strict: false, schema: optional });
    expect(
      convert({
        messages: [user('hi')],
        output_config: {
          format: { type: 'json_schema', strict: false, schema: valid },
        },
      }).text!.format.strict,
    ).toBe(false);
  });

  test.each(['web_search_20250305', 'web_search_20260209'])(
    'translates typed search %s without treating local tools with the same name as native',
    (type) => {
      const converted = convert({
        messages: [user('hi')],
        tools: [
          {
            type,
            name: 'browser_search',
            allowed_domains: ['example.com'],
            user_location: { type: 'approximate', city: 'Paris' },
          },
          tool('web_search'),
        ],
        tool_choice: { type: 'tool', name: 'browser_search' },
      });
      expect(JSON.stringify(converted.tools![0])).toBe(
        JSON.stringify({
          type: 'web_search',
          external_web_access: true,
          filters: { allowed_domains: ['example.com'] },
          user_location: { type: 'approximate', city: 'Paris' },
          search_content_types: ['text', 'image'],
        }),
      );
      expect(converted.tools![1]).toMatchObject({
        type: 'function',
        name: 'web_search',
      });
      expect(converted.tool_choice).toEqual({ type: 'web_search' });
      expect(converted.include).toEqual(['reasoning.encrypted_content']);
    },
  );

  test('accepts server-search response history and does not invent client function calls', () => {
    const request = CodexMessagesRequestSchema.parse({
      messages: [
        user('search'),
        {
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 'ws_1',
              name: 'web_search',
              input: { query: 'research' },
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'ws_1',
              content: [
                {
                  type: 'web_search_result',
                  url: 'https://example.com',
                  title: 'Example',
                  page_age: null,
                },
              ],
            },
            { type: 'text', text: 'Answer with sources' },
          ],
        },
      ],
    });
    const converted = convert(request);
    expect(converted.input.map((item) => item.type)).toEqual([
      'message',
      'message',
    ]);
    expect((converted.input[1].content as Json[])[0].text).toBe(
      'Answer with sources',
    );
  });
});

describe('consumed-shape validation', () => {
  test.each([
    { tool_choice: { type: 'auto', disable_parallel_tool_use: 'yes' } },
    { thinking: { type: 'enabled', budget_tokens: -2 } },
    { thinking: { type: 'enabled', budget_tokens: '8192' } },
    { output_config: { format: { type: 'json_schema', schema: [] } } },
    {
      output_config: {
        format: { type: 'json_schema', schema: {}, strict: 'yes' },
      },
    },
    {
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          allowed_domains: 'example.com',
        },
      ],
    },
    {
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          user_location: { type: 'precise' },
        },
      ],
    },
  ])('rejects malformed consumed configuration: %j', (configuration) => {
    expect(
      CodexMessagesRequestSchema.safeParse({
        messages: [user('hi')],
        ...configuration,
      }).success,
    ).toBe(false);
  });

  test('degrades unsupported image and document sources to visible placeholders', () => {
    const request = CodexMessagesRequestSchema.parse({
      messages: [
        user([
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/image.png' },
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/bmp', data: 'Ym1w' },
          },
          {
            type: 'document',
            title: 'Notes',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: Buffer.from('plain text body').toString('base64'),
            },
          },
          {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: 'inline' },
          },
          {
            type: 'document',
            source: { type: 'url', url: 'https://example.com/a.pdf' },
          },
        ]),
      ],
    });
    const texts = convert(request).input[0].content.map(
      (part: Record<string, unknown>) => part.text,
    );
    expect(texts[0]).toContain('[Image omitted');
    expect(texts[0]).toContain('https://example.com/image.png');
    expect(texts[1]).toContain('image/bmp');
    expect(texts[2]).toBe('Notes\n\nplain text body');
    expect(texts[3]).toBe('inline');
    expect(texts[4]).toContain('[Document omitted');
  });

  test('degrades tool-result documents and unknown blocks instead of rejecting the history', () => {
    const request = CodexMessagesRequestSchema.parse({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call', name: 'Read', input: {} },
            { type: 'mcp_tool_use', id: 'server', name: 'x', input: {} },
          ],
        },
        user([
          {
            type: 'tool_result',
            tool_use_id: 'call',
            content: [
              { type: 'text', text: 'head' },
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: 'JVBERi0=',
                },
              },
              {
                type: 'search_result',
                content: [{ type: 'text', text: 'hit' }],
              },
            ],
          },
          { type: 'container_upload', file_id: 'file_1' },
        ]),
      ],
    });
    const converted = convert(request);
    // The server-side assistant block is dropped, not replayed as a call.
    expect(
      converted.input.filter((item) => item.type === 'function_call'),
    ).toHaveLength(1);
    const output = converted.input.find(
      (item) => item.type === 'function_call_output',
    )!.output as Array<Record<string, unknown>>;
    expect(output[0]).toEqual({ type: 'input_text', text: 'head' });
    expect(output[1].text).toContain('[Document omitted from tool result');
    expect(output[2].text).toContain('hit');
    const trailing = converted.input.at(-1)!;
    expect(JSON.stringify(trailing)).toContain(
      'Unsupported container_upload content omitted',
    );
  });

  test('still rejects malformed known blocks and names their field path', () => {
    const result = CodexMessagesRequestSchema.safeParse({
      messages: [user([{ type: 'tool_result', content: 'missing id' }])],
    });
    expect(result.success).toBe(false);
    expect(describeCodexRequestIssue(result.error!)).toBe(
      'Invalid messages request at messages.0.content.0.tool_use_id (invalid_type)',
    );
  });

  test('preserves unrelated SDK fields through validation but omits them upstream', () => {
    const request = CodexMessagesRequestSchema.parse({
      messages: [user('hi')],
      metadata: { user_id: 'session' },
      context_management: { edits: [] },
      temperature: 1,
      max_tokens: 100,
    });
    const converted = convert(request);
    for (const field of [
      'metadata',
      'context_management',
      'temperature',
      'max_tokens',
    ])
      expect(converted).not.toHaveProperty(field);
  });
});

describe('official Responses Lite request shape', () => {
  const lite = { targetModel: 'gpt-6-sol', threadId: 'thread-1' };
  const tools = [
    {
      name: 'Bash',
      description: 'Run a command',
      input_schema: {
        type: 'object',
        properties: {
          timeout: { type: 'number', minimum: 0 },
          command: { type: 'string', description: 'Cmd', pattern: '.*' },
        },
        required: ['command'],
      },
    },
    {
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
      },
    },
  ];

  test('puts tools in an additional_tools prefix with the official functions namespace and id', () => {
    const converted = anthropicToResponses(
      {
        system: 'Rules',
        messages: [user([{ type: 'text', text: 'hi' }, image])],
        tools,
        thinking: { type: 'adaptive' },
      },
      lite,
    );
    expect(converted).not.toHaveProperty('tools');
    // Expected id computed independently with Python's uuid.uuid5 over the
    // compact JSON below; the same derivation reproduces ids captured from a
    // real codex-cli 0.162.1 request.
    expect(JSON.stringify(converted.input[0])).toBe(
      JSON.stringify({
        type: 'additional_tools',
        id: 'at_81767038-dbc1-5397-802c-57a7852cfd0f',
        role: 'developer',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            description: '',
            tools: [
              {
                type: 'function',
                name: 'Bash',
                description: 'Run a command',
                strict: false,
                parameters: {
                  type: 'object',
                  properties: {
                    command: { type: 'string', description: 'Cmd' },
                    timeout: { type: 'number' },
                  },
                  required: ['command'],
                },
              },
              {
                type: 'function',
                name: 'Read',
                description: '',
                strict: false,
                parameters: {
                  type: 'object',
                  properties: { path: { type: 'string' } },
                },
              },
            ],
          },
        ],
      }),
    );
    expect(converted.input[1]).toMatchObject({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'Rules' }],
    });
    // Lite strips image detail.
    expect(converted.input[2].content[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,c2NyZWVu',
    });
    expect(converted.tool_choice).toBe('auto');
    expect(converted.parallel_tool_calls).toBe(false);
    expect(converted.reasoning).toEqual({
      effort: 'xhigh',
      summary: 'auto',
      context: 'all_turns',
    });
    expect(converted.text).toEqual({ verbosity: 'low' });
    expect(codexRequestUsesResponsesLite({ tools }, 'gpt-6-sol')).toBe(true);
  });

  test('keeps the prefix id stable per thread and changes it across threads', () => {
    const id = (threadId?: string) =>
      anthropicToResponses(
        { system: 'Rules', messages: [user('hi')], tools },
        { targetModel: 'gpt-6-sol', threadId },
      ).input[0].id;
    expect(id('thread-1')).toBe(id('thread-1'));
    expect(id('thread-2')).not.toBe(id('thread-1'));
    // No session identity: deterministic fallback from the system prompt.
    expect(id()).toBe(id());
    expect(id()).not.toBe(id('thread-1'));
  });

  test('replays calls in the functions namespace and strips tool-output image detail', () => {
    const converted = anthropicToResponses(
      {
        messages: [
          { role: 'assistant', content: [call('c1', 'Bash')] },
          user([result('c1', [image])]),
        ],
        tools,
      },
      lite,
    );
    expect(JSON.stringify(converted.input[1])).toBe(
      JSON.stringify({
        type: 'function_call',
        name: 'Bash',
        namespace: 'functions',
        arguments: '{"q":"c1"}',
        call_id: 'c1',
      }),
    );
    expect(converted.input[2].output).toEqual([
      { type: 'input_image', image_url: 'data:image/png;base64,c2NyZWVu' },
    ]);
  });

  test('maps forced choices to string modes and omits the prefix without tools', () => {
    const choice = (tool_choice: Json) =>
      anthropicToResponses({ messages: [user('hi')], tools, tool_choice }, lite)
        .tool_choice;
    expect(choice({ type: 'tool', name: 'Read' })).toBe('required');
    expect(choice({ type: 'any' })).toBe('required');
    expect(choice({ type: 'none' })).toBe('none');
    const bare = anthropicToResponses(
      { messages: [user('hi')], tool_choice: { type: 'any' } },
      lite,
    );
    expect(bare.input.map((item) => item.type)).toEqual(['message']);
    expect(bare.tool_choice).toBe('auto');
    expect(bare.parallel_tool_calls).toBe(false);
  });

  test('keeps requests with server web search in the classic shape', () => {
    const request = {
      messages: [user('search')],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }, ...tools],
    };
    expect(codexRequestUsesResponsesLite(request, 'gpt-6-sol')).toBe(false);
    const converted = anthropicToResponses(request, lite);
    expect(converted.input[0].type).toBe('message');
    expect(converted.tools!.map((definition) => definition.type)).toEqual([
      'web_search',
      'function',
      'function',
    ]);
    expect(converted.parallel_tool_calls).toBe(true);
    expect(converted.reasoning).not.toHaveProperty('context');
  });
});

describe('catalog-driven request traits and body order', () => {
  test('uses the catalog for lite, verbosity and Fast tier; unknown models get the classic shape', () => {
    const fast = { messages: [user('hi')], speed: 'fast' };
    const known = anthropicToResponses(fast, { targetModel: 'gpt-6-luna' });
    expect(known.service_tier).toBe('priority');
    expect(known.text).toEqual({ verbosity: 'low' });
    expect(known.reasoning.context).toBe('all_turns');
    const unknown = anthropicToResponses(fast, { targetModel: 'gpt-9-future' });
    expect(unknown).not.toHaveProperty('service_tier');
    expect(unknown).not.toHaveProperty('text');
    expect(unknown.reasoning).not.toHaveProperty('context');
    // A provider catalog decides first; entries without shape data fall back.
    const catalog = [
      {
        value: 'gpt-9-future',
        label: 'future',
        efforts: ['low'],
        useResponsesLite: true,
        supportsVerbosity: true,
        defaultVerbosity: 'high' as const,
        serviceTiers: [],
      },
      { value: 'gpt-6-luna', label: 'luna', efforts: ['low'] },
    ];
    const live = anthropicToResponses(fast, {
      targetModel: 'gpt-9-future',
      catalog,
    });
    expect(live.text).toEqual({ verbosity: 'high' });
    expect(live.reasoning.context).toBe('all_turns');
    expect(live).not.toHaveProperty('service_tier');
    expect(
      anthropicToResponses(fast, { targetModel: 'gpt-6-luna', catalog })
        .service_tier,
    ).toBe('priority');
  });

  test('serializes keys in the official ResponsesApiRequest order', () => {
    const converted = anthropicToResponses(
      {
        system: 'Rules',
        messages: [user('hi')],
        tools: [tool('Bash')],
        speed: 'fast',
        output_config: {
          format: { type: 'json_schema', schema: { type: 'object' } },
        },
      },
      options,
    );
    const body = JSON.parse(
      serializeCodexResponsesRequest(
        { client_metadata: { stale: 'x' }, ...converted } as never,
        { promptCacheKey: 'cache', clientMetadata: { turn_id: 't' } },
      ),
    );
    expect(Object.keys(body)).toEqual([
      'model',
      'stream',
      'service_tier',
      'input',
      'tools',
      'tool_choice',
      'parallel_tool_calls',
      'reasoning',
      'store',
      'include',
      'prompt_cache_key',
      'text',
      'client_metadata',
    ]);
    expect(body.client_metadata).toEqual({ turn_id: 't' });
    expect(Object.keys(body.text)).toEqual(['verbosity', 'format']);
    expect(Object.keys(body.text.format)).toEqual([
      'type',
      'strict',
      'schema',
      'name',
    ]);
    expect(Object.keys(body.tools[0])).toEqual([
      'type',
      'name',
      'description',
      'strict',
      'parameters',
    ]);
    expect(
      Object.keys(JSON.parse(serializeCodexResponsesRequest(converted))),
    ).not.toContain('prompt_cache_key');
  });

  test('requests a reasoning summary unless thinking is explicitly disabled', () => {
    const summary = (thinking?: Json) =>
      convert({ messages: [user('hi')], thinking }).reasoning.summary;
    expect(summary()).toBe('auto');
    expect(summary({ type: 'adaptive' })).toBe('auto');
    expect(summary({ type: 'enabled', budget_tokens: 2048 })).toBe('auto');
    expect(summary({ type: 'disabled' })).toBeUndefined();
    expect(summary({ type: 'enabled', budget_tokens: 0 })).toBeUndefined();
  });
});

describe('assistant-side media and PDF delivery', () => {
  test('turns assistant images and documents into output_text placeholders', () => {
    const converted = convert({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'see' },
            image,
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: 'cGRm',
              },
            },
            {
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', data: 'note' },
            },
          ],
        },
      ],
    });
    const content = converted.input[0].content as Json[];
    expect(content.map((part) => part.type)).toEqual([
      'output_text',
      'output_text',
      'output_text',
      'output_text',
    ]);
    expect(content[1].text).toContain('[Image omitted');
    expect(content[2].text).toContain(
      '[Document omitted from assistant message',
    );
    expect(content[3].text).toBe('note');
  });

  test('falls back to a visible placeholder when PDFs are not sent as files', () => {
    const pdf = {
      type: 'document',
      title: 'Spec',
      source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
    };
    const sent = convert({ messages: [user([pdf])] });
    expect(sent.input[0].content[0].type).toBe('input_file');
    const placeholder = anthropicToResponses(
      { messages: [user([pdf])] },
      { ...options, sendPdfAsInputFile: false },
    );
    expect(placeholder.input[0].content).toEqual([
      {
        type: 'input_text',
        text: '[Document omitted: application/pdf documents are not supported by the ChatGPT backend]',
      },
    ]);
  });
});

describe('Claude Code tool search', () => {
  const request = {
    messages: [
      user('find a tool'),
      {
        role: 'assistant',
        content: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'tool_search_tool_regex',
            input: { pattern: 'read' },
          },
          {
            type: 'tool_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: {
              type: 'tool_search_tool_search_result',
              tool_references: [{ type: 'tool_reference', tool_name: 'Read' }],
            },
          },
          call('c1', 'ToolSearch'),
        ],
      },
      user([
        result('c1', [
          {
            type: 'tool_reference',
            tool_name: `mcp__${'long_server_'.repeat(6)}__read`,
          },
        ]),
        { type: 'tool_reference', tool_name: 'Read' },
      ]),
    ],
    tools: [
      {
        type: 'tool_search_tool_regex_20251119',
        name: 'tool_search_tool_regex',
      },
      tool('ToolSearch'),
      { ...tool('Read'), defer_loading: true },
      {
        ...tool(`mcp__${'long_server_'.repeat(6)}__read`),
        defer_loading: true,
      },
    ],
  };

  test('accepts the search tool, declares deferred tools upfront and drops the server tool', () => {
    const parsed = CodexMessagesRequestSchema.parse(request);
    const converted = convert(parsed);
    expect(converted.tools!.map((definition) => definition.name)).toEqual([
      'ToolSearch',
      'Read',
      'mcp__read',
    ]);
    expect(JSON.stringify(converted.tools)).not.toContain('defer_loading');
    // Server-side search history is skipped; client ToolSearch replays.
    expect(converted.input.map((item) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_output',
      'message',
    ]);
    expect(converted.input[2].output).toEqual([
      { type: 'input_text', text: '[Tool available: mcp__read]' },
    ]);
    expect(converted.input[3].content).toEqual([
      { type: 'input_text', text: '[Tool available: Read]' },
    ]);
    const lite = anthropicToResponses(parsed, { targetModel: 'gpt-6-sol' });
    expect(
      (lite.input[0].tools[0].tools as Json[]).map((entry) => entry.name),
    ).toEqual(['ToolSearch', 'Read', 'mcp__read']);
  });
});

describe('background requests behind the Codex gateway', () => {
  test('the gateway haiku default is a background request at low effort', () => {
    const request = {
      model: 'claude-haiku-5-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'max' },
    };
    expect(
      resolveGatewayReasoningEffort(request, {
        catalog: [],
        model: 'gpt-6-sol',
        providerEffort: 'xhigh',
        agentEffort: 'max',
      }),
    ).toBe('low');
    expect(
      resolveGatewayReasoningEffort(
        { ...request, model: 'gpt-6-sol' },
        { catalog: [], model: 'gpt-6-sol', providerEffort: 'xhigh' },
      ),
    ).toBe('xhigh');
  });
});
