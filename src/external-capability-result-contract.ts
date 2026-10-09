import {
  isValidExternalCapabilityXmlText,
  type ExternalOutputColumn,
} from './external-capability-output-schema.js';

export const EXTERNAL_CAPABILITY_WARNING_CODES = [
  'SOURCE_UNCERTAIN',
  'SOURCE_CONFLICT',
  'MISSING_VALUE',
  'UNSUPPORTED_VALUE',
  'MANUAL_REVIEW_REQUIRED',
  'MISSING_REQUIRED_VALUE',
] as const;

export type ExternalCapabilityWarningCode =
  (typeof EXTERNAL_CAPABILITY_WARNING_CODES)[number];

export interface ExternalCapabilityWarning {
  code: ExternalCapabilityWarningCode;
  /** One-based output row number. */
  rowIndex?: number;
  columnKey?: string;
}

const WARNING_CODE_SET = new Set<string>(EXTERNAL_CAPABILITY_WARNING_CODES);
const MODEL_WARNING_CODE_SET = new Set<string>(
  EXTERNAL_CAPABILITY_WARNING_CODES.filter(
    (code) => code !== 'MISSING_REQUIRED_VALUE',
  ),
);

const PROHIBITED_OUTPUT_VALUE_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:^|[^\d+])(?:\+?86[-\s.]?)?1[3-9](?:[-\s.]?\d){9}(?:\D|$)/,
  /(?:^|[^\w])\+\d{1,3}(?:[\s().-]*\d){7,14}(?:\D|$)/,
  /(?:^|\D)(?:\d{2,4}[\s.-]){2,}\d{3,4}(?:\D|$)/,
  /(?:^|\D)\d{3}-\d{2}-\d{4}(?:\D|$)/,
  /(?:^|\D)(?:\d[-\s]?){17}[\dXx](?:\D|$)/,
  /(?:^|\D)(?:\d{4}[-\s]){3}\d{4,7}(?:\D|$)/,
  /(?:姓名|客户|顾客|业主|联系人|收件人)\s*[:：]\s*\S+/,
  /(?:电话|手机|邮箱|身份证|证件号|税号|护照|银行卡|账号|密码|凭据|令牌|密钥|私钥|地址|房号|房间)\s*[:：]/,
  /(?:name|customer|client|buyer|recipient|contact|phone|telephone|mobile|e-?mail|ssn|tax\s*id|passport|account|password|credential|token|secret|address|room)\s*[:：]/i,
  /\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i,
  /(?:^|\s)(?:\/[^\s]+|[A-Za-z]:\\[^\s]+)/,
  /\b[^\s/\\]+\.(?:xlsx|xls|png|jpe?g|webp|pdf|docx?|csv)\b/i,
  /\d+(?:省|市|区|县|街道|街|路|号|室)\S*/,
] as const;

export function isSafeExternalCapabilityCellString(value: string): boolean {
  return (
    isValidExternalCapabilityXmlText(value) &&
    !PROHIBITED_OUTPUT_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWarning(
  value: unknown,
  options: {
    columnKeys?: ReadonlySet<string>;
    rowCount?: number;
    modelOutput: boolean;
  },
): ExternalCapabilityWarning | null {
  if (!isRecord(value)) return null;
  const allowedKeys = new Set(['code', 'rowIndex', 'columnKey']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  if (
    typeof value.code !== 'string' ||
    !(options.modelOutput ? MODEL_WARNING_CODE_SET : WARNING_CODE_SET).has(
      value.code,
    )
  ) {
    return null;
  }
  if (
    value.rowIndex !== undefined &&
    (!Number.isSafeInteger(value.rowIndex) ||
      (value.rowIndex as number) < 1 ||
      (options.rowCount !== undefined &&
        (value.rowIndex as number) > options.rowCount))
  ) {
    return null;
  }
  if (
    value.columnKey !== undefined &&
    (typeof value.columnKey !== 'string' ||
      (options.columnKeys !== undefined &&
        !options.columnKeys.has(value.columnKey)))
  ) {
    return null;
  }
  if (value.columnKey !== undefined && value.rowIndex === undefined)
    return null;
  return {
    code: value.code as ExternalCapabilityWarningCode,
    ...(typeof value.rowIndex === 'number' ? { rowIndex: value.rowIndex } : {}),
    ...(typeof value.columnKey === 'string'
      ? { columnKey: value.columnKey }
      : {}),
  };
}

export function parseExternalCapabilityModelWarnings(
  value: unknown,
  columns: ExternalOutputColumn[],
  rowCount: number,
): ExternalCapabilityWarning[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const columnKeys = new Set(columns.map((column) => column.key));
  const warnings = value.map((warning) =>
    parseWarning(warning, { columnKeys, rowCount, modelOutput: true }),
  );
  return warnings.every(
    (warning): warning is ExternalCapabilityWarning => warning !== null,
  )
    ? warnings
    : null;
}

export function sanitizeExternalCapabilityWarnings(
  value: unknown,
): ExternalCapabilityWarning[] {
  if (!Array.isArray(value)) return [];
  const warnings: ExternalCapabilityWarning[] = [];
  for (const rawWarning of value.slice(0, 100)) {
    const warning = parseWarning(rawWarning, { modelOutput: false });
    if (warning) warnings.push(warning);
  }
  return warnings;
}

export function addMissingRequiredWarnings(
  warnings: ExternalCapabilityWarning[],
  rows: Record<string, string | number | boolean | null>[],
  columns: ExternalOutputColumn[],
): ExternalCapabilityWarning[] {
  const missing: ExternalCapabilityWarning[] = [];
  for (const [rowOffset, row] of rows.entries()) {
    for (const column of columns) {
      const value = row[column.key];
      if (
        column.required === true &&
        (value === null ||
          (typeof value === 'string' && value.trim().length === 0))
      ) {
        missing.push({
          code: 'MISSING_REQUIRED_VALUE',
          rowIndex: rowOffset + 1,
          columnKey: column.key,
        });
      }
    }
  }

  const combined: ExternalCapabilityWarning[] = [];
  const seen = new Set<string>();
  const addUnique = (warning: ExternalCapabilityWarning): void => {
    const key = `${warning.code}:${warning.rowIndex ?? ''}:${warning.columnKey ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    combined.push(warning);
  };
  const reservedMissing = missing.slice(0, 100);
  const modelLimit = 100 - reservedMissing.length;
  for (const warning of warnings) {
    if (combined.length >= modelLimit) break;
    addUnique(warning);
  }
  for (const warning of reservedMissing) {
    if (combined.length >= 100) break;
    addUnique(warning);
  }
  return combined;
}
