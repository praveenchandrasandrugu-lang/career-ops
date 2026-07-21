#!/usr/bin/env node
/**
 * queue.mjs — SQLite job queue (the scanners' write target).
 *
 * Replaces the flat data/pipeline.md as the source of truth for discovered
 * postings. Scanners upsert normalized rows; dedup becomes a primary-key
 * lookup instead of three markdown greps that drift; freshness is computed at
 * READ time from `posted_at` + `posted_at_confidence` (never stored — a stored
 * bucket rots as `now` advances). pipeline.md becomes a rendered view. Only a
 * row whose freshness is sendable AND whose gates pass reaches an LLM.
 *
 * Same zero-dependency pattern tracker.mjs proved: node:sqlite, Node >= 22.5.
 *
 * This file is built incrementally and test-first (tests/queue.test.mjs). The
 * first landed piece is canonicalizeUrl — the dedup key, and the single
 * riskiest decision per code review.
 */

import { randomUUID } from 'node:crypto';
import { classifyFreshness } from './freshness.mjs';

// ── node:sqlite loading (mirrors tracker.mjs) ───────────────────────────────
//
// node:sqlite is stable in behavior but still flagged experimental on some Node
// lines — silence only that one warning, leave every other warning intact.
async function loadSqlite() {
  const origEmit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === 'string' ? warning : warning?.message || '';
    if (text.includes('SQLite is an experimental feature')) return;
    return origEmit.call(process, warning, ...rest);
  };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return DatabaseSync;
  } catch {
    console.error(`Error: node:sqlite is unavailable. queue.mjs needs Node >= 22.5 (you are on ${process.version}).`);
    process.exit(1);
  } finally {
    process.emitWarning = origEmit;
  }
}

// Gate columns carry per-posting screen state; they are PRESERVED across
// re-scans (an upsert must never wipe an E-Verify result). freshness is NOT a
// column — it is computed at read time in listReady, because a stored bucket
// would rot as `now` advances.
const VALID_CONFIDENCE = new Set(['exact', 'relative_exact', 'lower_bound', 'unknown']);
// Date-trust ordering: a real age (exact/relative_exact) beats a floor
// (lower_bound) beats nothing (unknown). Used to stop a re-scan from
// downgrading or erasing a known date. Mirrored by RANK_SQL in upsertJobs.
const confRank = (c) => (c === 'exact' || c === 'relative_exact') ? 3 : c === 'lower_bound' ? 2 : 1;
const sqlEnum = (values) => '(' + [...values].map((v) => `'${v}'`).join(', ') + ')';
const CONFIDENCES = sqlEnum(VALID_CONFIDENCE);
const QUEUE_STATES = sqlEnum(['new', 'llm_ready', 'in_progress', 'evaluated', 'skipped', 'failed']);
// Only `llm_ready` reaches an LLM (queue-plan invariant): a row is drainable
// once its gates have promoted it out of `new`. `new` rows are pre-gate and
// must NOT be drained as if ready — the gate step (a later increment) is what
// moves `new` → `llm_ready` or `skipped`.
const DRAINABLE_STATES = ['llm_ready'];

