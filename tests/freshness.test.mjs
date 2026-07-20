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
import { classifyFreshness, parseRelativeAge, pickNextBatch } from '../freshness.mjs';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed reference so tests are deterministic
const ago = (days) => NOW - days * DAY;
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
