import { describe, expect, test } from 'vitest';
import { naturalCompare } from '../src/natural-sort.js';

describe('naturalCompare', () => {
  test('sorts version-like numeric filenames in numeric order, not lexicographic', () => {
    // The reported bug: plain string compare puts "1.10" right after "1.1"
    // (since '1' < '2' as a character) instead of after "1.9".
    const names = ['1.1', '1.2', '1.9', '1.10', '1.3'];
    expect([...names].sort(naturalCompare)).toEqual([
      '1.1',
      '1.2',
      '1.3',
      '1.9',
      '1.10',
    ]);
  });

  test('sorts plain numbered names correctly (2 before 10)', () => {
    const names = ['file2.txt', 'file10.txt', 'file1.txt'];
    expect([...names].sort(naturalCompare)).toEqual([
      'file1.txt',
      'file2.txt',
      'file10.txt',
    ]);
  });

  test('falls back to normal alphabetical order for non-numeric names', () => {
    const names = ['banana', 'apple', 'cherry'];
    expect([...names].sort(naturalCompare)).toEqual([
      'apple',
      'banana',
      'cherry',
    ]);
  });

  test('accepts an explicit locale (e.g. zh-CN for Chinese names)', () => {
    expect(naturalCompare('版本1', '版本2', 'zh-CN')).toBeLessThan(0);
    expect(naturalCompare('版本10', '版本9', 'zh-CN')).toBeGreaterThan(0);
  });
});
