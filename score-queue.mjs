#!/usr/bin/env node
/**
 * score-queue.mjs — the queue-driven scorer (step 8b).
 *
 * The last stage of the zero-token pipeline. gate.mjs and screen-queue.mjs have
 * already reduced the raw scan to a clean, screened pool of `llm_ready` rows
 * that carry their ad text. 8b spends the one expensive resource — a model —
 * on that pool: it claims a row in drain order (freshest first), hands the ad
 * to a Codex worker running the self-contained `batch/batch-prompt.md`, parses
 * the worker's final JSON, records the score ON the row, and writes an
 * apply-queue the candidate can start working at the FIRST keeper, not the 25th.
 *
 * Bands (candidate-confirmed 2026-07-23): keeper bar 3.5, 4.0+ sorted on top,
 * below 3.5 discarded. There is deliberately NO stored `verdict` column — the
 * band is derived from the score at read time (bandFor), the same reason
 * freshness is never stored: a stored derivation rots when its rule changes.
 *
 * Built incrementally and test-first, exactly like queue.mjs. The pure core
 * (band classification, placeholder fill, final-JSON extraction, apply-queue
 * rendering, column migration) and the per-row orchestration (processRow) are
 * unit-tested with no subprocess. The live Codex spawn, the driver loop, and
 * the tracker merge are the thin I/O shell at the bottom of this file, behind
 * an --apply flag — dry run by default, like every other stage here.
 *
 * Usage:
 *   node score-queue.mjs                       # dry run: show the scoreable pool
 *   node score-queue.mjs --apply               # score up to --limit rows (default 25)
 *   node score-queue.mjs --apply --limit 3     # score just 3 (smoke test)
 *   node score-queue.mjs --apply --concurrency 3
 *   node score-queue.mjs --apply --no-refresh  # skip the liveness re-fetch (offline/rescore)
 *   node score-queue.mjs --apply --full-access # lift the codex sandbox (see below)
 *
 * Every row is re-fetched immediately before it is scored, so a posting that
 * closed since the last fetch-jds run is skipped for free instead of costing a
 * full Codex evaluation and a dead link in the apply queue.
 *
 * The codex workers are SANDBOXED by default (workspace-write): a job ad is
 * untrusted internet text, so a prompt-injected ad cannot reach outside the
 * repo. --full-access lifts the sandbox for runs where inline PDF/web research
 * is worth the trust — an explicit per-run opt-in, never the default.
 */

import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  completeClaim, failClaim, openQueue, listReady, claimUrls, reclaimStale,
  setJdText, markJdFailure, canonicalizeUrl,
} from './queue.mjs';
import { fetchJd } from './jd-fetch.mjs';

// ── the bands ───────────────────────────────────────────────────────────────
// 3.5 is the candidate's REVEALED bar: of the 32 he actually applied to, 13
// scored 3.5-3.9. A hard 4.0 would have discarded 24 of his own choices, so
// 4.0 is a priority tier ('top'), not the keeper line.
export const KEEPER_BAR = 3.5;
export const TOP_BAR = 4.0;

/**
 * The band a score falls in, or null when there is no usable score.
 * @param {unknown} score
 * @returns {'top'|'keeper'|'discard'|null}
 */
export function bandFor(score) {
  if (score === null || score === undefined) return null;
  const n = typeof score === 'number' ? score : Number(score);
  if (!Number.isFinite(n)) return null;
  if (n >= TOP_BAR) return 'top';
  if (n >= KEEPER_BAR) return 'keeper';
  return 'discard';
}

/** True for anything at or above the keeper bar (keeper or top). */
export function isKeeper(score) {
  const b = bandFor(score);
  return b === 'top' || b === 'keeper';
}

// ── prompt placeholder fill ─────────────────────────────────────────────────

/**
 * Substitute the five orchestrator placeholders into batch-prompt.md.
 *
 * split/join, not String.replace: a replace with a value that contains "$&",
 * "$1" etc. would treat those as backreferences and corrupt a real URL query
 * string. split/join inserts the value verbatim, and replaces EVERY occurrence
 * — a placeholder that appears twice in the template must be filled both times.
 *
 * @param {string} template
 * @param {{url?:string, jdFile?:string, reportNum?:string, date?:string, id?:string}} vars
 * @returns {string}
 */
export function fillPrompt(template, { url = '', jdFile = '', reportNum = '', date = '', id = '' } = {}) {
  const map = {
    '{{URL}}': url,
    '{{JD_FILE}}': jdFile,
    '{{REPORT_NUM}}': reportNum,
    '{{DATE}}': date,
    '{{ID}}': id,
  };
  let out = String(template ?? '');
  for (const [token, value] of Object.entries(map)) out = out.split(token).join(String(value));
  return out;
}

// ── final-JSON extraction from noisy Codex stdout ──────────────────────────

/**
 * Parse the object at `s[start]` if it closes into valid JSON.
 * String-aware brace matching, so a "}" inside a quoted value does not end the
 * object early and an escaped quote does not end a string early.
 *
 * Returns `{ value, end }`: `value` is the parsed object (or null if the span
 * did not parse), and `end` is the index of the brace that closed depth to 0
 * (or the string length if it never closed). The caller uses `end` to skip PAST
 * a parsed object so its own nested braces are never re-scanned as if they were
 * separate top-level objects.
 */
function parseObjectAt(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return { value: JSON.parse(s.slice(start, i + 1)), end: i }; } catch { return { value: null, end: i }; }
      }
    }
  }
  return { value: null, end: s.length };
}

/**
 * Pull the worker's final payload out of a Codex run's stdout.
 *
 * codex exec prints the prompt echo, timing, token counts, and the model's
 * prose — and the prose itself CONTAINS the JSON. So the payload is not the
 * first brace in the stream: it is the LAST object that parses AND carries a
 * `status` field (the one machine contract batch-prompt.md guarantees). An
 * object without `status` is prose the model happened to brace, never the
 * payload.
 *
 * @param {unknown} stdout
 * @returns {object|null}
 */
export function parseFinalJson(stdout) {
  const s = String(stdout ?? '');
  let payload = null;
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '{') { i++; continue; }
    const { value, end } = parseObjectAt(s, i);
    if (value && typeof value === 'object' && !Array.isArray(value) && 'status' in value) payload = value;
    // On a successful parse, jump PAST the whole object so its nested braces are
    // not re-scanned (a nested {"status":...} must not shadow the payload). On a
    // failed parse (prose, or an unclosed brace), step one char so a later valid
    // object further along the stream is still found.
    i = value !== null ? end + 1 : i + 1;
  }
  return payload;
}

