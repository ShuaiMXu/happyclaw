// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { SessionModelSelection } from './ModelSelector';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: { get: mocks.get, put: mocks.put },
}));
vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ hasPermission: () => false }),
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const { ModelSelector, describeDefaultModel } = await import('./ModelSelector');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function selection(
  overrides: Partial<SessionModelSelection> = {},
): SessionModelSelection {
  return {
    selectedModelConfigId: null,
    default: { source: 'pool', modelConfigId: null, enabledCount: 2 },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
      },
      {
        id: 'glm',
        name: 'GLM',
        kind: 'third_party',
        enabled: false,
        model: 'glm-5.3[1m]',
      },
    ],
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render(agentId: string | null, canChange = true) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ModelSelector
          groupJid="web:ws"
          agentId={agentId}
          canChange={canChange}
        />
      </MemoryRouter>,
    );
  });
}

function trigger(): HTMLButtonElement {
  const button = container.querySelector('button');
  if (!button) throw new Error('model selector trigger not rendered');
  return button;
}

describe('describeDefaultModel', () => {
  test('names the configuration an Agent or single provider resolves to', () => {
    expect(
      describeDefaultModel(
        selection({
          default: { source: 'agent', modelConfigId: 'glm', enabledCount: 1 },
        }),
      ),
    ).toBe('GLM');
    expect(describeDefaultModel(selection())).toBe('自动 · 2 个');
  });
});

describe('ModelSelector', () => {
  test('loads the conversation selection and labels the default', async () => {
    mocks.get.mockResolvedValue(selection());
    await render('session-1');
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection?agentId=session-1',
    );
    expect(trigger().textContent).toContain('默认 · 自动 · 2 个');
    expect(trigger().disabled).toBe(false);
  });

  test('shows the picked configuration and is read-only without Modify', async () => {
    mocks.get.mockResolvedValue(selection({ selectedModelConfigId: 'glm' }));
    await render(null, false);
    expect(mocks.get).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
    );
    expect(trigger().textContent).toContain('GLM');
    expect(trigger().disabled).toBe(true);
  });

  test('stays hidden when no model configuration exists', async () => {
    mocks.get.mockResolvedValue(selection({ options: [] }));
    await render(null);
    expect(container.querySelector('button')).toBeNull();
  });

  test('picking a configuration saves it for this conversation', async () => {
    mocks.get.mockResolvedValue(selection());
    mocks.put.mockResolvedValue(selection({ selectedModelConfigId: 'glm' }));
    await render('session-1');

    await act(async () => {
      trigger().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    const items = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ];
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('默认'),
      expect.stringContaining('Claude 官方'),
      expect.stringContaining('未启用'),
    ]);
    await act(async () => {
      items[2].click();
    });

    expect(mocks.put).toHaveBeenCalledWith(
      '/api/groups/web%3Aws/model-selection',
      { agentId: 'session-1', modelConfigId: 'glm' },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      '已切换到「GLM」，从下一条消息开始生效',
    );
    expect(trigger().textContent).toContain('GLM');
  });
});
