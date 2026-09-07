import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { AgentProfile, RegisteredGroup } from '../src/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hierarchy-routes-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: path.join(root, 'data'),
  GROUPS_DIR: path.join(root, 'groups'),
  STORE_DIR: path.join(root, 'db'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    const id = c.req.header('x-test-user') ?? 'hierarchy-owner';
    c.set('user', {
      id,
      username: id,
      role: id === 'hierarchy-other' ? 'admin' : 'member',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: vi.fn(),
  invalidateAllowedUserCache: vi.fn(),
}));

const db = await import('../src/db.js');
const { setWebDeps } = await import('../src/web-context.js');
const profileRuntime = await import('../src/agent-profile-runtime.js');
const groups = (await import('../src/routes/groups.js')).default;
const profiles = (await import('../src/routes/agent-profiles.js')).default;
const workspaces = (await import('../src/routes/workspaces.js')).default;
const app = new Hono()
  .route('/groups', groups)
  .route('/profiles', profiles)
  .route('/workspaces', workspaces);
const cache: Record<string, RegisteredGroup> = {};
const activeRuntimes = new Map<string, string>();
const stopGroup = vi.fn(async (jid: string) => {
  activeRuntimes.delete(jid);
});

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  db.initDatabase();
  for (const id of ['hierarchy-owner', 'hierarchy-other']) {
    const now = new Date().toISOString();
    db.createUser({
      id,
      username: id,
      password_hash: 'test-only',
      display_name: id,
      role: id === 'hierarchy-other' ? 'admin' : 'member',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
    });
  }
  setWebDeps({
    getRegisteredGroups: () => cache,
    ensureTerminalContainerStarted: vi.fn(),
    queue: {
      pauseGroupsForMutation: () => ({ id: 1 }),
      resumeGroupsAfterMutation: vi.fn(),
      listDescendantJids: (jid: string) =>
        [...activeRuntimes.keys()].filter((key) => key.startsWith(`${jid}#`)),
      stopGroup,
    },
  } as unknown as Parameters<typeof setWebDeps>[0]);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function request(
  url: string,
  method = 'GET',
  body?: Record<string, unknown>,
  user = 'hierarchy-owner',
) {
  return app.request(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function createProfile(
  name: string,
  user?: string,
): Promise<AgentProfile> {
  const response = await request('/profiles', 'POST', { name }, user);
  expect(response.status).toBe(201);
  return (await response.json()).profile;
}

async function createWorkspace(name: string, profile: AgentProfile) {
  const response = await request('/groups', 'POST', {
    name,
    agent_profile_id: profile.id,
    execution_mode: 'container',
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.group.agent_profile_id).toBe(profile.id);
  return { jid: body.jid as string, folder: body.group.folder as string };
}

test('one Agent owns multiple workspaces; reassigning one preserves its sibling and fences the old runtime identity', async () => {
  const agentA = await createProfile('Hierarchy Agent A');
  const agentB = await createProfile('Hierarchy Agent B');
  const first = await createWorkspace('Hierarchy First', agentA);
  const second = await createWorkspace('Hierarchy Second', agentA);
  const other = await createWorkspace('Hierarchy Other Agent', agentB);

  for (const [workspace, profile] of [
    [first, agentA],
    [second, agentA],
    [other, agentB],
  ] as const) {
    db.setSession(workspace.folder, `sdk-${workspace.folder}`, '', {
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      identityHash: profile.identity_hash,
    });
    activeRuntimes.set(workspace.jid, profile.id);
  }
  const childId = 'hierarchy-first-session';
  db.createAgent({
    id: childId,
    group_folder: first.folder,
    chat_jid: first.jid,
    name: 'First workspace conversation',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: 'hierarchy-owner',
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
  db.setSession(first.folder, 'sdk-first-conversation', childId, {
    agentProfileId: agentA.id,
    agentProfileVersion: agentA.version,
    identityHash: agentA.identity_hash,
  });
  const childJid = `${first.jid}#agent:${childId}`;
  activeRuntimes.set(childJid, agentA.id);

  const initial = await (
    await request(`/profiles/${agentA.id}/workspaces`)
  ).json();
  expect(initial.workspaces.map((w: { jid: string }) => w.jid).sort()).toEqual(
    [first.jid, second.jid].sort(),
  );
  const initialDetail = await (
    await request(`/workspaces/${first.jid}`)
  ).json();
  expect(initialDetail.runtime_sessions).toHaveLength(2);
  expect(initialDetail.workspace.agent_profile.id).toBe(agentA.id);
  expect(
    (
      await request(`/profiles/${agentA.id}/effective-capabilities`, 'POST', {
        workspace_jid: other.jid,
      })
    ).status,
  ).toBe(400);

  stopGroup.mockClear();
  const moved = await request(`/groups/${first.jid}/agent-profile`, 'PATCH', {
    agent_profile_id: agentB.id,
  });
  expect(moved.status).toBe(200);
  expect(new Set(stopGroup.mock.calls.map(([jid]) => jid))).toEqual(
    new Set([first.jid, childJid]),
  );
  expect(activeRuntimes).toEqual(
    new Map([
      [second.jid, agentA.id],
      [other.jid, agentB.id],
    ]),
  );
  expect(db.getWorkspaceAgentProfileId(first.folder)).toBe(agentB.id);
  expect(db.getWorkspaceAgentProfileId(second.folder)).toBe(agentA.id);
  expect(db.getAgent(childId)?.chat_jid).toBe(first.jid);
  const runtimeProfile = profileRuntime.resolveEffectiveAgentProfile(
    db.getAgentProfileForWorkspace(first.folder, 'hierarchy-owner'),
  )!;
  expect(runtimeProfile.id).toBe(agentB.id);
  // A migrated workspace cannot make A's resume state appear to belong to B.
  // Runtime startup uses this persisted mismatch to discard the old SDK session.
  for (const sessionId of ['', childId]) {
    const previous = db.getSessionAgentIdentity(first.folder, sessionId);
    expect(previous?.agent_profile_id).not.toBe(runtimeProfile.id);
  }

  const remaining = await (
    await request(`/profiles/${agentA.id}/workspaces`)
  ).json();
  expect(remaining.workspaces.map((w: { jid: string }) => w.jid)).toEqual([
    second.jid,
  ]);
  const receiving = await (
    await request(`/profiles/${agentB.id}/workspaces`)
  ).json();
  expect(
    receiving.workspaces.map((w: { jid: string }) => w.jid).sort(),
  ).toEqual([first.jid, other.jid].sort());
  const detail = await (await request(`/workspaces/${first.jid}`)).json();
  expect(detail.workspace.agent_profile.id).toBe(agentB.id);

  stopGroup.mockClear();
  const patched = await request(`/profiles/${agentA.id}`, 'PATCH', {
    agents_prompt: 'Updated instructions only for Agent A workspaces.',
  });
  expect(patched.status).toBe(200);
  expect(new Set(stopGroup.mock.calls.map(([jid]) => jid))).toEqual(
    new Set([second.jid]),
  );
  expect(activeRuntimes.get(other.jid)).toBe(agentB.id);
  expect((await request(`/profiles/${agentA.id}`, 'DELETE')).status).toBe(409);
});

test('even an administrator cannot create, inspect or reassign another user hierarchy', async () => {
  const own = await createProfile('Private Hierarchy Agent');
  const foreign = await createProfile('Other User Agent', 'hierarchy-other');
  const workspace = await createWorkspace('Private Hierarchy Workspace', own);
  const before = Object.keys(db.getAllRegisteredGroups()).sort();
  stopGroup.mockClear();

  expect(
    (
      await request('/groups', 'POST', {
        name: 'Forbidden foreign Agent',
        agent_profile_id: foreign.id,
        execution_mode: 'container',
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(`/groups/${workspace.jid}/agent-profile`, 'PATCH', {
        agent_profile_id: foreign.id,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await request(
        `/groups/${workspace.jid}/agent-profile`,
        'PATCH',
        {
          agent_profile_id: foreign.id,
        },
        'hierarchy-other',
      )
    ).status,
  ).toBe(404);
  for (const url of [
    `/profiles/${own.id}/workspaces`,
    `/workspaces/${workspace.jid}`,
    `/workspaces/${workspace.jid}/runtime-sessions`,
    `/workspaces/${workspace.jid}/channel-mounts`,
  ]) {
    expect(
      (await request(url, 'GET', undefined, 'hierarchy-other')).status,
    ).toBe(404);
  }
  expect(
    (
      await request(
        `/profiles/${own.id}`,
        'PATCH',
        {
          name: 'Unauthorized rename',
        },
        'hierarchy-other',
      )
    ).status,
  ).toBe(404);
  expect(Object.keys(db.getAllRegisteredGroups()).sort()).toEqual(before);
  expect(db.getWorkspaceAgentProfileId(workspace.folder)).toBe(own.id);
  expect(db.getAgentProfileForUser(own.id, 'hierarchy-owner')?.name).toBe(
    own.name,
  );
  expect(stopGroup).not.toHaveBeenCalled();
});
