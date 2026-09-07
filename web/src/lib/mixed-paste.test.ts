import { describe, expect, test } from 'vitest';
import { planImageClipboardPaste } from './mixed-paste';

describe('planImageClipboardPaste', () => {
  test('inserts mixed-paste text exactly once even with multiple image items', () => {
    expect(
      planImageClipboardPaste({
        value: 'before',
        selectionStart: 6,
        selectionEnd: 6,
        text: ' after',
        imageItemCount: 3,
      }),
    ).toEqual({
      preventDefault: true,
      value: 'before after',
      selectionStart: 12,
      selectionEnd: 12,
      insertedText: ' after',
    });
  });

  test('replaces the current textarea selection', () => {
    expect(
      planImageClipboardPaste({
        value: 'hello world',
        selectionStart: 6,
        selectionEnd: 11,
        text: 'HappyClaw',
        imageItemCount: 1,
      }),
    ).toMatchObject({
      value: 'hello HappyClaw',
      selectionStart: 15,
      selectionEnd: 15,
      insertedText: 'HappyClaw',
    });
  });

  test('leaves text-only paste to the browser', () => {
    expect(
      planImageClipboardPaste({
        value: 'existing',
        selectionStart: 2,
        selectionEnd: 4,
        text: 'text',
        imageItemCount: 0,
      }),
    ).toEqual({
      preventDefault: false,
      value: 'existing',
      selectionStart: 2,
      selectionEnd: 4,
      insertedText: '',
    });
  });

  test('handles image-only paste without changing textarea text', () => {
    expect(
      planImageClipboardPaste({
        value: 'existing',
        selectionStart: 3,
        selectionEnd: 6,
        text: '',
        imageItemCount: 1,
      }),
    ).toEqual({
      preventDefault: true,
      value: 'existing',
      selectionStart: 3,
      selectionEnd: 6,
      insertedText: '',
    });
  });

  test('truncates inserted text after accounting for the replaced selection', () => {
    expect(
      planImageClipboardPaste({
        value: 'abcdef',
        selectionStart: 2,
        selectionEnd: 4,
        text: 'WXYZ',
        imageItemCount: 1,
        maxLength: 7,
      }),
    ).toEqual({
      preventDefault: true,
      value: 'abWXYef',
      selectionStart: 5,
      selectionEnd: 5,
      insertedText: 'WXY',
    });
  });

  test('does not insert text when no capacity remains', () => {
    expect(
      planImageClipboardPaste({
        value: '12345',
        selectionStart: 5,
        selectionEnd: 5,
        text: 'extra',
        imageItemCount: 2,
        maxLength: 5,
      }),
    ).toEqual({
      preventDefault: true,
      value: '12345',
      selectionStart: 5,
      selectionEnd: 5,
      insertedText: '',
    });
  });

  test('does not delete a selection when max-length capacity is zero', () => {
    expect(
      planImageClipboardPaste({
        value: '123456',
        selectionStart: 0,
        selectionEnd: 1,
        text: 'extra',
        imageItemCount: 1,
        maxLength: 5,
      }),
    ).toEqual({
      preventDefault: true,
      value: '123456',
      selectionStart: 0,
      selectionEnd: 1,
      insertedText: '',
    });
  });
});