// ── apply-queue rendering ───────────────────────────────────────────────────

/**
 * Render data/apply-queue.md from scored rows: keepers only (>=3.5), highest
 * score first, so 4.0+ naturally sits above the 3.5-3.9 band. Written
 * CONTINUOUSLY during a run so the candidate can start applying at the first
 * keeper. An all-discard (or empty) input renders a real, explicitly-empty file
 * rather than throwing or leaving a stale one.
 *
 * @param {Array<{score:number, company:string, role:string, url:string, report_num:string}>} rows
 * @returns {string}
 */
export function renderApplyQueue(rows = []) {
  const header = '# Apply queue\n\n_Keepers (score >= 3.5), highest first. 4.0+ are top picks. Nothing here is applied — you make the call._\n\n';
  const keepers = (rows || []).filter((r) => isKeeper(r?.score)).sort((a, b) => b.score - a.score);
  if (!keepers.length) return header + '_No keepers yet._\n';
  // A job title routinely contains a pipe ("Engineer | Data Platform") and can
  // carry a stray newline; either would break the markdown table into fake
  // columns or split a row in two. Escape the pipe and flatten whitespace.
  const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const lines = ['| Score | Band | Company | Role | Report | URL |', '|-------|------|---------|------|--------|-----|'];
  for (const r of keepers) {
    lines.push(`| ${Number(r.score).toFixed(1)} | ${bandFor(r.score)} | ${cell(r.company)} | ${cell(r.role)} | ${cell(r.report_num)} | ${cell(r.url)} |`);
  }
  return header + lines.join('\n') + '\n';
}

// ── recording the score, guarded by the claim token ────────────────────────

/**
 * Write a worker's result onto the row it holds. Guarded on the fencing token
 * (not just `in_progress`), exactly like completeClaim: a worker that stalled
 * long enough to be reclaimed must not be able to wake up and stamp its score
 * onto a row that now belongs to a different worker. Leaves queue_status at
 * `in_progress` — the caller transitions it with completeClaim once the score
 * (and any tracker line) is durably recorded.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} canonicalUrl
 * @param {{score:number, legitimacy?:string, reportNum?:string, token?:string|null, now?:number}} opts
 * @returns {boolean} true when this caller actually owned the row
 */
export function setScore(db, canonicalUrl, { score, legitimacy = null, reportNum = null, token = null, now = Date.now() } = {}) {
  return db.prepare(`
    UPDATE jobs SET score = ?, legitimacy = ?, report_num = ?, scored_at = ?
    WHERE canonical_url = ? AND queue_status = 'in_progress' AND claim_token IS ?
  `).run(score, legitimacy, reportNum, now, canonicalUrl, token).changes === 1;
}

// ── report numbers the candidate has already dealt with ────────────────────

// A decision has been made about these, so the apply queue is done with them.
// `Evaluated` is deliberately absent: it means scored-but-not-yet-acted-on,
// which is exactly what the apply queue exists to surface.
const CLOSED_STATES = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'skip']);

/**
 * The report numbers in data/applications.md that are already closed out.
 *
 * scoredKeepers selects on score alone, so without this a keeper stays at the
 * top of apply-queue.md forever — including after it has been applied to. The
 * queue is meant to be worked from the top down, so a row that never leaves the
 * top is a standing invitation to apply to the same employer twice.
 *
 * Parsed leniently from the markdown table: this must never throw or block a
 * scoring run, and a tracker it cannot read simply excludes nothing.
 *
 * @param {string} trackerMd  the raw contents of data/applications.md
 * @returns {Set<string>} zero-padded report numbers
 */
export function closedReportNums(trackerMd) {
  const out = new Set();
  for (const line of String(trackerMd ?? '').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is the empty span before the leading pipe.
    const num = cells[1];
    if (!/^\d+$/.test(num || '')) continue; // header, separator, or a malformed row
    if (cells.some((c) => CLOSED_STATES.has(c.replace(/\*/g, '').toLowerCase()))) out.add(num);
  }
  return out;
}

/**
 * Every scored row at or above the keeper bar, shaped for renderApplyQueue.
 * `url` is the raw (clickable) URL, `role` the stored title. renderApplyQueue
 * does the final sort/escaping, so this only has to select and rename.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Array<{score:number, company:string, role:string, url:string, report_num:string}>}
 */
export function scoredKeepers(db) {
  return db.prepare('SELECT score, company, title, raw_url, report_num FROM jobs WHERE score IS NOT NULL AND score >= ?')
    .all(KEEPER_BAR)
    .map((r) => ({ score: r.score, company: r.company, role: r.title, url: r.raw_url, report_num: r.report_num }));
}

// ── slugify: a filesystem-safe company slug for the jd filename ─────────────

/**
 * Lowercase, hyphenate, and strip a string down to [a-z0-9-] so it is safe as a
 * filename component. Collapses runs of separators and trims them from the ends.
 * Critically, a value like "a/b/../c" cannot walk out of its directory — every
 * slash and dot becomes a separator.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── runPool: bounded-concurrency fan-out ────────────────────────────────────

/**
 * Run `worker(item, index)` over every item with at most `concurrency` in
 * flight, and return the results in INPUT order (not completion order). The
 * scorer spawns Codex workers, which are expensive and rate-limited, so the cap
 * is a hard ceiling; order preservation lets the caller line results up with
 * their rows.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @param {{concurrency?:number}} [opts]
 * @returns {Promise<R[]>}
 */
export async function runPool(items, worker, { concurrency = 3 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const cap = Math.max(1, Math.floor(concurrency));
  async function runner() {
    while (next < list.length) {
      const i = next++;
      results[i] = await worker(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cap, list.length) }, () => runner()));
  return results;
}

// ── processRow: score one claimed row end to end ────────────────────────────

