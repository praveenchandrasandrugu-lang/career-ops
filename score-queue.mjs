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
