#!/usr/bin/env node
/**
 * freshness.mjs — five-way job-freshness classifier (zero-token).
 *
 * The goal is to be among the FIRST applicants, so freshness is a hard gate,
 * not a note in markdown. Every posting is classified into one of five buckets:
 *
 *   hot     posted today                 sendable, drained first
 *   fresh   1..3 days old                sendable
 *   backup  4..7 days old                sendable, only when hot/fresh empty
 *   stale   > 7 days old                 NEVER reaches an LLM
 *   unknown no reliable date             NEVER reaches an LLM
 *
 * 0..3 days is the operating target; 7 days is a last-resort ceiling, the same
 * for every employer class (cap-exempt included — no special window).
 *
 * ── Date confidence is load-bearing ────────────────────────────────────────
 * A posting's age arrives with a confidence level, because ATS providers report
 * time very differently:
 *
 *   exact          absolute timestamp (Greenhouse/Lever/Ashby JSON `updated_at`)
 *   relative_exact "Posted 5 Days Ago" — a specific relative count
 *   lower_bound    "Posted 30+ Days Ago" — a MINIMUM; true age is >= this
 *   unknown        no parseable date at all
 *
 * A lower_bound can only PROVE staleness, never freshness: "5+ days" could be 5
 * or 500. So a lower_bound that is not provably stale is `unknown`, not `fresh`.
 * This mirrors the existing rigor in scan-workday-targeted.mjs, generalized so
 * every scanner (and the future queue.mjs) can share one policy instead of each
 * re-implementing date math and drifting apart.
 */

const DAY = 86_400_000;

export const DEFAULT_THRESHOLDS = { hot: 0, fresh: 3, backup: 7 };

// Bucket metadata: draining priority (lower = sooner) and whether an LLM may
// ever see it. stale/unknown are terminal — they cost zero tokens by design.
const BUCKETS = {
  hot:     { priority: 0, sendable: true },
  fresh:   { priority: 1, sendable: true },
  backup:  { priority: 2, sendable: true },
  unknown: { priority: 98, sendable: false },
  stale:   { priority: 99, sendable: false },
};

/**
 * Classify one posting.
 * @param {object} p
 * @param {number|null} p.postedAt   epoch ms of the posting (or its lower bound)
 * @param {string} p.confidence      exact | relative_exact | lower_bound | unknown
 * @param {number} [p.now]           epoch ms reference (injectable for tests)
 * @param {object} [p.thresholds]    { hot, fresh, backup } day ceilings
 * @returns {{bucket:string, sendable:boolean, priority:number, ageDays:number|null, reason:string}}
 */
export function classifyFreshness({ postedAt, confidence, now = Date.now(), thresholds = DEFAULT_THRESHOLDS } = {}) {
  const make = (bucket, ageDays, reason) => ({
    bucket, sendable: BUCKETS[bucket].sendable, priority: BUCKETS[bucket].priority, ageDays, reason,
  });

  // No reliable date → unknown, regardless of any stray timestamp.
  if (confidence === 'unknown' || postedAt == null || !Number.isFinite(postedAt)) {
    return make('unknown', null, 'no reliable posting date');
  }

  const ageDays = Math.max(0, Math.floor((now - postedAt) / DAY));

  // A lower bound can only prove "old enough to be stale". Anything short of
  // that is genuinely unknown — the true age has no upper bound.
  if (confidence === 'lower_bound') {
    if (ageDays > thresholds.backup) return make('stale', ageDays, `at least ${ageDays}d old (> ${thresholds.backup}d ceiling)`);
    return make('unknown', ageDays, `lower bound ${ageDays}d cannot confirm freshness`);
  }

  // exact / relative_exact → a trustworthy age.
  if (ageDays <= thresholds.hot) return make('hot', ageDays, 'posted today');
  if (ageDays <= thresholds.fresh) return make('fresh', ageDays, `${ageDays}d old`);
  if (ageDays <= thresholds.backup) return make('backup', ageDays, `${ageDays}d old`);
  return make('stale', ageDays, `${ageDays}d old (> ${thresholds.backup}d ceiling)`);
}

/**
 * Parse a coarse ATS relative-date string into { days, confidence }.
 * Generalizes scan-workday-targeted.mjs's postedAtFrom so every scanner can
 * share it. Returns confidence 'unknown' (never throws) on anything unparseable.
 */
export function parseRelativeAge(posted) {
  const s = String(posted ?? '').toLowerCase().trim();
  if (!s) return { days: null, confidence: 'unknown' };
  if (s.includes('today') || s.includes('just posted')) return { days: 0, confidence: 'exact' };
  if (s.includes('yesterday')) return { days: 1, confidence: 'exact' };
  const d = /(\d+)(\+?)\s*day/.exec(s);
  if (d) return { days: Number(d[1]), confidence: d[2] === '+' ? 'lower_bound' : 'relative_exact' };
  const mo = /(\d+)(\+?)\s*month/.exec(s);
  if (mo) return { days: Number(mo[1]) * 30, confidence: mo[2] === '+' ? 'lower_bound' : 'relative_exact' };
  return { days: null, confidence: 'unknown' };
}

/**
 * Order jobs the way an LLM should drain them: hot before fresh before backup,
 * freshest first within a bucket, stale/unknown excluded entirely. Each job
 * must carry { postedAt, confidence }.
 * @param {Array} jobs
 * @param {object} [opts] { now, limit, thresholds }
 * @returns {Array} the sendable jobs, in drain order (annotated with `.freshness`)
 */
export function pickNextBatch(jobs, { now = Date.now(), limit = Infinity, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const scored = jobs
    .map(j => ({ job: j, f: classifyFreshness({ postedAt: j.postedAt, confidence: j.confidence, now, thresholds }) }))
    .filter(x => x.f.sendable)
    .sort((a, b) => a.f.priority - b.f.priority || (a.f.ageDays ?? 0) - (b.f.ageDays ?? 0));
  return scored.slice(0, limit).map(x => ({ ...x.job, freshness: x.f }));
}

// CLI: classify a single relative-age string or epoch, for quick manual checks.
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === new URL(`file:///${process.argv[1]?.replace(/\\/g, '/')}`).href) {
  const arg = process.argv.slice(2).join(' ');
  if (!arg) {
    console.log('Usage: node freshness.mjs "Posted 2 Days Ago"   |   node freshness.mjs <epoch-ms>');
    process.exit(0);
  }
  const asNum = Number(arg);
  const parsed = Number.isFinite(asNum) && arg.trim() !== ''
    ? { days: Math.floor((Date.now() - asNum) / DAY), confidence: 'exact', postedAt: asNum }
    : { ...parseRelativeAge(arg), postedAt: null };
  const postedAt = parsed.postedAt ?? (parsed.days == null ? null : Date.now() - parsed.days * DAY);
  console.log(JSON.stringify(classifyFreshness({ postedAt, confidence: parsed.confidence }), null, 2));
}
