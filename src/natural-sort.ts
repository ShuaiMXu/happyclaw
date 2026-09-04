/**
 * Natural-order string comparison — numeric runs inside a string compare by
 * value instead of character-by-character, so "1.10" sorts after "1.9"
 * instead of right after "1.1". Plain `localeCompare` (or default sort)
 * treats names purely as text and gets version-like/numbered names (file
 * names, directory names, …) wrong once the numbers pass single digits.
 *
 * Backed by `Intl.Collator`'s built-in `numeric` option rather than a
 * hand-rolled digit-chunk parser — same idea, standards-based and already
 * handles locale-aware comparison for the non-numeric parts too. Mirrors
 * `web/src/utils/naturalSort.ts` (frontend and backend are separate Node
 * projects with no shared module path, so this is intentionally
 * duplicated rather than imported across them).
 */
const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export function naturalCompare(a: string, b: string): number {
  return naturalCollator.compare(a, b);
}
