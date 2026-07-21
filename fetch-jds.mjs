#!/usr/bin/env node
/**
 * fetch-jds.mjs — download the job ad for every gate-passed row in the queue.
 *
 * This is the step the pipeline was missing. Scan, load, gate, sort and claim
 * all worked, but nothing had ever downloaded a job description, so the queue
 * held 2,446 rows that no screen could read and no model could score. This
 * script fills `jd_text` at ZERO token cost by calling the same JSON endpoints
 * the careers pages call (see jd-fetch.mjs for the per-ATS shapes).
 *
 * It is safe to interrupt and safe to re-run: every row is written the moment
 * it arrives, rows already fetched are skipped, and a posting confirmed gone
 * (404) is never requested twice. Re-running after a crash resumes, it does not
 * restart.
 *
 * Usage:
 *   node fetch-jds.mjs                    # every llm_ready row missing its ad
 *   node fetch-jds.mjs --limit 50         # freshest 50 first (a safe smoke run)
 *   node fetch-jds.mjs --workers 12       # default 16
 *   node fetch-jds.mjs --json             # machine-readable summary only
 */
import { openQueue, listNeedingJd, setJdText, markJdFailure } from './queue.mjs';
import { fetchJd, detailApiFor } from './jd-fetch.mjs';
import { AdaptiveLimiter } from './adaptive-limiter.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};
const LIMIT = flag('limit', Infinity);
const WORKERS = flag('workers', 16);
const JSON_ONLY = argv.includes('--json');
const log = (...a) => { if (!JSON_ONLY) console.error(...a); };

const db = await openQueue();
const pending = listNeedingJd(db, { limit: LIMIT });
log(`${pending.length} rows need their job ad (freshest first)`);
if (!pending.length) {
  console.log(JSON.stringify({ fetched: 0, gone: 0, failed: 0, unsupported: 0, note: 'nothing to fetch' }));
  process.exit(0);
}

// One limiter for the whole run: every *.myworkdayjobs.com tenant sits behind
// the same Workday edge, so they must share a congestion window. Per-request
// backoff cannot see fleet-level pressure (see adaptive-limiter.mjs).
const limiter = new AdaptiveLimiter();
// Shared across the whole run so one ashby org's board is fetched exactly once
// no matter how many of its postings are in the queue.
const boardCache = new Map();

const tally = { fetched: 0, gone: 0, failed: 0, unsupported: 0, empty: 0 };
const byAts = {};
const reasons = {};
let done = 0;

async function handle(row) {
  const url = row.canonical_url;
  // Decided BEFORE the limiter: a site with no known endpoint issues no
  // request, so routing it through the limiter would book a request that never
  // happened and quietly corrupt the throttling report this run is judged by.
  if (!detailApiFor(url)) {
    markJdFailure(db, url, 'unsupported');
    tally.unsupported++;
    reasons.unsupported = (reasons.unsupported || 0) + 1;
    done++;
    return;
  }
  let result;
  try {
    result = await limiter.run(url, async () => {
      const out = await fetchJd(url, { cache: boardCache });
      // fetchJd reports throttling as a plain result; the limiter only learns
      // from a THROWN error carrying .status, so re-raise those two codes to
      // close the feedback loop that halves the window.
      const m = /^http_(429|503)$/.exec(out.reason || '');
      if (m) { const e = new Error(out.reason); e.status = Number(m[1]); throw e; }
      return out;
    });
  } catch (e) {
    result = { ok: false, text: '', ats: null, reason: e?.circuitOpen ? 'circuit_open' : `http_${e?.status || 'error'}` };
  }

  if (result.ok) {
    setJdText(db, url, result.text);
    tally.fetched++;
    byAts[result.ats] = (byAts[result.ats] || 0) + 1;
  } else {
    markJdFailure(db, url, result.reason);
    reasons[result.reason] = (reasons[result.reason] || 0) + 1;
    if (result.reason === 'gone') tally.gone++;
    else if (result.reason === 'unsupported') tally.unsupported++;
    else if (result.reason === 'empty') tally.empty++;
    else tally.failed++;
  }

  if (++done % 100 === 0) {
    log(`  ${done}/${pending.length}  ok=${tally.fetched} gone=${tally.gone} failed=${tally.failed}`);
  }
}

// Plain worker pool. The limiter, not this number, decides how many requests
// actually reach a given ATS at once.
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(WORKERS, pending.length) }, async () => {
  while (cursor < pending.length) await handle(pending[cursor++]);
}));

const chars = db.prepare("SELECT COALESCE(SUM(LENGTH(jd_text)), 0) n FROM jobs WHERE jd_status = 'ok'").get().n;
const total = db.prepare("SELECT COUNT(*) n FROM jobs WHERE jd_status = 'ok'").get().n;
const summary = { ...tally, byAts, reasons, adsInQueue: total, avgAdChars: total ? Math.round(chars / total) : 0, limiter: limiter.report() };
console.log(JSON.stringify(summary, null, 2));
