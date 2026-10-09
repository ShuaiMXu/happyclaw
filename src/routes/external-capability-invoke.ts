import crypto from 'node:crypto';

import AdmZip from 'adm-zip';
import { Hono } from 'hono';
import sharp from 'sharp';

import { CONTAINER_IMAGE } from '../config.js';
import {
  authenticateExternalCapabilityKey,
  cancelExternalCapabilityRun,
  consumeExternalCapabilityApiRateLimit,
  createExternalCapabilityRun,
  ExternalCapabilityAdmissionError,
  preflightExternalCapabilityRunSubmission,
  ExternalCapabilityIntakeReservationError,
  ExternalCapabilityQuotaError,
  finishExternalCapabilityIntake,
  getExternalCapabilityRunById,
  getRegisteredGroup,
  renewExternalCapabilityIntake,
  reserveExternalCapabilityIntake,
  type ExternalCapabilityIntakeOutcome,
} from '../db.js';
import { consumeExternalCapabilityAuthAdmission } from '../external-capability-auth-rate-limit.js';
import { stopExternalCapabilityExecution } from '../external-capability-execution-control.js';
import {
  EXTERNAL_CAPABILITY_MAX_BASE64_IMAGE_BYTES,
  externalCapabilityBase64ByteLength,
} from '../external-capability-input-limits.js';
import {
  tryAcquireExternalCapabilityDownloadSlot,
  tryAcquireExternalCapabilityIntakeSlot,
} from '../external-capability-intake-control.js';
import {
  parseExternalOutputSchema,
  type ExternalOutputSchema,
} from '../external-capability-output-schema.js';
import { getExternalCapabilityQuotaConfig } from '../external-capability-quota-config.js';
import { isExternalCapabilityVaultCensusReady } from '../external-capability-storage-backfill.js';
import {
  ExternalCapabilityStorageCapacityError,
  recordExternalCapabilityStorageMaterializedCapacity,
  releaseExternalCapabilityStorageCapacity,
  reserveExternalCapabilityStorageCapacity,
  settleExternalCapabilityStorageCapacity,
} from '../external-capability-storage-capacity.js';
import { sanitizeExternalCapabilityWarnings } from '../external-capability-result-contract.js';
import { getExternalCapabilitySafeErrorMetadata } from '../external-capability-safe-error.js';
import { probeExternalCapabilityDockerNetwork } from '../external-capability-network.js';
import { assertExternalCapabilityRunnerImage } from '../external-capability-runner-image.js';
import { getConfiguredExternalCapability } from '../external-capabilities.js';
import {
  hasSafeOoxmlContentTypeCoverage,
  hasSafeOoxmlRelationships,
  hasSafeOoxmlWorkbook,
  hasSafeOoxmlXmlDocument,
} from '../ooxml-package-validator.js';
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
import { acquireExternalCapabilityVaultSharedLock } from '../external-capability-vault-lock.js';
import type { ExternalCapabilityKey, ExternalCapabilityRun } from '../types.js';
import { getClientIp } from '../utils.js';

const EXTERNAL_MULTIPART_OVERHEAD_BYTES = 256 * 1024;
const EXTERNAL_MULTIPART_MAX_PARTS = 32;
const EXTERNAL_TASK_INSTRUCTIONS_MAX_CHARS = 8_000;
const EXTERNAL_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXTERNAL_REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_DISPLAY_FILENAME_RE = /^[^/\\\0]{1,180}$/;
const EXTERNAL_IMAGE_MAX_PIXELS = 25 * 1024 * 1024;
// Must not exceed the runner MessageStream image boundary; otherwise the
// runner emits a rejection warning before READY and the attempt cannot start.
const EXTERNAL_IMAGE_MAX_DIMENSION = 8_000;
const EXTERNAL_XLSX_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const EXTERNAL_XLSX_MAX_EXPANSION_RATIO = 20;
const EXTERNAL_XLSX_EXPANSION_ALLOWANCE_BYTES = 10 * 1024 * 1024;
const EXTERNAL_XLSX_MAX_CONTROL_XML_BYTES = 2 * 1024 * 1024;
const EXTERNAL_XLSX_MAX_ENTRIES = 2_000;

const externalCapabilityInvokeRoutes = new Hono<{
  Variables: { externalCapabilityKey: ExternalCapabilityKey };
}>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class ExternalRequestBodyError extends Error {
  constructor(
    readonly kind: 'payload_too_large' | 'invalid' | 'aborted',
    readonly observedBytes: number,
  ) {
    super(`External request body ${kind}`);
    this.name = 'ExternalRequestBodyError';
  }
}

function parseDeclaredContentLength(value: string | undefined): {
  valid: boolean;
  value: number | null;
} {
  if (value === undefined) return { valid: true, value: null };
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return { valid: false, value: null };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? { valid: true, value: parsed }
    : { valid: false, value: null };
}