/**
 * Take one already-claimed row through the full scoring pass. Every side effect
 * is an injected dependency so the decision tree is testable with no subprocess
 * and no filesystem:
 *
 *   reserve a report number → write the ad to jds/ → fill batch-prompt.md →
 *   run a Codex worker → parse its final JSON → land the outcome on the queue.
 *
 * Success (the worker exited 0 AND printed a `completed` payload with a finite
 * score) records the score and transitions the row to `evaluated`. Anything
 * else — a failed payload, unparseable stdout, a non-zero exit, or a worker
 * that threw — is a FAILURE, and a failure returns the row to `llm_ready` via
 * failClaim (retryable, never silently dropped: dropping a job over one bad run
 * is the outcome this pipeline refuses). The reserved report number is released
 * in every case: on success the worker has written the real report so the
 * sentinel's job is done; on failure the number is freed for reuse.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} row  a claimed row (carries canonical_url, raw_url, company, jd_text, claim_token)
 * @param {object} deps  { template, date, now, jdDir, reserveNum, releaseNum, writeJd, runWorker, maxRetries }
 * @returns {Promise<{url:string, status:'evaluated'|'failed', score:number|null, reportNum:string|null, error:string|null}>}
 */
export async function processRow(db, row, deps) {
  const {
    template, date, now = Date.now(), jdDir = 'jds', maxRetries = 3,
    reserveNum, releaseNum, writeJd, runWorker, discardTracker = () => {},
    refreshJd = null,
  } = deps;
  const token = row.claim_token;
  const url = row.canonical_url;
  let reportNum = null;
  let jdText = row.jd_text ?? '';

  const failed = (error) => {
    failClaim(db, url, { reason: String(error).slice(0, 200), maxRetries, token });
    if (reportNum) {
      // A worker can write its tracker TSV (batch-prompt.md step 5) and THEN
      // fail/time out. merge-tracker runs unconditionally, so that orphan line
      // would post a tracker row for a run the queue is retrying. Discard it.
      try { discardTracker(reportNum); } catch { /* nothing was written */ }
      try { releaseNum(reportNum); } catch { /* sentinel GC is a backstop */ }
    }
    return { url, status: 'failed', score: null, reportNum, error: String(error) };
  };

  try {
    // ── liveness, before a single cent is spent ──────────────────────────────
    // The stored ad is a snapshot from whenever fetch-jds last ran; most of the
    // pool is `backup` (4-7 days old). Re-fetch immediately before scoring so
    // the model reads the CURRENT ad and a closed posting is caught for free —
    // jd-fetch already returns reason 'gone' for a 404/410 on a per-job
    // endpoint. This runs before reserveNum so a dead posting never even burns
    // a report number.
    //
    // The asymmetry is deliberate: only a CONFIRMED 'gone' closes the row.
    // A transient error, an ambiguous 'empty' (an ashby shared board proves
    // nothing about one posting), or a throw all fall through to the stored ad.
    // Dropping a live job over a network blip is the outcome this pipeline
    // refuses — the same rule that makes `unknown` pass every other gate.
    if (refreshJd) {
      let fresh = null;
      try { fresh = await refreshJd(row); } catch { /* transient: keep the snapshot */ }
      if (fresh?.reason === 'gone') {
        completeClaim(db, url, { status: 'skipped', reason: 'closed: posting returned 404/410 at score time', token });
        return { url, status: 'closed', score: null, reportNum: null, error: null };
      }
      if (fresh?.ok && fresh.text) jdText = fresh.text;
    }

    reportNum = reserveNum();
    const slug = slugify(row.company) || 'job';
    const jdFile = `${jdDir}/${reportNum}-${slug}.txt`;
    writeJd(jdFile, jdText);

    const prompt = fillPrompt(template, {
      url: row.raw_url, jdFile, reportNum, date, id: reportNum,
    });
    const { stdout, code } = await runWorker(prompt, { cwd: process.cwd() });

    if (code !== 0) return failed(`worker exited ${code}`);
    const payload = parseFinalJson(stdout);
    if (!payload) return failed('no final JSON payload in worker output');
    // A DECIDED skip is not a failure. The free screens are regex and cannot see
    // everything; some hard rejects only surface once the worker has the ad
    // open. When it stops early instead of writing a full evaluation, that has
    // to be terminal: `failed` returns the row to llm_ready with a bumped retry
    // count, so recording a skip that way would pay for the same rejection
    // twice. Same shape as the `closed` branch above.
    if (payload.status === 'skipped') {
      const why = String(payload.skip_reason || payload.error || 'worker skipped: no reason given').slice(0, 200);
      completeClaim(db, url, { status: 'skipped', reason: `worker: ${why}`, token });
      // No report was written, so the number goes back and any partial tracker
      // line is dropped. Both are best-effort: the sentinel GC and the merge
      // step each tolerate a leftover.
      try { releaseNum(reportNum); } catch { /* sentinel GC is a backstop */ }
      try { discardTracker(reportNum); } catch { /* nothing was written */ }
      return { url, status: 'skipped', score: null, reportNum: null, error: null };
    }
    if (payload.status !== 'completed') return failed(payload.error || `worker status ${payload.status}`);
    const score = Number(payload.score);
    if (!Number.isFinite(score)) return failed(`non-numeric score ${JSON.stringify(payload.score)}`);

    setScore(db, url, { score, legitimacy: payload.legitimacy ?? null, reportNum, token, now });
    // completeClaim is fenced on the claim token. If it returns false this
    // worker's row was reclaimed mid-run and now belongs to someone else — the
    // setScore above was refused too, so the DB is untouched. Do NOT report
    // success or let this worker's tracker line be merged: it would double a row.
    const owned = completeClaim(db, url, { status: 'evaluated', token });
    try { releaseNum(reportNum); } catch { /* sentinel GC is a backstop */ }
    if (!owned) {
      try { discardTracker(reportNum); } catch { /* nothing was written */ }
      return { url, status: 'lost', score, reportNum, error: 'claim lost (row reclaimed mid-run)' };
    }
    return { url, status: 'evaluated', score, reportNum, error: null };
  } catch (err) {
    return failed(err?.message || err);
  }
}

/**
 * Interpret a child process's (code, signal) as a single exit code, treating a
 * signal-kill or a null code (OOM, SIGKILL, abnormal termination) as a FAILURE
 * rather than a clean 0. `code ?? 0` would read a killed worker that happened to
 * print a valid-looking payload as a success and record its score.
 *
 * @param {number|null} code
 * @param {string|null} signal
 * @returns {number} 0 only for a clean exit(0); non-zero otherwise
 */
export function exitCodeFrom(code, signal) {
  if (signal) return 137;      // 128 + SIGKILL(9): killed, never a success
  if (code == null) return 1;  // abnormal close with neither code nor signal
  return code;
}

// ── how long a claim stays valid ────────────────────────────────────────────

