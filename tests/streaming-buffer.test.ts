import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { StreamingBuffer } = await import('../src/streaming-buffer.js');
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('StreamingBuffer', () => {
  test('atomically persists and recovers active text through injected storage', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-streaming-buffer-'),
    );
    directories.push(directory);
    const active = new Map([['web:workspace', 'partial answer']]);
    const recovered = vi.fn();
    const buffer = new StreamingBuffer(directory, {
      getActiveTexts: () => active,
      persistInterrupted: recovered,
    });

    buffer.flush();
    expect(fs.readdirSync(directory)).toHaveLength(1);
    active.clear();
    buffer.recover();

    expect(recovered).toHaveBeenCalledWith(
      'web:workspace',
      'partial answer',
      'crash_recovery',
    );
    expect(fs.readdirSync(directory)).toHaveLength(0);
  });
});
