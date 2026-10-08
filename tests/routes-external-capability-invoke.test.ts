import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';
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
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/external-capability-network.js', () => ({
  probeExternalCapabilityDockerNetwork: vi.fn(() => {
    if (process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL === 'true') {
      throw new Error('network not ready');
    }
  }),
}));

const db = await import('../src/db.js');
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

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup('web:6241df8f-b015-472e-9083-6c4ec31eedc1', {
    name: '数据规整',
    folder: 'flow-munrwfg2-u6u8',
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: 'owner',
  });
  db.setExternalCapabilityStatus('quote-document-process', 'active');
  bearer = db.createExternalCapabilityKey({
    capabilitySlug: 'quote-document-process',
    label: 'T2 test',
  }).secret;
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.EXTERNAL_CAPABILITY_VAULT_DIR;
  delete process.env.EXTERNAL_CAPABILITY_RELEASE_ENABLED;
  delete process.env.EXTERNAL_CAPABILITY_DOCKER_NETWORK;
  delete process.env.EXTERNAL_TEST_NETWORK_PROBE_FAIL;
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
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" />',
    ),
    'xl/_rels/workbook.xml.rels': Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    ),
    ...extraEntries,
  };
  for (const [name, bytes] of Object.entries(entries)) zip.addFile(name, bytes);
  return zip.toBuffer();
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
        { key: 'name', name: '名称', required: true },
        { key: 'quantity', name: '数量' },
      ],
    }),
  );
  form.append('files', new File([PNG], 'source.png', { type: 'image/png' }));
  return form;
}

describe('external capability invoke API', () => {
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
            warnings: ['review one row'],
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
        warnings: ['review one row'],
        output: { displayName: 'normalized-data.xlsx', byteLength: 123 },
      },
    });
    expect(JSON.stringify(body)).not.toContain('storageRef');
    expect(JSON.stringify(body)).not.toContain('private-result');
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

  test('accepts a bounded macro-free XLSX archive', async () => {
    const body = requestBody('t2-task-xlsx');
    body.set(
      'files',
      new File([workbookArchive()], 'source.xlsx', {
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
    expect(response.status, await response.clone().text()).toBe(202);
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
    const first = await invokeRoutes.request('/quote-document-process/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: requestBody('t2-task-idempotent'),
    });
    expect(first.status).toBe(202);
    const original = (await first.json()) as { runId: string };

    const retry = await invokeRoutes.request('/quote-document-process/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: requestBody('t2-task-idempotent'),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      runId: original.runId,
      status: 'queued',
      duplicate: true,
    });
    expect(
      fs.readdirSync(path.join(vaultDir, 'runs', original.runId)),
    ).toHaveLength(1);
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
  });
});