/** The per-worker Codex timeout, and the unit the stale window is built from. */
export const WORKER_TIMEOUT_MS = 900_000;

/**
 * How long a claimed row may sit in_progress before another run may reclaim it.
 *
 * reclaimStale's 1h default was sized for a CRASHED run, and it is wrong for a
 * long healthy one. A --limit 100 batch at concurrency 3 is 34 sequential waves;
 * if each hit the 900s worker timeout that is over 8 hours of legitimate work.
 * With a flat 1h window, a second invocation started meanwhile would reclaim
 * rows the first run is still actively scoring — two paid Codex workers on one
 * job, and the one that finishes second has its claim refused and throws its
 * (already paid for) work away.
 *
 * So the window is derived from the batch's own worst case rather than fixed,
 * with 1h as a floor and 1.5x headroom for process startup and the refresh.
 *
 * @param {{limit?:number, concurrency?:number, timeoutMs?:number}} opts
 * @returns {number} milliseconds
 */
export function staleWindowMs({ limit = 25, concurrency = 3, timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  const rows = Math.max(0, Math.floor(limit) || 0);
  const workers = Math.max(1, Math.floor(concurrency) || 1);
  const waves = Math.ceil(rows / workers) || 0;
  return Math.max(3_600_000, Math.ceil(waves * timeoutMs * 1.5));
}

// ── pool deduplication: never send one employer two applications ────────────

/**
 * Collapse rows that are the SAME posting reached by different URLs.
 *
 * canonicalizeUrl cannot catch these: a company's own careers domain and its
 * ATS host are genuinely different URLs, and both are real. What gives them
 * away is that both rows carry the same downloaded ad — so the ad text is the
 * content key. Without this the scorer pays twice for one job and, worse, can
 * put two applications in front of one employer.
 *
 * Whitespace is normalised before hashing because one ATS pretty-prints its
 * HTML and another does not; matching exact bytes would miss the real duplicate.
 * An EMPTY ad is never a key — it is the absence of evidence, and collapsing on
 * it would delete unrelated jobs.
 *
 * The first occurrence wins, and since the pool arrives in drain order
 * (freshest first) that is the freshest copy of the posting.
 *
 * @param {Array<object>} rows
 * @returns {{unique:Array<object>, duplicates:Array<{row:object, duplicateOf:string}>}}
 */
export function dedupePool(rows = []) {
  const seen = new Map();
  const unique = [];
  const duplicates = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.jd_text ?? '').replace(/\s+/g, ' ').trim();
    if (!key) { unique.push(row); continue; }
    if (seen.has(key)) duplicates.push({ row, duplicateOf: seen.get(key) });
    else { seen.set(key, row.canonical_url); unique.push(row); }
  }
  return { unique, duplicates };
}

// ── spend order: the candidate's archetype tiers, applied to the drain ─────

// The tiers are config/profile.yml's target_roles.archetypes `fit` values, and
// the reason they exist is measured, not stylistic: modes/_custom.md records a
// 40-role batch test in which EVERY "Software Engineer" posting scored under
// 3.0/5 — Anthropic, LangChain, Palantir, Databricks and Vercel all landed
// 1.0-2.9 regardless of company quality. The one hit was an Analyst II at 4.1.
//
// `avoid` is the narrowest tier and names specific role shapes ("Forward
// Deployed", "Solutions Architect") that batch-tested at 1.4-2.8, not a whole
// job family.
const AVOID_TITLE_RE = /(forward[\s-]?deployed|solutions?\s+(?:architect|engineer)|sales\s+engineer)/i;
// "Analyst" is the STRONG primary signal and outranks everything: it is the
// exact noun profile.yml's primary tier is built on, and a title like "Business
// Systems Analyst" is an analyst job however technical its modifiers sound.
const ANALYST_TITLE_RE = /\banalysts?\b/i;
const ENGINEERING_TITLE_RE = /(engineer|architect|developer|programmer|scientist|\bsre\b|devops)/i;
// The weaker primary words. These are checked AFTER the engineering nouns,
// because they are common modifiers rather than job nouns — "Software Engineer
// Specialist" is an engineering role that happens to end in "Specialist", and
// treating it as primary would put it ahead of a real Analyst posting.
const PRIMARY_TITLE_RE = /(operations|clerk|coordinator|administrat|specialist|bookkeep|scheduler|planner|reporting)/i;

/**
 * Where a title sits in the candidate's own spend priority. Lower runs first.
 *
 *   0  primary    — Analyst / Operations / Clerk, his stated top tier
 *   1  neutral    — unclassified; never last, because an unknown title is not
 *                   evidence of a bad fit (the same asymmetry as every gate here)
 *   2  secondary  — engineering titles, which batch-tested under 3.0
 *   3  avoid      — the specific shapes profile.yml marks `fit: avoid`
 *
 * A title is read by the noun that NAMES the job, so "Business Systems Analyst"
 * and "Data Analyst" are primary even though they carry technical words: the
 * analyst check runs before the engineering one.
 *
 * This orders spend; it never drops a row. modes/_custom.md is explicit that
 * engineering titles must still be evaluated when nothing better is available.
 *
 * @param {unknown} title
 * @returns {0|1|2|3}
 */
export function titlePriority(title) {
  const t = String(title ?? '').trim();
  if (!t) return 1;
  if (AVOID_TITLE_RE.test(t)) return 3;
  if (ANALYST_TITLE_RE.test(t)) return 0;
  if (ENGINEERING_TITLE_RE.test(t)) return 2;
  if (PRIMARY_TITLE_RE.test(t)) return 0;
  return 1;
}

const BUCKET_RANK = { hot: 0, fresh: 1, backup: 2, unknown: 3, stale: 4 };

