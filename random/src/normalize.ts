/**
 * WHAT THIS FILE DOES
 *
 * Before the PDF and the database can be compared, both values must be put into the same standard form; that step
 * is called "normalization". The PDF says "$48,392.17" and the database says 4839217 (cents) and they are the same
 * amount; "  ACME  Corp" and "Acme Corp" are the same customer. Every function here is applied to BOTH sides so
 * neither side gets special treatment. Money becomes whole integer cents, never a decimal number, because computers
 * cannot represent 0.17 exactly and a comparison on cents is exact. Identifiers (account numbers) are only trimmed,
 * never reformatted, because "001234" and "1234" are different accounts. A value that cannot be normalized returns
 * null, and an ambiguous date returns a marker, so the comparison step can send it to REVIEW instead of guessing.
 */
/** Normalizers used by BOTH sides of a comparison. Identifiers are never normalized beyond trim. */
/** Turn a money value into whole cents. "$1,250.75" -> 125075; a database integer passes through; anything unparseable (e.g. an OCR "O" for "0") -> null, which the comparator reports as REVIEW. */
export function moneyToCents(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  // A number is accepted only if it is already whole cents; a decimal like 48392.17 is rejected because floats are inexact.
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;   // DB stores integer cents already
  // Strip currency symbol, thousands separators and spaces, then require "digits, optionally .1 or .2 decimals".
  const s = String(v).replace(/[$,\s]/g, '');
  const m = s.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  // "5" after the dot means 50 cents, so pad to two digits before adding.
  const c = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -c : c;
}
/** Free text such as a name: trim, collapse runs of spaces to one, lowercase. Cosmetic differences stop counting as mismatches. */
export const text = (v: unknown) => (v === null || v === undefined) ? null : String(v).trim().replace(/\s+/g, ' ').toLowerCase();
/** Identifiers: trim only. Leading zeros, case and internal spacing are all significant. */
export const exact = (v: unknown) => (v === null || v === undefined) ? null : String(v).trim();
/** Fixed-list values such as a status word: trim and lowercase so "PAID" and "paid" agree. */
export const enumToken = (v: unknown) => (v === null || v === undefined) ? null : String(v).trim().toLowerCase();

/** Returns ISO date, or { ambiguous: true } when MM/DD vs DD/MM cannot be decided and no locale is given. */
/** Convert a date to the standard YYYY-MM-DD form. Slash dates need a locale ('US' = month first, 'EU' = day first); with none, "01/02/2026" cannot be decided and is flagged ambiguous rather than guessed. Impossible dates (31/02) -> null. */
export function date(v: unknown, locale?: 'US' | 'EU'): string | null | { ambiguous: true } {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  // Already in the standard form: nothing to do.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  // Both parts could be a month and they differ, and nobody told us the convention: refuse to guess (the safety rule in README section 7).
  if (!locale && a <= 12 && b <= 12 && a !== b) return { ambiguous: true };
  const [mm, dd] = (locale === 'EU') ? [b, a] : [a, b];
  // Build the date and check it did not roll over (e.g. 31 Feb becoming 3 Mar), which would mean the input was not a real date.
  const d = new Date(Date.UTC(+m[3], mm - 1, dd));
  if (d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return `${m[3]}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