async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ bytes: Buffer; observedBytes: number }> {
  const reader = request.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), observedBytes: 0 };
  const chunks: Buffer[] = [];
  let observedBytes = 0;
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      reject(new ExternalRequestBodyError('aborted', observedBytes));
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    while (true) {
      let next;
      try {
        next = await Promise.race([reader.read(), timedOut]);
      } catch (error) {
        if (error instanceof ExternalRequestBodyError) throw error;
        throw new ExternalRequestBodyError('aborted', observedBytes);
      }
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      observedBytes += chunk.byteLength;
      if (observedBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ExternalRequestBodyError('payload_too_large', observedBytes);
      }
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks, observedBytes), observedBytes };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function assertBoundedMultipartParts(bytes: Buffer, contentType: string): void {
  const boundaryMatch = contentType.match(
    /(?:^|;)\s*boundary=(?:"([^"\r\n]{1,70})"|([^;\s]{1,70}))(?:;|$)/i,
  );
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) throw new Error('Invalid multipart boundary');

  const delimiter = Buffer.from(`--${boundary}`);
  let offset = 0;
  let parts = 0;
  while (offset < bytes.length) {
    const index = bytes.indexOf(delimiter, offset);
    if (index < 0) break;
    const lineStart =
      index === 0 ||
      (index >= 2 && bytes[index - 2] === 0x0d && bytes[index - 1] === 0x0a);
    const suffix = index + delimiter.byteLength;
    const startsPart = bytes[suffix] === 0x0d && bytes[suffix + 1] === 0x0a;
    const closesBody = bytes[suffix] === 0x2d && bytes[suffix + 1] === 0x2d;
    if (lineStart && startsPart) {
      parts += 1;
      if (parts > EXTERNAL_MULTIPART_MAX_PARTS) {
        throw new Error('Multipart request has too many parts');
      }
    }
    if (lineStart && closesBody) break;
    offset = suffix;
  }
  if (parts === 0) throw new Error('Multipart request has no parts');
}

async function parseMultipartBody(
  bytes: Buffer,
  contentType: string | undefined,
): Promise<Record<string, unknown>> {
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
    throw new Error('Expected multipart/form-data');
  }
  assertBoundedMultipartParts(bytes, contentType);
  const form = await new Request('http://localhost/external-intake', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: new Uint8Array(bytes),
  }).formData();
  const body: Record<string, unknown> = {};
  for (const [name, value] of form.entries()) {
    const existing = body[name];
    if (existing === undefined) {
      body[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      body[name] = [existing, value];
    }
  }
  return body;
}