// ── thin-market geography ──────────────────────────────────────────────────
//
// States where BLS reports FEWER unemployed people per job opening than the US
// average of 1.1 (seasonally adjusted, Dec 2025) — the employer is competing
// for the candidate rather than the reverse. everify-check.mjs derives the same
// set from its TIGHTNESS table; this mirrors the result rather than importing
// it, because that module loads a 961k-row employer index at import time.
//
// AK (1.1, exactly average) and NM (1.3, WORSE than average) are deliberately
// ABSENT. They were in the original hand-written "harsh weather" list, which
// was folk reasoning: cold winters correlate with thin labor markets but the
// labor-market number is the thing that matters. modes/_profile.md rule 8 still
// names both; the data does not support them.
//
// Honest limit: BLS measures overall market tightness, NOT applicants-per-
// posting for analyst roles. This is a well-grounded prior, not proof.
const THIN_MARKET_STATES = ['ND', 'SD', 'OK', 'ID', 'ME', 'MS', 'MT', 'NE', 'VT', 'WV', 'AR', 'IA', 'KS', 'WY'];
const THIN_MARKET_NAMES = [
  'north dakota', 'south dakota', 'oklahoma', 'idaho', 'maine', 'mississippi',
  'montana', 'nebraska', 'vermont', 'west virginia', 'arkansas', 'iowa',
  'kansas', 'wyoming',
];
const THIN_NAME_RE = new RegExp(`(?:^|[^\\p{L}])(?:${THIN_MARKET_NAMES.join('|')})(?:[^\\p{L}]|$)`, 'iu');
// The two-letter codes here are unusually hostile: ID, ME, OK, MS, NE and IA
// are all ordinary English words or ID-field noise ("Job ID 4471", "MS Excel",
// "contact me"). So a code counts only when it is UPPERCASE (real postings
// write state codes uppercase) AND follows a location separator — the "City,
// ST" and "City - ST - USA" shapes every ATS emits. A bare uppercase match with
// no separator reads "Remote, USA (Job ID 4471)" as Idaho.
// ...and it must also END a segment: a state code is followed by the end of the
// string, another separator, or a ZIP. "MS Excel" opens with the same separator
// and uppercase code as ", MS" but continues into a word, so the trailing
// lookahead is what tells Mississippi from a spreadsheet.
const THIN_CODE_RE = new RegExp(`[,\\-–—/(]\\s*(?:${THIN_MARKET_STATES.join('|')})(?=\\s*(?:$|[,\\-–—/)]|\\d))`, 'u');

/**
 * Does a posting's location name a thin-market state?
 *
 * A BOOST signal only. It is the last sort key in orderForSpend and nothing
 * anywhere filters on it: modes/_profile.md rule 8 is explicit that geography
 * is "a positive nudge when ranking what to evaluate/apply to — never a penalty
 * for other states". A false positive costs one slightly-misordered row.
 *
 * @param {unknown} location  a posting's location field
 * @returns {boolean}
 */
export function isThinMarketState(location) {
  const s = String(location ?? '').trim();
  if (!s) return false;
  return THIN_NAME_RE.test(s) || THIN_CODE_RE.test(s);
}

/**
 * Order a scoreable pool by what is worth spending a model on first.
 *
 * Freshness still LEADS — being an early applicant is the entire point of the
 * freshness model, and a hot row outranks everything. The archetype tier only
 * reorders rows inside a bucket, which is where the waste was: the pool arrived
 * freshness-sorted alone, so 13 of the first 25 rows were Engineer-titled while
 * Analyst rows in the same bucket waited behind them.
 *
 * Sorted with a stable comparator over the already-drain-ordered input, so two
 * rows of equal bucket and tier keep the freshest first.
 *
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
export function orderForSpend(rows = []) {
  return (Array.isArray(rows) ? [...rows] : []).sort((a, b) => {
    const bucket = (BUCKET_RANK[a?.freshness?.bucket] ?? 3) - (BUCKET_RANK[b?.freshness?.bucket] ?? 3);
    if (bucket !== 0) return bucket;
    const tier = titlePriority(a?.title) - titlePriority(b?.title);
    if (tier !== 0) return tier;
    // Geography sorts LAST, so it only separates rows already equal on
    // freshness and archetype tier. It must never pull a stale row or an
    // engineering title forward — fit and recency both outrank competition.
    return Number(isThinMarketState(b?.location)) - Number(isThinMarketState(a?.location));
  });
}

// ── self-healing from the reports on disk ──────────────────────────────────

/**
 * Read a finished evaluation back out of its report header.
 *
 * processRow's order is: the worker writes the report and its tracker TSV, THEN
 * the orchestrator records the score and completes the claim. A hard kill in
 * that window leaves a fully finished evaluation the queue knows nothing about.
 * Observed for real on 2026-07-24: report 322 (a 3.7 keeper) had its file and
 * its tracker row, but reclaimStale correctly returned the queue row to
 * llm_ready — so it was both missing from the apply queue AND queued to be paid
 * for a second time.
 *
 * The report file is the durable artefact, so it is what recovery reads. Every
 * field must be present and well-formed; a reserved-but-unwritten sentinel or a
 * half-written file yields null rather than a guess.
 *
 * @param {string} markdown  the report's contents
 * @param {string} filename  its basename, which carries the report number
 * @returns {{url:string, score:number, reportNum:string}|null}
 */
export function parseReportHeader(markdown, filename = '') {
  const md = String(markdown ?? '');
  const url = md.match(/^\*\*URL:\*\*\s*(\S+)/m)?.[1];
  const rawScore = md.match(/^\*\*Score:\*\*\s*([0-9.]+)\s*\/\s*5/m)?.[1];
  const reportNum = String(filename).match(/^(\d{3,})-/)?.[1];
  if (!url || !rawScore || !reportNum) return null;
  const score = Number(rawScore);
  if (!Number.isFinite(score)) return null;
  return { url, score, reportNum };
}

/**
 * Restore evaluations that finished on disk but never reached the queue.
 *
 * Strictly a repair, never a rewrite: it only touches rows that are still
 * awaiting an LLM and carry NO score. A row the live scorer already recorded is
 * authoritative over anything parsed from a file, so it is left alone.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{url:string, score:number, reportNum:string}>} reports
 * @param {{now?:number}} [opts]
 * @returns {Array<{url:string, score:number, reportNum:string}>} what was healed
 */
export function healFromReports(db, reports = [], { now = Date.now() } = {}) {
  const stmt = db.prepare(`
    UPDATE jobs SET score = ?, report_num = ?, scored_at = ?, queue_status = 'evaluated'
    WHERE (canonical_url = ? OR raw_url = ?) AND score IS NULL AND queue_status = 'llm_ready'
  `);
  const healed = [];
  for (const r of Array.isArray(reports) ? reports : []) {
    if (!r?.url || !Number.isFinite(r.score)) continue;
    const canon = canonicalizeUrl(r.url);
    if (stmt.run(r.score, r.reportNum ?? null, now, canon, r.url).changes === 1) healed.push(r);
  }
  return healed;
}

