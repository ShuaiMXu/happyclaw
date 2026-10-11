/**
 * GET/PUT /:jid/model-selection — the chat composer's per-conversation model
 * picker. Reading needs workspace Access, changing it needs Modify; a change
 * drains only the runners of the affected conversation.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-session-model-route-'),
);

const mocks = vi.hoisted(() => ({
  userId: 'alice',
  drainCalls: [] as Array<{ jids: string[]; target: string | null }>,
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmpDataDir,
    GROUPS_DIR: path.join(tmpDataDir, 'groups'),
    STORE_DIR: path.join(tmpDataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: mocks.userId,
        username: mocks.userId,
        role: 'member',
        permissions: [],
      });
      return next();
    },
  };
});

vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    getContainerEnvConfig: () => ({}),
    getProviders: () => [
      {
        id: 'official',
        name: 'Claude 官方',
        type: 'official',
        enabled: true,
        anthropicModel: 'opus',
        anthropicApiKey: 'sk-ant-key',
        codexOAuthCredentials: null,
      },
      {
        id: 'chatgpt',
        name: 'ChatGPT 订阅',
        type: 'official',
        enabled: true,
        anthropicModel: 'gpt-6-sol',
        anthropicAuthToken: 'gateway-id',
        codexOAuthCredentials: { accessToken: 'secret' },
      },
      {
        id: 'glm',
        name: 'GLM',
        type: 'third_party',
        enabled: false,
        anthropicModel: 'glm-5.3[1m]',
        anthropicAuthToken: 'glm-token',
        codexOAuthCredentials: null,
      },
      {
        id: 'copy',
        name: 'GLM (副本)',
        type: 'third_party',
        enabled: false,
        anthropicModel: 'glm-5.3',
        anthropicAuthToken: '',
        codexOAuthCredentials: null,
      },
    ],
  };
});

const groupRoutes = (await import('../src/routes/groups.js')).default;
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const OWNER_ID = 'alice';
const GROUP_JID = 'web:model-selection-group';
const GROUP_FOLDER = 'model-selection-group';
const AGENT_ID = 'agent-model-1';

async function call(
  method: 'GET' | 'PUT',
  query = '',
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await groupRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/model-selection${query}`,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Model Selection Group',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
  db.createAgent({
    id: AGENT_ID,
    group_folder: GROUP_FOLDER,
    chat_jid: GROUP_JID,
    name: 'Side conversation',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: OWNER_ID,
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  } as any);
  webContext.setWebDeps({
    queue: {
      drainRunnersForModelSelection: (
        jids: string[],
        target: string | null,
      ) => {
        mocks.drainCalls.push({ jids: [...jids], target });
        return 1;
      },
    },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  mocks.userId = OWNER_ID;
  mocks.drainCalls = [];
  db.setSessionModelSelection(GROUP_FOLDER, null, null);
  db.setSessionModelSelection(GROUP_FOLDER, AGENT_ID, null);
});

afterEach(() => {
  mocks.userId = OWNER_ID;
});

describe('GET /:jid/model-selection', () => {
  test('lists every saved configuration without secrets and the default', async () => {
    const { status, body } = await call('GET');
    expect(status).toBe(200);
    expect(body.selectedModelConfigId).toBeNull();
    expect(body.default).toMatchObject({ source: 'pool', enabledCount: 2 });
    expect(body.options).toEqual([
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
        usable: true,
      },
      {
        id: 'chatgpt',
        name: 'ChatGPT 订阅',
        kind: 'codex',
        enabled: true,
        model: 'gpt-6-sol',
        usable: true,
      },
      {
        id: 'glm',
        name: 'GLM',
        kind: 'third_party',
        enabled: false,
        model: 'glm-5.3[1m]',
        usable: true,
      },
      {
        id: 'copy',
        name: 'GLM (副本)',
        kind: 'third_party',
        enabled: false,
        model: 'glm-5.3',
        usable: false,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  test('hides another account’s workspace', async () => {
    mocks.userId = 'mallory';
    expect((await call('GET')).status).toBe(404);
  });

  test('rejects a session from another workspace', async () => {
    expect((await call('GET', '?agentId=missing')).status).toBe(404);
  });
});

describe('PUT /:jid/model-selection', () => {
  test('pins the main conversation and drains its runners', async () => {
    const { status, body } = await call('PUT', '', { modelConfigId: 'glm' });
    expect(status).toBe(200);
    expect(body.selectedModelConfigId).toBe('glm');
    expect(db.getSessionModelSelection(GROUP_FOLDER, null)).toBe('glm');
    expect(mocks.drainCalls).toEqual([{ jids: [GROUP_JID], target: 'glm' }]);
  });

  test('pins only the addressed Runtime Session', async () => {
    const { status } = await call('PUT', '', {
      agentId: AGENT_ID,
      modelConfigId: 'chatgpt',
    });
    expect(status).toBe(200);
    expect(db.getSessionModelSelection(GROUP_FOLDER, AGENT_ID)).toBe('chatgpt');
    expect(db.getSessionModelSelection(GROUP_FOLDER, null)).toBeNull();
    expect(mocks.drainCalls).toEqual([
      { jids: [`${GROUP_JID}#agent:${AGENT_ID}`], target: 'chatgpt' },
    ]);
    const { body } = await call('GET', `?agentId=${AGENT_ID}`);
    expect(body.selectedModelConfigId).toBe('chatgpt');
  });

  test('null returns to the default; repeating a choice drains nothing', async () => {
    await call('PUT', '', { modelConfigId: 'official' });
    await call('PUT', '', { modelConfigId: 'official' });
    expect(mocks.drainCalls).toHaveLength(1);
    const { body } = await call('PUT', '', { modelConfigId: null });
    expect(body.selectedModelConfigId).toBeNull();
    expect(mocks.drainCalls.at(-1)).toEqual({
      jids: [GROUP_JID],
      target: null,
    });
  });

  test('refuses a configuration without a credential', async () => {
    const { status, body } = await call('PUT', '', { modelConfigId: 'copy' });
    expect(status).toBe(400);
    expect(body.error).toContain('缺少凭据');
    expect(db.getSessionModelSelection(GROUP_FOLDER, null)).toBeNull();
  });

  test('rejects an unknown configuration and non-owners', async () => {
    expect((await call('PUT', '', { modelConfigId: 'nope' })).status).toBe(404);
    mocks.userId = 'mallory';
    expect((await call('PUT', '', { modelConfigId: 'glm' })).status).toBe(404);
    expect(db.getSessionModelSelection(GROUP_FOLDER, null)).toBeNull();
  });
});
