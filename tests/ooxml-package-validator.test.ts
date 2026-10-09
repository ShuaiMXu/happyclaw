import { describe, expect, test } from 'vitest';

import {
  hasSafeOoxmlContentTypes,
  hasSafeOoxmlRelationships,
} from '../src/ooxml-package-validator.js';

const CONTENT_TYPES_NS =
  'http://schemas.openxmlformats.org/package/2006/content-types';
const RELATIONSHIPS_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';
const WORKBOOK_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const OFFICE_DOCUMENT_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

function contentTypes(children: string, prefix = ''): string {
  const name = prefix ? `${prefix}:Types` : 'Types';
  const namespace = prefix ? `xmlns:${prefix}` : 'xmlns';
  return `<${name} ${namespace}="${CONTENT_TYPES_NS}">${children}</${name}>`;
}

function relationships(children: string, prefix = ''): string {
  const name = prefix ? `${prefix}:Relationships` : 'Relationships';
  const namespace = prefix ? `xmlns:${prefix}` : 'xmlns';
  return `<${name} ${namespace}="${RELATIONSHIPS_NS}">${children}</${name}>`;
}

function workbookOverride(prefix = ''): string {
  const name = prefix ? `${prefix}:Override` : 'Override';
  return `<${name} PartName="/xl/workbook.xml" ContentType="${WORKBOOK_TYPE}"/>`;
}

function workbookRelationship(prefix = ''): string {
  const name = prefix ? `${prefix}:Relationship` : 'Relationship';
  return `<${name} Id="rId1" Type="${OFFICE_DOCUMENT_REL}" Target="xl/workbook.xml"/>`;
}

describe('OOXML package control XML validation', () => {
  test('accepts namespace-prefixed content types and relationships', () => {
    expect(
      hasSafeOoxmlContentTypes(
        contentTypes(
          `<ct:Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${workbookOverride('ct')}`,
          'ct',
        ),
      ),
    ).toBe(true);
    expect(
      hasSafeOoxmlRelationships(relationships(workbookRelationship('r'), 'r'), {
        requireWorkbookTarget: true,
      }),
    ).toBe(true);
  });

  test('rejects prefixed and character-reference-obfuscated external relationships', () => {
    const prefixed = relationships(
      '<r:Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.invalid/a" TargetMode="External"/>',
      'r',
    );
    const encoded = relationships(
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.invalid/a" TargetMode="Ext&#x65;rnal"/>',
    );
    expect(hasSafeOoxmlRelationships(prefixed)).toBe(false);
    expect(hasSafeOoxmlRelationships(encoded)).toBe(false);
  });

  test('rejects external relationships with greater-than signs in quoted targets', () => {
    expect(
      hasSafeOoxmlRelationships(
        relationships(
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://attacker.invalid/a>b" TargetMode="External"/>',
        ),
      ),
    ).toBe(false);
  });

  test('rejects encoded unsafe relationship types', () => {
    expect(
      hasSafeOoxmlRelationships(
        relationships(
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/external&#x4c;ink" Target="externalLinks/externalLink1.xml"/>',
        ),
      ),
    ).toBe(false);
  });

  test('rejects prefixed and encoded unsafe content types', () => {
    const prefixed = contentTypes(
      `${workbookOverride('ct')}<ct:Override PartName="/xl/neutral.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/>`,
      'ct',
    );
    const encoded = contentTypes(
      `${workbookOverride()}<Override PartName="/xl/neutral.xml" ContentType="application/vnd.ms-excel.macro&#x73;heet+xml"/>`,
    );
    expect(hasSafeOoxmlContentTypes(prefixed)).toBe(false);
    expect(hasSafeOoxmlContentTypes(encoded)).toBe(false);
  });

  test('rejects namespace-spoofed workbook overrides', () => {
    expect(
      hasSafeOoxmlContentTypes(
        `<Types xmlns="${CONTENT_TYPES_NS}" xmlns:fake="https://attacker.invalid/ns"><fake:Override PartName="/xl/workbook.xml" ContentType="${WORKBOOK_TYPE}"/></Types>`,
      ),
    ).toBe(false);
  });

  test('rejects malformed and DTD-bearing control XML', () => {
    expect(
      hasSafeOoxmlContentTypes(contentTypes(`${workbookOverride()}<Override`)),
    ).toBe(false);
    expect(
      hasSafeOoxmlRelationships(
        `<!DOCTYPE Relationships [<!ENTITY ext SYSTEM "file:///etc/passwd">]>${relationships(workbookRelationship())}`,
        { requireWorkbookTarget: true },
      ),
    ).toBe(false);
  });

  test('accepts harmless comments containing fake dangerous tags', () => {
    expect(
      hasSafeOoxmlContentTypes(
        contentTypes(
          `<!-- <Override ContentType="application/vnd.ms-excel.macrosheet+xml"/> -->${workbookOverride()}`,
        ),
      ),
    ).toBe(true);
    expect(
      hasSafeOoxmlRelationships(
        relationships(
          `<!-- <Relationship TargetMode="External"/> -->${workbookRelationship()}`,
        ),
        { requireWorkbookTarget: true },
      ),
    ).toBe(true);
  });

  test('requires one exact internal root officeDocument target', () => {
    expect(
      hasSafeOoxmlRelationships(relationships(''), {
        requireWorkbookTarget: true,
      }),
    ).toBe(false);
    expect(
      hasSafeOoxmlRelationships(
        relationships(
          `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_REL}" Target="../xl/workbook.xml"/>`,
        ),
        { requireWorkbookTarget: true },
      ),
    ).toBe(false);
    expect(
      hasSafeOoxmlRelationships(
        relationships(
          `${workbookRelationship()}<Relationship Id="rId2" Type="${OFFICE_DOCUMENT_REL}" Target="xl/workbook.xml"/>`,
        ),
        { requireWorkbookTarget: true },
      ),
    ).toBe(false);
  });
});