// ── the column migration ────────────────────────────────────────────────────

/**
 * Add score-queue's result columns to the jobs table. Additive and idempotent,
 * exactly like queue.mjs's own addMissingColumns — safe to run on every open,
 * no version bookkeeping. NO `verdict` column: the band is derived from `score`
 * at read time (bandFor), never stored.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function addScoreColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  const columns = {
    score: 'REAL',
    legitimacy: 'TEXT',
    report_num: 'TEXT',
    scored_at: 'INTEGER',
  };
  for (const [name, decl] of Object.entries(columns)) {
    if (!have.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${decl}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// The live I/O shell — everything below runs only when this file is invoked
// directly (node score-queue.mjs). Tests import the functions above and never
// reach here. The shell is deliberately thin: the tested functions do the work.
// ════════════════════════════════════════════════════════════════════════════

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Decide how to spawn `codex`. npm installs it as `codex.cmd` on Windows, and
 * spawn() with shell:false cannot launch a `.cmd` (it never applies PATHEXT) —
 * that is the exit-127 ENOENT. So on Windows the command is run through the
 * command interpreter (`cmd.exe /c codex ...`); everywhere else codex is exec'd
 * directly. Kept shell:false in both cases, so Node still auto-quotes each argv
 * entry and a path containing a space survives without any manual quoting.
 *
 * @param {string[]} args  the codex arguments (after the program name)
 * @returns {{cmd:string, spawnArgs:string[]}}
 */
export function buildCodexSpawn(args, { isWin = process.platform === 'win32', comspec = process.env.ComSpec || 'cmd.exe' } = {}) {
  return isWin
    ? { cmd: comspec, spawnArgs: ['/c', 'codex', ...args] }
    : { cmd: 'codex', spawnArgs: args };
}

/**
 * Kill a worker AND everything it spawned.
 *
 * On Windows the child is `cmd.exe /c codex ...` (buildCodexSpawn — npm installs
 * codex as a .cmd, which spawn with shell:false cannot launch directly). A plain
 * child.kill() there terminates only the interpreter: codex itself is a
 * grandchild, survives, and keeps running a paid model to completion. Worse, it
 * finishes by writing the tracker TSV that the timeout path had already
 * discarded, so a run the queue has marked failed still posts a tracker row.
 *
 * taskkill /T walks the process tree; /F is required because codex will not
 * exit on a polite signal it never receives. POSIX keeps the direct SIGKILL —
 * codex is the child there, with no interpreter in between.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{isWin?:boolean, spawnImpl?:Function}} [opts]
 * @returns {boolean} true when a tree-kill was issued (Windows), false for the
 *   direct-signal path — the return exists so this is testable without a process.
 */
export function killTree(child, { isWin = process.platform === 'win32', spawnImpl = spawn } = {}) {
  if (isWin && child?.pid) {
    try {
      spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return true;
    } catch { /* fall through to the direct signal below */ }
  }
  try { child?.kill?.('SIGKILL'); } catch { /* already gone */ }
  return false;
}

/**
 * The real Codex worker. Feeds the filled batch-prompt.md to `codex exec` on
 * stdin and captures the agent's final message via `-o` (a clean single-message
 * file, so parseFinalJson never has to fish the payload out of Codex's own event
 * logging). Falls back to raw stdout if that file is empty.
 *
 * SANDBOXED BY DEFAULT (`-s workspace-write`): the job ad is untrusted text
 * fetched from the internet, so a prompt-injected ad must not be able to reach
 * outside the repo. workspace-write lets the worker write its report/tracker/jd
 * files and run repo scripts, and codex exec is non-interactive so an escalation
 * it cannot perform is auto-denied, never a hang. `fullAccess: true` (the
 * --full-access flag) lifts the sandbox for runs where inline PDF generation or
 * live web research is worth the added trust — an explicit, per-run opt-in.
 */
