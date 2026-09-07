export interface ImageClipboardPasteInput {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  text: string;
  imageItemCount: number;
  maxLength?: number;
}

export interface ImageClipboardPastePlan {
  preventDefault: boolean;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  insertedText: string;
}

function clampSelection(value: string, position: number | null): number {
  if (position === null || !Number.isFinite(position)) return value.length;
  return Math.max(0, Math.min(value.length, Math.trunc(position)));
}

/**
 * Plan the text side of a clipboard paste that also contains one or more
 * images. Browsers insert plain text for us when there is no image; once we
 * prevent that default to collect images, the same insertion must be applied
 * exactly once by the application.
 */
export function planImageClipboardPaste({
  value,
  selectionStart,
  selectionEnd,
  text,
  imageItemCount,
  maxLength,
}: ImageClipboardPasteInput): ImageClipboardPastePlan {
  const rawStart = clampSelection(value, selectionStart);
  const rawEnd = clampSelection(value, selectionEnd);
  const start = Math.min(rawStart, rawEnd);
  const end = Math.max(rawStart, rawEnd);

  if (imageItemCount <= 0) {
    return {
      preventDefault: false,
      value,
      selectionStart: start,
      selectionEnd: end,
      insertedText: '',
    };
  }

  if (text.length === 0) {
    return {
      preventDefault: true,
      value,
      selectionStart: start,
      selectionEnd: end,
      insertedText: '',
    };
  }

  const retainedLength = value.length - (end - start);
  const insertionCapacity =
    maxLength === undefined
      ? text.length
      : Math.max(0, Math.trunc(maxLength) - retainedLength);
  const insertedText = text.slice(0, insertionCapacity);
  if (insertedText.length === 0) {
    return {
      preventDefault: true,
      value,
      selectionStart: start,
      selectionEnd: end,
      insertedText: '',
    };
  }
  const nextValue = value.slice(0, start) + insertedText + value.slice(end);
  const cursor = start + insertedText.length;

  return {
    preventDefault: true,
    value: nextValue,
    selectionStart: cursor,
    selectionEnd: cursor,
    insertedText,
  };
}
