import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-invoke-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const vaultDir = path.join(root, 'vault');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.EXTERNAL_CAPABILITY_VAULT_DIR = vaultDir;
process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED = 'true';
process.env.EXTERNAL_CAPABILITY_DOCKER_NETWORK = 'happyclaw-external-egress';

vi.mock('../src/config.js', () => ({
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  CONTAINER_IMAGE: `registry.example/happyclaw-agent@sha256:${'a'.repeat(64)}`,
  TRUST_PROXY: false,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const executionMocks = vi.hoisted(() => ({
  stop: vi.fn(async () => 'no_active' as const),
}));
const censusMocks = vi.hoisted(() => ({ ready: true }));
const vaultLockMocks = vi.hoisted(() => ({
  available: true,
  blockAfterAcquire: false,
  acquireCalls: 0,
  release: vi.fn(),
}));
vi.mock('../src/external-capability-storage-backfill.js', () => ({
  isExternalCapabilityVaultCensusReady: () => censusMocks.ready,
}));
vi.mock('../src/external-capability-vault-lock.js', () => ({
  acquireExternalCapabilityVaultSharedLock: vi.fn(() => {
    vaultLockMocks.acquireCalls += 1;
    if (vaultLockMocks.blockAfterAcquire) censusMocks.ready = false;
    return vaultLockMocks.available
      ? { release: vaultLockMocks.release }
      : null;
  }),
}));
vi.mock('../src/external-capability-execution-control.js', () => ({
  stopExternalCapabilityExecution: executionMocks.stop,
}));
vi.mock('../src/external-capability-network.js', () => ({
  probeExternalCapabilityDockerNetwork: vi.fn(() => {
    if (process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL === 'true') {
      throw new Error('network not ready');
    }
  }),
}));
vi.mock('../src/external-capability-runner-image.js', () => ({
  assertExternalCapabilityRunnerImage: vi.fn(async () => {
    if (process.env.EXTERNAL_TEST_IMAGE_PROTOCOL_FAIL === 'true') {
      throw new Error('runner image unavailable');
    }
  }),
}));

const db = await import('../src/db.js');
const authAdmission =
  await import('../src/external-capability-auth-rate-limit.js');
const inputLimits = await import('../src/external-capability-input-limits.js');
const intakeControl =
  await import('../src/external-capability-intake-control.js');
const network = await import('../src/external-capability-network.js');
const runnerImage = await import('../src/external-capability-runner-image.js');
const storage = await import('../src/external-capability-storage.js');
const { default: invokeRoutes } =
  await import('../src/routes/external-capability-invoke.js');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==',
  'base64',
);
const METADATA_READABLE_TRUNCATED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLZpQAAAABJRU5ErkJg',
  'base64',
);
let bearer = '';
let keyId = '';

beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'owner',
    username: 'external-invoke-owner',
    password_hash: 'hash',
    display_name: 'External invoke owner',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup('web:6241df8f-b015-472e-9083-6c4ec31eedc1', {
    name: '数据规整',
    folder: 'flow-munrwfg2-u6u8',
    added_at: now,
    executionMode: 'container',
    created_by: 'owner',
  });
  db.setExternalCapabilityStatus('quote-document-process', 'active');
  const createdKey = db.createExternalCapabilityKey({
    capabilitySlug: 'quote-document-process',
    label: 'T2 test',
  });
  keyId = createdKey.key.id;
  bearer = createdKey.secret;
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.EXTERNAL_CAPABILITY_VAULT_DIR;
  delete process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED;
  delete process.env.EXTERNAL_CAPABILITY_DOCKER_NETWORK;
  delete process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL;
  delete process.env.EXTERNAL_TEST_IMAGE_PROTOCOL_FAIL;
});

function workbookArchive(extraEntries: Record<string, Buffer> = {}): Buffer {
  const zip = new AdmZip();
  const entries: Record<string, Buffer> = {
    '[Content_Types].xml': Buffer.from(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    ),
    '_rels/.rels': Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': Buffer.from(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Items" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': Buffer.from(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
    ),
    ...extraEntries,
  };
  for (const [name, bytes] of Object.entries(entries)) zip.addFile(name, bytes);
  return zip.toBuffer();
}

