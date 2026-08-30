/**
 * WHAT THIS FILE DOES
 *
 * The command-line front door a tester uses. It has two jobs. `validate:pdf` takes a PDF path and options, runs the
 * whole validator (validate.ts), prints the text report to the screen, writes the JSON and text reports to disk, and
 * exits with code 1 only on FAIL. REVIEW exits 0 on purpose: an open question is for the tester to resolve, not a
 * reason to break a script or a pipeline. `review` records a human decision for one field or line item on one
 * document so the next run reflects it; the decision word is checked against the five allowed values so a typo
 * cannot be saved. `--locale` must be given only when the tester knows the document's date convention, and `--mask`
 * hides sensitive customer values in both report files. This file only parses arguments and reports; all business
 * rules live in the other files.
 *
 * npm run validate:pdf -- ./input/file.pdf [--db .data/app.sqlite] [--reviews reviews] [--out reports] [--locale US|EU] [--env staging] [--mask]
 *   --locale  pass ONLY when you know the document's date convention; without it an ambiguous 01/02/2026 is REVIEW
 *   --mask    masks every `sensitive` field (see rules.ts) in both the .txt and the .json report
 * npm run review -- <hash> <field|lineItems:key> <DECISION> --by <name> [--value <v>] [--reason <text>]
 *   the field is a db column (account_number …) or the "review key" printed next to a line-item issue
 */
import { validatePdf } from './validate';
import { writeReport, renderText } from './report';
import { saveReview } from './review';

const args = process.argv.slice(2);
// Read the value after `--name`, or the default. A flag given without a value is a usage error (exit code 2 = "bad invocation", distinct from 1 = "validation failed").
const flag = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) { console.error(`--${n} needs a value`); process.exit(2); }
  return v;
};
// The five decisions a reviewer may record (see README section 10); anything else is rejected.
const DECISIONS = ['DATABASE_CORRECT', 'DATABASE_INCORRECT', 'QA_EXTRACTION_INCORRECT', 'PDF_AMBIGUOUS', 'UNABLE_TO_DETERMINE'] as const;
// True when a value-less switch such as `--mask` is present.
const has = (n: string) => args.includes(`--${n}`);

(async () => {
  // Mode 1: record a human decision. Needs the document hash, the field (or line-item review key) and a valid decision word.
  if (args[0] === 'review') {
    const [, hash, field, decision] = args;
    if (!hash || !field || !(DECISIONS as readonly string[]).includes(decision)) {
      console.error(`usage: review <sha256> <field|lineItems:key> <${DECISIONS.join('|')}> --by <name> [--value v] [--reason text]`); process.exit(2);
    }
    saveReview(flag('reviews', 'reviews')!, hash, { field, decision: decision as any, verifiedValue: flag('value'), reviewer: flag('by', 'unknown')!, timestamp: new Date().toISOString(), reason: flag('reason') });
    console.log(`recorded ${decision} for ${field} on ${hash.slice(0, 12)}…`); return;
  }
  // Mode 2: validate a PDF. The file is whichever argument ends in .pdf.
  const file = args.find(a => a.endsWith('.pdf'));
  if (!file) { console.error('usage: validate:pdf <file.pdf> [--db path] [--reviews dir] [--out dir] [--locale US|EU] [--env label] [--mask]'); process.exit(2); }
  // Locale is optional, but if given it must be one of the two conventions the date normalizer understands.
  const locale = flag('locale');
  if (locale !== undefined && locale !== 'US' && locale !== 'EU') { console.error(`--locale must be US or EU (got "${locale}")`); process.exit(2); }
  const report = await validatePdf(file, { dbPath: flag('db', '.data/app.sqlite')!, reviewsDir: flag('reviews', 'reviews'), locale: locale as 'US' | 'EU' | undefined,
    environment: flag('env', process.env.TEST_ENVIRONMENT) });
  // Write both report files (masked if requested), echo the text report, and point at where it was saved.
  const path = writeReport(flag('out', 'reports')!, report, { maskIdentifiers: has('mask') });
  console.log(renderText(report, { maskIdentifiers: has('mask') }));
  console.log(`\nreport written: ${path}`);
  // Exit 1 only on FAIL so automation can catch real defects; REVIEW is left for the tester and exits 0.
  process.exit(report.overallResult === 'FAIL' ? 1 : 0);
})();
