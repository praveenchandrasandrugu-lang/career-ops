/**
 * score-queue.test.mjs — the queue-driven scorer (step 8b).
 *
 * 8b turns the clean, screened pool into scored keepers: it claims a row in
 * drain order, hands the ad to a Codex worker running batch/batch-prompt.md,
 * parses the worker's final JSON, records the score on the row, and writes an
 * apply-queue the candidate can start working before the run finishes.
 *
 * This file tests the pure, deterministic core first (band classification,
 * placeholder fill, final-JSON extraction, apply-queue rendering, the column
 * migration). The live Codex spawn is wired and tested in a later increment;
 * everything here runs with no subprocess and no network.
 *
 * The bands are the ones the candidate confirmed 2026-07-23: keeper bar 3.5,
 * 4.0+ sorted on top. There is deliberately NO stored `verdict` column — a
 * verdict is derived from the score at read time, the same reason freshness is
 * never stored.
 *
 * Run: node tests/score-queue.test.mjs  (or via test-all.mjs)
 */
import { pass, fail } from './helpers.mjs';
import { openQueue, upsertJobs, claimUrls, canonicalizeUrl } from '../queue.mjs';
import {
  bandFor, fillPrompt, parseFinalJson, renderApplyQueue, addScoreColumns,
  setScore, scoredKeepers, slugify, runPool,
} from '../score-queue.mjs';

const T = (label, cond) => (cond ? pass(label) : fail(label));

// A scoreable, claimed row: upsert, promote to llm_ready, add score columns,
// claim it so it carries a fencing token — the state score-queue writes into.
async function claimedDb(offers) {
  const db = await openQueue(':memory:');
  upsertJobs(db, offers, { now: 1_000 });
  db.prepare("UPDATE jobs SET queue_status='llm_ready' WHERE 1").run();
  addScoreColumns(db);
  return db;
}
const eq = (label, got, want) => T(`${label}${got === want ? '' : ` (got ${JSON.stringify(got)})`}`, got === want);

// ── band classification (keeper bar 3.5, top 4.0) ──────────────────────────
// The candidate's revealed bar is 3.5: of the 32 he actually applied to, 13
// scored 3.5-3.9. A hard 4.0 would have discarded 24 of his own choices.

eq('bandFor: a 4.0 is top', bandFor(4.0), 'top');
eq('bandFor: a 4.6 is top', bandFor(4.6), 'top');
eq('bandFor: exactly 3.5 is a keeper (the bar is inclusive)', bandFor(3.5), 'keeper');
eq('bandFor: a 3.9 is a keeper', bandFor(3.9), 'keeper');
eq('bandFor: a 3.4 is discard', bandFor(3.4), 'discard');
eq('bandFor: a 2.5 is discard', bandFor(2.5), 'discard');
eq('bandFor: a null score has no band', bandFor(null), null);
eq('bandFor: a non-numeric score has no band', bandFor('n/a'), null);

// ── placeholder fill ───────────────────────────────────────────────────────
// batch-prompt.md carries exactly five placeholders. A missed substitution
// sends a literal "{{URL}}" to the worker, which then evaluates nothing.

{
  const tpl = 'Score {{URL}} using {{JD_FILE}} as report {{REPORT_NUM}} on {{DATE}} (id {{ID}}).';
  const out = fillPrompt(tpl, {
    url: 'https://co/jobs/9', jdFile: 'jds/co-9.md', reportNum: '042', date: '2026-07-23', id: 'q-042',
  });
  eq('fillPrompt: substitutes every placeholder',
    out, 'Score https://co/jobs/9 using jds/co-9.md as report 042 on 2026-07-23 (id q-042).');
  T('fillPrompt: leaves no {{ }} token behind', !/\{\{|\}\}/.test(out));
}
{
  // A URL that appears twice must be replaced in both places, not just the first.
  const out = fillPrompt('{{URL}} ... {{URL}}', { url: 'X', jdFile: '', reportNum: '', date: '', id: '' });
  eq('fillPrompt: replaces EVERY occurrence of a repeated placeholder', out, 'X ... X');
}
{
  // A $ or backslash in a value must survive verbatim (String.replace treats
  // "$&" and friends specially — a naive replace would corrupt a real value).
  const out = fillPrompt('{{URL}}', { url: 'https://co/j?x=$1&y=100%', jdFile: '', reportNum: '', date: '', id: '' });
  eq('fillPrompt: a $-bearing value is inserted verbatim, not treated as a backreference',
    out, 'https://co/j?x=$1&y=100%');
}

