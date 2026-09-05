import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src/index.ts'),
  'utf8',
);

describe('authorized chat unbind lifecycle', () => {
  test('/unbind clears the route without restoring a default', () => {
    const start = source.indexOf('function unbindImGroup(');
    const end = source.indexOf('\n/**\n * Remove an IM group entirely', start);
    const body = source.slice(start, end);
    expect(body).toContain('unbindChannelMount(');
    expect(body).not.toContain('restoreDefaultChannelMount(');
    expect(source).not.toContain('已恢复 Bot 默认工作区。');
  });

  test('health repair does not auto-create a replacement session', () => {
    const start = source.indexOf('async function checkImBindingsHealth()');
    const body = source.slice(start);
    expect(body).toContain('unbindImGroup(');
    expect(body).not.toContain('createAutoImConversationAgent(');
  });

  test('thread workspace detaches only after the last source leaves', () => {
    const start = source.indexOf('function detachThreadMapWorkspace(');
    const end = source.indexOf('\n/** Restore an authorized chat', start);
    const body = source.slice(start, end);
    expect(body).toContain('hasRemainingThreadMapMount(');
  });
});
