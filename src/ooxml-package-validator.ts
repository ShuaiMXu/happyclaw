import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from 'saxes';

const CONTENT_TYPES_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/content-types';
const RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const SPREADSHEET_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const OFFICE_DOCUMENT_RELATIONSHIPS_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const XLSX_WORKBOOK_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const UNSAFE_OOXML_CONTENT_TYPE_RE =
  /(macroenabled|macrosheet|dialogsheet|vbaproject|oleobject|activex)/i;
const UNSAFE_OOXML_RELATIONSHIP_TYPE_RE =
  /\/(externalLink|vbaProject|oleObject|package)$/i;
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]);
const WORKSHEET_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet',
]);

function unqualifiedAttribute(tag: SaxesTagNS, name: string): string | null {
  for (const attribute of Object.values(tag.attributes)) {
    const namespaced = attribute as SaxesAttributeNS;
    if (namespaced.local === name && namespaced.uri === '') {
      return namespaced.value;
    }
  }
  return null;
}

function namespacedAttribute(
  tag: SaxesTagNS,
  name: string,
  namespaces: ReadonlySet<string>,
): string | null {
  for (const attribute of Object.values(tag.attributes)) {
    const namespaced = attribute as SaxesAttributeNS;
    if (namespaced.local === name && namespaces.has(namespaced.uri)) {
      return namespaced.value;
    }
  }
  return null;
}

interface XmlValidationHandlers {
  root: { namespace: string; local: string };
  child: (tag: SaxesTagNS) => boolean;
}

function validateBoundedControlXml(
  xml: string,
  handlers: XmlValidationHandlers,
): boolean {
  let valid = true;
  let depth = 0;
  let rootSeen = false;
  let rootClosed = false;
  const parser = new SaxesParser({ xmlns: true, position: false });

  parser.on('doctype', () => {
    valid = false;
  });
  parser.on('processinginstruction', () => {
    valid = false;
  });
  parser.on('cdata', () => {
    valid = false;
  });
  parser.on('text', (text) => {
    if (text.trim()) valid = false;
  });
  parser.on('error', () => {
    valid = false;
  });
  parser.on('opentag', (tag) => {
    depth += 1;
    if (rootClosed) {
      valid = false;
      return;
    }
    if (depth === 1) {
      if (
        rootSeen ||
        tag.uri !== handlers.root.namespace ||
        tag.local !== handlers.root.local
      ) {
        valid = false;
      }
      rootSeen = true;
      return;
    }
    if (depth !== 2 || !handlers.child(tag)) valid = false;
  });
  parser.on('closetag', () => {
    if (depth === 1) rootClosed = true;
    depth -= 1;
    if (depth < 0) valid = false;
  });

  try {
    parser.write(xml).close();
  } catch {
    return false;
  }
  return valid && rootSeen && rootClosed && depth === 0;
}

interface OoxmlContentTypeDefinitions {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
}

