import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

const main = fs.readFileSync('src/index.ts', 'utf8');

describe('provider failover cold-run batch wiring', () => {
  test('main conversations pass every pending message ID through both execution modes', () => {
    const mainConversation = main.slice(
      main.indexOf('async function processGroupMessages('),
      main.indexOf('async function runTerminalWarmup('),
    );
    expect(mainConversation).toMatch(
      /runAgent\([\s\S]*?missedMessages\.map\(\(message\) => message\.id\),\s*\);/,
    );

    const runAgent = main.slice(
      main.indexOf('async function runAgent('),
      main.indexOf('interface SendMessageOutcome'),
    );
    expect(runAgent.match(/currentBatchMessageIds,/g)).toHaveLength(2);
  });

  test('conversation agents put every pending message ID on their cold-run input', () => {
    const agentConversation = main.slice(
      main.indexOf('async function processAgentConversation('),
      main.indexOf('async function startMessageLoop()'),
    );
    expect(agentConversation).toContain(
      'currentBatchMessageIds: missedMessages.map((message) => message.id)',
    );
  });
});
