import { describe, expect, test } from 'vitest';

import {
  addMissingRequiredWarnings,
  isSafeExternalCapabilityCellString,
} from '../src/external-capability-result-contract.js';

describe('external capability result privacy contract', () => {
  test.each([
    '13800138000',
    '138-0013-8000',
    '+86 138 0013 8000',
    '138.0013.8000',
    '+86 (138) 0013-8000',
    '+1 415 555 2671',
    '6222 0202 0123 4567',
    '110105 1949 1231 002X',
    '123-45-6789',
    'customer@example.com',
    'Name: Alice Smith',
    'Passport: E12345678',
    'Token: sk-test-secret',
    '访问密钥：synthetic-value',
    '私钥: synthetic-value',
    `ghp_${'A'.repeat(36)}`,
    `github_pat_${'A'.repeat(22)}`,
    `AKIA${'A'.repeat(16)}`,
    `AIza${'A'.repeat(35)}`,
    'xoxb-1234567890-ABCDEFGHIJ',
    `eyJ${'A'.repeat(12)}.eyJ${'B'.repeat(12)}.${'C'.repeat(12)}`,
    '-----BEGIN PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----',
    'A\u0000B',
    '\ud800',
  ])('rejects formatted sensitive value %s', (value) => {
    expect(isSafeExternalCapabilityCellString(value)).toBe(false);
  });

  test.each([
    '12.50',
    'item-2026-10',
    'A-12345',
    '1000 units',
    '6901234567892',
  ])('allows ordinary quotation value %s', (value) => {
    expect(isSafeExternalCapabilityCellString(value)).toBe(true);
  });

  test('reserves warning capacity for blank required values', () => {
    const modelWarnings = Array.from({ length: 100 }, (_, index) => ({
      code: 'SOURCE_UNCERTAIN' as const,
      rowIndex: index + 1,
      columnKey: 'quantity',
    }));
    const rows = Array.from({ length: 100 }, (_, index) => ({
      quantity: index === 99 ? ' ' : index,
    }));

    const warnings = addMissingRequiredWarnings(modelWarnings, rows, [
      { key: 'quantity', name: 'Quantity', required: true },
    ]);

    expect(warnings).toHaveLength(100);
    expect(warnings.at(-1)).toEqual({
      code: 'MISSING_REQUIRED_VALUE',
      rowIndex: 100,
      columnKey: 'quantity',
    });
  });
});
