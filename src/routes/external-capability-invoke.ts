import crypto from 'node:crypto';

import AdmZip from 'adm-zip';
import { Hono } from 'hono';
import sharp from 'sharp';
import { bodyLimit } from 'hono/body-limit';

import {
  authenticateExternalCapabilityKey,
  cancelExternalCapabilityRun,
  createExternalCapabilityRun,
  ExternalCapabilityQuotaError,
  getExternalCapabilityRunById,
} from '../db.js';
import { stopExternalCapabilityExecution } from '../external-capability-execution-control.js';
import { getExternalCapabilityQuotaConfig } from '../external-capability-quota-config.js';
import { getExternalCapabilitySafeErrorMetadata } from '../external-capability-safe-error.js';
import { probeExternalCapabilityDockerNetwork } from '../external-capability-network.js';
import { getConfiguredExternalCapability } from '../external-capabilities.js';
import {
  getExternalCapabilityDockerNetwork,
  isExternalCapabilityReleaseEnabled,
} from '../external-capability-release-config.js';
import { logger } from '../logger.js';
import {
  deleteExternalCapabilityRunArtifacts,
  getExternalCapabilityVaultRoot,
  readExternalCapabilityArtifact,
  storeExternalCapabilityArtifact,
} from '../external-capability-storage.js';
import type { ExternalCapabilityKey, ExternalCapabilityRun } from '../types.js';

