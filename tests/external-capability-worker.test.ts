import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import ExcelJS from 'exceljs';
import { describe, expect, test } from 'vitest';

import {
  createExternalCapabilitySpreadsheetPreview,
  parseExternalCapabilityAgentRows,
  stageExternalCapabilityInputArtifact,
} from '../src/external-capability-worker.js';

describe('external capability spreadsheet preview', () => {
  test('extracts bounded worksheet text from a valid workbook', async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Items');
    worksheet.addRows([
      ['name', 'quantity'],
      ['desk', 2],
    ]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(
      createExternalCapabilitySpreadsheetPreview(bytes),
    ).resolves.toContain('# Sheet: Items\nname\tquantity\ndesk\t2');
  });

  test('rejects parser failures instead of sending placeholder data to the model', async () => {
    await expect(
      createExternalCapabilitySpreadsheetPreview(
        Buffer.from('PK\x03\x04broken', 'binary'),
      ),
    ).rejects.toThrow(/could not be parsed/);
  });
});

describe('external capability model output validation', () => {
  test('rejects JSON numeric overflow before generating a workbook', () => {
    expect(() =>
      parseExternalCapabilityAgentRows(
        '{"rows":[{"amount":1e400}],"warnings":[]}',
        [{ key: 'amount', name: 'Amount' }],
        100,
      ),
    ).toThrow(/non-finite numeric value/);
  });
});

describe('external capability input staging', () => {
  test('uses server-generated private file names and durable bytes', () => {
    const inputDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-capability-input-'),
    );
    const bytes = Buffer.from('verified source bytes');
    try {
      stageExternalCapabilityInputArtifact(
        inputDirectory,
        0,
        'image/png',
        bytes,
      );

      const stagedPath = path.join(inputDirectory, 'source-001.png');
      expect(fs.readdirSync(inputDirectory)).toEqual(['source-001.png']);
      expect(fs.readFileSync(stagedPath)).toEqual(bytes);
      expect(fs.statSync(stagedPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(inputDirectory, { recursive: true, force: true });
    }
  });

  test('rejects an unsupported staged content type before the container mounts it', () => {
    const inputDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'external-capability-input-'),
    );
    try {
      expect(() =>
        stageExternalCapabilityInputArtifact(
          inputDirectory,
          0,
          'application/pdf',
          Buffer.from('not allowed'),
        ),
      ).toThrow(/unsupported staged external capability input type/i);
      expect(fs.readdirSync(inputDirectory)).toEqual([]);
    } finally {
      fs.rmSync(inputDirectory, { recursive: true, force: true });
    }
  });
});