/** Add any declared column the `jobs` table does not already have. */
function addMissingColumns(db, columns) {
  const have = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  for (const [name, decl] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${decl}`);
  }
}

/**
 * Open (and create/migrate) the job-queue database.
 * @param {string} path  file path, or ':memory:' for tests
 * @returns {Promise<import('node:sqlite').DatabaseSync>}
 */
export async function openQueue(path = process.env.CAREER_OPS_QUEUE_DB || 'data/queue.db') {
  const DatabaseSync = await loadSqlite();
  const db = new DatabaseSync(path);
  // WAL lets concurrent scanners upsert without blocking each other; a busy
  // timeout rides out the brief writer lock instead of throwing SQLITE_BUSY.
  // (Both are no-ops / harmless on an in-memory DB.)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      canonical_url          TEXT PRIMARY KEY,
      raw_url                TEXT NOT NULL,
      provider_job_id        TEXT,
      company                TEXT NOT NULL DEFAULT '',
      title                  TEXT NOT NULL DEFAULT '',
      location               TEXT NOT NULL DEFAULT '',
      source                 TEXT NOT NULL DEFAULT '',
      posted_at              INTEGER,
      posted_at_confidence   TEXT NOT NULL DEFAULT 'unknown' CHECK(posted_at_confidence IN ${CONFIDENCES}),
      first_seen_at          INTEGER NOT NULL,
      last_seen_at           INTEGER NOT NULL,
      everify_status         TEXT NOT NULL DEFAULT 'unchecked',
      sponsorship_status     TEXT NOT NULL DEFAULT 'unchecked',
      level_status           TEXT NOT NULL DEFAULT 'unchecked',
      liveness_status        TEXT NOT NULL DEFAULT 'unchecked',
      required_skill_status  TEXT NOT NULL DEFAULT 'unchecked',
      missing_required_skills TEXT NOT NULL DEFAULT '[]',
      queue_status           TEXT NOT NULL DEFAULT 'new' CHECK(queue_status IN ${QUEUE_STATES}),
      retry_count            INTEGER NOT NULL DEFAULT 0 CHECK(retry_count >= 0),
      skip_reason            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_queue_status ON jobs(queue_status);
    CREATE INDEX IF NOT EXISTS idx_jobs_posted_at ON jobs(posted_at);
  `);
  // CREATE TABLE IF NOT EXISTS silently skips an EXISTING table, so a column
  // added after a DB was first created has to be ALTERed in. Additive-only, so
  // it is safe to run on every open and needs no version bookkeeping.
  addMissingColumns(db, {
    location: "TEXT NOT NULL DEFAULT ''",
    // Claim bookkeeping. `claimed_at` is what makes a crashed worker
    // recoverable: without it an abandoned row sits in_progress forever and is
    // invisible to both the drain and the gate.
    claimed_at: 'INTEGER',
    claimed_by: 'TEXT',
    // Fencing token: unique per CLAIM, not per worker. Guarding a finish on
    // `queue_status='in_progress'` alone is not ownership — a worker that
    // stalls long enough to be reclaimed can wake up and close out a row that
    // now belongs to someone else, silently discarding the new worker's result.
    // Every transition out of a claim must present the token it was issued.
    claim_token: 'TEXT',
    // The job ad itself. Until this column existed the queue stored pointers
    // (url/title/company) and verdicts (everify_status, level_status) but never
    // the EVIDENCE, so no gate could read a requirement and nothing could be
    // scored. jd_status is bounded ('none'|'ok'|'gone'|'error') because gate
    // logic branches on it; the human-readable cause lives in jd_error, so an
    // 'error' row can be diagnosed without re-running the fetch.
    jd_text: 'TEXT',
    jd_status: "TEXT NOT NULL DEFAULT 'none'",
    jd_fetched_at: 'INTEGER',
    jd_error: 'TEXT',
  });
  return db;
}

// ── the job ad (jd_text) ────────────────────────────────────────────────────

/**
 * Store the fetched ad for one posting.
 * @returns {boolean} true when the row existed (false means the URL is unknown,
 *   which is a caller bug worth surfacing rather than a silent no-op)
 */
export function setJdText(db, canonicalUrl, text, { now = Date.now() } = {}) {
  return db.prepare(`
    UPDATE jobs SET jd_text = ?, jd_status = 'ok', jd_fetched_at = ?, jd_error = NULL
    WHERE canonical_url = ?
  `).run(String(text ?? ''), now, canonicalUrl).changes === 1;
}

/**
 * Record that the ad could not be fetched.
 *
 * The distinction the reason encodes is the whole point: a posting confirmed
 * GONE (404/410) must never be requested again, while a timeout or 5xx must be,
 * because dropping a job over one bad network moment is the one outcome this
 * pipeline refuses. Anything not 'gone' therefore stays in the retry pool.
 *
 * @returns {boolean} true when the row existed
 */
export function markJdFailure(db, canonicalUrl, reason, { now = Date.now() } = {}) {
  const status = reason === 'gone' ? 'gone' : 'error';
  return db.prepare(`
    UPDATE jobs SET jd_status = ?, jd_error = ?, jd_fetched_at = ?
    WHERE canonical_url = ?
  `).run(status, String(reason ?? ''), now, canonicalUrl).changes === 1;
}

