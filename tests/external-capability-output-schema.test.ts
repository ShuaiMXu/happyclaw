import { describe, expect, test } from 'vitest';

import {
  decodeExternalOutputSchema,
  parseExternalOutputSchema,
} from '../src/external-capability-output-schema.js';

describe('external capability output schema', () => {
  test('normalizes and preserves supported column semantics', () => {
    expect(
      parseExternalOutputSchema(
        JSON.stringify({
          version: 1,
          sheetName: 'Items',
          columns: [
            {
              key: 'quantity',
              name: ' 数量 ',
              required: true,
              description: '原始报价数量',
            },
            { key: 'amount', name: '金额', required: false },
          ],
        }),
      ),
    ).toEqual({
      ok: true,
      schema: {
        version: 1,
        sheetName: 'Items',
        columns: [
          {
            key: 'quantity',
            name: '数量',
            required: true,
            description: '原始报价数量',
          },
          { key: 'amount', name: '金额' },
        ],
      },
    });
  });

  test.each([
    {
      label: 'duplicate keys',
      schema: {
        columns: [
          { key: 'amount', name: '金额' },
          { key: 'amount', name: '合计' },
        ],
      },
    },
    {
      label: 'invalid required type',
      schema: {
        columns: [{ key: 'amount', name: '金额', required: 'yes' }],
      },
    },
    {
      label: 'unknown column property',
      schema: {
        columns: [{ key: 'amount', name: '金额', pii: false }],
      },
    },
    {
      label: 'unsupported schema version',
      schema: {
        version: 2,
        columns: [{ key: 'amount', name: '金额' }],
      },
    },
  ])('rejects $label', ({ schema }) => {
    expect(parseExternalOutputSchema(JSON.stringify(schema))).toMatchObject({
      ok: false,
    });
  });

  test.each([
    'History',
    'history',
    "'Items",
    "Items'",
    ' Items',
    'Items ',
    '\u0000',
    'A\u0001B',
    '\ud800',
  ])('rejects worksheet name %s before execution', (sheetName) => {
    expect(
      parseExternalOutputSchema(
        JSON.stringify({
          sheetName,
          columns: [{ key: 'amount', name: '金额' }],
        }),
      ),
    ).toEqual({
      ok: false,
      error: 'outputSchema sheetName is invalid',
    });
  });

  test.each([
    { key: 'customer_name', name: '客户姓名' },
    { key: 'phone_number', name: '联系电话' },
    { key: 'phoneNumber', name: 'Mobile Number' },
    { key: 'clientAddress', name: 'Delivery Location' },
    { key: 'item', name: '项目', description: '复制原始文件名' },
    { key: 'bank_account', name: '结算账户' },
    { key: 'telephone', name: 'Telephone' },
    { key: 'fullName', name: 'Full Name' },
    { key: 'ssn', name: 'Tax ID' },
    { key: 'roomNo', name: 'Room No' },
    { key: 'room', name: '房间' },
    { key: 'apiKey', name: 'API Key' },
    { key: 'accessKey', name: 'Access Key' },
    { key: 'privateKey', name: 'Private Key' },
    { key: 'authKey', name: 'Authentication Key' },
    { key: 'metadata', name: 'API 密钥' },
    { key: 'metadata', name: '签名私钥' },
  ])('rejects prohibited sensitive-data field $key', (column) => {
    expect(
      parseExternalOutputSchema(JSON.stringify({ columns: [column] })),
    ).toEqual({
      ok: false,
      error: 'outputSchema requests a prohibited sensitive-data field',
    });
  });

  test('decodes the same strict schema contract from a durable manifest', () => {
    expect(
      decodeExternalOutputSchema({
        version: 1,
        columns: [{ key: 'item_name', name: '名称', required: true }],
      }),
    ).toEqual({
      version: 1,
      columns: [{ key: 'item_name', name: '名称', required: true }],
    });
    expect(
      decodeExternalOutputSchema({
        version: 1,
        columns: [{ key: 'email', name: '邮箱' }],
      }),
    ).toBeNull();
  });
});
