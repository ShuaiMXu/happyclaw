import { describe, expect, test } from 'vitest';

import {
  resolveCompatibleChannelBatchAnchor,
  resolveForwardBundleBatchAnchor,
} from '../src/forward-bundle-batch.js';
import type {
  ChannelContentLink,
  ChannelTurnContext,
  NewMessage,
} from '../src/types.js';

function message(input: {
  id: string;
  sourceJid: string;
  link: ChannelContentLink;
  rootId?: string;
  threadId?: string;
  accountId?: string;
}): NewMessage {
  const context: ChannelTurnContext = {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId: input.accountId ?? 'bot-a',
    sourceJid: input.sourceJid,
    chat: { id: 'oc_chat', type: 'group' },
    message: {
      id: input.id,
      type: input.link.role === 'forwarded_content' ? 'merge_forward' : 'text',
      contentLink: input.link,
      ...(input.rootId ? { rootId: input.rootId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
  };
  return {
    id: input.id,
    chat_jid: 'web:workspace',
    source_jid: input.sourceJid,
    sender: 'Alice',
    content: input.id,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    channel_context: context,
  };
}

const rootLink: ChannelContentLink = {
  kind: 'forward_bundle',
  bundleId: 'om_root',
  role: 'forwarded_content',
};
const noteLink: ChannelContentLink = {
  kind: 'forward_bundle',
  bundleId: 'om_root',
  role: 'forwarder_comment',
  relatedMessageId: 'om_root',
};

describe('forward bundle batch routing', () => {
  test('selects the authored note despite different native route fragments', () => {
    const root = message({
      id: 'om_root',
      sourceJid: 'feishu:bot-a:oc_chat',
      link: rootLink,
    });
    const note = message({
      id: 'om_note',
      sourceJid: 'feishu:bot-a:oc_chat#root:om_root',
      rootId: 'om_root',
      link: noteLink,
    });

    expect(resolveForwardBundleBatchAnchor([root, note])).toEqual({
      context: note.channel_context,
      message: note,
    });
  });

  test('accepts multiple notes from the same structurally asserted bundle', () => {
    const root = message({
      id: 'om_root',
      sourceJid: 'feishu:bot-a:oc_chat',
      link: rootLink,
    });
    const firstNote = message({
      id: 'om_note_1',
      sourceJid: 'feishu:bot-a:oc_chat#root:om_root',
      rootId: 'om_root',
      link: noteLink,
    });
    const lastNote = message({
      id: 'om_note_2',
      sourceJid: 'feishu:bot-a:oc_chat#root:om_root',
      rootId: 'om_root',
      link: noteLink,
    });

    expect(
      resolveForwardBundleBatchAnchor([root, firstNote, lastNote])?.message.id,
    ).toBe('om_note_2');
  });

  test('rejects unrelated rows, accounts, bundles, and incompatible threads', () => {
    const root = message({
      id: 'om_root',
      sourceJid: 'feishu:bot-a:oc_chat#thread:a',
      threadId: 'a',
      link: rootLink,
    });
    const note = message({
      id: 'om_note',
      sourceJid: 'feishu:bot-a:oc_chat#thread:b#root:om_root',
      rootId: 'om_root',
      threadId: 'b',
      link: noteLink,
    });
    expect(resolveForwardBundleBatchAnchor([root, note])).toBeUndefined();
    expect(
      resolveForwardBundleBatchAnchor([
        root,
        { ...note, channel_context: undefined },
      ]),
    ).toBeUndefined();
    expect(
      resolveForwardBundleBatchAnchor([
        root,
        message({
          id: 'om_note',
          sourceJid: 'feishu:bot-b:oc_chat#root:om_root',
          rootId: 'om_root',
          accountId: 'bot-b',
          link: noteLink,
        }),
      ]),
    ).toBeUndefined();
    expect(
      resolveForwardBundleBatchAnchor([
        root,
        message({
          id: 'om_note',
          sourceJid: 'feishu:bot-a:oc_chat#root:om_other',
          rootId: 'om_other',
          link: { ...noteLink, bundleId: 'om_other' },
        }),
      ]),
    ).toBeUndefined();
  });

  test('keeps slash/plugin notes out of a shared Agent delivery receipt', () => {
    const root = message({
      id: 'om_root',
      sourceJid: 'feishu:bot-a:oc_chat',
      link: rootLink,
    });
    const pluginNote = message({
      id: 'om_note',
      sourceJid: 'feishu:bot-a:oc_chat#root:om_root',
      rootId: 'om_root',
      link: noteLink,
    });
    pluginNote.content = '/plugin analyze';

    expect(resolveForwardBundleBatchAnchor([root, pluginNote])).toBeUndefined();
  });

  test('keeps a mixed cold batch on the latest route of the same provider chat', () => {
    const ordinary = message({
      id: 'om_ordinary',
      sourceJid: 'feishu:bot-a:oc_chat',
      link: rootLink,
    });
    ordinary.channel_context!.message.contentLink = undefined;
    const root = message({
      id: 'om_root',
      sourceJid: 'feishu:bot-a:oc_chat',
      link: rootLink,
    });
    const note = message({
      id: 'om_note',
      sourceJid: 'feishu:bot-a:oc_chat#root:om_root',
      rootId: 'om_root',
      link: noteLink,
    });

    expect(
      resolveCompatibleChannelBatchAnchor([ordinary, root, note])?.context
        .sourceJid,
    ).toBe('feishu:bot-a:oc_chat#root:om_root');
  });

  test('rejects unrelated threads in the same provider chat', () => {
    const unrelated = message({
      id: 'om_unrelated',
      sourceJid: 'feishu:bot-a:oc_chat#root:om_unrelated',
      rootId: 'om_unrelated',
      link: rootLink,
    });
    unrelated.channel_context!.message.contentLink = undefined;
    const root = message({
      id: 'om_root',
      sourceJid: 'feishu:bot-a:oc_chat',
      link: rootLink,
    });
    const note = message({
      id: 'om_note',
      sourceJid: 'feishu:bot-a:oc_chat#root:om_root',
      rootId: 'om_root',
      link: noteLink,
    });

    expect(
      resolveCompatibleChannelBatchAnchor([unrelated, root, note]),
    ).toBeUndefined();
  });

  test('rejects a top-level message mixed with a threaded bundle', () => {
    const ordinary = message({
      id: 'om_ordinary',
      sourceJid: 'feishu:bot-a:oc_chat',
      link: rootLink,
    });
    ordinary.channel_context!.message.contentLink = undefined;
    const threadedRoot = message({
      id: 'om_root',
      sourceJid: 'feishu:bot-a:oc_chat#thread:thread-b',
      threadId: 'thread-b',
      link: rootLink,
    });
    const threadedNote = message({
      id: 'om_note',
      sourceJid: 'feishu:bot-a:oc_chat#thread:thread-b#root:om_root',
      rootId: 'om_root',
      threadId: 'thread-b',
      link: noteLink,
    });

    expect(
      resolveCompatibleChannelBatchAnchor([
        ordinary,
        threadedRoot,
        threadedNote,
      ]),
    ).toBeUndefined();
  });

  test('does not use a bundle note route for a later unrelated message', () => {
    const root = message({
      id: 'om_root',
      sourceJid: 'feishu:bot-a:oc_chat',
      link: rootLink,
    });
    const note = message({
      id: 'om_note',
      sourceJid: 'feishu:bot-a:oc_chat#root:om_root',
      rootId: 'om_root',
      link: noteLink,
    });
    const ordinary = message({
      id: 'om_later',
      sourceJid: 'feishu:bot-a:oc_chat',
      link: rootLink,
    });
    ordinary.channel_context!.message.contentLink = undefined;

    expect(
      resolveCompatibleChannelBatchAnchor([root, note, ordinary]),
    ).toBeUndefined();
  });
});
