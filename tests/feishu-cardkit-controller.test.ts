import { afterEach, describe, expect, test, vi } from 'vitest';
import { CARD_ELEMENT_IDS } from '../src/feishu-cards/sections.js';
import { StreamingCardController } from '../src/feishu-streaming-card.js';
import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';

function makeClient() {
  let cardNumber = 0;
  const cardCreate = vi.fn().mockImplementation(async () => ({
    code: 0,
    data: { card_id: `card_${++cardNumber}` },
  }));
  const batchUpdate = vi.fn().mockResolvedValue({ code: 0 });
  const elementContent = vi.fn().mockResolvedValue({ code: 0 });
  const cardSettings = vi.fn().mockResolvedValue({ code: 0 });
  const cardUpdate = vi.fn().mockResolvedValue({ code: 0 });
  const messageReply = vi
    .fn()
    .mockResolvedValue({ data: { message_id: 'om_card' } });
  const messageCreate = vi
    .fn()
    .mockResolvedValue({ data: { message_id: 'om_card' } });
  return {
    client: {
      cardkit: {
        v1: {
          card: {
            create: cardCreate,
            batchUpdate,
            settings: cardSettings,
            update: cardUpdate,
          },
          cardElement: {
            content: elementContent,
            update: vi.fn().mockResolvedValue({ code: 0 }),
          },
        },
      },
      im: {
        message: { reply: messageReply },
        v1: {
          message: {
            create: messageCreate,
            patch: vi.fn().mockResolvedValue({}),
          },
        },
      },
    },
    cardCreate,
    batchUpdate,
    elementContent,
    cardSettings,
    cardUpdate,
  };
}

function findElementContent(value: unknown, elementId: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findElementContent(item, elementId);
      if (found !== null) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.element_id === elementId && typeof record.content === 'string') {
    return record.content;
  }
  for (const child of Object.values(record)) {
    const found = findElementContent(child, elementId);
    if (found !== null) return found;
  }
  return null;
}