function normalizeOverridePartName(partName: string): string | null {
  if (!partName.startsWith('/') || /[\\?#\0]/.test(partName)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(partName.slice(1));
  } catch {
    return null;
  }
  const segments = decoded.split('/');
  if (
    !decoded ||
    decoded.startsWith('/') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return decoded;
}

function parseSafeOoxmlContentTypes(
  xml: string,
): OoxmlContentTypeDefinitions | null {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  let hasExpectedWorkbookType = false;
  let definitionCount = 0;
  const valid = validateBoundedControlXml(xml, {
    root: { namespace: CONTENT_TYPES_NAMESPACE, local: 'Types' },
    child: (tag) => {
      if (
        tag.uri !== CONTENT_TYPES_NAMESPACE ||
        (tag.local !== 'Default' && tag.local !== 'Override')
      ) {
        return false;
      }
      const contentType = unqualifiedAttribute(tag, 'ContentType');
      if (!contentType || UNSAFE_OOXML_CONTENT_TYPE_RE.test(contentType)) {
        return false;
      }
      definitionCount += 1;
      if (tag.local === 'Default') {
        const extension = unqualifiedAttribute(tag, 'Extension')?.toLowerCase();
        if (
          !extension ||
          /[./\\?#\0]/.test(extension) ||
          defaults.has(extension)
        ) {
          return false;
        }
        defaults.set(extension, contentType);
        return true;
      }
      const rawPartName = unqualifiedAttribute(tag, 'PartName');
      const partName = rawPartName
        ? normalizeOverridePartName(rawPartName)
        : null;
      if (!partName || overrides.has(partName)) return false;
      overrides.set(partName, contentType);
      if (
        partName === 'xl/workbook.xml' &&
        contentType === XLSX_WORKBOOK_CONTENT_TYPE
      ) {
        hasExpectedWorkbookType = true;
      }
      return true;
    },
  });
  return valid && definitionCount > 0 && hasExpectedWorkbookType
    ? { defaults, overrides }
    : null;
}

export function hasSafeOoxmlContentTypes(xml: string): boolean {
  return parseSafeOoxmlContentTypes(xml) !== null;
}

export function hasSafeOoxmlContentTypeCoverage(
  xml: string,
  entryNames: ReadonlySet<string>,
): boolean {
  const definitions = parseSafeOoxmlContentTypes(xml);
  if (!definitions) return false;
  for (const entryName of entryNames) {
    if (entryName === '[Content_Types].xml' || entryName.endsWith('/'))
      continue;
    if (definitions.overrides.has(entryName)) continue;
    const slash = entryName.lastIndexOf('/');
    const dot = entryName.lastIndexOf('.');
    if (dot <= slash || dot === entryName.length - 1) return false;
    if (!definitions.defaults.has(entryName.slice(dot + 1).toLowerCase())) {
      return false;
    }
  }
  return true;
}

function resolveInternalRelationshipTarget(
  target: string,
  sourceEntryName: string | null,
): string | null {
  if (!target || /[\\?#\0]/.test(target) || target.startsWith('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (
    !decoded ||
    /[\\?#\0]/.test(decoded) ||
    decoded.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)
  ) {
    return null;
  }
  const baseSegments = sourceEntryName?.includes('/')
    ? sourceEntryName.split('/').slice(0, -1)
    : [];
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (baseSegments.length === 0) return null;
      baseSegments.pop();
      continue;
    }
    baseSegments.push(segment);
  }
  return baseSegments.length > 0 ? baseSegments.join('/') : null;
}

export function hasSafeOoxmlRelationships(
  xml: string,
  options: {
    requireWorkbookTarget?: boolean;
    requireWorksheetTarget?: boolean;
    entryNames?: ReadonlySet<string>;
    sourceEntryName?: string | null;
  } = {},
): boolean {
  let hasWorkbookTarget = false;
  let hasWorksheetTarget = false;
  const relationshipIds = new Set<string>();
  const valid = validateBoundedControlXml(xml, {
    root: { namespace: RELATIONSHIPS_NAMESPACE, local: 'Relationships' },
    child: (tag) => {
      if (tag.uri !== RELATIONSHIPS_NAMESPACE || tag.local !== 'Relationship') {
        return false;
      }
      const id = unqualifiedAttribute(tag, 'Id');
      const type = unqualifiedAttribute(tag, 'Type');
      const target = unqualifiedAttribute(tag, 'Target');
      const targetMode = unqualifiedAttribute(tag, 'TargetMode');
      if (!id || !type || !target || relationshipIds.has(id)) return false;
      relationshipIds.add(id);
      if (targetMode !== null && targetMode !== 'Internal') return false;
      if (UNSAFE_OOXML_RELATIONSHIP_TYPE_RE.test(type)) return false;
      const resolvedTarget = resolveInternalRelationshipTarget(
        target,
        options.sourceEntryName ?? null,
      );
      if (!resolvedTarget) return false;
      if (options.entryNames && !options.entryNames.has(resolvedTarget)) {
        return false;
      }
      if (OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(type)) {
        if (hasWorkbookTarget || resolvedTarget !== 'xl/workbook.xml') {
          return false;
        }
        hasWorkbookTarget = true;
      }
      if (WORKSHEET_RELATIONSHIP_TYPES.has(type)) {
        hasWorksheetTarget = true;
      }
      return true;
    },
  });
  return (
    valid &&
    (!options.requireWorkbookTarget || hasWorkbookTarget) &&
    (!options.requireWorksheetTarget || hasWorksheetTarget)
  );
}

export function hasSafeOoxmlXmlDocument(xml: string): boolean {
  let valid = true;
  let rootCount = 0;
  const parser = new SaxesParser({ xmlns: true, position: false });
  parser.on('doctype', () => {
    valid = false;
  });
  parser.on('error', () => {
    valid = false;
  });
  parser.on('opentag', () => {
    rootCount += 1;
  });
  try {
    parser.write(xml).close();
  } catch {
    return false;
  }
  return valid && rootCount > 0;
}

export function hasSafeOoxmlWorkbook(xml: string): boolean {
  let valid = true;
  let depth = 0;
  let rootSeen = false;
  let sheetsDepth = 0;
  let hasSheet = false;
  const parser = new SaxesParser({ xmlns: true, position: false });
  parser.on('doctype', () => {
    valid = false;
  });
  parser.on('error', () => {
    valid = false;
  });
  parser.on('opentag', (tag) => {
    depth += 1;
    if (depth === 1) {
      rootSeen = true;
      if (tag.local !== 'workbook' || !SPREADSHEET_NAMESPACES.has(tag.uri)) {
        valid = false;
      }
      return;
    }
    if (
      depth === 2 &&
      tag.local === 'sheets' &&
      SPREADSHEET_NAMESPACES.has(tag.uri)
    ) {
      sheetsDepth = depth;
      return;
    }
    if (
      sheetsDepth > 0 &&
      depth === sheetsDepth + 1 &&
      tag.local === 'sheet' &&
      SPREADSHEET_NAMESPACES.has(tag.uri) &&
      unqualifiedAttribute(tag, 'name') &&
      unqualifiedAttribute(tag, 'sheetId') &&
      namespacedAttribute(tag, 'id', OFFICE_DOCUMENT_RELATIONSHIPS_NAMESPACES)
    ) {
      hasSheet = true;
    }
  });
  parser.on('closetag', () => {
    if (depth === sheetsDepth) sheetsDepth = 0;
    depth -= 1;
    if (depth < 0) valid = false;
  });
  try {
    parser.write(xml).close();
  } catch {
    return false;
  }
  return valid && rootSeen && depth === 0 && hasSheet;
}
