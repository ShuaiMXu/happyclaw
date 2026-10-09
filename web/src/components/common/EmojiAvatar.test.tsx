// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { EmojiAvatar } from './EmojiAvatar';

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

describe('EmojiAvatar', () => {
  test('renders fe083 as a Fluent 3D image instead of text', async () => {
    await act(async () => {
      root?.render(<EmojiAvatar emoji="fe083" fallbackChar="agent" />);
    });

    expect(container?.querySelector('img')?.getAttribute('src')).toContain(
      '/emoji/fluent3d/fe083.png',
    );
    expect(container?.textContent).not.toContain('fe083');
  });

  test.each(['FE083', ' fe083 '])(
    'normalizes %s before resolving the Fluent asset',
    async (emoji) => {
      await act(async () => {
        root?.render(<EmojiAvatar emoji={emoji} fallbackChar="agent" />);
      });

      expect(container?.querySelector('img')?.getAttribute('src')).toContain(
        '/emoji/fluent3d/fe083.png',
      );
      expect(container?.textContent).not.toContain(emoji.trim());
    },
  );

  test('never renders an unknown Fluent-shaped token as avatar text', async () => {
    await act(async () => {
      root?.render(<EmojiAvatar emoji="fe999" fallbackChar="agent" />);
    });

    expect(container?.querySelector('img')).toBeNull();
    expect(container?.textContent).toBe('A');
    expect(container?.textContent).not.toContain('fe999');
  });

  test('falls back to the profile letter when a Fluent 3D asset fails', async () => {
    await act(async () => {
      root?.render(<EmojiAvatar emoji="fe001" fallbackChar="agent" />);
    });

    const image = container?.querySelector('img');
    expect(image?.getAttribute('src')).toContain('/emoji/fluent3d/fe001.png');

    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });

    expect(container?.querySelector('img')).toBeNull();
    expect(container?.textContent).toBe('A');
    expect(container?.textContent).not.toContain('fe001');
  });

  test('retries the Fluent 3D asset when the emoji changes', async () => {
    await act(async () => {
      root?.render(<EmojiAvatar emoji="fe001" fallbackChar="agent" />);
    });

    await act(async () => {
      container?.querySelector('img')?.dispatchEvent(new Event('error'));
    });
    expect(container?.querySelector('img')).toBeNull();

    await act(async () => {
      root?.render(<EmojiAvatar emoji="fe002" fallbackChar="agent" />);
    });

    expect(container?.querySelector('img')?.getAttribute('src')).toContain(
      '/emoji/fluent3d/fe002.png',
    );
  });
});