async function createThinkingController() {
  const mock = makeClient();
  const controller = new StreamingCardController({
    client: mock.client as any,
    chatId: 'oc_cardkit',
    replyToMsgId: 'om_root',
  });
  controller.setThinking();
  await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
  const backend = (controller as any).streamingBackend as {
    drain(): Promise<void>;
    updateMarkdownContents(
      patches: Array<{ elementId: string; content: string }>,
    ): Promise<{ updated: string[]; failed: string[] }>;
    updateMarkdownContent(elementId: string, content: string): Promise<void>;
    streamContent(content: string): Promise<void>;
  };
  await backend.drain();
  return { ...mock, controller, backend };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Feishu CardKit streaming controller', () => {
  test('thinking/tool-only runs start with deterministic progress instead of a bare ellipsis', async () => {
    const { cardCreate, controller } = await createThinkingController();
    const initialCard = JSON.parse(cardCreate.mock.calls[0][0].data.data);
    const main = findElementContent(initialCard, CARD_ELEMENT_IDS.MAIN_CONTENT);

    expect(main).toContain('正在分析请求');
    expect(main?.trim()).not.toBe('...');
    expect(
      typeof findElementContent(initialCard, CARD_ELEMENT_IDS.STATUS_BANNER),
    ).toBe('string');
    controller.dispose();
  });

  test('retracting provisional narration keeps the live main slot on a neutral placeholder', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_retract',
    });
    controller.append('过程说明');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();
    mock.elementContent.mockClear();

    controller.append('');
    await vi.waitFor(() =>
      expect(
        mock.elementContent.mock.calls.some(
          (call) => call[0].path.element_id === CARD_ELEMENT_IDS.MAIN_CONTENT,
        ),
      ).toBe(true),
    );
    await backend.drain();

    const mainUpdate = mock.elementContent.mock.calls.find(
      (call) => call[0].path.element_id === CARD_ELEMENT_IDS.MAIN_CONTENT,
    )![0];
    expect(mainUpdate.data.content).toContain('正在分析请求');
    expect(mainUpdate.data.content).not.toBe('');
    expect((controller as any).accumulatedText).toBe('');
    controller.dispose();
  });

  test('normal auxiliary flush is one idempotent batch mutation and preserves element structure', async () => {
    const { batchUpdate, controller, backend } =
      await createThinkingController();
    batchUpdate.mockClear();

    const current = (controller as any).buildRichPanelPatches();
    await backend.updateMarkdownContents([
      {
        elementId: CARD_ELEMENT_IDS.STATUS_BANNER,
        content: current.statusBanner,
      },
      {
        elementId: CARD_ELEMENT_IDS.FOOTER_NOTE,
        content: current.footerNote,
      },
    ]);
    expect(batchUpdate).not.toHaveBeenCalled();

    await backend.updateMarkdownContents([
      {
        elementId: CARD_ELEMENT_IDS.STATUS_BANNER,
        content: '调用工具 · WebSearch',
      },
      {
        elementId: CARD_ELEMENT_IDS.FOOTER_NOTE,
        content: '已用 10 秒',
      },
    ]);

    expect(batchUpdate).toHaveBeenCalledTimes(1);
    const payload = batchUpdate.mock.calls[0][0];
    expect(payload.data.sequence).toBeGreaterThan(1);
    expect(payload.data.uuid).toMatch(/^hc_[a-f0-9]{32}$/);
    expect(payload.data.uuid.length).toBeLessThanOrEqual(64);
    const actions = JSON.parse(payload.data.actions);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      action: 'partial_update_element',
      params: { element_id: CARD_ELEMENT_IDS.STATUS_BANNER },
    });
    expect(JSON.parse(actions[0].params.partial_element)).toEqual({
      content: '调用工具 · WebSearch',
    });
    expect(actions[0].params).not.toHaveProperty('element');
    controller.dispose();
  });

  test('batch transport retry reuses the exact sequence and UUID', async () => {
    const { batchUpdate, controller, backend } =
      await createThinkingController();
    batchUpdate.mockReset();
    batchUpdate
      .mockRejectedValueOnce(new Error('socket closed after write'))
      .mockResolvedValueOnce({ code: 0 });

    const result = await backend.updateMarkdownContents([
      {
        elementId: CARD_ELEMENT_IDS.STATUS_BANNER,
        content: '正在重试',
      },
    ]);

    expect(result.failed).toEqual([]);
    expect(batchUpdate).toHaveBeenCalledTimes(2);
    expect(batchUpdate.mock.calls[1][0].data.sequence).toBe(
      batchUpdate.mock.calls[0][0].data.sequence,
    );
    expect(batchUpdate.mock.calls[1][0].data.uuid).toBe(
      batchUpdate.mock.calls[0][0].data.uuid,
    );
    expect(batchUpdate.mock.calls[1][0].data.actions).toBe(
      batchUpdate.mock.calls[0][0].data.actions,
    );
    controller.dispose();
  });

  test('streaming-expired recovery re-enables first and retries with a newer sequence', async () => {
    const { elementContent, cardSettings, controller, backend } =
      await createThinkingController();
    elementContent.mockReset();
    cardSettings.mockClear();
    elementContent
      .mockRejectedValueOnce({ code: 200850 })
      .mockResolvedValueOnce({ code: 0 });

    await backend.streamContent('恢复后的正文');

    expect(elementContent).toHaveBeenCalledTimes(2);
    expect(cardSettings).toHaveBeenCalledTimes(1);
    const firstSequence = elementContent.mock.calls[0][0].data.sequence;
    const settingsSequence = cardSettings.mock.calls[0][0].data.sequence;
    const retrySequence = elementContent.mock.calls[1][0].data.sequence;
    expect(settingsSequence).toBeGreaterThan(firstSequence);
    expect(retrySequence).toBeGreaterThan(settingsSequence);
    expect(elementContent.mock.calls[0][0].data.uuid).not.toBe(
      elementContent.mock.calls[1][0].data.uuid,
    );
    controller.dispose();
  });

  test('a rejected batch isolates slots so one invalid panel cannot block status/footer', async () => {
    const { batchUpdate, elementContent, controller, backend } =
      await createThinkingController();
    batchUpdate.mockReset().mockResolvedValue({ code: 230099, msg: 'invalid' });
    elementContent.mockImplementation(async (request: any) => {
      if (request.path.element_id === CARD_ELEMENT_IDS.TASK_CONTENT) {
        return { code: 230099, msg: 'invalid task markdown' };
      }
      return { code: 0 };
    });

    const result = await backend.updateMarkdownContents([
      {
        elementId: CARD_ELEMENT_IDS.STATUS_BANNER,
        content: '仍在运行',
      },
      {
        elementId: CARD_ELEMENT_IDS.TASK_CONTENT,
        content: '<invalid>',
      },
      {
        elementId: CARD_ELEMENT_IDS.FOOTER_NOTE,
        content: '已用 15 秒',
      },
    ]);

    expect(batchUpdate).toHaveBeenCalledTimes(1);
    expect(elementContent).toHaveBeenCalledTimes(3);
    expect(result.updated).toEqual([
      CARD_ELEMENT_IDS.STATUS_BANNER,
      CARD_ELEMENT_IDS.FOOTER_NOTE,
    ]);
    expect(result.failed).toEqual([CARD_ELEMENT_IDS.TASK_CONTENT]);
    const sequences = elementContent.mock.calls.map(
      (call) => call[0].data.sequence as number,
    );
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    controller.dispose();
  });

  test('live content uses a code-fence-safe 30K view while retaining full terminal text', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_long',
    });
    const full = `\`\`\`typescript\n${'const value = 1;\n'.repeat(2500)}\`\`\``;
    controller.append(full);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));

    const initialCard = JSON.parse(mock.cardCreate.mock.calls[0][0].data.data);
    const main = findElementContent(
      initialCard,
      CARD_ELEMENT_IDS.MAIN_CONTENT,
    )!;
    expect(main.length).toBeLessThanOrEqual(30000);
    expect(main).toContain('完成后将展示完整结果');
    expect(main).toMatch(/```\n\n> ⚠️ 内容较长/);
    expect((controller as any).accumulatedText).toBe(full);
    controller.dispose();
  });

  test('terminal finalization drains queued mutations before disabling streaming', async () => {
    const { elementContent, cardSettings, cardUpdate, controller, backend } =
      await createThinkingController();
    const order: string[] = [];
    let release!: (value: { code: number }) => void;
    const pending = new Promise<{ code: number }>((resolve) => {
      release = resolve;
    });
    elementContent.mockImplementationOnce(async () => {
      order.push('content');
      return pending;
    });
    cardSettings.mockImplementation(async () => {
      order.push('settings');
      return { code: 0 };
    });
    cardUpdate.mockImplementation(async () => {
      order.push('update');
      return { code: 0 };
    });

    const mutation = backend.updateMarkdownContent('probe_slot', 'probe');
    await vi.waitFor(() => expect(order).toEqual(['content']));
    const completing = controller.complete('最终答复');
    await Promise.resolve();
    expect(order).toEqual(['content']);
    release({ code: 0 });
    await mutation;
    await completing;

    expect(order).toEqual(['content', 'settings', 'update']);
    expect(cardSettings.mock.calls[0][0].data.uuid).toMatch(/^hc_/);
    expect(cardUpdate.mock.calls[0][0].data.sequence).toBeGreaterThan(
      cardSettings.mock.calls[0][0].data.sequence,
    );
  });

  test.each(['v1', 'legacy'] as const)(
    '%s active fallback never patches an empty main body',
    async (mode) => {
      let createCount = 0;
      const cardUpdate = vi.fn().mockResolvedValue({ code: 0 });
      const messagePatch = vi.fn().mockResolvedValue({ code: 0 });
      const cardCreate = vi.fn().mockImplementation(async () => {
        createCount++;
        if (createCount === 1 || mode === 'legacy') {
          throw new Error('CardKit mode unavailable');
        }
        return { data: { card_id: 'card_v1' } };
      });
      const client = {
        cardkit: {
          v1: {
            card: { create: cardCreate, update: cardUpdate },
            cardElement: {},
          },
        },
        im: {
          message: {},
          v1: {
            message: {
              create: vi
                .fn()
                .mockResolvedValue({ data: { message_id: 'om_fallback' } }),
              patch: messagePatch,
            },
          },
        },
      };
      const controller = new StreamingCardController({
        client: client as any,
        chatId: `oc_${mode}`,
      });
      controller.append('过程说明');
      await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
      cardUpdate.mockClear();
      messagePatch.mockClear();

      controller.append('');
      await (controller as any).patchCard('streaming');

      const cardJson =
        mode === 'v1'
          ? JSON.parse(cardUpdate.mock.calls.at(-1)![0].data.card.data)
          : JSON.parse(messagePatch.mock.calls.at(-1)![0].data.content);
      expect(
        findElementContent(cardJson, CARD_ELEMENT_IDS.MAIN_CONTENT),
      ).toContain('正在分析请求');
      expect((controller as any).accumulatedText).toBe('');
      controller.dispose();
    },
  );

  test('accepted streaming message timeout is sticky and never creates a fallback card', async () => {
    const mock = makeClient();
    let visibleMutations = 0;
    const acceptedTimeout = Object.assign(
      new Error('message.create ACK timed out after acceptance'),
      { code: 'ETIMEDOUT' },
    );
    const messageCreate = vi.fn(async () => {
      visibleMutations += 1;
      throw acceptedTimeout;
    });
    mock.client.im.v1.message.create = messageCreate;
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_uncertain_create',
    });

    controller.append('answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('error'));

    expect(mock.cardCreate).toHaveBeenCalledOnce();
    expect(messageCreate).toHaveBeenCalledOnce();
    expect(visibleMutations).toBe(1);
    expect(controller.isActive()).toBe(true);
    await expect(controller.complete('answer')).rejects.toMatchObject({
      deliveryPhase: 'uncertain',
      cause: acceptedTimeout,
    });
    await expect(controller.complete('answer')).rejects.toMatchObject({
      deliveryPhase: 'uncertain',
    });
    expect(messageCreate).toHaveBeenCalledOnce();
    expect(visibleMutations).toBe(1);
    const aborted = await finalizeChannelCardAfterDelivery(
      controller,
      'answer',
      false,
      'attachment prerequisite failed',
    );
    expect(aborted).toMatchObject({
      acknowledged: false,
      error: { deliveryPhase: 'uncertain' },
    });
    expect(controller.currentState).toBe('aborted');
    expect(messageCreate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test.each([
    [408, 408],
    [503, 9999],
  ])(
    'HTTP %s with numeric body code %s remains uncertain and never switches backend',
    async (status, code) => {
      const mock = makeClient();
      let visibleMutations = 0;
      const messageCreate = vi.fn(async () => {
        visibleMutations += 1;
        throw Object.assign(new Error(`HTTP ${status} after mutation`), {
          response: { status, data: { code, msg: 'ambiguous response' } },
        });
      });
      mock.client.im.v1.message.create = messageCreate;
      const controller = new StreamingCardController({
        client: mock.client as any,
        chatId: `oc_http_${status}`,
      });

      controller.append('answer');
      await vi.waitFor(() => expect(controller.currentState).toBe('error'));

      expect(mock.cardCreate).toHaveBeenCalledOnce();
      expect(messageCreate).toHaveBeenCalledOnce();
      expect(visibleMutations).toBe(1);
      await expect(controller.complete('answer')).rejects.toMatchObject({
        deliveryPhase: 'uncertain',
      });
      controller.dispose();
    },
  );

  test('a successfully aborted visible card still fences static prerequisite fallback', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_visible_abort_fence',
    });
    controller.append('visible preview');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));

    const result = await finalizeChannelCardAfterDelivery(
      controller,
      'final answer',
      false,
      'attachment prerequisite failed',
    );

    expect(result).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
        totalOutputs: 2,
      },
    });
    expect(controller.currentState).toBe('aborted');
    expect(mock.client.im.v1.message.create).toHaveBeenCalledOnce();
    expect(mock.cardUpdate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test('an explicit streaming-message rejection still permits CardKit v1 fallback', async () => {
    const mock = makeClient();
    const messageCreate = vi
      .fn()
      .mockResolvedValueOnce({ code: 230001, msg: 'streaming unsupported' })
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_v1_fallback' },
      });
    mock.client.im.v1.message.create = messageCreate;
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_rejected_create',
    });

    controller.append('answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));

    expect(mock.cardCreate).toHaveBeenCalledTimes(2);
    expect(messageCreate).toHaveBeenCalledTimes(2);
    expect(controller.currentMessageId).toBe('om_v1_fallback');
    expect((controller as any).backendMode).toBe('v1');
    controller.dispose();
  });

  test('a proven pre-accept streaming-message failure permits CardKit v1 fallback', async () => {
    const mock = makeClient();
    const messageCreate = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), {
          code: 'ENOTFOUND',
        }),
      )
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_v1_after_preaccept' },
      });
    mock.client.im.v1.message.create = messageCreate;
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_preaccept_create',
    });

    controller.append('answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));

    expect(mock.cardCreate).toHaveBeenCalledTimes(2);
    expect(messageCreate).toHaveBeenCalledTimes(2);
    expect(controller.currentMessageId).toBe('om_v1_after_preaccept');
    expect((controller as any).backendMode).toBe('v1');
    controller.dispose();
  });

  test('accepted CardKit v1 message timeout never falls through to legacy create', async () => {
    const mock = makeClient();
    mock.cardCreate
      .mockRejectedValueOnce(new Error('streaming resource unavailable'))
      .mockResolvedValueOnce({ code: 0, data: { card_id: 'card_v1' } });
    let visibleMutations = 0;
    const messageCreate = vi.fn(async () => {
      visibleMutations += 1;
      throw Object.assign(new Error('v1 message ACK timed out'), {
        code: 'ETIMEDOUT',
      });
    });
    mock.client.im.v1.message.create = messageCreate;
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_uncertain_v1',
    });

    controller.append('answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('error'));

    expect(mock.cardCreate).toHaveBeenCalledTimes(2);
    expect(messageCreate).toHaveBeenCalledOnce();
    expect(visibleMutations).toBe(1);
    expect(controller.isActive()).toBe(true);
    await expect(controller.complete('answer')).rejects.toMatchObject({
      deliveryPhase: 'uncertain',
    });
    expect(messageCreate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test('unknown final update ACK is sticky and never tries a truncated second mutation', async () => {
    const mock = makeClient();
    const acceptedTimeout = Object.assign(
      new Error('card.update ACK timed out after acceptance'),
      { code: 'ETIMEDOUT' },
    );
    mock.cardUpdate.mockRejectedValue(acceptedTimeout);
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_uncertain_finalize',
    });
    controller.append('final answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));

    await expect(controller.complete('final answer')).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      cause: acceptedTimeout,
    });

    expect(mock.cardUpdate).toHaveBeenCalledOnce();
    expect(controller.currentState).toBe('error');
    await expect(controller.complete('final answer')).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
    });
    expect(mock.cardUpdate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test.each(['v1', 'legacy'] as const)(
    '%s unknown active-update ACK becomes sticky without a new message',
    async (mode) => {
      let cardCreates = 0;
      const cardCreate = vi.fn(async () => {
        cardCreates += 1;
        if (cardCreates === 1 || mode === 'legacy') {
          throw new Error('backend resource unavailable');
        }
        return { code: 0, data: { card_id: 'card_v1' } };
      });
      const acceptedTimeout = Object.assign(
        new Error(`${mode} update ACK timed out after acceptance`),
        { code: 'ETIMEDOUT' },
      );
      const cardUpdate = vi.fn(async () => {
        throw acceptedTimeout;
      });
      const messagePatch = vi.fn(async () => {
        throw acceptedTimeout;
      });
      const messageCreate = vi
        .fn()
        .mockResolvedValue({ code: 0, data: { message_id: `om_${mode}` } });
      const client = {
        cardkit: {
          v1: {
            card: {
              create: cardCreate,
              update: cardUpdate,
            },
            cardElement: {},
          },
        },
        im: {
          message: {},
          v1: { message: { create: messageCreate, patch: messagePatch } },
        },
      };
      const controller = new StreamingCardController({
        client: client as any,
        chatId: `oc_${mode}_sticky_update`,
      });
      controller.append('body');
      await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
      (controller as any).accumulatedText = 'body changed';

      await expect(
        (controller as any).patchCard('streaming'),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_PARTIAL',
        cause: acceptedTimeout,
      });

      expect(controller.currentState).toBe('error');
      expect(messageCreate).toHaveBeenCalledOnce();
      expect(mode === 'v1' ? cardUpdate : messagePatch).toHaveBeenCalledOnce();
      await expect(controller.complete('body')).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_PARTIAL',
      });
      expect(messageCreate).toHaveBeenCalledOnce();
      controller.dispose();
    },
  );

  // Regression: finalize enters the split branch on raw text length as well as
  // on card JSON size, and splitOnFinalize can still emit a SINGLE group. The
  // tail is then the reused streaming card rather than a continuation card.
  test('a split finalize that yields one group still lands the usage note on the tail card', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_split_tail',
    });

    const body = Array.from(
      { length: 40 },
      (_, i) => `paragraph ${i} ${'a'.repeat(370)}`,
    ).join('\n\n');
    expect(body.length).toBeGreaterThan(15000);
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThan(16 * 1024);

    controller.append(body);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();

    await controller.complete(body);
    expect(controller.currentState).toBe('completed');
    expect((controller as any).finalizedAsSplit).toBe(true);
    expect((controller as any).lastSplitCard).not.toBeNull();

    mock.cardUpdate.mockClear();
    await controller.patchUsageNote({
      inputTokens: 1200,
      outputTokens: 340,
      costUSD: 0.42,
      durationMs: 12000,
      numTurns: 3,
    });
    await backend.drain();

    const rendered = mock.cardUpdate.mock.calls
      .map((call) => String(call[0].data.card.data))
      .join('\n');
    expect(rendered).toContain('💰');
    expect(rendered).toContain('输入 1.2K');
    expect(rendered).toContain('输出 340');
    controller.dispose();
  });

  test('usage arriving while complete() is mid-flight still lands on the final card', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_usage_race',
    });
    controller.append('短回复正文');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();

    const completing = controller.complete('短回复正文');
    const patching = controller.patchUsageNote({
      inputTokens: 800,
      outputTokens: 120,
      costUSD: 0.1,
      durationMs: 5000,
      numTurns: 2,
    });
    await Promise.all([completing, patching]);
    await backend.drain();

    const lastCard = String(
      mock.cardUpdate.mock.calls.at(-1)![0].data.card.data,
    );
    expect(lastCard).toContain('meta_row');
    expect(lastCard).toContain('输出 120');
    expect(lastCard).toContain('输入 800');
    controller.dispose();
  });

  test('split finalize plus usage arriving mid-complete still lands on the tail', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_split_race',
    });
    const body = Array.from(
      { length: 40 },
      (_, i) => `paragraph ${i} ${'a'.repeat(370)}`,
    ).join('\n\n');
    controller.append(body);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();

    const completing = controller.complete(body);
    const patching = controller.patchUsageNote({
      inputTokens: 2100,
      outputTokens: 880,
      costUSD: 0.55,
      durationMs: 18000,
      numTurns: 4,
    });
    await Promise.all([completing, patching]);
    await backend.drain();

    expect((controller as any).finalizedAsSplit).toBe(true);
    const rendered = mock.cardUpdate.mock.calls
      .map((call) => String(call[0].data.card.data))
      .join('\n');
    expect(rendered).toContain('💰');
    expect(rendered).toContain('输出 880');
    controller.dispose();
  });

  test('multi-group split only patches the tail card with usage', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_split_groups',
    });
    const body = Array.from(
      { length: 60 },
      (_, i) => `block ${i} ${'b'.repeat(400)}`,
    ).join('\n\n');
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(16 * 1024);

    controller.append(body);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();

    await controller.complete(body);
    expect((controller as any).finalizedAsSplit).toBe(true);
    expect(mock.cardCreate.mock.calls.length).toBeGreaterThan(1);

    const updatesBeforeUsage = mock.cardUpdate.mock.calls.length;
    await controller.patchUsageNote({
      inputTokens: 900,
      outputTokens: 250,
      costUSD: 0.2,
      durationMs: 8000,
      numTurns: 2,
    });
    await backend.drain();

    const usageUpdates = mock.cardUpdate.mock.calls
      .slice(updatesBeforeUsage)
      .map((call) => String(call[0].data.card.data));
    expect(usageUpdates.length).toBeGreaterThan(0);
    expect(usageUpdates.some((card) => card.includes('💰'))).toBe(true);
    expect(usageUpdates.at(-1)).toContain('输出 250');
    controller.dispose();
  });

  test('aborted turns drop parked usage instead of patching later', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_abort_usage',
    });
    controller.append('进行中');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();

    await controller.patchUsageNote({
      inputTokens: 10,
      outputTokens: 4,
      costUSD: 0.01,
      durationMs: 100,
      numTurns: 1,
    });
    mock.cardUpdate.mockClear();
    await controller.abort('stopped');
    expect(controller.currentState).toBe('aborted');
    expect((controller as any).pendingUsage).toBeNull();
    const afterAbort = mock.cardUpdate.mock.calls
      .map((call) => String(call[0].data.card.data))
      .join('\n');
    expect(afterAbort).not.toContain('💰');
    controller.dispose();
  });
});
