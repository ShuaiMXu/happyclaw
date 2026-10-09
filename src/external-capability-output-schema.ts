export const EXTERNAL_OUTPUT_SCHEMA_VERSION = 1;

const MAX_OUTPUT_COLUMNS = 100;
const MAX_COLUMN_KEY_LENGTH = 64;
const MAX_COLUMN_NAME_LENGTH = 120;
const MAX_COLUMN_DESCRIPTION_LENGTH = 500;
const COLUMN_KEY_RE = new RegExp(
  `^[A-Za-z][A-Za-z0-9_]{0,${MAX_COLUMN_KEY_LENGTH - 1}}$`,
);
const SAFE_SHEET_NAME_RE = /^[^\\/*?:\[\]]{1,31}$/;

export function isValidExternalCapabilityXmlText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint !== 0x9 &&
      codePoint !== 0xa &&
      codePoint !== 0xd &&
      (codePoint < 0x20 ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
        codePoint > 0x10ffff)
    ) {
      return false;
    }
  }
  return true;
}

function isSafeSheetName(value: string): boolean {
  return (
    SAFE_SHEET_NAME_RE.test(value) &&
    isValidExternalCapabilityXmlText(value) &&
    value.trim() === value &&
    !value.startsWith("'") &&
    !value.endsWith("'") &&
    value.toLowerCase() !== 'history'
  );
}

const PROHIBITED_OUTPUT_FIELD_PATTERNS = [
  /(?:^|_)(?:customer|client|contact|recipient|consignee|buyer|full_name|recipient_name|buyer_name|owner_name|person_name|phone|telephone|tel|mobile|email|e_mail|mail|identity|identity_number|ssn|tax_id|passport|address|location|room|room_no|room_number|bank|bank_account|card|card_number|account|credential|password|token|secret|api_key|access_key|private_key|auth_key|authentication_key|source_path|file_name|filename|original_file)(?:_|$)/i,
  /客户|顾客|业主|联系人|收件人|姓名|手机|电话|邮箱|身份证|证件号|税号|护照|详细地址|收货地址|门牌|房号|房间|房间号|银行|银行卡|卡号|账号|密码|凭据|令牌|密钥|私钥|源路径|文件路径|原文件|文件名/,
] as const;

export interface ExternalOutputColumn {
  key: string;
  name: string;
  required?: true;
  description?: string;
}

export interface ExternalOutputSchema {
  version: typeof EXTERNAL_OUTPUT_SCHEMA_VERSION;
  columns: ExternalOutputColumn[];
  sheetName?: string;
}

export type ExternalOutputSchemaParseResult =
  | { ok: true; schema: ExternalOutputSchema }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOutputFieldForPolicy(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9㐀-鿿]+/g, '_');
}

function requestsProhibitedOutputField(
  column: Pick<ExternalOutputColumn, 'key' | 'name' | 'description'>,
): boolean {
  const values = [column.key, column.name, column.description ?? ''].map(
    normalizeOutputFieldForPolicy,
  );
  return PROHIBITED_OUTPUT_FIELD_PATTERNS.some((pattern) =>
    values.some((value) => pattern.test(value)),
  );
}

function normalizeExternalOutputSchema(
  value: unknown,
): ExternalOutputSchemaParseResult {
  if (!isRecord(value)) {
    return { ok: false, error: 'outputSchema must be a JSON object' };
  }
  const allowedSchemaKeys = new Set(['version', 'columns', 'sheetName']);
  if (Object.keys(value).some((key) => !allowedSchemaKeys.has(key))) {
    return { ok: false, error: 'outputSchema contains unsupported fields' };
  }
  if (
    value.version !== undefined &&
    value.version !== EXTERNAL_OUTPUT_SCHEMA_VERSION
  ) {
    return { ok: false, error: 'outputSchema version is not supported' };
  }
  if (
    !Array.isArray(value.columns) ||
    value.columns.length === 0 ||
    value.columns.length > MAX_OUTPUT_COLUMNS
  ) {
    return {
      ok: false,
      error: `outputSchema must contain 1-${MAX_OUTPUT_COLUMNS} columns`,
    };
  }

  const seen = new Set<string>();
  const columns: ExternalOutputColumn[] = [];
  for (const rawColumn of value.columns) {
    if (!isRecord(rawColumn)) {
      return { ok: false, error: 'outputSchema contains an invalid column' };
    }
    const allowedColumnKeys = new Set([
      'key',
      'name',
      'required',
      'description',
    ]);
    if (Object.keys(rawColumn).some((key) => !allowedColumnKeys.has(key))) {
      return {
        ok: false,
        error: 'outputSchema column contains unsupported fields',
      };
    }
    if (
      typeof rawColumn.key !== 'string' ||
      !COLUMN_KEY_RE.test(rawColumn.key) ||
      seen.has(rawColumn.key)
    ) {
      return {
        ok: false,
        error: 'outputSchema columns must use unique valid keys',
      };
    }
    if (
      typeof rawColumn.name !== 'string' ||
      rawColumn.name.trim().length === 0 ||
      rawColumn.name.trim().length > MAX_COLUMN_NAME_LENGTH
    ) {
      return { ok: false, error: 'outputSchema column name is invalid' };
    }
    if (
      rawColumn.required !== undefined &&
      typeof rawColumn.required !== 'boolean'
    ) {
      return {
        ok: false,
        error: 'outputSchema column required must be boolean',
      };
    }
    if (
      rawColumn.description !== undefined &&
      (typeof rawColumn.description !== 'string' ||
        rawColumn.description.length > MAX_COLUMN_DESCRIPTION_LENGTH)
    ) {
      return {
        ok: false,
        error: 'outputSchema column description is invalid',
      };
    }

    const column: ExternalOutputColumn = {
      key: rawColumn.key,
      name: rawColumn.name.trim(),
      ...(rawColumn.required === true ? { required: true as const } : {}),
      ...(typeof rawColumn.description === 'string'
        ? { description: rawColumn.description }
        : {}),
    };
    if (requestsProhibitedOutputField(column)) {
      return {
        ok: false,
        error: 'outputSchema requests a prohibited sensitive-data field',
      };
    }
    seen.add(column.key);
    columns.push(column);
  }

  if (
    value.sheetName !== undefined &&
    (typeof value.sheetName !== 'string' || !isSafeSheetName(value.sheetName))
  ) {
    return { ok: false, error: 'outputSchema sheetName is invalid' };
  }

  return {
    ok: true,
    schema: {
      version: EXTERNAL_OUTPUT_SCHEMA_VERSION,
      columns,
      ...(typeof value.sheetName === 'string'
        ? { sheetName: value.sheetName }
        : {}),
    },
  };
}

export function parseExternalOutputSchema(
  raw: unknown,
): ExternalOutputSchemaParseResult {
  if (typeof raw !== 'string' || raw.length > 50_000) {
    return { ok: false, error: 'outputSchema is required' };
  }
  try {
    return normalizeExternalOutputSchema(JSON.parse(raw));
  } catch {
    return { ok: false, error: 'outputSchema must be valid JSON' };
  }
}

export function decodeExternalOutputSchema(
  value: unknown,
): ExternalOutputSchema | null {
  const parsed = normalizeExternalOutputSchema(value);
  return parsed.ok ? parsed.schema : null;
}