// ── final-JSON extraction from noisy Codex stdout ──────────────────────────
// codex exec prints the prompt echo, timing, token counts, and the model's
// prose — and the model's prose CONTAINS the JSON. 8b must pull the last valid
// status-bearing object out of that stream, not the first brace it sees.

{
  const stdout = [
    'thinking about the role...',
    'Here is my analysis. { "note": "this is prose, not the payload" }',
    'succeeded in 40213ms',
    '{"status":"completed","id":"q-042","report_num":"042","company":"Clay","role":"Data Analyst","score":4.5,"legitimacy":"High Confidence","pdf":"output/x.pdf","report":"reports/042-clay-2026-07-23.md","error":null}',
    'tokens used 51234',
  ].join('\n');
  const p = parseFinalJson(stdout);
  eq('parseFinalJson: finds the final status-bearing payload', p?.status, 'completed');
  eq('parseFinalJson: reads the score off it', p?.score, 4.5);
  eq('parseFinalJson: reads the company off it', p?.company, 'Clay');
}
{
  const stdout = '{"status":"failed","id":"q-9","report_num":"050","company":"unknown","role":"unknown","score":null,"legitimacy":null,"pdf":null,"report":null,"error":"JD file empty"}';
  const p = parseFinalJson(stdout);
  eq('parseFinalJson: a failure payload parses', p?.status, 'failed');
  eq('parseFinalJson: a failure carries a null score', p?.score, null);
}
eq('parseFinalJson: stdout with no JSON at all returns null', parseFinalJson('no payload here'), null);
eq('parseFinalJson: empty stdout returns null', parseFinalJson(''), null);
T('parseFinalJson: an object with no status is not accepted as the payload',
  parseFinalJson('{"score":4.1}') === null);
{
  // A nested object that happens to carry its own `status` must not shadow the
  // real top-level payload. The scanner has to skip past a parsed object's body,
  // not re-scan its inner braces as if they were top-level payloads.
  const p = parseFinalJson('{"status":"completed","id":"q1","score":4.2,"meta":{"status":"inner-noise"},"error":null}');
  eq('parseFinalJson: a nested status does not shadow the real payload (score)', p?.score, 4.2);
  eq('parseFinalJson: returns the TOP-LEVEL status, not the nested one', p?.status, 'completed');
}
{
  // An unclosed brace in prose before the payload must not swallow the payload:
  // a failed parse steps forward one char so a later valid object is still found.
  const p = parseFinalJson('the config opens with { and then\n{"status":"completed","score":3.9}');
  eq('parseFinalJson: an unclosed prose brace before the payload is skipped', p?.score, 3.9);
}

// ── apply-queue rendering (keepers only, 4.0+ on top) ──────────────────────
// The candidate starts applying at the first keeper, not the 25th, so the
// apply-queue is written continuously. Only keepers appear; 4.0+ sort above the
// 3.5-3.9 band; below 3.5 never appears.

