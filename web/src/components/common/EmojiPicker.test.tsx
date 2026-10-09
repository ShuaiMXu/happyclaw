// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { EmojiPicker } from './EmojiPicker';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('EmojiPicker', () => {
  test('normalizes a controlled Fluent value and resynchronizes the style', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root?.render(<EmojiPicker value="🐱" onChange={onChange} />);
    });
    expect(container?.textContent).toContain('当前选择：🐱');

    await act(async () => {
      root?.render(<EmojiPicker value=" FE083 " onChange={onChange} />);
    });

    expect(
      container?.querySelector('img[src$="/emoji/fluent3d/fe083.png"]'),
    ).not.toBeNull();
    expect(container?.textContent).not.toContain('FE083');
  });

  test('replaces a failed Fluent image without exposing its code', async () => {
    await act(async () => {
      root?.render(<EmojiPicker value="fe001" onChange={vi.fn()} />);
    });

    const image = container?.querySelector(
      'img[src$="/emoji/fluent3d/fe001.png"]',
    );
    expect(image).not.toBeNull();

    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });

    expect(
      container?.querySelector('[aria-label="咧嘴笑图片不可用"]'),
    ).not.toBeNull();
    expect(container?.textContent).not.toContain('fe001');
  });

  test('never displays an unknown Fluent-shaped value as classic text', async () => {
    await act(async () => {
      root?.render(<EmojiPicker value="fe999" onChange={vi.fn()} />);
    });

    expect(container?.textContent).not.toContain('fe999');
  });
});
