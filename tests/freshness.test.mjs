/**
 * freshness.test.mjs — five-way freshness classifier (hot/fresh/backup/stale/unknown).
 *
 * Policy (memory: freshness-policy-five-way):
 *   hot     age == 0
 *   fresh   1..3 days
 *   backup  4..7 days
 *   stale   > 7 days             (never reaches an LLM)
 *   unknown no reliable date     (never reaches an LLM)
 *
 * A lower_bound age ("Posted 30+ Days Ago") is the MINIMUM age. It can only be
 * used to prove staleness, never freshness — so a lower_bound that is not
 * provably stale is `unknown`, not `fresh`.
 *
 * Run: node tests/freshness.test.mjs   (or via test-all.mjs auto-discovery)
 */
import { pass, fail } from './helpers.mjs';
import { classifyFreshness, parseRelativeAge, pickNextBatch, calendarDayMs, sinceCutoffMs } from '../freshness.mjs';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed reference so tests are deterministic
// Ages are day TOKENS (UTC midnight of a calendar day), because that is what
// every queue row actually holds — pipeline.md is date-only and
// queue-migrate.mjs parses it with Date.UTC. Using raw instants here would test
// a shape production never produces, and would hide the off-by-one that made a
// job posted today read as 1 day old when scanned late in the local evening.
const ago = (days) => calendarDayMs(days, NOW);
const T = (label, cond) => (cond ? pass(label) : fail(label, 'assertion failed'));

// ── classifyFreshness: exact ages into each bucket ──────────────────────────
T('freshness: age 0 exact → hot',
  classifyFreshness({ postedAt: ago(0), confidence: 'exact', now: NOW }).bucket === 'hot');
T('freshness: age 2 exact → fresh',
  classifyFreshness({ postedAt: ago(2), confidence: 'exact', now: NOW }).bucket === 'fresh');
T('freshness: age 5 exact → backup',
  classifyFreshness({ postedAt: ago(5), confidence: 'exact', now: NOW }).bucket === 'backup');
T('freshness: age 10 exact → stale',
  classifyFreshness({ postedAt: ago(10), confidence: 'exact', now: NOW }).bucket === 'stale');

// ── boundaries ──────────────────────────────────────────────────────────────
T('freshness: age exactly 3 → fresh (upper edge)',
  classifyFreshness({ postedAt: ago(3), confidence: 'exact', now: NOW }).bucket === 'fresh');
T('freshness: age exactly 4 → backup (lower edge)',
  classifyFreshness({ postedAt: ago(4), confidence: 'exact', now: NOW }).bucket === 'backup');
T('freshness: age exactly 7 → backup (ceiling)',
  classifyFreshness({ postedAt: ago(7), confidence: 'exact', now: NOW }).bucket === 'backup');
T('freshness: age exactly 8 → stale (over ceiling)',
  classifyFreshness({ postedAt: ago(8), confidence: 'exact', now: NOW }).bucket === 'stale');

// ── sendability ─────────────────────────────────────────────────────────────
T('freshness: hot is sendable',
  classifyFreshness({ postedAt: ago(0), confidence: 'exact', now: NOW }).sendable === true);
T('freshness: backup is sendable',
  classifyFreshness({ postedAt: ago(6), confidence: 'exact', now: NOW }).sendable === true);
T('freshness: stale is NOT sendable',
  classifyFreshness({ postedAt: ago(20), confidence: 'exact', now: NOW }).sendable === false);

// ── lower_bound: proves staleness, never freshness ──────────────────────────
T('freshness: lower_bound 30 → stale (provably old)',
  classifyFreshness({ postedAt: ago(30), confidence: 'lower_bound', now: NOW }).bucket === 'stale');
T('freshness: lower_bound 5 → unknown (cannot confirm fresh)',
  classifyFreshness({ postedAt: ago(5), confidence: 'lower_bound', now: NOW }).bucket === 'unknown');