function codexRunWorker(prompt, { cwd = HERE, timeoutMs = 900_000, fullAccess = false } = {}) {
  return new Promise((resolve) => {
    const outFile = join(tmpdir(), `codex-final-${randomUUID()}.txt`);
    const sandbox = fullAccess
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['-s', 'workspace-write'];
    const { cmd, spawnArgs } = buildCodexSpawn(['exec', ...sandbox, '-C', cwd, '-o', outFile, '-']);
    const child = spawn(cmd, spawnArgs, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false;
    const finish = (code) => {
      if (done) return; done = true;
      clearTimeout(timer);
      let finalMsg = '';
      try { if (existsSync(outFile)) finalMsg = readFileSync(outFile, 'utf-8'); } catch { /* fall back to stdout */ }
      try { if (existsSync(outFile)) unlinkSync(outFile); } catch { /* best effort */ }
      resolve({ stdout: finalMsg.trim() ? finalMsg : stdout, stderr, code });
    };
    const timer = setTimeout(() => { killTree(child); finish(124); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += String(e?.message || e); finish(127); });
    // (code, signal): a signal-kill must not be read as a clean exit (exitCodeFrom).
    child.on('close', (code, signal) => finish(exitCodeFrom(code, signal)));
    // If codex exits before draining stdin, end() emits EPIPE — swallow it; the
    // close/error handler above is what turns the early exit into a failed run.
    child.stdin.on('error', () => { /* worker already gone; handled via close */ });
    try { child.stdin.end(prompt); } catch { /* EPIPE: worker already gone */ }
  });
}

/**
 * The live liveness refresh: re-download the ad immediately before scoring.
 *
 * Costs one JSON request (zero tokens) and pays for itself the first time it
 * catches a closed posting, because the alternative is a full Codex evaluation
 * plus a dead link in apply-queue.md. The result is written back to the row, so
 * a refreshed ad also un-stales the queue for the next run.
 *
 * Note the ashby caveat baked into jd-fetch: its board endpoint is SHARED, so a
 * 404 there proves nothing about one posting and never returns 'gone'. Only
 * per-job endpoints (workday/greenhouse/lever) can confirm a closure, which is
 * exactly the conservative behaviour this gate needs.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {(row:object)=>Promise<{ok:boolean, text:string, reason:string|null}>}
 */
function liveRefreshJd(db) {
  return async (row) => {
    const res = await fetchJd(row.raw_url || row.canonical_url, { timeoutMs: 15_000, boardToken: String(row.company || '').trim() });
    // Write back ONLY what improves the row: a fresh ad, or a confirmed closure.
    //
    // A transient failure must never be persisted here. markJdFailure sets
    // jd_status='error', and this scorer's pool filter is jd_status==='ok' — so
    // recording a blip would evict a row that already holds a good ad from the
    // scoreable pool. That is not hypothetical: measured on the live queue,
    // ~17% of Workday detail requests answer 403 (bot defence, not a closure),
    // which would silently drop roughly 1 in 6 Workday jobs per run. The
    // refresh is an opportunistic improvement, never a demotion.
    try {
      if (res.ok && res.text) setJdText(db, row.canonical_url, res.text);
      else if (res.reason === 'gone') markJdFailure(db, row.canonical_url, 'gone');
    } catch { /* the score path matters more than the bookkeeping */ }
    return res;
  };
}

/**
 * Which prompt the scoring workers run.
 *
 * `batch/score-prompt.md` is the lean scorer: it emits Block B and the machine
 * contracts only, makes no web calls, and does its hard-reject scan on the ad
 * BEFORE loading cv.md/profile. It exists as its own file rather than as edits to
 * `batch/batch-prompt.md` for two reasons. That prompt declares itself
 * self-contained and orders the worker to "complete every block below", so a
 * house-rule override in modes/_custom.md cannot reliably countermand it — and
 * worse, the test suite would keep passing while the live worker stayed
 * contradictory. And batch-prompt.md is in update-system.mjs SYSTEM_PATHS, so any
 * edit there is reverted by `node update-system.mjs apply`; a new file is not.
 *
 * The fallback to the full A-G batch prompt is deliberately OPT-IN, not automatic.
 * A silent fallback is the worst possible failure here: nothing errors, every row
 * still scores, and the only symptom is that each job quietly costs ~2.3x more and
 * fires ~8 web calls again. That is precisely the kind of regression an updater
 * reverting this file would cause, so it has to be loud. Set
 * CAREER_OPS_LEGACY_PROMPT=1 to run the old A-G prompt on purpose.
 */
export function scorePromptPath() {
  const override = process.env.CAREER_OPS_SCORE_PROMPT;
  if (override) return override;
  const legacy = join(HERE, 'batch', 'batch-prompt.md');
  if (process.env.CAREER_OPS_LEGACY_PROMPT === '1') return legacy;
  const lean = join(HERE, 'batch', 'score-prompt.md');
  if (existsSync(lean)) return lean;
  throw new Error(
    'batch/score-prompt.md is missing. The lean scorer prompt is gone — an update may have removed it.\n'
    + '  Restore it, or set CAREER_OPS_LEGACY_PROMPT=1 to deliberately run the full A-G prompt\n'
    + '  (which costs roughly 2.3x more per job and makes ~8 web calls).',
  );
}

/** Production dependency bag for processRow: real reserve/release/fs/spawn. */
function liveDeps({ date, now, fullAccess = false, db = null, refresh = true }) {
  const reserveScript = join(HERE, 'reserve-report-num.mjs');
  return {
    refreshJd: refresh && db ? liveRefreshJd(db) : null,
    template: readFileSync(scorePromptPath(), 'utf-8'),
    date, now, jdDir: 'jds',
    reserveNum: () => execFileSync(process.execPath, [reserveScript], { cwd: HERE }).toString().trim(),
    releaseNum: (n) => { try { execFileSync(process.execPath, [reserveScript, '--release', n], { cwd: HERE }); } catch { /* GC backstop */ } },
    writeJd: (rel, text) => {
      const abs = join(HERE, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text ?? '');
    },
    // Remove a tracker TSV a failed/lost worker may have written, before
    // merge-tracker sweeps the directory. The ID handed to the worker is the
    // report number, so that is the TSV's basename.
    discardTracker: (n) => {
      const tsv = join(HERE, 'batch', 'tracker-additions', `${n}.tsv`);
      try { if (existsSync(tsv)) unlinkSync(tsv); } catch { /* already gone */ }
    },
    runWorker: (prompt, o) => codexRunWorker(prompt, { ...o, fullAccess }),
  };
}

/**
 * Every finished report on disk, as {url, score, reportNum}.
 *
 * Cheap enough to do on every run (a few hundred small files, header-only
 * parse), and it is the only way to notice an evaluation that completed but
 * never reached the queue. Unreadable or half-written files are skipped rather
 * than allowed to abort a scoring run.
 */
function readReportHeaders() {
  const dir = join(HERE, 'reports');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name.includes('RESERVED')) continue;
    try {
      // The header is the first few lines; no need to read a 200-line report.
      const head = readFileSync(join(dir, name), 'utf-8').slice(0, 2000);
      const parsed = parseReportHeader(head, name);
      if (parsed) out.push(parsed);
    } catch { /* unreadable file: skip, never abort the run */ }
  }
  return out;
}

/** Today's date as YYYY-MM-DD (local), the format batch-prompt.md expects. */
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Continuously (re)write data/apply-queue.md from whatever is scored so far,
 * minus anything the tracker says has already been decided. Without that filter
 * an applied keeper stays pinned at the top of a list meant to be worked
 * top-down, which is how one employer ends up with two applications.
 */
function writeApplyQueue(db) {
  let closed = new Set();
  try {
    closed = closedReportNums(readFileSync(join(HERE, 'data', 'applications.md'), 'utf-8'));
  } catch { /* no tracker yet: nothing has been applied to, so exclude nothing */ }
  const open = scoredKeepers(db).filter((r) => !closed.has(String(r.report_num ?? '')));
  writeFileSync(join(HERE, 'data', 'apply-queue.md'), renderApplyQueue(open));
}