function externalAuth(c: any): ExternalCapabilityKey | Response {
  if (!consumeExternalCapabilityAuthAdmission({ clientId: getClientIp(c) })) {
    return c.json({ error: 'Too many requests', code: 'RATE_LIMITED' }, 429);
  }
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

function decodeUtf8Xml(bytes: Buffer): string | null {
  if (
    (bytes.length >= 2 &&
      ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
        (bytes[0] === 0xfe && bytes[1] === 0xff))) ||
    (bytes.length >= 4 &&
      ((bytes[0] === 0x00 && bytes[1] === 0x00) ||
        (bytes[2] === 0x00 && bytes[3] === 0x00)))
  ) {
    return null;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function relationshipSourceEntryName(entryName: string): string | null | false {
  if (entryName === '_rels/.rels') return null;
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(entryName);
  if (!match) return false;
  return `${match[1] ?? ''}${match[2]}`;
}

function hasSafeXlsxPackageMetadata(
  inflatedEntries: ReadonlyMap<string, Buffer>,
  entryNames: ReadonlySet<string>,
): boolean {
  if (
    !entryNames.has('_rels/.rels') ||
    !entryNames.has('xl/_rels/workbook.xml.rels')
  ) {
    return false;
  }

  const contentTypeBytes = inflatedEntries.get('[Content_Types].xml');
  const contentTypes = contentTypeBytes
    ? decodeUtf8Xml(contentTypeBytes)
    : null;
  if (
    !contentTypes ||
    contentTypeBytes!.byteLength > EXTERNAL_XLSX_MAX_CONTROL_XML_BYTES ||
    !hasSafeOoxmlContentTypeCoverage(contentTypes, entryNames)
  ) {
    return false;
  }

  const workbookBytes = inflatedEntries.get('xl/workbook.xml');
  const workbook = workbookBytes ? decodeUtf8Xml(workbookBytes) : null;
  if (!workbook || !hasSafeOoxmlWorkbook(workbook)) return false;

  for (const entryName of entryNames) {
    if (!entryName.toLowerCase().endsWith('.rels')) continue;
    const sourceEntryName = relationshipSourceEntryName(entryName);
    const relationshipBytes = inflatedEntries.get(entryName);
    const relationships = relationshipBytes
      ? decodeUtf8Xml(relationshipBytes)
      : null;
    if (
      sourceEntryName === false ||
      !relationships ||
      relationshipBytes!.byteLength > EXTERNAL_XLSX_MAX_CONTROL_XML_BYTES ||
      (sourceEntryName !== null && !entryNames.has(sourceEntryName)) ||
      !hasSafeOoxmlRelationships(relationships, {
        requireWorkbookTarget: entryName === '_rels/.rels',
        requireWorksheetTarget: entryName === 'xl/_rels/workbook.xml.rels',
        entryNames,
        sourceEntryName,
      })
    ) {
      return false;
    }
  }
  return true;
}

function hasSafeZipEntryName(entryName: string, isDirectory: boolean): boolean {
  if (
    !entryName ||
    entryName.startsWith('/') ||
    entryName.includes('\\') ||
    /[\0-\x1f\x7f]/.test(entryName)
  ) {
    return false;
  }
  const segments = entryName.split('/');
  if (isDirectory && segments.at(-1) === '') segments.pop();
  return (
    segments.length > 0 &&
    segments.every((segment) => segment && segment !== '.' && segment !== '..')
  );
}

function isOoxmlXmlPart(entryName: string): boolean {
  return /\.(?:xml|rels|vml)$/i.test(entryName);
}

function hasBoundedZipCentralDirectory(bytes: Buffer): boolean {
  const minimumEocdBytes = 22;
  if (bytes.byteLength < minimumEocdBytes) return false;
  const earliestOffset = Math.max(
    0,
    bytes.byteLength - minimumEocdBytes - 0xffff,
  );
  for (
    let offset = bytes.byteLength - minimumEocdBytes;
    offset >= earliestOffset;
    offset -= 1
  ) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentBytes = bytes.readUInt16LE(offset + 20);
    if (offset + minimumEocdBytes + commentBytes !== bytes.byteLength) continue;
    const diskNumber = bytes.readUInt16LE(offset + 4);
    const centralDirectoryDisk = bytes.readUInt16LE(offset + 6);
    const entriesOnDisk = bytes.readUInt16LE(offset + 8);
    const totalEntries = bytes.readUInt16LE(offset + 10);
    const centralDirectoryBytes = bytes.readUInt32LE(offset + 12);
    const centralDirectoryOffset = bytes.readUInt32LE(offset + 16);
    return (
      diskNumber === 0 &&
      centralDirectoryDisk === 0 &&
      entriesOnDisk === totalEntries &&
      totalEntries > 0 &&
      totalEntries <= EXTERNAL_XLSX_MAX_ENTRIES &&
      centralDirectoryOffset + centralDirectoryBytes <= offset
    );
  }
  return false;
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
      if (!hasBoundedZipCentralDirectory(bytes)) return null;
      const zip = new AdmZip(bytes);
      const entries = zip.getEntries();
      if (entries.length === 0 || entries.length > EXTERNAL_XLSX_MAX_ENTRIES) {
        return null;
      }
      const names = new Set<string>();
      const caseFoldedNames = new Set<string>();
      const inflatedEntries = new Map<string, Buffer>();
      const expansionLimit = Math.max(
        EXTERNAL_XLSX_EXPANSION_ALLOWANCE_BYTES,
        bytes.length * EXTERNAL_XLSX_MAX_EXPANSION_RATIO,
      );
      let uncompressedBytes = 0;
      for (const entry of entries) {
        const caseFoldedName = entry.entryName.toLowerCase();
        if (
          !hasSafeZipEntryName(entry.entryName, entry.isDirectory) ||
          names.has(entry.entryName) ||
          caseFoldedNames.has(caseFoldedName) ||
          entry.header.encrypted ||
          (entry.header.method !== 0 && entry.header.method !== 8) ||
          entry.header.size < 0 ||
          entry.header.size > EXTERNAL_XLSX_MAX_UNCOMPRESSED_BYTES ||
          entry.header.compressedSize < 0 ||
          entry.header.compressedSize > bytes.length ||
          /(^|\/)(?:[^/]+\.bin|activeX\/|embeddings\/|externalLinks\/|macrosheets\/|dialogsheets\/)/i.test(
            entry.entryName,
          )
        ) {
          return null;
        }
        names.add(entry.entryName);
        caseFoldedNames.add(caseFoldedName);
        if (entry.isDirectory) continue;

        // Reject from central-directory metadata before synchronous inflation.
        // The post-inflate equality check below remains authoritative against
        // forged metadata, but bounded declared totals prevent avoidable heap
        // spikes and event-loop stalls for archives that are already too large.
        const projectedUncompressedBytes =
          uncompressedBytes + entry.header.size;
        if (
          !Number.isSafeInteger(projectedUncompressedBytes) ||
          projectedUncompressedBytes > EXTERNAL_XLSX_MAX_UNCOMPRESSED_BYTES ||
          projectedUncompressedBytes > expansionLimit
        ) {
          return null;
        }

        const data = entry.getData();
        const localHeader = entry.header.localHeader;
        if (
          data.byteLength !== entry.header.size ||
          localHeader.method !== entry.header.method ||
          (typeof localHeader.flags === 'number' &&
            (localHeader.flags & 1) !== 0)
        ) {
          return null;
        }
        uncompressedBytes += data.byteLength;
        if (
          uncompressedBytes > EXTERNAL_XLSX_MAX_UNCOMPRESSED_BYTES ||
          uncompressedBytes > expansionLimit
        ) {
          return null;
        }
        inflatedEntries.set(entry.entryName, data);
        if (isOoxmlXmlPart(entry.entryName)) {
          const xml = decodeUtf8Xml(data);
          if (!xml || !hasSafeOoxmlXmlDocument(xml)) return null;
        }
      }
      if (
        names.has('[Content_Types].xml') &&
        names.has('xl/workbook.xml') &&
        hasSafeXlsxPackageMetadata(inflatedEntries, names)
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
    const options = {
      limitInputPixels: EXTERNAL_IMAGE_MAX_PIXELS,
      pages: 1,
      failOn: 'error' as const,
      sequentialRead: true,
    };
    const metadata = await sharp(bytes, options).metadata();
    const dimensionsSafe =
      typeof metadata.width === 'number' &&
      typeof metadata.height === 'number' &&
      metadata.width > 0 &&
      metadata.height > 0 &&
      metadata.width <= EXTERNAL_IMAGE_MAX_DIMENSION &&
      metadata.height <= EXTERNAL_IMAGE_MAX_DIMENSION &&
      metadata.width * metadata.height <= EXTERNAL_IMAGE_MAX_PIXELS &&
      (metadata.pages ?? 1) <= 1;
    if (!dimensionsSafe) return false;

    // metadata() can succeed on truncated PNG/JPEG/WebP inputs. Force libvips
    // to decode every pixel before admitting the file to the private Vault.
    await sharp(bytes, options).raw().toBuffer();
    return true;
  } catch {
    return false;
  }
}

function parseOutputSchema(raw: unknown): ExternalOutputSchema | Response {
  const parsed = parseExternalOutputSchema(raw);
  if (parsed.ok) return parsed.schema;
  return new Response(
    JSON.stringify({
      error: parsed.error,
      code:
        parsed.error === 'outputSchema is required'
          ? 'INVALID_REQUEST'
          : 'INVALID_OUTPUT_SCHEMA',
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

function createRequestFingerprint(input: {
  taskInstructions: string;
  outputSchema: ExternalOutputSchema;
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
    ...(result.format === 'xlsx' ? { format: 'xlsx' } : {}),
    ...(Number.isSafeInteger(result.rowCount) &&
    (result.rowCount as number) >= 0
      ? { rowCount: result.rowCount }
      : {}),
    ...(Array.isArray(result.warnings)
      ? { warnings: sanitizeExternalCapabilityWarnings(result.warnings) }
      : {}),
    ...(output
      ? {
          output: {
            displayName: 'normalized-data.xlsx',
            mimeType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ...(Number.isSafeInteger(output.byteLength) &&
            (output.byteLength as number) >= 0
              ? { byteLength: output.byteLength }
              : {}),
            ...(typeof output.sha256 === 'string' &&
            /^[a-f0-9]{64}$/.test(output.sha256)
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

externalCapabilityInvokeRoutes.post('/:slug/runs', async (c) => {
  // Authentication, credential scope and durable reservation all happen before
  // touching the request stream. A key for another capability therefore cannot
  // make this route buffer a chunked body.
  const key = externalAuth(c);
  if (key instanceof Response) return key;
  const slug = c.req.param('slug');
  if (key.capability_slug !== slug) {
    return c.json({ error: 'Capability not found', code: 'NOT_FOUND' }, 404);
  }

  const capability = getConfiguredExternalCapability(slug);
  const networkName = getExternalCapabilityDockerNetwork();
  const workspace = capability
    ? getRegisteredGroup(capability.workspace_jid)
    : undefined;
  if (
    !capability ||
    capability.status !== 'active' ||
    !isExternalCapabilityReleaseEnabled() ||
    !isExternalCapabilityVaultCensusReady() ||
    !networkName ||
    !workspace ||
    workspace.folder !== capability.workspace_folder ||
    workspace.executionMode !== 'container'
  ) {
    return c.json(
      {
        error: 'Capability is not available',
        code: 'CAPABILITY_UNAVAILABLE',
      },
      409,
    );
  }

  let vaultLock;
  try {
    vaultLock = acquireExternalCapabilityVaultSharedLock();
  } catch (error) {
    logger.warn(
      {
        ...getExternalCapabilitySafeErrorMetadata(error),
        capabilitySlug: slug,
      },
      'External capability intake could not acquire the Vault producer lock',
    );
    return c.json(
      {
        error: 'Capability is not available',
        code: 'CAPABILITY_UNAVAILABLE',
      },
      409,
    );
  }
  if (!vaultLock) {
    return c.json(
      {
        error: 'Capability is not available',
        code: 'CAPABILITY_UNAVAILABLE',
      },
      409,
    );
  }

  try {
    if (!isExternalCapabilityVaultCensusReady()) {
      return c.json(
        {
          error: 'Capability is not available',
          code: 'CAPABILITY_UNAVAILABLE',
        },
        409,
      );
    }

    const quotaConfig = getExternalCapabilityQuotaConfig();
    const maxRawBytes =
      quotaConfig.maxInputBytesPerRun + EXTERNAL_MULTIPART_OVERHEAD_BYTES;
    const declaredLength = parseDeclaredContentLength(
      c.req.header('content-length'),
    );
    const reservedRawBytes =
      declaredLength.valid &&
      declaredLength.value !== null &&
      declaredLength.value <= maxRawBytes
        ? declaredLength.value
        : declaredLength.valid && declaredLength.value === null
          ? maxRawBytes
          : 0;
    const reservationResult = reserveExternalCapabilityIntake({
      capabilitySlug: slug,
      keyId: key.id,
      reservedRawBytes,
      limits: quotaConfig,
      expectedWorkspace: {
        jid: capability.workspace_jid,
        folder: capability.workspace_folder,
        executionMode: 'container',
      },
    });
    if (!reservationResult.admitted) {
      return reservationResult.reason === 'quota'
        ? c.json(
            {
              error: 'External capability intake quota exceeded',
              code: 'INTAKE_QUOTA_EXCEEDED',
            },
            429,
          )
        : c.json(
            {
              error: 'Capability is not available',
              code: 'CAPABILITY_UNAVAILABLE',
            },
            409,
          );
    }

    const reservation = reservationResult.reservation;
    let releaseIntakeSlot: (() => void) | null = null;
    let observedRawBytes = 0;
    let intakeOutcome: ExternalCapabilityIntakeOutcome = 'failed';
    let intakeFinalized = false;
    let runId = '';
    let vaultRoot: string | undefined;
    let inputStorageReservationKey: string | undefined;
    const renewIntake = (): void => {
      if (
        !renewExternalCapabilityIntake(
          reservation.id,
          reservation.lease_token,
          quotaConfig.intakeReservationTtlMs,
        )
      ) {
        throw new ExternalCapabilityIntakeReservationError();
      }
    };
    try {
      if (!declaredLength.valid) {
        intakeOutcome = 'invalid';
        return c.json(
          { error: 'Invalid Content-Length', code: 'INVALID_REQUEST' },
          400,
        );
      }
      if (declaredLength.value !== null && declaredLength.value > maxRawBytes) {
        intakeOutcome = 'payload_too_large';
        return c.json(
          { error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' },
          413,
        );
      }
      const contentEncoding = c.req
        .header('content-encoding')
        ?.trim()
        .toLowerCase();
      if (contentEncoding && contentEncoding !== 'identity') {
        intakeOutcome = 'invalid';
        return c.json(
          {
            error: 'Encoded request bodies are not allowed',
            code: 'INVALID_REQUEST',
          },
          415,
        );
      }

      releaseIntakeSlot = tryAcquireExternalCapabilityIntakeSlot(
        quotaConfig.localIntakeConcurrency,
      );
      if (!releaseIntakeSlot) {
        intakeOutcome = 'overloaded';
        return c.json(
          { error: 'External capability intake is busy', code: 'INTAKE_BUSY' },
          429,
        );
      }

      const latestWorkspace = getRegisteredGroup(capability.workspace_jid);
      if (
        getConfiguredExternalCapability(slug)?.status !== 'active' ||
        !isExternalCapabilityReleaseEnabled() ||
        !isExternalCapabilityVaultCensusReady() ||
        getExternalCapabilityDockerNetwork() !== networkName ||
        !latestWorkspace ||
        latestWorkspace.folder !== capability.workspace_folder ||
        latestWorkspace.executionMode !== 'container'
      ) {
        intakeOutcome = 'unavailable';
        return c.json(
          {
            error: 'Capability is not available',
            code: 'CAPABILITY_UNAVAILABLE',
          },
          409,
        );
      }
      try {
        await assertExternalCapabilityRunnerImage(CONTAINER_IMAGE, {
          force: true,
        });
        renewIntake();
        await probeExternalCapabilityDockerNetwork(networkName);
        renewIntake();
      } catch (error) {
        if (error instanceof ExternalCapabilityIntakeReservationError)
          throw error;
        intakeOutcome = 'unavailable';
        return c.json(
          {
            error: 'Capability is not available',
            code: 'CAPABILITY_UNAVAILABLE',
          },
          409,
        );
      }

      let rawBody: Buffer;
      try {
        const bounded = await readBoundedRequestBody(
          c.req.raw,
          maxRawBytes,
          quotaConfig.intakeTimeoutMs,
        );
        rawBody = bounded.bytes;
        observedRawBytes = bounded.observedBytes;
        renewIntake();
      } catch (error) {
        if (error instanceof ExternalRequestBodyError) {
          observedRawBytes = error.observedBytes;
          intakeOutcome = error.kind;
          return error.kind === 'payload_too_large'
            ? c.json(
                { error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' },
                413,
              )
            : c.json(
                {
                  error: 'Request body was not completed',
                  code: 'INTAKE_ABORTED',
                },
                408,
              );
        }
        throw error;
      }

      let body: Record<string, unknown>;
      try {
        body = await parseMultipartBody(rawBody, c.req.header('content-type'));
        renewIntake();
      } catch (error) {
        if (error instanceof ExternalCapabilityIntakeReservationError)
          throw error;
        intakeOutcome = 'invalid';
        return c.json(
          { error: 'Invalid multipart request', code: 'INVALID_REQUEST' },
          400,
        );
      }
      const externalTaskId =
        typeof body.externalTaskId === 'string' ? body.externalTaskId : '';
      if (!EXTERNAL_TASK_ID_RE.test(externalTaskId)) {
        intakeOutcome = 'invalid';
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
      if (tenantRef instanceof Response) {
        intakeOutcome = 'invalid';
        return tenantRef;
      }
      if (accountRef instanceof Response) {
        intakeOutcome = 'invalid';
        return accountRef;
      }
      if (idempotencyKey instanceof Response) {
        intakeOutcome = 'invalid';
        return idempotencyKey;
      }
      if (taskInstructions instanceof Response) {
        intakeOutcome = 'invalid';
        return taskInstructions;
      }
      const outputSchema = parseOutputSchema(body.outputSchema);
      if (outputSchema instanceof Response) {
        intakeOutcome = 'invalid';
        return outputSchema;
      }

      const candidateFiles = body.files;
      const files = (
        Array.isArray(candidateFiles) ? candidateFiles : [candidateFiles]
      ).filter((value): value is File => value instanceof File);
      if (files.length === 0 || files.length > capability.max_files_per_run) {
        intakeOutcome = 'invalid';
        return c.json(
          { error: 'Invalid number of files', code: 'INVALID_FILE_COUNT' },
          400,
        );
      }
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      const effectiveTotalBytes = Math.min(
        capability.max_total_bytes,
        quotaConfig.maxInputBytesPerRun,
      );
      const effectiveFileBytes = Math.min(
        capability.max_file_bytes,
        effectiveTotalBytes,
      );
      if (
        totalBytes > effectiveTotalBytes ||
        files.some((file) => file.size > effectiveFileBytes)
      ) {
        intakeOutcome = 'payload_too_large';
        return c.json(
          {
            error: 'Input exceeds the advertised size limit',
            code: 'PAYLOAD_TOO_LARGE',
          },
          413,
        );
      }
      if (
        files.some(
          (file) =>
            file.size === 0 || !SAFE_DISPLAY_FILENAME_RE.test(file.name),
        )
      ) {
        intakeOutcome = 'invalid';
        return c.json(
          { error: 'File size or name is not allowed', code: 'INVALID_FILE' },
          400,
        );
      }

      runId = crypto.randomUUID();
      const artifacts: Array<Record<string, unknown>> = [];
      const preparedFiles: Array<{
        file: File;
        bytes: Buffer;
        detectedMimeType: string;
        sha256: string;
      }> = [];
      for (const file of files) {
        renewIntake();
        const bytes = Buffer.from(await file.arrayBuffer());
        const detectedMimeType = detectMimeType(bytes);
        if (
          !detectedMimeType ||
          !capability.allowed_mime_types.includes(detectedMimeType)
        ) {
          intakeOutcome = 'invalid';
          return c.json(
            {
              error: 'File type or content is not allowed',
              code: 'INVALID_FILE',
            },
            400,
          );
        }
        if (
          detectedMimeType.startsWith('image/') &&
          externalCapabilityBase64ByteLength(bytes.byteLength) >
            EXTERNAL_CAPABILITY_MAX_BASE64_IMAGE_BYTES
        ) {
          intakeOutcome = 'payload_too_large';
          return c.json(
            {
              error: 'Input exceeds the advertised size limit',
              code: 'PAYLOAD_TOO_LARGE',
            },
            413,
          );
        }
        if (
          detectedMimeType.startsWith('image/') &&
          !(await hasSafeImageDimensions(bytes))
        ) {
          intakeOutcome = 'invalid';
          return c.json(
            {
              error: 'File type or content is not allowed',
              code: 'INVALID_FILE',
            },
            400,
          );
        }
        renewIntake();
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
      const preflight = preflightExternalCapabilityRunSubmission({
        capabilitySlug: slug,
        keyId: key.id,
        externalTaskId,
        idempotencyKey,
        tenantRef,
        accountRef,
        requestFingerprint,
        plannedRunId: runId,
        intakeReservation: {
          id: reservation.id,
          leaseToken: reservation.lease_token,
          observedRawBytes,
        },
      });
      if (preflight.existing) {
        intakeFinalized = true;
        return c.json(
          {
            ...runView(preflight.run),
            duplicate: preflight.reason === 'duplicate',
          },
          preflight.reason === 'duplicate' ? 200 : 409,
        );
      }
      vaultRoot = getExternalCapabilityVaultRoot();
      inputStorageReservationKey = reserveExternalCapabilityStorageCapacity({
        runId,
        kind: 'input',
        objectKey: 'run-artifacts',
        byteCount: totalBytes,
        vaultRoot,
      });
      let materializedInputBytes = 0;
      for (const prepared of preparedFiles) {
        renewIntake();
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
        materializedInputBytes += stored.byteLength;
        recordExternalCapabilityStorageMaterializedCapacity(
          inputStorageReservationKey,
          materializedInputBytes,
        );
      }
      settleExternalCapabilityStorageCapacity(
        inputStorageReservationKey,
        totalBytes,
      );
      renewIntake();
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
        expectedWorkspace: {
          jid: capability.workspace_jid,
          folder: capability.workspace_folder,
          executionMode: 'container',
        },
        intakeReservation: {
          id: reservation.id,
          leaseToken: reservation.lease_token,
          observedRawBytes,
        },
      });
      intakeFinalized = true;
      if (!submitted.created) {
        deleteExternalCapabilityRunArtifacts(vaultRoot, runId);
        releaseExternalCapabilityStorageCapacity(inputStorageReservationKey);
        inputStorageReservationKey = undefined;
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
      if (vaultRoot && runId) {
        try {
          deleteExternalCapabilityRunArtifacts(vaultRoot, runId);
          if (inputStorageReservationKey) {
            releaseExternalCapabilityStorageCapacity(
              inputStorageReservationKey,
            );
            inputStorageReservationKey = undefined;
          }
        } catch {
          // Keep the durable charge when physical cleanup or its accounting fails.
        }
      }
      if (error instanceof ExternalCapabilityStorageCapacityError) {
        intakeOutcome = 'overloaded';
        return c.json(
          {
            error: 'External capability storage capacity is unavailable',
            code: error.code,
          },
          507,
        );
      }
      if (
        error instanceof ExternalCapabilityAdmissionError ||
        error instanceof ExternalCapabilityIntakeReservationError
      ) {
        intakeOutcome = 'unavailable';
        return c.json(
          { error: 'Capability is not available', code: error.code },
          409,
        );
      }
      if (error instanceof ExternalCapabilityQuotaError) {
        intakeOutcome = 'quota_rejected';
        return c.json(
          { error: 'External capability quota exceeded', code: error.code },
          429,
        );
      }
      intakeOutcome = 'failed';
      logger.warn(
        {
          ...getExternalCapabilitySafeErrorMetadata(error),
          capabilitySlug: slug,
          ...(runId ? { runId } : {}),
        },
        'External capability intake failed',
      );
      return c.json(
        { error: 'Could not accept files', code: 'EXTERNAL_INTAKE_FAILED' },
        500,
      );
    } finally {
      releaseIntakeSlot?.();
      if (!intakeFinalized) {
        try {
          finishExternalCapabilityIntake({
            id: reservation.id,
            leaseToken: reservation.lease_token,
            outcome: intakeOutcome,
            observedRawBytes,
          });
        } catch (error) {
          // The reservation expires conservatively at its reserved byte count.
          // Do not replace the already-determined HTTP response with cleanup I/O.
          logger.warn(
            {
              ...getExternalCapabilitySafeErrorMetadata(error),
              capabilitySlug: slug,
              intakeReservationId: reservation.id,
            },
            'External capability intake reservation cleanup failed',
          );
        }
      }
    }
  } finally {
    try {
      vaultLock.release();
    } catch (error) {
      // A surviving owner record blocks future census work fail-closed. Preserve
      // the already-determined idempotent HTTP response and surface the debt.
      logger.error(
        {
          ...getExternalCapabilitySafeErrorMetadata(error),
          capabilitySlug: slug,
        },
        'External capability Vault producer lock release failed',
      );
    }
  }
});

externalCapabilityInvokeRoutes.get('/:slug/runs/:runId', (c) => {
  const key = externalAuth(c);
  if (key instanceof Response) return key;
  const slug = c.req.param('slug');
  if (key.capability_slug !== slug) {
    return c.json({ error: 'Run not found', code: 'NOT_FOUND' }, 404);
  }
  if (
    !consumeExternalCapabilityApiRateLimit({
      keyId: key.id,
      operation: 'status',
      limit: getExternalCapabilityQuotaConfig().keyStatusRequestsPerMinute,
    })
  ) {
    return c.json(
      { error: 'Too many status requests', code: 'RATE_LIMITED' },
      429,
    );
  }
  if (!isExternalCapabilityReleaseEnabled()) {
    return c.json(
      { error: 'Capability is not available', code: 'CAPABILITY_UNAVAILABLE' },
      409,
    );
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
  if (
    !consumeExternalCapabilityApiRateLimit({
      keyId: key.id,
      operation: 'cancel',
      limit: getExternalCapabilityQuotaConfig().keyCancelRequestsPerMinute,
    })
  ) {
    return c.json(
      { error: 'Too many cancel requests', code: 'RATE_LIMITED' },
      429,
    );
  }
  const cancelled = cancelExternalCapabilityRun(
    slug,
    key.id,
    c.req.param('runId'),
  );
  if (!cancelled) {
    return c.json({ error: 'Run not found', code: 'NOT_FOUND' }, 404);
  }
  if (
    cancelled.cancelled ||
    cancelled.run.container_cleanup_attempt !== null ||
    cancelled.run.container_cleanup_lease_token !== null ||
    cancelled.run.container_create_pending_until !== null
  ) {
    // The durable state change fences the worker even if it runs in another
    // process. Repeated cancellation also retries local cleanup while durable
    // container debt remains unresolved.
    stopExternalCapabilityExecution(cancelled.run.id);
  }
  return c.json({
    ...runView(cancelled.run),
    cancelled: cancelled.cancelled,
  });
});

function externalCapabilityDownloadBody(
  bytes: Buffer,
  releaseSlot: () => void,
): ReadableStream<Uint8Array> {
  const chunkBytes = 64 * 1024;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        releaseSlot();
        return;
      }
      const end = Math.min(bytes.length, offset + chunkBytes);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() {
      releaseSlot();
    },
  });
}

externalCapabilityInvokeRoutes.get('/:slug/runs/:runId/output', (c) => {
  const key = externalAuth(c);
  if (key instanceof Response) return key;
  const slug = c.req.param('slug');
  if (key.capability_slug !== slug) {
    return c.json({ error: 'Output not found', code: 'NOT_FOUND' }, 404);
  }
  const quotaConfig = getExternalCapabilityQuotaConfig();
  if (
    !consumeExternalCapabilityApiRateLimit({
      keyId: key.id,
      operation: 'download',
      limit: quotaConfig.keyDownloadRequestsPerMinute,
    })
  ) {
    return c.json(
      { error: 'Too many download requests', code: 'RATE_LIMITED' },
      429,
    );
  }
  if (!isExternalCapabilityReleaseEnabled()) {
    return c.json(
      { error: 'Capability is not available', code: 'CAPABILITY_UNAVAILABLE' },
      409,
    );
  }
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
    !Number.isSafeInteger(output.byteLength) ||
    (output.byteLength as number) < 0 ||
    (output.byteLength as number) > quotaConfig.maxOutputBytes ||
    typeof output.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(output.sha256)
  ) {
    return c.json({ error: 'Output not found', code: 'NOT_FOUND' }, 404);
  }
  const releaseDownloadSlot = tryAcquireExternalCapabilityDownloadSlot(
    quotaConfig.localDownloadConcurrency,
  );
  if (!releaseDownloadSlot) {
    return c.json(
      { error: 'Output download is busy', code: 'DOWNLOAD_BUSY' },
      429,
    );
  }
  let downloadSlotReleased = false;
  const releaseDownloadSlotOnce = () => {
    if (downloadSlotReleased) return;
    downloadSlotReleased = true;
    releaseDownloadSlot();
  };
  try {
    const bytes = readExternalCapabilityArtifact(
      getExternalCapabilityVaultRoot(),
      {
        storageRef: output.storageRef,
        byteLength: output.byteLength as number,
        sha256: output.sha256,
      },
    );
    return new Response(
      externalCapabilityDownloadBody(bytes, releaseDownloadSlotOnce),
      {
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="normalized-data.xlsx"',
          'Content-Length': String(bytes.length),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  } catch {
    releaseDownloadSlotOnce();
    return c.json(
      { error: 'Output unavailable', code: 'OUTPUT_UNAVAILABLE' },
      410,
    );
  }
});

export default externalCapabilityInvokeRoutes;
