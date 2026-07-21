/**
 * everify-batch.test.mjs — batch E-Verify lookup for the queue gate.
 *
 * everify-check.mjs answers ONE company per invocation, streaming a 63 MB index
 * each time. The gate needs ~1,900 companies answered at once, so a batch entry
 * point walks the index a single time and matches every query against each row.
 *
 * The verdict vocabulary is deliberately two-valued. The USCIS export lists only
 * ENROLLED employers, so absence proves a name mismatch, never non-enrollment —
 * "not_found" is an unknown, not a rejection. That is why the gate ranks on this
 * signal instead of skipping on it.
 *
 * Run: node tests/everify-batch.test.mjs  (or via test-all.mjs)
 */
import { pass, fail } from './helpers.mjs';
import { norm, matchConfidence, everifyLookup } from '../everify-check.mjs';

const T = (label, cond) => (cond ? pass(label) : fail(label, 'assertion failed'));
const eq = (label, got, want) => T(`${label}${got === want ? '' : ` (got ${JSON.stringify(got)})`}`, got === want);

// ── normalization ───────────────────────────────────────────────────────────
eq('norm: strips a legal suffix', norm('Walmart Inc.'), 'WALMART');
eq('norm: strips L.L.C. even with dots', norm('Acme L.L.C.'), 'ACME');
eq('norm: drops "The"', norm('The Kroger Co'), 'KROGER');
eq('norm: collapses punctuation', norm('AT&T Services, Inc.'), 'AT T SERVICES');

// ── match confidence (lower is better) ──────────────────────────────────────
const row = (employer, dba = '') => ({ employer, dba });
eq('matchConfidence: exact is 0', matchConfidence('WALMART', row('Walmart Inc')), 0);
eq('matchConfidence: prefix is 1', matchConfidence('WALMART', row('Walmart Stores East')), 1);
eq('matchConfidence: whole-word is 2', matchConfidence('KROGER', row('The Great Kroger Company Store')), 2);
eq('matchConfidence: no match is -1', matchConfidence('WALMART', row('Target Corporation')), -1);
eq('matchConfidence: matches on the DBA too', matchConfidence('ACME', row('Zeta Holdings', 'Acme')), 0);

// ── batch lookup ────────────────────────────────────────────────────────────
// A fixture index, so the test never touches the real 63 MB file.
const INDEX = [
  { employer: 'WALMART INC', dba: '', status: 'Open', enrolled: '1/2/2010', terminated: '' },
  { employer: 'TARGET CORPORATION', dba: '', status: 'Open', enrolled: '3/4/2012', terminated: '' },
  { employer: 'OLD CO LLC', dba: '', status: 'Closed', enrolled: '1/1/2005', terminated: '6/1/2019' },
  { employer: 'QUITTER INC', dba: '', status: 'Open', enrolled: '1/1/2015', terminated: '2/2/2024' },
];
async function* fixtureRows() { for (const r of INDEX) yield r; }