T('freshness: lower_bound 5 is NOT sendable',
  classifyFreshness({ postedAt: ago(5), confidence: 'lower_bound', now: NOW }).sendable === false);

// ── no reliable date → unknown ──────────────────────────────────────────────
T('freshness: confidence unknown → unknown bucket',
  classifyFreshness({ postedAt: null, confidence: 'unknown', now: NOW }).bucket === 'unknown');
T('freshness: missing postedAt → unknown',
  classifyFreshness({ confidence: 'exact', now: NOW }).bucket === 'unknown');
T('freshness: unknown is NOT sendable',
  classifyFreshness({ postedAt: null, confidence: 'unknown', now: NOW }).sendable === false);

// ── relative_exact behaves like exact ───────────────────────────────────────
T('freshness: relative_exact age 1 → fresh',
  classifyFreshness({ postedAt: ago(1), confidence: 'relative_exact', now: NOW }).bucket === 'fresh');

// ── parseRelativeAge: coarse ATS strings → {days, confidence} ────────────────
T('parseRelativeAge: "Posted Today" → 0 exact',
  (() => { const r = parseRelativeAge('Posted Today'); return r.days === 0 && r.confidence === 'exact'; })());
T('parseRelativeAge: "just posted" → 0 exact',
  parseRelativeAge('just posted').days === 0);
T('parseRelativeAge: "Yesterday" → 1 exact',
  (() => { const r = parseRelativeAge('Posted Yesterday'); return r.days === 1 && r.confidence === 'exact'; })());
T('parseRelativeAge: "Posted 5 Days Ago" → 5 relative_exact',
  (() => { const r = parseRelativeAge('Posted 5 Days Ago'); return r.days === 5 && r.confidence === 'relative_exact'; })());
T('parseRelativeAge: "Posted 30+ Days Ago" → 30 lower_bound',
  (() => { const r = parseRelativeAge('Posted 30+ Days Ago'); return r.days === 30 && r.confidence === 'lower_bound'; })());
T('parseRelativeAge: "2+ months" → 60 lower_bound',
  (() => { const r = parseRelativeAge('Posted 2+ months ago'); return r.days === 60 && r.confidence === 'lower_bound'; })());
T('parseRelativeAge: garbage → unknown',
  parseRelativeAge('Apply now').confidence === 'unknown');
T('parseRelativeAge: empty → unknown',
  parseRelativeAge('').confidence === 'unknown');

// ── pickNextBatch: drain hot → fresh → backup, freshest first, exclude the rest
const jobs = [
  { id: 'backup6', postedAt: ago(6), confidence: 'exact' },
  { id: 'stale20', postedAt: ago(20), confidence: 'exact' },
  { id: 'hot0',    postedAt: ago(0), confidence: 'exact' },
  { id: 'fresh3',  postedAt: ago(3), confidence: 'exact' },
  { id: 'unknown', postedAt: null,   confidence: 'unknown' },
  { id: 'fresh1',  postedAt: ago(1), confidence: 'exact' },
];
const drained = pickNextBatch(jobs, { now: NOW });
T('pickNextBatch: excludes stale and unknown',
  !drained.some(j => j.id === 'stale20' || j.id === 'unknown'));
T('pickNextBatch: drains hot first, then fresh (freshest first), then backup',
  drained.map(j => j.id).join(',') === 'hot0,fresh1,fresh3,backup6');
T('pickNextBatch: respects limit',
  pickNextBatch(jobs, { now: NOW, limit: 2 }).map(j => j.id).join(',') === 'hot0,fresh1');
T('pickNextBatch: empty input → empty output',
  pickNextBatch([], { now: NOW }).length === 0);