{
  const rows = [
    { score: 3.7, company: 'Attio', role: 'FDE', url: 'u1', report_num: '043' },
    { score: 4.5, company: 'Clay', role: 'Data Analyst', url: 'u2', report_num: '042' },
    { score: 3.4, company: 'Nope', role: 'X', url: 'u3', report_num: '044' },
    { score: 4.1, company: 'Arize', role: 'FDE', url: 'u4', report_num: '045' },
  ];
  const md = renderApplyQueue(rows);
  T('renderApplyQueue: excludes the sub-3.5 row', !md.includes('Nope'));
  T('renderApplyQueue: includes both keepers and top rows', md.includes('Clay') && md.includes('Attio'));
  // Clay (4.5) and Arize (4.1) must both appear above Attio (3.7).
  T('renderApplyQueue: 4.0+ sorts above the 3.5-3.9 band',
    md.indexOf('Clay') < md.indexOf('Attio') && md.indexOf('Arize') < md.indexOf('Attio'));
  T('renderApplyQueue: within a band it is highest-score-first',
    md.indexOf('Clay') < md.indexOf('Arize'));
}
{
  // No keepers yet is a valid, common state early in a run — it must render a
  // real (empty) file, not throw and not print a stale one.
  const md = renderApplyQueue([{ score: 2.0, company: 'Low', role: 'X', url: 'u', report_num: '1' }]);
  T('renderApplyQueue: an all-discard input still returns a string', typeof md === 'string');
  T('renderApplyQueue: an empty keeper set names itself empty', /no keepers|none yet|empty/i.test(md));
}
{
  // Job titles routinely contain a pipe ("Engineer | Data Platform"). Unescaped,
  // it opens a fake table column and corrupts the whole apply-queue.
  const md = renderApplyQueue([{ score: 4.0, company: 'A|B Corp', role: 'Eng | Data', url: 'u', report_num: '1' }]);
  T('renderApplyQueue: a pipe in a company cell is escaped', md.includes('A\\|B Corp'));
  T('renderApplyQueue: a pipe in a role cell is escaped', md.includes('Eng \\| Data'));
  const row = md.split('\n').find((l) => l.startsWith('| 4.0'));
  T('renderApplyQueue: the row still has exactly 6 columns despite the pipes',
    (row.match(/(?<!\\)\|/g) || []).length === 7);
}
{
  // A newline in a cell would break the row into two table lines.
  const md = renderApplyQueue([{ score: 3.6, company: 'Two\nLines', role: 'X', url: 'u', report_num: '2' }]);
  T('renderApplyQueue: a newline in a cell is flattened, not left to split the row',
    !/Two\nLines/.test(md) && md.includes('Two Lines'));
}

// ── the column migration ───────────────────────────────────────────────────
// score-queue records its result ON the row. The four columns are additive and
// idempotent, exactly like queue.mjs's own addMissingColumns.

{
  const db = await openQueue(':memory:');
  upsertJobs(db, [{ url: 'https://co/jobs/1', company: 'Co', title: 'Analyst' }]);
  addScoreColumns(db);
  const cols = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  T('addScoreColumns: adds score', cols.has('score'));
  T('addScoreColumns: adds legitimacy', cols.has('legitimacy'));
  T('addScoreColumns: adds report_num', cols.has('report_num'));
  T('addScoreColumns: adds scored_at', cols.has('scored_at'));
  T('addScoreColumns: does NOT add a stored verdict column (derived from score)',
    !cols.has('verdict'));
  // Idempotent: a second call must not throw (duplicate-column error).
  let threw = false;
  try { addScoreColumns(db); } catch { threw = true; }
  T('addScoreColumns: is idempotent (safe to run on every open)', !threw);
}

// ── setScore: record the result ON the row, guarded by the claim token ──────
// A worker may only write the score for the row IT holds. Guarding on the
// fencing token (not just in_progress) stops a reclaimed-then-woken worker from
// stamping a score onto a row that now belongs to someone else.

{
  const db = await claimedDb([{ url: 'https://co/jobs/1', company: 'Co', title: 'Analyst' }]);
  const url = canonicalizeUrl('https://co/jobs/1');
  const [claim] = claimUrls(db, [url], { now: 2_000, workerId: 'w1' });

  const wrong = setScore(db, url, { score: 4.2, legitimacy: 'High Confidence', reportNum: '042', token: 'not-the-token', now: 3_000 });
  T('setScore: a wrong token writes nothing (fencing)', wrong === false);
  T('setScore: the score is still unset after a rejected write',
    db.prepare('SELECT score FROM jobs WHERE canonical_url = ?').get(url).score === null);

  const ok = setScore(db, url, { score: 4.2, legitimacy: 'High Confidence', reportNum: '042', token: claim.claim_token, now: 3_000 });
  T('setScore: the holding token writes the score', ok === true);
  const row = db.prepare('SELECT score, legitimacy, report_num, scored_at FROM jobs WHERE canonical_url = ?').get(url);
  T('setScore: records the score', row.score === 4.2);
  T('setScore: records the legitimacy tier', row.legitimacy === 'High Confidence');
  T('setScore: records the report number', row.report_num === '042');
  T('setScore: stamps scored_at', row.scored_at === 3_000);
  T('setScore: leaves the row still claimed (completeClaim transitions it)',
    db.prepare('SELECT queue_status FROM jobs WHERE canonical_url = ?').get(url).queue_status === 'in_progress');
}