/**
 * Gate-passed rows still missing their ad, in the same drain order the LLM uses
 * (freshest first), so a partial run always fetches the ads that matter most.
 *
 * Only `llm_ready` rows are returned: a row the gate already rejected does not
 * deserve a network request.
 *
 * @returns {Array<object>}
 */
export function listNeedingJd(db, { now = Date.now(), limit = Infinity } = {}) {
  // Filter AFTER ordering, then slice — limiting inside listReady would count
  // already-fetched rows against the budget and silently under-return.
  return listReady(db, { now })
    .filter((r) => r.jd_status !== 'ok' && r.jd_status !== 'gone')
    .slice(0, limit);
}

/**
 * Upsert discovered postings. Keyed on canonical_url, so a re-scan (or the same
 * job under different tracking params) UPDATES rather than duplicates. An update
 * refreshes the volatile fields (title/company/source/date/last_seen_at) but
 * PRESERVES first_seen_at, every gate status, and queue_status — a re-scan must
 * never undo screening already done.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{url:string, company?:string, title?:string, source?:string,
 *   postedAt?:number|null, confidence?:string, providerJobId?:string}>} offers
 * @param {{now?:number}} [opts]
 * @returns {{inserted:number, updated:number, skipped:number}}
 */
export function upsertJobs(db, offers, { now = Date.now() } = {}) {
  const exists = db.prepare('SELECT 1 FROM jobs WHERE canonical_url = ?');
  const insert = db.prepare(`
    INSERT INTO jobs (canonical_url, raw_url, provider_job_id, company, title, location, source,
      posted_at, posted_at_confidence, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // On update, a date is overwritten ONLY when the incoming one is usable AND at
  // least as trustworthy as what is stored — so a re-scan that lost the date
  // (Workday sometimes drops postedOn) or only carries a weaker "30+ days" lower
  // bound can never erase or downgrade a known exact date, which would silently
  // drop the job out of the freshness window. `?` is the incoming trust rank;
  // RANK_SQL derives the stored row's rank from its own confidence.
  const RANK_SQL = "(CASE posted_at_confidence WHEN 'exact' THEN 3 WHEN 'relative_exact' THEN 3 WHEN 'lower_bound' THEN 2 ELSE 1 END)";
  const update = db.prepare(`
    UPDATE jobs SET raw_url = ?, provider_job_id = COALESCE(?, provider_job_id),
      company = ?, title = ?, location = ?, source = ?,
      posted_at            = CASE WHEN ? >= ${RANK_SQL} THEN ? ELSE posted_at            END,
      posted_at_confidence = CASE WHEN ? >= ${RANK_SQL} THEN ? ELSE posted_at_confidence END,
      last_seen_at = ? WHERE canonical_url = ?`);

  let inserted = 0, updated = 0, skipped = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const o of offers) {
      const canonical = canonicalizeUrl(o.url);
      if (!canonical) { skipped++; continue; }
      // Exact-membership check — a substring test against the enum string would
      // let malformed input like "exact','relative_exact" pass here and then
      // blow up the whole batch on the DB CHECK.
      // A confidence is only as good as the date it comes with: a claimed
      // "exact" with no usable timestamp is effectively unknown. And an unknown
      // confidence never keeps a date — the invariant `posted_at IS NULL <=>
      // confidence = 'unknown'` makes the equal-rank overwrite a harmless
      // null-for-null no-op, so a later unknown re-scan can never NULL a real date.
      let conf = VALID_CONFIDENCE.has(o.confidence) ? o.confidence : 'unknown';
      if (!Number.isFinite(o.postedAt)) conf = 'unknown';
      const postedAt = conf === 'unknown' ? null : o.postedAt;
      const inRank = confRank(conf);
      if (exists.get(canonical)) {
        update.run(o.url, o.providerJobId ?? null, o.company ?? '', o.title ?? '', o.location ?? '', o.source ?? '',
          inRank, postedAt, inRank, conf, now, canonical);
        updated++;
      } else {
        insert.run(canonical, o.url, o.providerJobId ?? null, o.company ?? '', o.title ?? '', o.location ?? '', o.source ?? '',
          postedAt, conf, now, now);
        inserted++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { inserted, updated, skipped };
}

/**
 * The drain order an LLM should consume: `llm_ready` rows only (gate-promoted;
 * `new`/pre-gate rows are excluded), freshness classified at READ time, hot
 * before fresh before backup, freshest first; stale/unknown excluded (never
 * spend a token on them). Each returned row carries a `.freshness` annotation.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?:number, limit?:number}} [opts]
 * @returns {Array<object>}
 */
export function listReady(db, { now = Date.now(), limit = Infinity } = {}) {
  const placeholders = DRAINABLE_STATES.map(() => '?').join(', ');
  const rows = db.prepare(`SELECT * FROM jobs WHERE queue_status IN (${placeholders})`).all(...DRAINABLE_STATES);
  // Freshness leads (being first to apply is the whole strategy), then E-Verify:
  // a confirmed-enrolled employer can actually hire on STEM OPT, so it is drained
  // before an unconfirmed one of equal age. `not_found` is only a name mismatch,
  // never a rejection, so it still drains — just later.
  const everifyRank = (s) => (s === 'enrolled' ? 0 : s === 'terminated' ? 2 : 1);
  return rows
    .map((r) => ({ r, f: classifyFreshness({ postedAt: r.posted_at, confidence: r.posted_at_confidence, now }) }))
    .filter((x) => x.f.sendable)
    .sort((a, b) => a.f.priority - b.f.priority
      || everifyRank(a.r.everify_status) - everifyRank(b.r.everify_status)
      || (a.f.ageDays ?? 0) - (b.f.ageDays ?? 0))
    .slice(0, limit)
    .map((x) => ({ ...x.r, freshness: x.f }));
}

// ── the claim: handing rows to workers without ever handing one out twice ───
//
// A duplicate claim is not a cosmetic bug. It means two workers evaluate the
// same posting, spend the tokens twice, and can put two applications in front
// of one real employer. So ownership has to be provable, not assumed.
//
// Drain ORDER is computed in JS (freshness is read-time, never stored), so the
// claim cannot be one `UPDATE ... ORDER BY ... LIMIT`. Instead each candidate is
// taken with a conditional update whose `changes === 1` IS the proof: SQLite
// applies the row's WHERE test and its write as one atomic step, so exactly one
// caller can observe the transition out of `llm_ready`. A loser sees 0 and
// simply moves on. This is the #749 report-number race one layer down, and the
// fix is the same shape: let the write itself be the lock.

/** Rows a claim may end in. `skipped` covers "looked at it, not worth a report". */
const TERMINAL_STATES = ['evaluated', 'skipped'];

/**
 * Atomically claim up to `limit` drainable rows, in drain order.
 *
 * Returns FEWER than `limit` when another worker took candidates in between —
 * that is normal contention, not an error. Callers that want a full batch
 * should simply call again.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{limit?:number, now?:number, workerId?:string}} [opts]
 * @returns {Array<object>} the claimed rows, each with its `.freshness`
 */
export function claimNext(db, { limit = 1, now = Date.now(), workerId = 'worker' } = {}) {
  const want = Math.max(0, Math.floor(limit));
  if (!want) return [];
  const candidates = listReady(db, { now, limit: want });
  if (!candidates.length) return [];

  const take = db.prepare(`
    UPDATE jobs SET queue_status = 'in_progress', claimed_at = ?, claimed_by = ?, claim_token = ?
    WHERE canonical_url = ? AND queue_status = 'llm_ready'
  `);
  const claimed = [];
  // BEGIN IMMEDIATE takes the write lock up front, so a concurrent claimer
  // blocks (busy_timeout) instead of racing us mid-batch.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of candidates) {
      const token = randomUUID();
      if (take.run(now, String(workerId), token, row.canonical_url).changes === 1) {
        claimed.push({
          ...row, queue_status: 'in_progress', claimed_at: now, claimed_by: String(workerId), claim_token: token,
        });
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    // Best-effort rollback: if it also throws, the ORIGINAL failure is the one
    // worth reporting — masking it with a rollback error hides the real cause.
    try { db.exec('ROLLBACK'); } catch { /* connection is already unusable */ }
    throw e;
  }
  return claimed;
}

/**
 * Finish a claimed row. Guarded on `in_progress`, so a worker cannot close out
 * a row it does not hold (a late reply from a reclaimed worker is a no-op).
 * @returns {boolean} true when this caller actually owned the row
 */
export function completeClaim(db, canonicalUrl, { status = 'evaluated', reason = null, token = null } = {}) {
  if (!TERMINAL_STATES.includes(status)) {
    throw new Error(`completeClaim: status must be one of ${TERMINAL_STATES.join('/')}, got ${JSON.stringify(status)}`);
  }
  return db.prepare(`
    UPDATE jobs SET queue_status = ?, claimed_at = NULL, claimed_by = NULL, claim_token = NULL,
                    skip_reason = COALESCE(?, skip_reason)
    WHERE canonical_url = ? AND queue_status = 'in_progress' AND claim_token IS ?
  `).run(status, reason, canonicalUrl, token).changes === 1;
}

/**
 * Hand a claimed row back untouched (worker shutting down, batch trimmed). No
 * retry is counted: nothing went wrong, the row was simply not worked.
 * @returns {boolean} true when this caller actually owned the row
 */
export function releaseClaim(db, canonicalUrl, { token = null } = {}) {
  return db.prepare(`
    UPDATE jobs SET queue_status = 'llm_ready', claimed_at = NULL, claimed_by = NULL, claim_token = NULL
    WHERE canonical_url = ? AND queue_status = 'in_progress' AND claim_token IS ?
  `).run(canonicalUrl, token).changes === 1;
}

/**
 * Record a failed attempt. Returns the row to the queue until `maxRetries` is
 * exhausted, then parks it as `failed` so one poison posting cannot occupy a
 * worker forever.
 * @returns {{status:string, retryCount:number}|null} null when not owned
 */
export function failClaim(db, canonicalUrl, { reason = null, maxRetries = 3, token = null } = {}) {
  // The increment and the terminal decision happen INSIDE one guarded UPDATE.
  // Reading retry_count first and writing it back was a read-modify-write race:
  // between the two statements the row could be reclaimed and re-claimed, and
  // the write would then land on somebody else's claim. In SQLite the right-hand
  // `retry_count` is the pre-update value, so `retry_count + 1` is the new count.
  const changed = db.prepare(`
    UPDATE jobs SET
      retry_count  = retry_count + 1,
      queue_status = CASE WHEN retry_count + 1 >= ? THEN 'failed' ELSE 'llm_ready' END,
      claimed_at = NULL, claimed_by = NULL, claim_token = NULL,
      skip_reason  = COALESCE(?, skip_reason)
    WHERE canonical_url = ? AND queue_status = 'in_progress' AND claim_token IS ?
  `).run(maxRetries, reason, canonicalUrl, token).changes;
  if (changed !== 1) return null; // not ours (reclaimed, or never held)
  const row = db.prepare('SELECT queue_status, retry_count FROM jobs WHERE canonical_url = ?').get(canonicalUrl);
  return { status: row.queue_status, retryCount: row.retry_count };
}

/**
 * Recover rows whose worker died holding them.
 *
 * Without this a crashed drain silently shrinks the queue every run: the rows
 * stay `in_progress`, so they are neither drainable nor visibly stuck. A
 * reclaim counts as a retry, so a row that reliably kills its worker is parked
 * as `failed` instead of cycling forever.
 *
 * @returns {string[]} the canonical URLs actually recovered
 */
export function reclaimStale(db, { staleAfterMs = 3_600_000, now = Date.now(), maxRetries = 3 } = {}) {
  // `claimed_at IS NULL` is deliberately included: a row left in_progress by a
  // build that predates claim bookkeeping (or by a crash between the two) has no
  // timestamp, and excluding it would strand the row forever — invisible to the
  // drain AND to this recovery pass. Treat missing bookkeeping as instantly stale.
  const stale = db.prepare(`
    SELECT canonical_url, retry_count, claim_token FROM jobs
    WHERE queue_status = 'in_progress' AND (claimed_at IS NULL OR claimed_at < ?)
  `).all(now - staleAfterMs);
  // The UPDATE re-checks the exact claim the SELECT saw. Without that, a row
  // reclaimed and re-claimed by a new worker between the two statements would
  // have its fresh claim wiped by this pass.
  const put = db.prepare(`
    UPDATE jobs SET queue_status = ?, retry_count = ?, claimed_at = NULL, claimed_by = NULL, claim_token = NULL,
                    skip_reason = COALESCE(?, skip_reason)
    WHERE canonical_url = ? AND queue_status = 'in_progress' AND claim_token IS ?
  `);
  const recovered = [];
  for (const row of stale) {
    const retryCount = row.retry_count + 1;
    const status = retryCount >= maxRetries ? 'failed' : 'llm_ready';
    const reason = status === 'failed' ? `abandoned by worker ${maxRetries}x` : null;
    if (put.run(status, retryCount, reason, row.canonical_url, row.claim_token).changes === 1) {
      recovered.push(row.canonical_url);
    }
  }
  return recovered;
}

/**
 * Every canonical URL in the queue — so scan.mjs's loadSeenUrls() can treat the
 * DB as a dedup source once pipeline.md becomes a rendered view.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string[]}
 */
export function allUrls(db) {
  return db.prepare('SELECT canonical_url FROM jobs').all().map((r) => r.canonical_url);
}

// ── URL canonicalization (the dedup key) ────────────────────────────────────
//
// The job's identity lives in the PATH for every ATS we scan (Greenhouse
// /jobs/{id}, Lever/Ashby /{uuid}, Workday /job/.../{title}_{reqId}), so the
// safe move is to strip a denylist of pure-tracking query params and PRESERVE
// everything else. Dropping the whole query would collapse a Greenhouse embed
// (?gh_jid=N is the job identity) — a collision, which loses a distinct job and
// is strictly worse than leaving a duplicate. The host is lowercased (DNS is
// case-insensitive); the path is NOT (company slugs and job ids are
// case-sensitive).
//
// The denylist holds ONLY unambiguous marketing/analytics params. Generic names
// (source, src, ref, id, from…) are deliberately NOT stripped: the queue also
// ingests arbitrary direct-site URLs (scan-direct-sites.mjs), where such a param
// could BE the job identity — stripping it would collide two distinct jobs
// (data loss). A stray tracking dupe is the acceptable lesser evil.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gh_src', 'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid',
  'lever-origin', 'lever-source', 'ashby_source',
]);