// ── calendarDayMs: a relative label names a DAY, not an instant ─────────────
// Regression guard for the bug that put 972 rows in the queue one day fresher
// than they were: "Posted Today" was stored as Date.now(), then rendered with
// toISOString(), so a scan at 22:41 Pacific (05:41Z the next day) wrote
// tomorrow's date. The value must be UTC midnight of the LOCAL calendar day so
// it round-trips through pipeline.md's date-only `posted:` field anywhere.
const dayPad = (n) => String(n).padStart(2, '0');
const localDayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${dayPad(d.getMonth() + 1)}-${dayPad(d.getDate())}`;
};
const renderDay = (ms) => new Date(ms).toISOString().slice(0, 10);

let sweepFail = null;
for (let h = 0; h < 24 && !sweepFail; h++) {
  const at = Date.UTC(2026, 6, 21, h, 30);
  if (renderDay(calendarDayMs(0, at)) !== localDayOf(at)) sweepFail = `${h}:30Z`;
}
T('calendarDayMs: today renders the local calendar day at every hour', sweepFail === null);

T('calendarDayMs: result is exactly UTC midnight (round-trips as a date-only field)',
  calendarDayMs(0, Date.UTC(2026, 6, 21, 5, 41)) % DAY === 0);

T('calendarDayMs: N days back is exactly N days before today',
  calendarDayMs(0, NOW) - calendarDayMs(5, NOW) === 5 * DAY);

// Date.UTC normalizes an out-of-range day, so crossing a month or year edge
// needs no special case — pin it so a "clever" rewrite cannot regress it.
// The expectation is derived from the LOCAL day of the reference instant rather
// than hard-coded, because calendarDayMs is local-anchored by design: a
// hard-coded UTC date would fail under TZ=Pacific/Auckland (Codex review).
const expectDaysBack = (ref, n) => {
  const d = new Date(ref);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
};
const monthRef = Date.UTC(2026, 7, 2, 12, 0);
T('calendarDayMs: crosses a month boundary correctly',
  renderDay(calendarDayMs(5, monthRef)) === expectDaysBack(monthRef, 5));
const yearRef = Date.UTC(2026, 0, 2, 12, 0);
T('calendarDayMs: crosses a year boundary correctly',
  renderDay(calendarDayMs(3, yearRef)) === expectDaysBack(yearRef, 3));

// Boundary parity: scan-ats-full.mjs drops a posting when postedAt < cutoff.
// Both sides are day-granular now, so an exactly-N-day-old posting survives the
// --since N window. Pinned against the real gate rather than restated here.
{
  const { classifyPostingDate } = await import('../scan-ats-full.mjs');
  // Built with sinceCutoffMs — the helper the scanners actually call — so this
  // exercises the real boundary in every timezone, half-hour offsets included.
  const cutoff = sinceCutoffMs(7, NOW);
  T('scan cutoff: a day-token posting exactly 7 days old survives --since 7',
    classifyPostingDate({ postedAt: calendarDayMs(7, NOW) }, cutoff) === 'keep');
  T('scan cutoff: a raw instant exactly 7 days old survives --since 7',
    classifyPostingDate({ postedAt: NOW - 7 * DAY }, cutoff) === 'keep');
  T('scan cutoff: a day-token posting 8 days old is still dropped by --since 7',
    classifyPostingDate({ postedAt: calendarDayMs(8, NOW) }, cutoff) === 'stale');
}

// ── raw provider instants age by calendar day, not elapsed milliseconds ─────
// Greenhouse/Lever/Ashby hand over real timestamps rather than day tokens.
// Differencing an instant against today's token mixed two frames: west of UTC a
// timestamp exactly 8 elapsed days old measured as 7 and stayed `backup`, so a
// stale posting would have reached an LLM (Codex review).
T('freshness: a raw instant 8 elapsed days old is stale, not backup',
  classifyFreshness({ postedAt: NOW - 8 * DAY, confidence: 'exact', now: NOW }).bucket === 'stale');
T('freshness: a raw instant 7 elapsed days old is backup (still inside the ceiling)',
  classifyFreshness({ postedAt: NOW - 7 * DAY, confidence: 'exact', now: NOW }).bucket === 'backup');
T('freshness: a raw instant from earlier today is hot',
  classifyFreshness({ postedAt: NOW - 60_000, confidence: 'exact', now: NOW }).bucket === 'hot');
