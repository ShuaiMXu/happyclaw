import { describe, expect, test } from 'vitest';

import { selectBatchProcessingIndicatorOwners } from '../src/processing-indicator-batch.js';

describe('batch processing indicator ownership', () => {
  test('selects only the latest Feishu input in one executing batch', () => {
    expect(
      selectBatchProcessingIndicatorOwners([
        { id: 'first', sourceJid: 'feishu:chat#thread:one' },
        { id: 'second', sourceJid: 'feishu:chat#thread:one' },
      ]),
    ).toEqual([
      {
        inputTurnId: 'second',
        transportJid: 'feishu:chat#thread:one',
      },
    ]);
  });

  test('keeps independent non-Feishu ingress acknowledgements exact', () => {
    expect(
      selectBatchProcessingIndicatorOwners([
        { id: 'telegram-a', sourceJid: 'telegram:chat' },
        { id: 'telegram-b', sourceJid: 'telegram:chat' },
      ]),
    ).toEqual([
      { inputTurnId: 'telegram-a', transportJid: 'telegram:chat' },
      { inputTurnId: 'telegram-b', transportJid: 'telegram:chat' },
    ]);
  });

  test('does not mirror an explicit Web input to a sticky IM fallback', () => {
    expect(
      selectBatchProcessingIndicatorOwners(
        [{ id: 'web-input', sourceJid: 'web:main' }],
        'feishu:chat',
      ),
    ).toEqual([]);
  });

  test('uses the active Feishu route when a warm cursor omits its source', () => {
    expect(
      selectBatchProcessingIndicatorOwners(
        [{ id: 'first' }, { id: 'second' }],
        'feishu:chat#thread:one',
      ),
    ).toEqual([
      {
        inputTurnId: 'second',
        transportJid: 'feishu:chat#thread:one',
      },
    ]);
  });
});