// Locale/display-language suffixes (#2065). The same posting served as
// ?language=en and ?language=de is one job in two display languages, so leaving
// these in defeats dedup (a personio scan re-emitted 11 already-processed roles).
//
// But these param NAMES are not reserved: `?lang=java` on a careers page is a
// skills filter — real, identifying data. Stripping it would collapse two
// distinct postings, the one failure mode this canonicalizer refuses to risk.
// So the strip is gated on the VALUE being locale-SHAPED: a 2-3 letter language
// subtag with optional script/region subtags (en, en-us, fr_FR, pt-BR, zh-Hans).
// "java"/"python" do not match and are preserved.
const LOCALE_PARAMS = new Set(['language', 'lang', 'locale']);
const LOCALE_VALUE = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;

const isDroppableParam = (key, value) => {
  const k = key.toLowerCase();
  if (TRACKING_PARAMS.has(k)) return true;
  return LOCALE_PARAMS.has(k) && LOCALE_VALUE.test(value);
};

/**
 * Canonicalize a job URL into a stable dedup key.
 * Never throws: unparseable / non-http input returns the trimmed original.
 * @param {unknown} raw
 * @returns {string}
 */
export function canonicalizeUrl(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { return s; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return s;

  u.protocol = 'https:';                 // http/https address the same resource
  u.hostname = u.hostname.toLowerCase(); // host is case-insensitive; path is NOT
  u.hash = '';                           // fragments never identify a posting
  if (u.port === '80' || u.port === '443') u.port = '';

  // Keep every non-tracking param; sort for a stable key regardless of order.
  const kept = [];
  for (const [k, v] of u.searchParams) {
    if (!isDroppableParam(k, v)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // Strip a single trailing slash from a non-root path ("/a/b/" → "/a/b").
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');

  return u.toString();
}