const EXTERNAL_REQUEST_MAX_BYTES = 50 * 1024 * 1024 + 256 * 1024;
const EXTERNAL_OUTPUT_SCHEMA_VERSION = 1;
const EXTERNAL_TASK_INSTRUCTIONS_MAX_CHARS = 8_000;
const EXTERNAL_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXTERNAL_REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_DISPLAY_FILENAME_RE = /^[^/\\\0]{1,180}$/;
const SAFE_SHEET_NAME_RE = /^[^\\/*?:\[\]]{1,31}$/;
const EXTERNAL_IMAGE_MAX_PIXELS = 25 * 1024 * 1024;
const EXTERNAL_IMAGE_MAX_DIMENSION = 10_000;
const EXTERNAL_XLSX_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const EXTERNAL_XLSX_MAX_EXPANSION_RATIO = 20;
const EXTERNAL_XLSX_EXPANSION_ALLOWANCE_BYTES = 10 * 1024 * 1024;
const EXTERNAL_XLSX_MAX_CONTROL_XML_BYTES = 2 * 1024 * 1024;
const XLSX_WORKBOOK_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const UNSAFE_OOXML_CONTENT_TYPE_RE =
  /(macroenabled|macrosheet|dialogsheet|vbaproject|oleobject|activex)/i;
const UNSAFE_OOXML_RELATIONSHIP_TYPE_RE =
  /\/(externalLink|vbaProject|oleObject|package)$/i;

const externalCapabilityInvokeRoutes = new Hono<{
  Variables: { externalCapabilityKey: ExternalCapabilityKey };
}>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function externalAuth(c: any): ExternalCapabilityKey | Response {
  const value = c.req.header('authorization');
  const match = value?.match(/^Bearer (ec_[A-Za-z0-9_-]+)$/);
  if (!match) {
    return c.json(
      { error: 'Unauthorized', code: 'EXTERNAL_AUTH_REQUIRED' },
      401,
    );
  }
  const key = authenticateExternalCapabilityKey(match[1]);
  if (!key) {
    return c.json(
      { error: 'Unauthorized', code: 'EXTERNAL_AUTH_INVALID' },
      401,
    );
  }
  return key;
}

function parseOptionalReference(
  raw: unknown,
  label: string,
): string | null | Response {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || !EXTERNAL_REFERENCE_RE.test(raw)) {
    return new Response(
      JSON.stringify({
        error: `${label} must be an opaque identifier up to 128 characters`,
        code: 'INVALID_REQUEST',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return raw;
}

function parseTaskInstructions(raw: unknown): string | Response {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string') {
    return new Response(
      JSON.stringify({
        error: 'instructions must be text',
        code: 'INVALID_REQUEST',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  const instructions = raw.trim();
  if (instructions.length > EXTERNAL_TASK_INSTRUCTIONS_MAX_CHARS) {
    return new Response(
      JSON.stringify({
        error: `instructions must not exceed ${EXTERNAL_TASK_INSTRUCTIONS_MAX_CHARS} characters`,
        code: 'INVALID_REQUEST',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  return instructions;
}

function readBoundedZipXml(zip: AdmZip, entryName: string): string | null {
  const entry = zip.getEntry(entryName);
  if (
    !entry ||
    entry.isDirectory ||
    entry.header.size < 0 ||
    entry.header.size > EXTERNAL_XLSX_MAX_CONTROL_XML_BYTES
  ) {
    return null;
  }
  const data = entry.getData();
  if (data.byteLength > EXTERNAL_XLSX_MAX_CONTROL_XML_BYTES) return null;
  return data.toString('utf8');
}

function xmlAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'is').exec(tag);
  return match?.[2] ?? null;
}

function hasSafeXlsxPackageMetadata(
  zip: AdmZip,
  entryNames: Set<string>,
): boolean {
  if (
    !entryNames.has('_rels/.rels') ||
    !entryNames.has('xl/_rels/workbook.xml.rels')
  ) {
    return false;
  }

  const contentTypes = readBoundedZipXml(zip, '[Content_Types].xml');
  if (!contentTypes) return false;
  const contentTypeTags = contentTypes.match(/<(?:Default|Override)\b[^>]*>/gi);
  if (!contentTypeTags) return false;
  let hasExpectedWorkbookType = false;
  for (const tag of contentTypeTags) {
    const contentType = xmlAttribute(tag, 'ContentType');
    if (!contentType || UNSAFE_OOXML_CONTENT_TYPE_RE.test(contentType)) {
      return false;
    }
    if (
      xmlAttribute(tag, 'PartName') === '/xl/workbook.xml' &&
      contentType === XLSX_WORKBOOK_CONTENT_TYPE
    ) {
      hasExpectedWorkbookType = true;
    }
  }
  if (!hasExpectedWorkbookType) return false;

  for (const entryName of entryNames) {
    if (!entryName.toLowerCase().endsWith('.rels')) continue;
    const relationships = readBoundedZipXml(zip, entryName);
    if (!relationships) return false;
    const relationshipTags =
      relationships.match(/<Relationship\b[^>]*>/gi) ?? [];
    for (const tag of relationshipTags) {
      if (/^external$/i.test(xmlAttribute(tag, 'TargetMode') ?? '')) {
        return false;
      }
      if (
        UNSAFE_OOXML_RELATIONSHIP_TYPE_RE.test(xmlAttribute(tag, 'Type') ?? '')
      ) {
        return false;
      }
    }
  }
  return true;
}

function detectMimeType(bytes: Buffer): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    bytes.subarray(8, 12).equals(Buffer.from('WEBP'))
  ) {
    return 'image/webp';
  }
  if (bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return 'application/pdf';
  }
  if (bytes.subarray(0, 4).equals(Buffer.from('PK\x03\x04'))) {
    try {
      const zip = new AdmZip(bytes);
      const entries = zip.getEntries();
      const names = new Set(entries.map((entry) => entry.entryName));
      const safeEntries = entries.every(
        (entry) =>
          !entry.entryName.startsWith('/') &&
          !entry.entryName.split('/').includes('..') &&
          entry.header.size >= 0 &&
          entry.header.size <= EXTERNAL_XLSX_MAX_UNCOMPRESSED_BYTES,
      );
      const uncompressedBytes = entries.reduce(
        (sum, entry) => sum + entry.header.size,
        0,
      );
      const expansionLimit = Math.max(
        EXTERNAL_XLSX_EXPANSION_ALLOWANCE_BYTES,
        bytes.length * EXTERNAL_XLSX_MAX_EXPANSION_RATIO,
      );
      const containsActiveContent = entries.some((entry) =>
        /(^|\/)(?:[^/]+\.bin|activeX\/|embeddings\/|externalLinks\/|macrosheets\/|dialogsheets\/)/i.test(
          entry.entryName,
        ),
      );
      if (
        safeEntries &&
        !containsActiveContent &&
        uncompressedBytes <= EXTERNAL_XLSX_MAX_UNCOMPRESSED_BYTES &&
        uncompressedBytes <= expansionLimit &&
        names.has('[Content_Types].xml') &&
        names.has('xl/workbook.xml') &&
        hasSafeXlsxPackageMetadata(zip, names)
      ) {
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      }
    } catch {
      // Not a valid, bounded OOXML spreadsheet.
    }
  }
  return null;
}

async function hasSafeImageDimensions(bytes: Buffer): Promise<boolean> {
  try {
    const metadata = await sharp(bytes, {
      limitInputPixels: EXTERNAL_IMAGE_MAX_PIXELS,
      pages: 1,
    }).metadata();
    return (
      typeof metadata.width === 'number' &&
      typeof metadata.height === 'number' &&
      metadata.width > 0 &&
      metadata.height > 0 &&
      metadata.width <= EXTERNAL_IMAGE_MAX_DIMENSION &&
      metadata.height <= EXTERNAL_IMAGE_MAX_DIMENSION &&
      metadata.width * metadata.height <= EXTERNAL_IMAGE_MAX_PIXELS &&
      (metadata.pages ?? 1) <= 1
    );
  } catch {
    return false;
  }
}

type OutputColumn = {
  key: string;
  name: string;
  required?: boolean;
  description?: string;
};

function parseOutputSchema(
  raw: unknown,
): { columns: OutputColumn[]; sheetName?: string; version: number } | Response {
  if (typeof raw !== 'string' || raw.length > 50_000) {
    return new Response(
      JSON.stringify({
        error: 'outputSchema is required',
        code: 'INVALID_REQUEST',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const columns = Array.isArray(parsed.columns) ? parsed.columns : [];
    if (columns.length === 0 || columns.length > 100) throw new Error();
    const seen = new Set<string>();
    const normalized = columns.map((value): OutputColumn => {
      if (!value || typeof value !== 'object') throw new Error();
      const column = value as Record<string, unknown>;
      const key = typeof column.key === 'string' ? column.key : '';
      const name = typeof column.name === 'string' ? column.name : '';
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
        !name ||
        name.length > 120 ||
        seen.has(key)
      ) {
        throw new Error();
      }
      seen.add(key);
      return {
        key,
        name,
        ...(column.required === true ? { required: true } : {}),
        ...(typeof column.description === 'string' &&
        column.description.length <= 500
          ? { description: column.description }
          : {}),
      };
    });
    if (
      parsed.sheetName !== undefined &&
      (typeof parsed.sheetName !== 'string' ||
        !SAFE_SHEET_NAME_RE.test(parsed.sheetName))
    ) {
      throw new Error();
    }
    const sheetName = parsed.sheetName as string | undefined;
    return {
      columns: normalized,
      sheetName,
      version: EXTERNAL_OUTPUT_SCHEMA_VERSION,
    };
  } catch {
    return new Response(
      JSON.stringify({
        error: 'outputSchema must contain 1-100 uniquely keyed columns',
        code: 'INVALID_OUTPUT_SCHEMA',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

function createRequestFingerprint(input: {
  taskInstructions: string;
  outputSchema: {
    columns: OutputColumn[];
    sheetName?: string;
    version: number;
  };
  artifacts: Array<{
    displayName: string;
    detectedMimeType: string;
    byteLength: number;
    sha256: string;
  }>;
}): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        taskInstructions: input.taskInstructions,
        outputSchema: input.outputSchema,
        artifacts: input.artifacts,
      }),
    )
    .digest('hex');
}

function publicRunErrorMessage(code: string | null): string {
  switch (code) {
    case 'CAPABILITY_CONFIGURATION_INVALID':
      return 'The processing capability is not ready.';
    case 'PROCESSING_INTERRUPTED':
      return 'Processing was interrupted and was not retried.';
    case 'CAPABILITY_UNAVAILABLE':
      return 'The processing capability is not available.';
    default:
      return 'The task could not be processed.';
  }
}

function publicRunResult(result: Record<string, unknown>) {
  const output = isRecord(result.output) ? result.output : null;
  return {
    ...(typeof result.format === 'string' ? { format: result.format } : {}),
    ...(typeof result.rowCount === 'number'
      ? { rowCount: result.rowCount }
      : {}),
    ...(Array.isArray(result.warnings)
      ? {
          warnings: result.warnings.filter(
            (warning): warning is string => typeof warning === 'string',
          ),
        }
      : {}),
    ...(output
      ? {
          output: {
            ...(typeof output.displayName === 'string'
              ? { displayName: output.displayName }
              : {}),
            ...(typeof output.mimeType === 'string'
              ? { mimeType: output.mimeType }
              : {}),
            ...(typeof output.byteLength === 'number'
              ? { byteLength: output.byteLength }
              : {}),
            ...(typeof output.sha256 === 'string'
              ? { sha256: output.sha256 }
              : {}),
          },
        }
      : {}),
  };
}

function runView(run: ExternalCapabilityRun) {
  return {
    runId: run.id,
    externalTaskId: run.external_task_id,
    status: run.status,
    attempt: run.attempt,
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    ...(run.status === 'succeeded' && run.result
      ? { result: publicRunResult(run.result) }
      : {}),
    ...(run.status === 'failed'
      ? {
          error: {
            code: run.error_code ?? 'PROCESSING_FAILED',
            message: publicRunErrorMessage(run.error_code),
          },
        }
      : {}),
  };
}

// Authenticate before the body parser so an anonymous sender cannot make the
// service buffer a maximum-sized multipart payload.
externalCapabilityInvokeRoutes.use('/:slug/runs', async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const key = externalAuth(c);
  if (key instanceof Response) return key;
  c.set('externalCapabilityKey', key);
  await next();
});

externalCapabilityInvokeRoutes.use(
  '/:slug/runs',
  bodyLimit({
    maxSize: EXTERNAL_REQUEST_MAX_BYTES,
    onError: (c) =>
      c.json({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' }, 413),
  }),
);

externalCapabilityInvokeRoutes.post('/:slug/runs', async (c) => {
  const key = c.get('externalCapabilityKey');
  const slug = c.req.param('slug');
  if (key.capability_slug !== slug) {
    return c.json({ error: 'Capability not found', code: 'NOT_FOUND' }, 404);
  }
  const capability = getConfiguredExternalCapability(slug);
  const networkName = getExternalCapabilityDockerNetwork();
  if (
    !capability ||
    capability.status !== 'active' ||
    !isExternalCapabilityReleaseEnabled() ||
    !networkName
  ) {
    return c.json(
      { error: 'Capability is not available', code: 'CAPABILITY_UNAVAILABLE' },
      409,
    );
  }
  try {
    await probeExternalCapabilityDockerNetwork(networkName);
  } catch {
    return c.json(
      { error: 'Capability is not available', code: 'CAPABILITY_UNAVAILABLE' },
      409,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch {
    return c.json(
      { error: 'Invalid multipart request', code: 'INVALID_REQUEST' },
      400,
    );
  }
  const externalTaskId =
    typeof body.externalTaskId === 'string' ? body.externalTaskId : '';
  if (!EXTERNAL_TASK_ID_RE.test(externalTaskId)) {
    return c.json(
      {
        error:
          'externalTaskId must be an opaque identifier up to 128 characters',
        code: 'INVALID_REQUEST',
      },
      400,
    );
  }
  const tenantRef = parseOptionalReference(body.tenantRef, 'tenantRef');
  const accountRef = parseOptionalReference(body.accountRef, 'accountRef');
  const idempotencyKey = parseOptionalReference(
    body.idempotencyKey,
    'idempotencyKey',
  );
  const taskInstructions = parseTaskInstructions(body.instructions);
  if (tenantRef instanceof Response) return tenantRef;
  if (accountRef instanceof Response) return accountRef;
  if (idempotencyKey instanceof Response) return idempotencyKey;
  if (taskInstructions instanceof Response) return taskInstructions;
  const outputSchema = parseOutputSchema(body.outputSchema);
  if (outputSchema instanceof Response) return outputSchema;

  const candidateFiles = body.files;
  const files = (
    Array.isArray(candidateFiles) ? candidateFiles : [candidateFiles]
  ).filter((value): value is File => value instanceof File);
  if (files.length === 0 || files.length > capability.max_files_per_run) {
    return c.json(
      { error: 'Invalid number of files', code: 'INVALID_FILE_COUNT' },
      400,
    );
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const quotaConfig = getExternalCapabilityQuotaConfig();
  if (totalBytes > quotaConfig.maxInputBytesPerRun) {
    return c.json(
      {
        error: 'Input exceeds the processing budget',
        code: 'INPUT_BUDGET_EXCEEDED',
      },
      413,
    );
  }
  if (
    totalBytes > capability.max_total_bytes ||
    files.some(
      (file) =>
        file.size === 0 ||
        file.size > capability.max_file_bytes ||
        !SAFE_DISPLAY_FILENAME_RE.test(file.name),
    )
  ) {
    return c.json(
      { error: 'File size or name is not allowed', code: 'INVALID_FILE' },
      400,
    );
  }

  const runId = crypto.randomUUID();
  let vaultRoot: string | undefined;
  const artifacts: Array<Record<string, unknown>> = [];
  try {
    const preparedFiles: Array<{
      file: File;
      bytes: Buffer;
      detectedMimeType: string;
      sha256: string;
    }> = [];
    for (const file of files) {
      const bytes = Buffer.from(await file.arrayBuffer());
      const detectedMimeType = detectMimeType(bytes);
      if (
        !detectedMimeType ||
        !capability.allowed_mime_types.includes(detectedMimeType) ||
        (detectedMimeType.startsWith('image/') &&
          !(await hasSafeImageDimensions(bytes)))
      ) {
        return c.json(
          {
            error: 'File type or content is not allowed',
            code: 'INVALID_FILE',
          },
          400,
        );
      }
      preparedFiles.push({
        file,
        bytes,
        detectedMimeType,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
    }
    const requestFingerprint = createRequestFingerprint({
      taskInstructions,
      outputSchema,
      artifacts: preparedFiles.map((prepared) => ({
        displayName: prepared.file.name,
        detectedMimeType: prepared.detectedMimeType,
        byteLength: prepared.bytes.byteLength,
        sha256: prepared.sha256,
      })),
    });
    vaultRoot = getExternalCapabilityVaultRoot();
    for (const prepared of preparedFiles) {
      const artifactId = crypto.randomUUID();
      const stored = storeExternalCapabilityArtifact(vaultRoot, {
        runId,
        artifactId,
        bytes: prepared.bytes,
      });
      artifacts.push({
        id: artifactId,
        displayName: prepared.file.name,
        detectedMimeType: prepared.detectedMimeType,
        byteLength: stored.byteLength,
        sha256: stored.sha256,
        storageRef: stored.storageRef,
      });
    }
    const submitted = createExternalCapabilityRun({
      id: runId,
      capabilitySlug: slug,
      keyId: key.id,
      externalTaskId,
      idempotencyKey,
      tenantRef,
      accountRef,
      inputManifest: {
        version: 1,
        requestFingerprint,
        taskInstructions,
        outputSchema,
        artifacts,
      },
      admissionLimits: quotaConfig,
    });
    if (!submitted.created) {
      deleteExternalCapabilityRunArtifacts(vaultRoot, runId);
      return c.json(
        {
          ...runView(submitted.run),
          duplicate: submitted.reason === 'duplicate',
        },
        submitted.reason === 'duplicate' ? 200 : 409,
      );
    }
    return c.json(runView(submitted.run), 202);
  } catch (error) {
    if (vaultRoot!) {
      try {
        deleteExternalCapabilityRunArtifacts(vaultRoot, runId);
      } catch {
        // Best-effort cleanup must not hide the intake failure.
      }
    }
    if (error instanceof ExternalCapabilityQuotaError) {
      return c.json(
        { error: 'External capability quota exceeded', code: error.code },
        429,
      );
    }
    logger.warn(
      {
        ...getExternalCapabilitySafeErrorMetadata(error),
        capabilitySlug: slug,
        runId,
      },
      'External capability intake failed',
    );
    return c.json(
      { error: 'Could not accept files', code: 'EXTERNAL_INTAKE_FAILED' },
      500,
    );
  }
});

externalCapabilityInvokeRoutes.get('/:slug/runs/:runId', (c) => {
  const key = externalAuth(c);
  if (key instanceof Response) return key;
  const slug = c.req.param('slug');
  if (key.capability_slug !== slug) {
    return c.json({ error: 'Run not found', code: 'NOT_FOUND' }, 404);
  }
  const run = getExternalCapabilityRunById(c.req.param('runId'));
  if (!run || run.capability_slug !== slug || run.key_id !== key.id) {
    return c.json({ error: 'Run not found', code: 'NOT_FOUND' }, 404);
  }
  return c.json(runView(run));
});

externalCapabilityInvokeRoutes.delete('/:slug/runs/:runId', (c) => {
  const key = externalAuth(c);
  if (key instanceof Response) return key;
  const slug = c.req.param('slug');
  if (key.capability_slug !== slug) {
    return c.json({ error: 'Run not found', code: 'NOT_FOUND' }, 404);
  }
  const cancelled = cancelExternalCapabilityRun(
    slug,
    key.id,
    c.req.param('runId'),
  );
  if (!cancelled) {
    return c.json({ error: 'Run not found', code: 'NOT_FOUND' }, 404);
  }
  if (cancelled.cancelled) {
    // The durable state change fences the worker even if it runs in another
    // process. This additionally stops a local container without waiting for
    // the next lease heartbeat.
    stopExternalCapabilityExecution(cancelled.run.id);
  }
  return c.json({
    ...runView(cancelled.run),
    cancelled: cancelled.cancelled,
  });
});

externalCapabilityInvokeRoutes.get('/:slug/runs/:runId/output', (c) => {
  const key = externalAuth(c);
  if (key instanceof Response) return key;
  const slug = c.req.param('slug');
  const run = getExternalCapabilityRunById(c.req.param('runId'));
  if (
    !run ||
    run.capability_slug !== slug ||
    run.key_id !== key.id ||
    run.status !== 'succeeded' ||
    !run.result ||
    !isRecord(run.result.output)
  ) {
    return c.json({ error: 'Output not found', code: 'NOT_FOUND' }, 404);
  }
  const output = run.result.output;
  if (
    typeof output.storageRef !== 'string' ||
    typeof output.byteLength !== 'number' ||
    typeof output.sha256 !== 'string' ||
    typeof output.displayName !== 'string'
  ) {
    return c.json({ error: 'Output not found', code: 'NOT_FOUND' }, 404);
  }
  try {
    const bytes = readExternalCapabilityArtifact(
      getExternalCapabilityVaultRoot(),
      {
        storageRef: output.storageRef,
        byteLength: output.byteLength,
        sha256: output.sha256,
      },
    );
    return new Response(bytes, {
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${output.displayName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return c.json(
      { error: 'Output unavailable', code: 'OUTPUT_UNAVAILABLE' },
      410,
    );
  }
});

export default externalCapabilityInvokeRoutes;
