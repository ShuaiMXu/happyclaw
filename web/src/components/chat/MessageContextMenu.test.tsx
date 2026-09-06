// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const deleteMessageMock = vi.hoisted(() => vi.fn());

vi.mock('../../stores/chat', () => ({
  useChatStore: {
    getState: () => ({ deleteMessage: deleteMessageMock }),
  },
}));

const { MessageContextMenu } = await import('./MessageContextMenu');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  deleteMessageMock.mockReset();
  deleteMessageMock.mockResolvedValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  document.body
    .querySelectorAll('.fixed.inset-0')
    .forEach((node) => node.remove());
  root = null;
  container = null;
});

describe('MessageContextMenu deletion semantics', () => {
  test('states that deletion removes persisted history but does not retract active input', async () => {
    await act(async () => {
      root?.render(
        <MessageContextMenu
          content="sensitive prompt"
          position={{ x: 10, y: 10 }}
          chatJid="web:main#agent:session-1"
          messageId="message-1"
          onClose={vi.fn()}
        />,
      );
    });

    const initialDelete = [...document.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '删除聊天记录',
    );
    expect(initialDelete).toBeDefined();
    await act(async () =>
      initialDelete?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(document.body.textContent).toContain(
      '仅删除持久聊天记录，不会撤回正在处理的模型输入。',
    );
    expect(document.body.textContent).toContain('确认删除记录');
    expect(deleteMessageMock).not.toHaveBeenCalled();
  });
});
