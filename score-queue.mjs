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
 * Built incrementally and test-first, exactly like queue.mjs. This increment
 * lands the pure, deterministic core (band classification, placeholder fill,
 * final-JSON extraction, apply-queue rendering) and the additive column
 * migration. The live Codex spawn (parallel workers, atomic claim via
 * queue.mjs, tracker merge) is the next increment, behind an --apply flag, so
 * this stage stays dry-run-safe by default like every other stage here.
 */

import { completeClaim, failClaim } from './queue.mjs';

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
    reserveNum, releaseNum, writeJd, runWorker,
  } = deps;
  const token = row.claim_token;
  const url = row.canonical_url;
  let reportNum = null;

  const failed = (error) => {
    failClaim(db, url, { reason: String(error).slice(0, 200), maxRetries, token });
    if (reportNum) { try { releaseNum(reportNum); } catch { /* sentinel GC is a backstop */ } }
    return { url, status: 'failed', score: null, reportNum, error: String(error) };
  };

  try {
    reportNum = reserveNum();
    const slug = slugify(row.company) || 'job';
    const jdFile = `${jdDir}/${reportNum}-${slug}.txt`;
    writeJd(jdFile, row.jd_text ?? '');

    const prompt = fillPrompt(template, {
      url: row.raw_url, jdFile, reportNum, date, id: reportNum,
    });
    const { stdout, code } = await runWorker(prompt, { cwd: process.cwd() });

    if (code !== 0) return failed(`worker exited ${code}`);
    const payload = parseFinalJson(stdout);
    if (!payload) return failed('no final JSON payload in worker output');
    if (payload.status !== 'completed') return failed(payload.error || `worker status ${payload.status}`);
    const score = Number(payload.score);
    if (!Number.isFinite(score)) return failed(`non-numeric score ${JSON.stringify(payload.score)}`);

    setScore(db, url, { score, legitimacy: payload.legitimacy ?? null, reportNum, token, now });
    completeClaim(db, url, { status: 'evaluated', token });
    try { releaseNum(reportNum); } catch { /* sentinel GC is a backstop */ }
    return { url, status: 'evaluated', score, reportNum, error: null };
  } catch (err) {
    return failed(err?.message || err);
  }
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