async function main() {
  const argv = process.argv.slice(2);
  const APPLY = argv.includes('--apply');
  const flag = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const limit = Math.max(1, parseInt(flag('--limit', '25'), 10) || 25);
  const concurrency = Math.max(1, parseInt(flag('--concurrency', '3'), 10) || 3);
  const fullAccess = argv.includes('--full-access');
  // The liveness re-fetch is ON by default: one free JSON request per row is
  // always cheaper than a Codex evaluation of a posting that already closed.
  // --no-refresh is the escape hatch for an offline run or a deliberate rescore.
  const noRefresh = argv.includes('--no-refresh');

  const db = await openQueue();
  addScoreColumns(db);

  // Recover any rows a previous run died holding before we compute the pool.
  // The window is sized to THIS batch's worst case, so a long healthy run is
  // never mistaken for a dead one by a second invocation (staleWindowMs).
  const recovered = reclaimStale(db, { staleAfterMs: staleWindowMs({ limit, concurrency }) });
  if (recovered.length) console.error(`reclaimed ${recovered.length} stale in-progress row(s) from a prior run`);

  // ...then heal anything that finished on disk but never reached the queue.
  // This runs AFTER the reclaim on purpose: a killed run's rows come back as
  // llm_ready first, and any of them whose report was already written is
  // recovered here rather than paid for a second time.
  const healed = healFromReports(db, readReportHeaders());
  if (healed.length) {
    console.error(`recovered ${healed.length} evaluation(s) that finished on disk but never reached the queue (reports ${healed.map((h) => h.reportNum).join(', ')})`);
  }

  // The scoreable pool: drain order (freshest first), but only rows that carry
  // an ad. jd_status !== 'ok' can never be scored, and its freshness could
  // otherwise float it to the top and starve rows that CAN be scored.
  // --url pins the batch to one posting. The normal path picks by freshness and
  // tier, so there is otherwise no way to re-score a specific row (e.g. one whose
  // report was lost when a run was killed) without draining everything ahead of it.
  const onlyUrl = flag('--url', null);
  let raw = listReady(db, {}).filter((r) => r.jd_status === 'ok');
  if (onlyUrl) {
    const want = canonicalizeUrl(onlyUrl);
    raw = raw.filter((r) => r.canonical_url === want || r.raw_url === onlyUrl);
    if (!raw.length) {
      console.error(`--url matched no scoreable row. The row must be queue_status='llm_ready' with jd_status='ok'.`);
      console.error(`  looked for: ${want}`);
      process.exit(1);
    }
  }
  // The same posting is routinely reachable at two URLs (a company's own careers
  // domain and its ATS host), which canonicalizeUrl cannot collapse because the
  // hosts genuinely differ. Both rows carry the same ad, so the ad is the key.
  // Left in, the scorer pays twice and can put two applications in front of one
  // employer.
  const { unique: deduped, duplicates } = dedupePool(raw);
  // Freshness still leads; the archetype tier decides who goes first WITHIN a
  // freshness bucket, so a batch is not spent on titles his own batch test
  // already measured at under 3.0 while primary-tier rows wait behind them.
  const pool = orderForSpend(deduped);
  const buckets = pool.reduce((m, r) => { const b = r.freshness?.bucket || '?'; m[b] = (m[b] || 0) + 1; return m; }, {});

  console.error(`\nscoreable pool: ${pool.length} rows (llm_ready + jd ok)`);
  if (duplicates.length) console.error(`  (${duplicates.length} duplicate posting(s) collapsed — same ad under a different URL)`);
  console.error(`  by freshness: ${Object.entries(buckets).map(([k, v]) => `${k} ${v}`).join(', ') || '(none)'}`);

  if (!APPLY) {
    console.error('\nDRY RUN — nothing scored. Pass --apply to score.');
    console.error(`would score the first ${Math.min(limit, pool.length)} (of ${pool.length}); next up:`);
    for (const r of pool.slice(0, Math.min(10, limit))) {
      console.error(`  [${r.freshness?.bucket}] ${r.company} — ${r.title}`);
    }
    console.log(JSON.stringify({ applied: false, scoreable: pool.length, buckets, wouldScore: Math.min(limit, pool.length) }, null, 2));
    return;
  }

  const batch = pool.slice(0, limit);
  const urls = batch.map((r) => r.canonical_url);
  const workerId = `score-${randomUUID().slice(0, 8)}`;
  const claimed = claimUrls(db, urls, { workerId });
  const mode = fullAccess ? 'FULL ACCESS (sandbox lifted)' : 'sandboxed (workspace-write)';
  if (fullAccess) console.error('\n⚠️  --full-access: the codex workers run untrusted job-ad text with NO sandbox. Only use this on a machine you accept that risk on.');
  console.error(`\nclaimed ${claimed.length} row(s); scoring at concurrency ${concurrency} with Codex [${mode}]...`);
  writeApplyQueue(db); // establish the file even before the first result

  const deps = liveDeps({ date: today(), now: Date.now(), fullAccess, db, refresh: !noRefresh });
  let evaluated = 0, failed = 0, lost = 0, keepers = 0, closed = 0, skipped = 0;
  await runPool(claimed, async (row, i) => {
    // processRow catches its own errors, but a post-row throw (an fs write in
    // writeApplyQueue) must never reject and abort the whole batch — that would
    // strand every not-yet-started claimed row in_progress until stale reclaim.
    let res;
    try {
      res = await processRow(db, row, deps);
    } catch (e) {
      res = { url: row.canonical_url, status: 'failed', score: null, reportNum: null, error: e?.message || String(e) };
    }
    if (res.status === 'evaluated') { evaluated++; if (isKeeper(res.score)) keepers++; }
    else if (res.status === 'lost') lost++;
    else if (res.status === 'closed') closed++;
    else if (res.status === 'skipped') skipped++;
    else failed++;
    try { writeApplyQueue(db); } catch (e) { console.error(`apply-queue write failed (continuing): ${e?.message || e}`); }
    console.error(`  (${i + 1}/${claimed.length}) ${row.company}: ${res.status}${res.score != null ? ` ${res.score}` : ''}${res.error ? ` — ${res.error}` : ''}`);
    return res;
  }, { concurrency });

  // The workers wrote tracker TSVs to batch/tracker-additions/; merge them once.
  try {
    execFileSync(process.execPath, [join(HERE, 'merge-tracker.mjs')], { cwd: HERE, stdio: 'inherit' });
  } catch (e) {
    console.error(`merge-tracker failed (tracker rows are still in batch/tracker-additions/): ${e?.message || e}`);
  }
  writeApplyQueue(db);

  console.error(`\ndone: ${evaluated} evaluated (${keepers} keepers >= ${KEEPER_BAR}), ${failed} failed${skipped ? `, ${skipped} skipped early (hard reject the free screens missed)` : ''}${closed ? `, ${closed} closed (posting gone, not scored)` : ''}${lost ? `, ${lost} lost (reclaimed mid-run)` : ''}`);
  console.error('apply queue: data/apply-queue.md');
  console.log(JSON.stringify({ applied: true, claimed: claimed.length, evaluated, keepers, failed, skipped, closed, lost }, null, 2));
}

// Run the shell only on direct invocation; importing this module must be inert.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
