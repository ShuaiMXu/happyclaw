import ExcelJS from 'exceljs';
import { describe, expect, test } from 'vitest';

import { createExternalCapabilitySpreadsheetPreview } from '../src/external-capability-worker.js';

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