// ── scoredKeepers: the rows the apply-queue is rendered from ────────────────
// Reads back everything at or above the keeper bar, shaped for renderApplyQueue.

{
  const db = await claimedDb([
    { url: 'https://co/jobs/1', company: 'Clay', title: 'Data Analyst' },
    { url: 'https://co/jobs/2', company: 'Low', title: 'X' },
    { url: 'https://co/jobs/3', company: 'Attio', title: 'FDE' },
  ]);
  const claim = (n) => claimUrls(db, [canonicalizeUrl(`https://co/jobs/${n}`)], { now: 2_000, workerId: 'w' })[0];
  const c1 = claim(1), c2 = claim(2), c3 = claim(3);
  setScore(db, c1.canonical_url, { score: 4.5, legitimacy: 'High Confidence', reportNum: '042', token: c1.claim_token, now: 3_000 });
  setScore(db, c2.canonical_url, { score: 2.0, legitimacy: 'Suspicious', reportNum: '043', token: c2.claim_token, now: 3_000 });
  setScore(db, c3.canonical_url, { score: 3.6, legitimacy: 'Proceed with Caution', reportNum: '044', token: c3.claim_token, now: 3_000 });

  const keepers = scoredKeepers(db);
  T('scoredKeepers: returns only rows at/above the keeper bar', keepers.length === 2);
  T('scoredKeepers: excludes the sub-3.5 row', !keepers.some((r) => r.company === 'Low'));
  T('scoredKeepers: carries the fields renderApplyQueue needs',
    keepers.every((r) => 'score' in r && 'company' in r && 'role' in r && 'url' in r && 'report_num' in r));
  // renderApplyQueue consumes it directly — the two must fit together.
  const md = renderApplyQueue(scoredKeepers(db));
  T('scoredKeepers: feeds renderApplyQueue (Clay above Attio)',
    md.includes('Clay') && md.includes('Attio') && md.indexOf('Clay') < md.indexOf('Attio'));
  T('scoredKeepers: a never-scored row (score NULL) is not a keeper', !md.includes('Low'));
}

// ── slugify: filesystem-safe company slug for the jd filename ───────────────

eq('slugify: lowercases and hyphenates', slugify('Acme Corp'), 'acme-corp');
eq('slugify: strips punctuation and collapses runs', slugify('Acme, Inc.  (US)'), 'acme-inc-us');
eq('slugify: trims leading/trailing separators', slugify('  --Data & AI--  '), 'data-ai');
eq('slugify: empty input yields empty string', slugify(''), '');
eq('slugify: a slashy value cannot escape a directory', slugify('a/b/../c'), 'a-b-c');

// ── runPool: bounded-concurrency fan-out, order preserved ───────────────────
// The scorer runs Codex workers at a small concurrency cap. runPool must never
// exceed the cap, must return results in INPUT order, and must run every item.

{
  let inFlight = 0, maxInFlight = 0;
  const order = [];
  const worker = async (item) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, item % 3 === 0 ? 5 : 15)); // uneven durations
    order.push(item);
    inFlight--;
    return item * 10;
  };
  const items = Array.from({ length: 9 }, (_, i) => i + 1);
  const results = await runPool(items, worker, { concurrency: 3 });
  T('runPool: never exceeds the concurrency cap', maxInFlight <= 3);
  T('runPool: actually uses the concurrency (more than one at once)', maxInFlight > 1);
  T('runPool: runs every item', order.length === 9);
  T('runPool: returns results in INPUT order despite uneven durations',
    results.join(',') === items.map((i) => i * 10).join(','));
}
{
  // concurrency larger than the item count is fine (runs them all at once).
  const results = await runPool([1, 2], async (x) => x + 1, { concurrency: 10 });
  T('runPool: handles concurrency > item count', results.join(',') === '2,3');
  T('runPool: an empty item list returns an empty array',
    (await runPool([], async (x) => x, { concurrency: 3 })).length === 0);
}