function patchZipEntryHeaders(
  archive: Buffer,
  entryName: string,
  patch: (bytes: Buffer, centralOffset: number, localOffset: number) => void,
): Buffer {
  const bytes = Buffer.from(archive);
  for (let offset = 0; offset + 46 <= bytes.length; offset += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    if (name === entryName) {
      patch(bytes, offset, bytes.readUInt32LE(offset + 42));
      return bytes;
    }
    offset += 45 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry not found: ${entryName}`);
}

function createScopedKey(label: string): { keyId: string; bearer: string } {
  const created = db.createExternalCapabilityKey({
    capabilitySlug: 'quote-document-process',
    label,
  });
  return { keyId: created.key.id, bearer: created.secret };
}

function createSucceededRunWithOutput(input: {
  keyId: string;
  taskId: string;
  output: {
    displayName: string;
    mimeType: string;
    byteLength: number;
    sha256: string;
    storageRef: string;
  };
}): string {
  const created = db.createExternalCapabilityRun({
    capabilitySlug: 'quote-document-process',
    keyId: input.keyId,
    externalTaskId: input.taskId,
    inputManifest: {
      version: 1,
      requestFingerprint: input.taskId,
      artifacts: [],
    },
  });
  expect(created.created).toBe(true);
  const claim = db.claimNextExternalCapabilityRun(
    `route-output-${input.taskId}`,
    60_000,
  );
  expect(claim?.id).toBe(created.run.id);
  expect(
    db.completeExternalCapabilityRun(
      claim!.id,
      claim!.lease_owner,
      claim!.lease_token,
      {
        status: 'succeeded',
        result: {
          format: 'xlsx',
          rowCount: 1,
          warnings: [],
          output: input.output,
        },
      },
    ),
  ).toBe(true);
  return created.run.id;
}

function requestBody(taskId = 't2-task-001') {
  const form = new FormData();
  form.set('externalTaskId', taskId);
  form.set('instructions', '优先保留原始计价口径，并标记无法确认的字段。');
  form.set(
    'outputSchema',
    JSON.stringify({
      sheetName: 'Items',
      columns: [
        {
          key: 'name',
          name: '名称',
          required: true,
          description: '原始项目名称',
        },
        { key: 'quantity', name: '数量' },
      ],
    }),
  );
  form.append('files', new File([PNG], 'source.png', { type: 'image/png' }));
  return form;
}

async function invokeWorkbook(
  taskId: string,
  bytes: Buffer,
): Promise<Response> {
  const body = requestBody(taskId);
  body.set(
    'files',
    new File([bytes], `${taskId}.xlsx`, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );
  return invokeRoutes.request('/quote-document-process/runs', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
    body,
  });
}

function multipartWithTextParts(boundary: string, count: number): Buffer {
  return Buffer.from(
    `${Array.from(
      { length: count },
      (_, index) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="field${index}"\r\n\r\nx\r\n`,
    ).join('')}--${boundary}--\r\n`,
  );
}

describe('external capability invoke API', () => {
  test('rejects authenticated intake while the Vault census is blocked', async () => {
    censusMocks.ready = false;
    try {
      const response = await invokeRoutes.request(
        '/quote-document-process/runs',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
      });
    } finally {
      censusMocks.ready = true;
    }
  });

  test('rejects intake when the Vault producer lock is unavailable', async () => {
    vaultLockMocks.available = false;
    vaultLockMocks.release.mockClear();
    try {
      const response = await invokeRoutes.request(
        '/quote-document-process/runs',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
      });
      expect(vaultLockMocks.release).not.toHaveBeenCalled();
    } finally {
      vaultLockMocks.available = true;
    }
  });

  test('rechecks the census marker after acquiring the producer lock', async () => {
    censusMocks.ready = true;
    vaultLockMocks.blockAfterAcquire = true;
    vaultLockMocks.release.mockClear();
    try {
      const response = await invokeRoutes.request(
        '/quote-document-process/runs',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
      });
      expect(vaultLockMocks.release).toHaveBeenCalledOnce();
    } finally {
      vaultLockMocks.blockAfterAcquire = false;
      censusMocks.ready = true;
    }
  });

  test('releases the producer lock after request validation fails', async () => {
    vaultLockMocks.release.mockClear();
    const boundary = 'external-lock-release-validation';
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartWithTextParts(boundary, 33),
      },
    );

    expect(response.status).toBe(400);
    expect(vaultLockMocks.release).toHaveBeenCalledOnce();
  });

  test('rate-limits unauthenticated requests before bearer verification', async () => {
    process.env.EXTERNAL_CAPABILITY_UNAUTH_REQUESTS_PER_MINUTE = '1';
    authAdmission.resetExternalCapabilityAuthAdmissionForTest();
    try {
      const unauthorized = await invokeRoutes.request(
        '/quote-document-process/runs/missing',
      );
      expect(unauthorized.status).toBe(401);

      const limited = await invokeRoutes.request(
        '/quote-document-process/runs/missing',
        { headers: { Authorization: 'Bearer ec_invalid-token' } },
      );
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      delete process.env.EXTERNAL_CAPABILITY_UNAUTH_REQUESTS_PER_MINUTE;
      authAdmission.resetExternalCapabilityAuthAdmissionForTest();
    }
  });

  test('does not charge client-rejected attempts to the global auth bucket', () => {
    const env = {
      EXTERNAL_CAPABILITY_UNAUTH_REQUESTS_PER_MINUTE: '2',
      EXTERNAL_CAPABILITY_UNAUTH_PER_CLIENT_REQUESTS_PER_MINUTE: '1',
    } as NodeJS.ProcessEnv;
    authAdmission.resetExternalCapabilityAuthAdmissionForTest();

    expect(
      authAdmission.consumeExternalCapabilityAuthAdmission({
        clientId: 'client-a',
        now: 1,
        env,
      }),
    ).toBe(true);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        authAdmission.consumeExternalCapabilityAuthAdmission({
          clientId: 'client-a',
          now: 1,
          env,
        }),
      ).toBe(false);
    }
    expect(
      authAdmission.consumeExternalCapabilityAuthAdmission({
        clientId: 'client-b',
        now: 1,
        env,
      }),
    ).toBe(true);
    expect(
      authAdmission.consumeExternalCapabilityAuthAdmission({
        clientId: 'client-c',
        now: 1,
        env,
      }),
    ).toBe(false);
  });

  test('rejects excessive multipart cardinality before materializing FormData', async () => {
    const boundary = 'external-many-parts';
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartWithTextParts(boundary, 33),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('returns a distinct storage-capacity error before writing input', async () => {
    process.env.EXTERNAL_CAPABILITY_VAULT_MAX_BYTES = '0';
    try {
      const response = await invokeRoutes.request(
        '/quote-document-process/runs',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
          body: requestBody('t2-task-storage-capacity'),
        },
      );
      expect(response.status).toBe(507);
      expect(await response.json()).toMatchObject({
        code: 'VAULT_CAPACITY_EXCEEDED',
      });
    } finally {
      delete process.env.EXTERNAL_CAPABILITY_VAULT_MAX_BYTES;
    }
  });

  test('accepts authenticated multipart input into a private queued run', async () => {
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body: requestBody(),
      },
    );
    expect(response.status, await response.clone().text()).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      externalTaskId: 't2-task-001',
      status: 'queued',
    });
    expect(typeof body.runId).toBe('string');
    expect(
      db.getExternalCapabilityRunById(body.runId)?.input_manifest,
    ).toMatchObject({
      taskInstructions: '优先保留原始计价口径，并标记无法确认的字段。',
      outputSchema: {
        version: 1,
        sheetName: 'Items',
        columns: [
          {
            key: 'name',
            name: '名称',
            required: true,
            description: '原始项目名称',
          },
          { key: 'quantity', name: '数量' },
        ],
      },
    });

    const status = await invokeRoutes.request(
      `/quote-document-process/runs/${body.runId}`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      runId: body.runId,
      status: 'queued',
    });

    const files = fs.readdirSync(path.join(vaultDir, 'runs', body.runId));
    expect(files).toHaveLength(1);

    const claim = db.claimNextExternalCapabilityRun(
      'status-error-test',
      60_000,
    )!;
    expect(claim.id).toBe(body.runId);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        {
          status: 'failed',
          error: {
            code: 'PROCESSING_FAILED',
            message: 'ENOTDIR: /private/vault/customer-input.xlsx',
          },
        },
      ),
    ).toBe(true);
    const failedStatus = await invokeRoutes.request(
      `/quote-document-process/runs/${body.runId}`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    );
    const failedBody = await failedStatus.json();
    expect(failedBody).toMatchObject({
      status: 'failed',
      error: {
        code: 'PROCESSING_FAILED',
        message: 'The task could not be processed.',
      },
    });
    expect(JSON.stringify(failedBody)).not.toContain('/private/vault');
  });

  test('does not expose internal artifact references in a succeeded status response', async () => {
    const created = await invokeRoutes.request('/quote-document-process/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: requestBody('t2-task-public-result'),
    });
    const { runId } = (await created.json()) as { runId: string };
    const claim = db.claimNextExternalCapabilityRun(
      'public-result-test',
      60_000,
    )!;
    expect(claim.id).toBe(runId);
    expect(
      db.completeExternalCapabilityRun(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        {
          status: 'succeeded',
          result: {
            format: 'xlsx',
            rowCount: 2,
            warnings: [
              {
                code: 'SOURCE_UNCERTAIN',
                rowIndex: 1,
                columnKey: 'quantity',
              },
              'customer phone 13800138000',
              {
                code: 'SOURCE_UNCERTAIN',
                message: '/private/vault/customer-input.xlsx',
              },
            ],
            output: {
              displayName: 'normalized-data.xlsx',
              mimeType:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              byteLength: 123,
              sha256: 'a'.repeat(64),
              storageRef: `ecv1:${runId}:private-result`,
            },
          },
        },
      ),
    ).toBe(true);

    const response = await invokeRoutes.request(
      `/quote-document-process/runs/${runId}`,
      { headers: { Authorization: `Bearer ${bearer}` } },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'succeeded',
      result: {
        format: 'xlsx',
        rowCount: 2,
        warnings: [
          {
            code: 'SOURCE_UNCERTAIN',
            rowIndex: 1,
            columnKey: 'quantity',
          },
        ],
        output: { displayName: 'normalized-data.xlsx', byteLength: 123 },
      },
    });
    expect(JSON.stringify(body)).not.toContain('storageRef');
    expect(JSON.stringify(body)).not.toContain('private-result');
    expect(JSON.stringify(body)).not.toContain('13800138000');
    expect(JSON.stringify(body)).not.toContain('/private/vault');

    delete process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED;
    try {
      const closedStatus = await invokeRoutes.request(
        `/quote-document-process/runs/${runId}`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      );
      expect(closedStatus.status).toBe(409);
      expect(await closedStatus.json()).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
      });
      const closedOutput = await invokeRoutes.request(
        `/quote-document-process/runs/${runId}/output`,
        { headers: { Authorization: `Bearer ${bearer}` } },
      );
      expect(closedOutput.status).toBe(409);
      expect(await closedOutput.json()).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
      });
    } finally {
      process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED = 'true';
    }
  });

  test('rate-limits status requests in an independent credential lane', async () => {
    const scoped = createScopedKey('status lane');
    const created = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: scoped.keyId,
      externalTaskId: 'status-rate-lane-task',
      inputManifest: { version: 1, artifacts: [] },
    });
    expect(created.created).toBe(true);
    process.env.EXTERNAL_CAPABILITY_KEY_STATUS_REQUESTS_PER_MINUTE = '1';
    try {
      const first = await invokeRoutes.request(
        `/quote-document-process/runs/${created.run.id}`,
        { headers: { Authorization: `Bearer ${scoped.bearer}` } },
      );
      expect(first.status).toBe(200);
      const limited = await invokeRoutes.request(
        `/quote-document-process/runs/${created.run.id}`,
        { headers: { Authorization: `Bearer ${scoped.bearer}` } },
      );
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      delete process.env.EXTERNAL_CAPABILITY_KEY_STATUS_REQUESTS_PER_MINUTE;
      expect(
        db.cancelExternalCapabilityRun(
          'quote-document-process',
          scoped.keyId,
          created.run.id,
        ),
      ).toMatchObject({ cancelled: true });
    }
  });

  test('keeps cancellation available while intake is saturated and release is closed', async () => {
    const scoped = createScopedKey('cancel lane');
    const created = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId: scoped.keyId,
      externalTaskId: 'cancel-independent-lane-task',
      inputManifest: { version: 1, artifacts: [] },
    });
    expect(created.created).toBe(true);
    const releases = Array.from({ length: 4 }, () =>
      intakeControl.tryAcquireExternalCapabilityIntakeSlot(4),
    );
    delete process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED;
    process.env.EXTERNAL_CAPABILITY_KEY_CANCEL_REQUESTS_PER_MINUTE = '1';
    try {
      const response = await invokeRoutes.request(
        `/quote-document-process/runs/${created.run.id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${scoped.bearer}` },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        runId: created.run.id,
        status: 'cancelled',
        cancelled: true,
      });
      const limited = await invokeRoutes.request(
        `/quote-document-process/runs/${created.run.id}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${scoped.bearer}` },
        },
      );
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED = 'true';
      delete process.env.EXTERNAL_CAPABILITY_KEY_CANCEL_REQUESTS_PER_MINUTE;
      for (const release of releases) release?.();
    }
    expect(intakeControl.getActiveExternalCapabilityIntakesForTest()).toBe(0);
  });

  test('rate-limits output downloads independently', async () => {
    const scoped = createScopedKey('download lane');
    const bytes = Buffer.from('bounded xlsx output');
    const stored = storage.storeExternalCapabilityArtifact(vaultDir, {
      runId: 'download-rate-run',
      artifactId: 'result',
      bytes,
    });
    const runId = createSucceededRunWithOutput({
      keyId: scoped.keyId,
      taskId: 'download-rate-task',
      output: {
        displayName: 'normalized-data.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ...stored,
      },
    });
    process.env.EXTERNAL_CAPABILITY_KEY_DOWNLOAD_REQUESTS_PER_MINUTE = '1';
    try {
      const first = await invokeRoutes.request(
        `/quote-document-process/runs/${runId}/output`,
        { headers: { Authorization: `Bearer ${scoped.bearer}` } },
      );
      expect(first.status).toBe(200);
      expect(Buffer.from(await first.arrayBuffer())).toEqual(bytes);
      const limited = await invokeRoutes.request(
        `/quote-document-process/runs/${runId}/output`,
        { headers: { Authorization: `Bearer ${scoped.bearer}` } },
      );
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    } finally {
      delete process.env.EXTERNAL_CAPABILITY_KEY_DOWNLOAD_REQUESTS_PER_MINUTE;
    }
  });

  test('holds local download capacity until the response body is consumed', async () => {
    const scoped = createScopedKey('download body lifetime');
    const bytes = Buffer.alloc(128 * 1024, 7);
    const stored = storage.storeExternalCapabilityArtifact(vaultDir, {
      runId: 'download-body-lifetime-run',
      artifactId: 'result',
      bytes,
    });
    const runId = createSucceededRunWithOutput({
      keyId: scoped.keyId,
      taskId: 'download-body-lifetime-task',
      output: {
        displayName: 'normalized-data.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ...stored,
      },
    });
    process.env.EXTERNAL_CAPABILITY_LOCAL_DOWNLOAD_CONCURRENCY = '1';
    try {
      const first = await invokeRoutes.request(
        `/quote-document-process/runs/${runId}/output`,
        { headers: { Authorization: `Bearer ${scoped.bearer}` } },
      );
      expect(first.status).toBe(200);
      expect(intakeControl.getActiveExternalCapabilityDownloadsForTest()).toBe(
        1,
      );

      const busy = await invokeRoutes.request(
        `/quote-document-process/runs/${runId}/output`,
        { headers: { Authorization: `Bearer ${scoped.bearer}` } },
      );
      expect(busy.status).toBe(429);
      expect(await busy.json()).toMatchObject({ code: 'DOWNLOAD_BUSY' });

      expect(Buffer.from(await first.arrayBuffer())).toEqual(bytes);
      expect(intakeControl.getActiveExternalCapabilityDownloadsForTest()).toBe(
        0,
      );
      const afterDrain = await invokeRoutes.request(
        `/quote-document-process/runs/${runId}/output`,
        { headers: { Authorization: `Bearer ${scoped.bearer}` } },
      );
      expect(afterDrain.status).toBe(200);
      await afterDrain.body?.cancel();
    } finally {
      delete process.env.EXTERNAL_CAPABILITY_LOCAL_DOWNLOAD_CONCURRENCY;
    }
    expect(intakeControl.getActiveExternalCapabilityDownloadsForTest()).toBe(0);
  });

  test('rejects output download when local download capacity is saturated', async () => {
    const scoped = createScopedKey('download concurrency');
    const bytes = Buffer.from('download concurrency output');
    const stored = storage.storeExternalCapabilityArtifact(vaultDir, {
      runId: 'download-concurrency-run',
      artifactId: 'result',
      bytes,
    });
    const runId = createSucceededRunWithOutput({
      keyId: scoped.keyId,
      taskId: 'download-concurrency-task',
      output: {
        displayName: 'normalized-data.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ...stored,
      },
    });
    const releases = Array.from({ length: 4 }, () =>
      intakeControl.tryAcquireExternalCapabilityDownloadSlot(4),
    );
    try {
      const response = await invokeRoutes.request(
        `/quote-document-process/runs/${runId}/output`,
        { headers: { Authorization: `Bearer ${scoped.bearer}` } },
      );
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ code: 'DOWNLOAD_BUSY' });
    } finally {
      for (const release of releases) release?.();
    }
    expect(intakeControl.getActiveExternalCapabilityDownloadsForTest()).toBe(0);
  });

  test('rejects oversized output metadata before reading the artifact', async () => {
    const scoped = createScopedKey('oversized output');
    const runId = createSucceededRunWithOutput({
      keyId: scoped.keyId,
      taskId: 'oversized-output-task',
      output: {
        displayName: 'normalized-data.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        byteLength: 1024 * 1024 + 1,
        sha256: 'a'.repeat(64),
        storageRef: `ecv1:oversized-output-task:${'b'.repeat(36)}`,
      },
    });
    process.env.EXTERNAL_CAPABILITY_MAX_OUTPUT_BYTES = String(1024 * 1024);
    try {
      const response = await invokeRoutes.request(
        `/quote-document-process/runs/${runId}/output`,
        { headers: { Authorization: `Bearer ${scoped.bearer}` } },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      delete process.env.EXTERNAL_CAPABILITY_MAX_OUTPUT_BYTES;
    }
  });

  test('rejects intake while the host release gate is disabled', async () => {
    delete process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED;
    try {
      const response = await invokeRoutes.request(
        '/quote-document-process/runs',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
          body: requestBody('t2-task-release-gate'),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
      });
    } finally {
      process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED = 'true';
    }
  });

  test('rejects workspace folder or execution-mode drift before intake admission', async () => {
    const jid = 'web:6241df8f-b015-472e-9083-6c4ec31eedc1';
    const original = db.getRegisteredGroup(jid)!;
    for (const drift of [
      { folder: 'unexpected-folder' },
      { executionMode: 'host' as const },
    ]) {
      const before = db.getExternalCapabilityIntakeReservationsForTest(keyId);
      vi.mocked(network.probeExternalCapabilityDockerNetwork).mockClear();
      db.setRegisteredGroup(jid, { ...original, ...drift });
      const response = await invokeRoutes.request(
        '/quote-document-process/runs',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
          body: requestBody(`t2-task-workspace-drift-${Object.keys(drift)[0]}`),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
      });
      expect(
        network.probeExternalCapabilityDockerNetwork,
      ).not.toHaveBeenCalled();
      expect(
        db.getExternalCapabilityIntakeReservationsForTest(keyId),
      ).toHaveLength(before.length);
    }
    db.setRegisteredGroup(jid, original);
    expect(
      db.setExternalCapabilityStatus('quote-document-process', 'active'),
    ).toBe(true);
  });

  test('rejects intake when the pinned runner image is no longer locally ready', async () => {
    process.env.EXTERNAL_TEST_IMAGE_PROTOCOL_FAIL = 'true';
    vi.mocked(network.probeExternalCapabilityDockerNetwork).mockClear();
    vi.mocked(runnerImage.assertExternalCapabilityRunnerImage).mockClear();
    try {
      const response = await invokeRoutes.request(
        '/quote-document-process/runs',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
          body: requestBody('t2-task-image-readiness'),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
      });
      expect(
        runnerImage.assertExternalCapabilityRunnerImage,
      ).toHaveBeenCalledWith(expect.any(String), { force: true });
      expect(
        network.probeExternalCapabilityDockerNetwork,
      ).not.toHaveBeenCalled();
      expect(
        db.getExternalCapabilityIntakeReservationsForTest(keyId).at(-1),
      ).toMatchObject({
        state: 'finished',
        outcome: 'unavailable',
        observed_raw_bytes: 0,
      });
    } finally {
      delete process.env.EXTERNAL_TEST_IMAGE_PROTOCOL_FAIL;
    }
  });

  test('rejects intake when the approved egress network is unavailable', async () => {
    process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL = 'true';
    try {
      const response = await invokeRoutes.request(
        '/quote-document-process/runs',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
          body: requestBody('t2-task-network-readiness'),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
      });
    } finally {
      delete process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL;
    }
  });

  test('rejects callers without a capability-scoped bearer key', async () => {
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        body: requestBody('t2-task-002'),
      },
    );
    expect(response.status).toBe(401);
  });

  test('rejects a capability-slug mismatch before network or intake admission', async () => {
    const before = db.getExternalCapabilityIntakeReservationsForTest(keyId);
    vi.mocked(network.probeExternalCapabilityDockerNetwork).mockClear();
    const response = await invokeRoutes.request('/another-capability/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: requestBody('t2-task-wrong-slug'),
    });
    expect(response.status).toBe(404);
    expect(network.probeExternalCapabilityDockerNetwork).not.toHaveBeenCalled();
    expect(
      db.getExternalCapabilityIntakeReservationsForTest(keyId),
    ).toHaveLength(before.length);
  });

  test('rejects locally saturated intake without probing the network', async () => {
    expect(intakeControl.getActiveExternalCapabilityIntakesForTest()).toBe(0);
    const releases = Array.from({ length: 4 }, () =>
      intakeControl.tryAcquireExternalCapabilityIntakeSlot(4),
    );
    expect(releases.every(Boolean)).toBe(true);
    vi.mocked(network.probeExternalCapabilityDockerNetwork).mockClear();
    try {
      const response = await invokeRoutes.request(
        '/quote-document-process/runs',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}` },
          body: requestBody('t2-task-local-saturation'),
        },
      );
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ code: 'INTAKE_BUSY' });
      expect(
        network.probeExternalCapabilityDockerNetwork,
      ).not.toHaveBeenCalled();
      expect(
        db.getExternalCapabilityIntakeReservationsForTest(keyId).at(-1),
      ).toMatchObject({
        state: 'finished',
        outcome: 'overloaded',
        observed_raw_bytes: 0,
      });
    } finally {
      for (const release of releases) release?.();
    }
    expect(intakeControl.getActiveExternalCapabilityIntakesForTest()).toBe(0);
  });

  test('stops reading a body when the derived raw request cap is crossed', async () => {
    process.env.EXTERNAL_CAPABILITY_MAX_INPUT_BYTES_PER_RUN = String(
      1024 * 1024,
    );
    try {
      const rawLimit = 1024 * 1024 + 256 * 1024;
      const bytes = Buffer.alloc(rawLimit + 1, 0x61);
      let offset = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (cancelled) return;
          const end = Math.min(offset + 64 * 1024, bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
          if (offset >= bytes.length) controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });
      const request = new Request(
        'http://localhost/quote-document-process/runs',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'multipart/form-data; boundary=intake-test',
          },
          body: stream,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' },
      );
      const response = await invokeRoutes.request(request);
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
      });
      expect(
        db.getExternalCapabilityIntakeReservationsForTest(keyId).at(-1),
      ).toMatchObject({
        state: 'finished',
        outcome: 'payload_too_large',
      });
    } finally {
      delete process.env.EXTERNAL_CAPABILITY_MAX_INPUT_BYTES_PER_RUN;
    }
  });

  test('rejects an image whose base64 form would exceed the API limit before storage', async () => {
    const runsDir = path.join(vaultDir, 'runs');
    const storedRunsBefore = fs.existsSync(runsDir)
      ? fs.readdirSync(runsDir).sort()
      : [];
    const oversizedImage = Buffer.concat([
      PNG,
      Buffer.alloc(
        inputLimits.EXTERNAL_CAPABILITY_MAX_RAW_IMAGE_BYTES + 1 - PNG.length,
      ),
    ]);
    const body = requestBody('t2-task-encoded-image-limit');
    body.set(
      'files',
      new File([oversizedImage], 'oversized.png', { type: 'image/png' }),
    );

    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: 'Input exceeds the advertised size limit',
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(
      fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort() : [],
    ).toEqual(storedRunsBefore);
    const reservation = db
      .getExternalCapabilityIntakeReservationsForTest(keyId)
      .at(-1);
    expect(reservation).toMatchObject({
      state: 'finished',
      outcome: 'payload_too_large',
    });
    expect(reservation!.observed_raw_bytes).toBeGreaterThanOrEqual(
      oversizedImage.byteLength,
    );
  });

  test('rejects unsupported file contents without reflecting the file name', async () => {
    const body = requestBody('t2-task-unsupported-file');
    body.set(
      'files',
      new File([Buffer.from('not a supported document')], 'private-input.bin'),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'File type or content is not allowed',
      code: 'INVALID_FILE',
    });
    expect(
      db.getExternalCapabilityIntakeReservationsForTest(keyId).at(-1),
    ).toMatchObject({
      state: 'finished',
      outcome: 'invalid',
    });
  });

  test('rejects an image whose metadata parses but full decoding fails', async () => {
    const body = requestBody('t2-task-truncated-image');
    body.set(
      'files',
      new File([METADATA_READABLE_TRUNCATED_PNG], 'truncated.png', {
        type: 'image/png',
      }),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects images outside the runner MessageStream dimension limit', async () => {
    const tooWide = await sharp({
      create: {
        width: 8_001,
        height: 1,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const body = requestBody('t2-task-image-too-wide');
    body.set(
      'files',
      new File([tooWide], 'too-wide.png', { type: 'image/png' }),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('accepts a bounded macro-free XLSX archive', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Items').addRow(['name', 'quantity']);
    const response = await invokeWorkbook(
      't2-task-xlsx',
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );

    expect(response.status, await response.clone().text()).toBe(202);
  });

  test('rejects XLSX archives with excessive central-directory entries', async () => {
    const extraEntries = Object.fromEntries(
      Array.from({ length: 2_001 }, (_, index) => [
        `xl/empty/entry-${index}.xml`,
        Buffer.alloc(0),
      ]),
    );
    const body = requestBody('t2-task-xlsx-entry-limit');
    body.set(
      'files',
      new File([workbookArchive(extraEntries)], 'too-many-entries.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );

    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('accepts namespace-prefixed OOXML package metadata', async () => {
    const body = requestBody('t2-task-prefixed-xlsx');
    body.set(
      'files',
      new File(
        [
          workbookArchive({
            '[Content_Types].xml': Buffer.from(
              '<ct:Types xmlns:ct="http://schemas.openxmlformats.org/package/2006/content-types"><ct:Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><ct:Default Extension="xml" ContentType="application/xml"/><ct:Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></ct:Types>',
            ),
            '_rels/.rels': Buffer.from(
              '<r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships"><r:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></r:Relationships>',
            ),
          }),
        ],
        'prefixed.xlsx',
        {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status, await response.clone().text()).toBe(202);
  });

  test('rejects DTD-bearing OOXML package metadata', async () => {
    const body = requestBody('t2-task-dtd-xlsx');
    body.set(
      'files',
      new File(
        [
          workbookArchive({
            '_rels/.rels': Buffer.from(
              '<!DOCTYPE Relationships [<!ENTITY ext SYSTEM "file:///etc/passwd">]><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
            ),
          }),
        ],
        'dtd.xlsx',
        {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects DTD-bearing worksheet XML', async () => {
    const response = await invokeWorkbook(
      't2-task-dtd-worksheet',
      workbookArchive({
        'xl/worksheets/sheet1.xml': Buffer.from(
          '<!DOCTYPE worksheet><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
        ),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects entries without content-type coverage', async () => {
    const response = await invokeWorkbook(
      't2-task-content-type-gap',
      workbookArchive({
        '[Content_Types].xml': Buffer.from(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        ),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects workbook packages without a declared worksheet', async () => {
    const response = await invokeWorkbook(
      't2-task-no-worksheet',
      workbookArchive({
        'xl/workbook.xml': Buffer.from(
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
        ),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects implicit remote internal relationship targets', async () => {
    const response = await invokeWorkbook(
      't2-task-implicit-remote-target',
      workbookArchive({
        'xl/_rels/workbook.xml.rels': Buffer.from(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="https://attacker.invalid/sheet.xml"/></Relationships>',
        ),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects encrypted and unsupported-compression ZIP entries', async () => {
    const encrypted = patchZipEntryHeaders(
      workbookArchive(),
      'xl/worksheets/sheet1.xml',
      (bytes, centralOffset, localOffset) => {
        bytes.writeUInt16LE(
          bytes.readUInt16LE(centralOffset + 8) | 1,
          centralOffset + 8,
        );
        bytes.writeUInt16LE(
          bytes.readUInt16LE(localOffset + 6) | 1,
          localOffset + 6,
        );
      },
    );
    const unsupported = patchZipEntryHeaders(
      workbookArchive(),
      'xl/worksheets/sheet1.xml',
      (bytes, centralOffset, localOffset) => {
        bytes.writeUInt16LE(99, centralOffset + 10);
        bytes.writeUInt16LE(99, localOffset + 8);
      },
    );

    const encryptedResponse = await invokeWorkbook(
      't2-task-encrypted-entry',
      encrypted,
    );
    const unsupportedResponse = await invokeWorkbook(
      't2-task-unsupported-compression',
      unsupported,
    );
    expect(encryptedResponse.status).toBe(400);
    expect(await encryptedResponse.json()).toMatchObject({
      code: 'INVALID_FILE',
    });
    expect(unsupportedResponse.status).toBe(400);
    expect(await unsupportedResponse.json()).toMatchObject({
      code: 'INVALID_FILE',
    });
  });

  test('rejects forged uncompressed ZIP entry sizes', async () => {
    const forged = patchZipEntryHeaders(
      workbookArchive({
        'xl/worksheets/sheet1.xml': Buffer.from(
          `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c t="inlineStr"><is><t>${'x'.repeat(128 * 1024)}</t></is></c></row></sheetData></worksheet>`,
        ),
      }),
      'xl/worksheets/sheet1.xml',
      (bytes, centralOffset) => {
        bytes.writeUInt32LE(1, centralOffset + 24);
      },
    );
    const response = await invokeWorkbook('t2-task-forged-size', forged);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects declared ZIP expansion above the archive allowance', async () => {
    const oversized = patchZipEntryHeaders(
      workbookArchive(),
      'xl/worksheets/sheet1.xml',
      (bytes, centralOffset) => {
        bytes.writeUInt32LE(11 * 1024 * 1024, centralOffset + 24);
      },
    );
    const response = await invokeWorkbook(
      't2-task-preinflate-expansion-limit',
      oversized,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects legacy XLS compound documents in V1', async () => {
    const body = requestBody('t2-task-legacy-xls');
    body.set(
      'files',
      new File(
        [
          Buffer.from([
            0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0,
          ]),
        ],
        'legacy.xls',
        { type: 'application/vnd.ms-excel' },
      ),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects macro-enabled or embedded active XLSX content', async () => {
    const body = requestBody('t2-task-active-xlsx');
    body.set(
      'files',
      new File(
        [workbookArchive({ 'xl/vbaProject.bin': Buffer.from('macro') })],
        'active.xlsm',
        {
          type: 'application/vnd.ms-excel.sheet.macroEnabled.12',
        },
      ),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects arbitrary external OOXML relationships', async () => {
    const body = requestBody('t2-task-external-relationship');
    body.set(
      'files',
      new File(
        [
          workbookArchive({
            'xl/_rels/workbook.xml.rels': Buffer.from(
              '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.invalid/payload" TargetMode="External"/></Relationships>',
            ),
          }),
        ],
        'external-link.xlsx',
        {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects macro-sheet content types even without a VBA binary', async () => {
    const body = requestBody('t2-task-xlm-macro-sheet');
    body.set(
      'files',
      new File(
        [
          workbookArchive({
            '[Content_Types].xml': Buffer.from(
              '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/macrosheets/sheet1.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/></Types>',
            ),
            'xl/macrosheets/sheet1.xml': Buffer.from('<worksheet/>'),
          }),
        ],
        'xlm-macro.xlsx',
        {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_FILE' });
  });

  test('rejects a corrupt image that only has a valid magic header', async () => {
    const body = requestBody('t2-task-corrupt-image');
    body.set(
      'files',
      new File(
        [
          Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
          ]),
        ],
        'corrupt.png',
        { type: 'image/png' },
      ),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'File type or content is not allowed',
      code: 'INVALID_FILE',
    });
  });

  test('rejects unsafe output workbook sheet names', async () => {
    const body = requestBody('t2-task-003');
    body.set(
      'outputSchema',
      JSON.stringify({
        sheetName: 'Items/2026',
        columns: [{ key: 'name', name: '名称' }],
      }),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'INVALID_OUTPUT_SCHEMA',
    });
  });

  test('rejects output columns that request prohibited sensitive data', async () => {
    const body = requestBody('t2-task-sensitive-schema');
    body.set(
      'outputSchema',
      JSON.stringify({
        columns: [{ key: 'phone_number', name: '客户联系电话' }],
      }),
    );
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'outputSchema requests a prohibited sensitive-data field',
      code: 'INVALID_OUTPUT_SCHEMA',
    });
  });

  test('rejects caller instructions longer than the bounded task field', async () => {
    const body = requestBody('t2-task-004');
    body.set('instructions', 'x'.repeat(8_001));
    const response = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('treats a multipart retry with the same business request as idempotent', async () => {
    const attemptCount =
      db.getExternalCapabilityIntakeReservationsForTest(keyId).length;
    const first = await invokeRoutes.request('/quote-document-process/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: requestBody('t2-task-idempotent'),
    });
    expect(first.status).toBe(202);
    const original = (await first.json()) as { runId: string };
    const storageBefore = db.getExternalCapabilityStorageUsageForTest();
    process.env.EXTERNAL_CAPABILITY_VAULT_MAX_BYTES = '0';

    const retry = await invokeRoutes.request('/quote-document-process/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: requestBody('t2-task-idempotent'),
    });
    delete process.env.EXTERNAL_CAPABILITY_VAULT_MAX_BYTES;
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      runId: original.runId,
      status: 'queued',
      duplicate: true,
    });
    expect(
      fs.readdirSync(path.join(vaultDir, 'runs', original.runId)),
    ).toHaveLength(1);
    expect(db.getExternalCapabilityStorageUsageForTest()).toEqual(
      storageBefore,
    );
    expect(
      db
        .getExternalCapabilityIntakeReservationsForTest(keyId)
        .slice(attemptCount)
        .map((attempt) => attempt.outcome),
    ).toEqual(['accepted', 'duplicate']);
  });

  test('returns an idempotency conflict before Vault capacity admission', async () => {
    const first = await invokeRoutes.request('/quote-document-process/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: requestBody('t2-task-preflight-conflict'),
    });
    expect(first.status).toBe(202);
    const storageBefore = db.getExternalCapabilityStorageUsageForTest();
    const conflictingBody = requestBody('t2-task-preflight-conflict');
    conflictingBody.set('instructions', '使用不同的处理要求。');
    process.env.EXTERNAL_CAPABILITY_VAULT_MAX_BYTES = '0';
    const conflict = await invokeRoutes.request(
      '/quote-document-process/runs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}` },
        body: conflictingBody,
      },
    );
    delete process.env.EXTERNAL_CAPABILITY_VAULT_MAX_BYTES;

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ duplicate: false });
    expect(db.getExternalCapabilityStorageUsageForTest()).toEqual(
      storageBefore,
    );
  });

  test('lets the owning bearer key cancel a queued task', async () => {
    const created = await invokeRoutes.request('/quote-document-process/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: requestBody('t2-task-cancel'),
    });
    expect(created.status).toBe(202);
    const { runId } = (await created.json()) as { runId: string };

    const cancelled = await invokeRoutes.request(
      `/quote-document-process/runs/${runId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bearer}` },
      },
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      runId,
      status: 'cancelled',
      cancelled: true,
    });
    expect(db.getExternalCapabilityRunById(runId)).toMatchObject({
      status: 'cancelled',
      error_code: 'CANCELLED_BY_CALLER',
    });
  });

  test('retries local cleanup for repeated caller cancellation with Docker debt', async () => {
    const run = db.createExternalCapabilityRun({
      capabilitySlug: 'quote-document-process',
      keyId,
      externalTaskId: 't2-task-repeated-cancel-cleanup',
      idempotencyKey: 't2-idempotency-repeated-cancel-cleanup',
      inputManifest: { version: 1 },
    }).run;
    let claim: NonNullable<
      ReturnType<typeof db.claimNextExternalCapabilityRun>
    >;
    for (;;) {
      claim = db.claimNextExternalCapabilityRun(
        'caller-repeated-cleanup-worker',
        60_000,
      )!;
      if (claim.id === run.id) break;
      expect(
        db.completeExternalCapabilityRun(
          claim.id,
          claim.lease_owner,
          claim.lease_token,
          { status: 'cancelled' },
        ),
      ).toBe(true);
    }
    expect(
      db.markExternalCapabilityRunContainerCleanupRequired(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        claim.attempt,
      ),
    ).toBe(true);
    const pendingUntil = db.reserveExternalCapabilityRunContainerCreation(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
      claim.attempt,
      60_000,
      45_000,
    );
    expect(pendingUntil).not.toBeNull();
    executionMocks.stop.mockClear();

    const cancel = () =>
      invokeRoutes.request(`/quote-document-process/runs/${run.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bearer}` },
      });
    const first = await cancel();
    const repeated = await cancel();

    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      runId: run.id,
      status: 'cancelled',
      cancelled: false,
    });
    expect(executionMocks.stop).toHaveBeenCalledTimes(2);
    expect(executionMocks.stop).toHaveBeenNthCalledWith(1, run.id);
    expect(executionMocks.stop).toHaveBeenNthCalledWith(2, run.id);

    expect(
      db.finishExternalCapabilityRunContainerCreation(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        claim.attempt,
        pendingUntil!,
        60_000,
      ),
    ).toBe(false);
    expect(
      db.clearExternalCapabilityRunContainerCleanupAfterVerifiedAbsence(
        run.id,
        claim.attempt,
        claim.lease_token,
      ),
    ).toBe(true);
  });

  test('does not reveal or cancel another key owner’s task', async () => {
    const created = await invokeRoutes.request('/quote-document-process/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: requestBody('t2-task-key-isolation'),
    });
    const { runId } = (await created.json()) as { runId: string };
    const otherBearer = db.createExternalCapabilityKey({
      capabilitySlug: 'quote-document-process',
      label: 'Other T2 test',
    }).secret;

    const response = await invokeRoutes.request(
      `/quote-document-process/runs/${runId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${otherBearer}` },
      },
    );
    expect(response.status).toBe(404);
    expect(db.getExternalCapabilityRunById(runId)?.status).toBe('queued');
    expect(
      db.cancelExternalCapabilityRun('quote-document-process', keyId, runId),
    ).toMatchObject({ cancelled: true });
  });

  test('revokes old bearer access when the canonical workspace is deleted', async () => {
    for (;;) {
      const stale = db.claimNextExternalCapabilityRun(
        'workspace-deletion-test-drain',
        60_000,
      );
      if (!stale) break;
      expect(
        db.completeExternalCapabilityRun(
          stale.id,
          stale.lease_owner,
          stale.lease_token,
          { status: 'cancelled' },
        ),
      ).toBe(true);
    }

    const scoped = createScopedKey('workspace deletion');
    const bytes = Buffer.from('workspace deletion output');
    const stored = storage.storeExternalCapabilityArtifact(vaultDir, {
      runId: 'workspace-deletion-output',
      artifactId: 'result',
      bytes,
    });
    const runId = createSucceededRunWithOutput({
      keyId: scoped.keyId,
      taskId: 'workspace-deletion-output-task',
      output: {
        displayName: 'normalized-data.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ...stored,
      },
    });

    const beforeDelete = await invokeRoutes.request(
      `/quote-document-process/runs/${runId}/output`,
      { headers: { Authorization: `Bearer ${scoped.bearer}` } },
    );
    expect(beforeDelete.status).toBe(200);
    expect(Buffer.from(await beforeDelete.arrayBuffer())).toEqual(bytes);

    db.deleteGroupData(
      'web:6241df8f-b015-472e-9083-6c4ec31eedc1',
      'flow-munrwfg2-u6u8',
    );
    expect(
      db
        .getExternalCapabilityKeys('quote-document-process')
        .find((key) => key.id === scoped.keyId),
    ).toMatchObject({ status: 'revoked' });

    const status = await invokeRoutes.request(
      `/quote-document-process/runs/${runId}`,
      { headers: { Authorization: `Bearer ${scoped.bearer}` } },
    );
    expect(status.status).toBe(401);
    const output = await invokeRoutes.request(
      `/quote-document-process/runs/${runId}/output`,
      { headers: { Authorization: `Bearer ${scoped.bearer}` } },
    );
    expect(output.status).toBe(401);
  });
});