async function batchTests() {
  const res = await everifyLookup(['Walmart', 'Target Corp', 'Nonexistent Widgets'], { rows: fixtureRows });

  eq('everifyLookup: finds an enrolled employer', res.get('Walmart').status, 'enrolled');
  eq('everifyLookup: reports which record matched', res.get('Walmart').employer, 'WALMART INC');
  eq('everifyLookup: a legal-suffix variant still matches', res.get('Target Corp').status, 'enrolled');

  // Absence is a name mismatch, never proof of non-enrollment. The verdict must
  // say so, because the gate ranks on it rather than skipping on it.
  eq('everifyLookup: an unmatched company is not_found, never not_enrolled',
    res.get('Nonexistent Widgets').status, 'not_found');

  // A closed account, and an Open one carrying a termination date, are both
  // unusable — an Open row that already has a termination date is a red flag
  // even before the status flips.
  const res2 = await everifyLookup(['Old Co', 'Quitter'], { rows: fixtureRows });
  eq('everifyLookup: a closed account is not enrolled', res2.get('Old Co').status, 'terminated');
  eq('everifyLookup: Open + a termination date is not a clean enrollment',
    res2.get('Quitter').status, 'terminated');

  // One pass over the index regardless of how many companies are asked about —
  // the whole reason this exists rather than calling the CLI 1,900 times.
  let passes = 0;
  async function* counting() { passes++; yield* fixtureRows(); }
  await everifyLookup(['Walmart', 'Target', 'Old Co', 'Quitter', 'Nope'], { rows: counting });
  eq('everifyLookup: walks the index exactly once for N companies', passes, 1);

  // ── ATS tenant slugs ──────────────────────────────────────────────────────
  // Every `company` value in the real queue is an ATS tenant slug, not a legal
  // name: "capitalone", "generalmotors", "zeissgroup". Word-boundary matching
  // never fires on those, because the USCIS record is "CAPITAL ONE, N.A." with a
  // space. Comparing with all spaces removed is what makes a slug matchable.
  const SLUG_INDEX = [
    { employer: 'CAPITAL ONE, N.A.', dba: '', status: 'Open', enrolled: '1/1/2010', terminated: '' },
    { employer: 'GENERAL MOTORS LLC', dba: '', status: 'Open', enrolled: '1/1/2010', terminated: '' },
    { employer: 'CATHOLIC HEALTH INITIATIVES', dba: '', status: 'Open', enrolled: '1/1/2010', terminated: '' },
  ];
  async function* slugRows() { for (const r of SLUG_INDEX) yield r; }

  const slug = await everifyLookup(['capitalone', 'generalmotors'], { rows: slugRows });
  eq('everifyLookup: a concatenated slug matches a spaced legal name',
    slug.get('capitalone').status, 'enrolled');
  eq('everifyLookup: ...and reports the record it matched',
    slug.get('capitalone').employer, 'CAPITAL ONE, N.A.');
  eq('everifyLookup: generalmotors matches GENERAL MOTORS LLC',
    slug.get('generalmotors').status, 'enrolled');

  // A short slug must NOT prefix-match its way into an unrelated employer.
  // "cat" (Caterpillar's tenant) would otherwise claim CATHOLIC HEALTH.
  const shortSlug = await everifyLookup(['cat'], { rows: slugRows });
  eq('everifyLookup: a 3-char slug does not prefix-match an unrelated employer',
    shortSlug.get('cat').status, 'not_found');

  // Code review (Medium): the bucketing pre-filter must never hide a match that
  // batchConfidence would accept — that is a SILENT false not_found, the
  // expensive error. Both of these matched only from a non-initial token.
  const BUCKET_EDGE = [
    { employer: 'A B CONSULTING LLC', dba: '', status: 'Open', enrolled: '1/1/2010', terminated: '' },
    { employer: 'BIG AI LABS INC', dba: '', status: 'Open', enrolled: '1/1/2010', terminated: '' },
  ];
  async function* edgeRows() { for (const r of BUCKET_EDGE) yield r; }
  const edge = await everifyLookup(['A B', 'AI Labs'], { rows: edgeRows });
  eq('everifyLookup: a short multi-token query is not lost by bucketing',
    edge.get('A B').status, 'enrolled');
  eq('everifyLookup: a whole-word match on a non-initial token is not lost',
    edge.get('AI Labs').status, 'enrolled');

  // Code review (Medium): the space-stripped tier exists so a CONCATENATED slug
  // can span a token boundary ("capitalone" -> "CAPITAL ONE"). It must not turn
  // into a plain prefix match on a single long token, or "meta" claims
  // METAGENOMI and "lovable" claims LOVABLE KIDS KARE.
  const PREFIX_TRAP = [
    { employer: 'METAGENOMI INC', dba: '', status: 'Open', enrolled: '1/1/2010', terminated: '' },
  ];
  async function* trapRows() { for (const r of PREFIX_TRAP) yield r; }
  const trap = await everifyLookup(['meta'], { rows: trapRows });
  eq('everifyLookup: a slug does not prefix-claim a longer single-token employer',
    trap.get('meta').status, 'not_found');

  // ...while the real concatenated case must keep working.
  eq('everifyLookup: capitalone still spans the token boundary',
    (await everifyLookup(['capitalone'], { rows: slugRows })).get('capitalone').status, 'enrolled');

  // A query too short to be distinctive must not match half the index.
  const res3 = await everifyLookup(['Co'], { rows: fixtureRows });
  eq('everifyLookup: a generic query is rejected, not matched', res3.get('Co').status, 'too_generic');

  // Empty input must not walk the index at all.
  let passes2 = 0;
  async function* counting2() { passes2++; yield* fixtureRows(); }
  const empty = await everifyLookup([], { rows: counting2 });
  eq('everifyLookup: no companies means no index walk', passes2, 0);
  eq('everifyLookup: ...and an empty result', empty.size, 0);
}

await batchTests();
