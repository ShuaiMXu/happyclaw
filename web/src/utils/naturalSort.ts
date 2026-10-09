/**
 * Natural-order string comparison — numeric runs inside a string compare by
 * value instead of character-by-character, so "1.10" sorts after "1.9"
 * instead of right after "1.1". Plain `localeCompare` (or default JS sort)
 * treats names purely as text and gets version-like/numbered names (file
 * names, workspace/agent names, group labels, …) wrong once the numbers
 * pass single digits.
 *
 * Backed by `Intl.Collator`'s built-in `numeric` option rather than a
 * hand-rolled digit-chunk parser — same idea, standards-based and already
 * handles locale-aware comparison for the non-numeric parts too.
 */
const defaultNaturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});
// Collators are somewhat expensive to construct — cache per locale instead
// of building one on every call for call sites that need a specific locale
// (e.g. 'zh-CN' for correct pinyin/stroke ordering of Chinese names).
const localeCollators = new Map<string, Intl.Collator>();

export function naturalCompare(a: string, b: string, locale?: string): number {
  if (!locale) return defaultNaturalCollator.compare(a, b);
  let collator = localeCollators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, {
      numeric: true,
      sensitivity: 'base',
    });
    localeCollators.set(locale, collator);
  }
  return collator.compare(a, b);
}
