#!/usr/bin/env node
/**
 * queue-migrate.mjs — one-time import of the legacy flat files into queue.mjs.
 *
 * data/pipeline.md is not a list, it is a list plus an audit trail. Rows under
 * `## Archived` are still written `- [ ]`, so a checkbox grep reports ~7.9k
 * pending when only ~6.8k are real. This importer is therefore SECTION-aware
 * and never looks at the checkbox.
 *
 * Archived/processed rows must still land in the DB. scan.mjs's loadSeenUrls()
 * matches a URL anywhere in pipeline.md regardless of section, so leaving them
 * out would make every previously-rejected job re-emerge on the next scan. They
 * import as `skipped` — visible to dedup, invisible to the LLM drain.
 *
 * ── Why scan-history.tsv is deliberately NOT imported ──────────────────────
 * An earlier version of this file imported it too, and inserted exactly 0 rows
 * against the real data: every history URL was already in pipeline.md. It was
 * pure downside. scan.mjs applies a real policy to that file
 * (`scan_history.recheck_after_days`, plus permanent statuses and expiring
 * `cooldown:<date>` statuses), and reproducing it from the queue means smuggling
 * the row's `status` and its EXACT `first_seen` string through columns that do
 * not exist — the schema has no place for either. Every approximation diverged:
 * a malformed date like `2026-02-30` silently normalizes to 2026-03-02 (scan.mjs
 * round-trip-validates and dedups it forever), a blank date became "seen today",
 * and a `cooldown:` row lost its expiry. Each divergence over-dedups, and a lost
 * job is the one outcome this pipeline refuses.
 *
 * loadSeenUrls() already reads scan-history.tsv directly and applies that policy
 * correctly, so dedup coverage is complete without this. Before a future
 * increment absorbs the file, the `jobs` table needs real columns for the
 * history status and its original ISO date — not an overloaded `skip_reason`.
 *
 * Usage:
 *   node queue-migrate.mjs             # migrate into data/queue.db
 *   node queue-migrate.mjs --dry-run   # parse + report, write nothing
 */
import { readFileSync, existsSync } from 'fs';
import { openQueue, canonicalizeUrl } from './queue.mjs';

// ── date confidence, derived rather than guessed ────────────────────────────
//
// providers/workday.mjs `parsePostedOn` returns undefined for any "30+ Days
// Ago" label, so a lower_bound date was NEVER written to pipeline.md. Every
// dated row is one of:
//   - an absolute timestamp (Greenhouse first_published, Lever createdAt,
//     Ashby publishedAt, and every other provider's date field) → exact
//   - a specific relative day count ("Posted 5 Days Ago") → relative_exact
// Workday is the only label-derived source, so it is the only special case.
// Both ranks are equally trusted by freshness.mjs; the distinction is recorded
// for honesty and for anyone auditing where a date came from.
const isWorkday = (url) => /\.myworkdayjobs\.com/i.test(url);

const URL_RE = /https?:\/\/\S+/;
const POSTED_RE = /^posted:\s*(\d{4})-(\d{2})-(\d{2})/i;
const SCORE_RE = /^\d(?:\.\d)?\/5$/;

/**
 * Parse one pipeline.md bullet into a normalized row.
 *
 * Two shapes exist in the file and the URL is not in the same column in both:
 *   Pending:   `- [ ] {url} | {company} | {title} | {location} | posted: {date}`
 *   Processed: `- [x] #145 | {url} | {company} | {title} | {score} | PDF ❌`
 * so the URL is located by scheme, and the other fields are read relative to it.
 *
 * @param {string} line
 * @returns {{url:string, company:string, title:string, location:string,
 *            postedAt:number|null, confidence:string} | null}  null if not a row
 */
export function parsePipelineRow(line) {
  if (!/^\s*-\s*\[[ xX]\]/.test(line)) return null;
  const body = line.replace(/^\s*-\s*\[[ xX]\]\s*/, '');
  const fields = body.split('|').map((f) => f.trim());
  const i = fields.findIndex((f) => URL_RE.test(f));
  if (i === -1) return null;
  const url = fields[i].match(URL_RE)[0];

  const after = fields.slice(i + 1);
  // A field is only a location if it is not one of the other known shapes.
  const isPosted = (f) => POSTED_RE.test(f);
  const isMeta = (f) => !f || isPosted(f) || SCORE_RE.test(f) || /^PDF\b/i.test(f);

  const posted = after.find(isPosted);
  const m = posted ? posted.match(POSTED_RE) : null;
  const postedAt = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;

  return {
    url,
    company: after[0] && !isMeta(after[0]) ? after[0] : '',
    title: after[1] && !isMeta(after[1]) ? after[1] : '',
    location: after[2] && !isMeta(after[2]) ? after[2] : '',
    postedAt,
    confidence: postedAt == null ? 'unknown' : (isWorkday(url) ? 'relative_exact' : 'exact'),
  };
}

// Section → queue state. The heading, never the checkbox, decides: an archived
// row is written `- [ ]` and would otherwise read as pending.
function classifySection(heading, subheading) {
  if (/^##\s*Pending/i.test(heading)) return { queueStatus: 'new', skipReason: null };
  if (/^##\s*Processed/i.test(heading)) return { queueStatus: 'evaluated', skipReason: null };
  if (/^##\s*Hard-Filtered/i.test(heading)) return { queueStatus: 'skipped', skipReason: 'hard-filtered' };
  if (/^##\s*Archived/i.test(heading)) {
    return { queueStatus: 'skipped', skipReason: subheading ? `archived: ${subheading}` : 'archived' };
  }
  // Unknown section: skip rather than queue. Queueing an unrecognised section
  // could feed an LLM rows a human already rejected; skipping is recoverable.
  const name = heading.replace(/^#+\s*/, '').replace(/\s*\(.*$/, '').trim() || 'unknown';
  return { queueStatus: 'skipped', skipReason: name.toLowerCase() };
}

// `### Non-US (847)` → `Non-US`: the count is a rendering artifact, not identity.
const subName = (line) => line.replace(/^#+\s*/, '').replace(/\s*\(\d[\d,]*\)\s*$/, '').trim();

/**
 * Parse a whole pipeline.md into rows annotated with their section verdict.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parsePipeline(text) {
  const rows = [];
  let heading = '';
  let subheading = '';
  for (const line of String(text).split(/\r?\n/)) {
    if (/^##\s/.test(line)) { heading = line; subheading = ''; continue; }
    if (/^###\s/.test(line)) { subheading = subName(line); continue; }
    const row = parsePipelineRow(line);
    if (row) rows.push({ ...row, ...classifySection(heading, subheading) });
  }
  return rows;
}

const COLUMNS = `(canonical_url, raw_url, company, title, source,
    posted_at, posted_at_confidence, first_seen_at, last_seen_at,
    queue_status, skip_reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// pipeline.md carries VERDICTS ("archived: Non-US", "hard-filtered"), so when it
// disagrees with an existing row the verdict has to win — but only over `new`.
// `new` means "discovered, no decision yet", which is precisely the state a
// legacy decision should overwrite. Every other state (llm_ready, in_progress,
// evaluated, skipped, failed) reflects work already done and must never be
// rolled back by re-running a one-time migration.
const INSERT_PIPELINE_SQL = `
  INSERT INTO jobs ${COLUMNS}
  ON CONFLICT(canonical_url) DO UPDATE SET
    queue_status = excluded.queue_status,
    skip_reason  = excluded.skip_reason
  WHERE jobs.queue_status = 'new' AND excluded.queue_status <> 'new'`;

/**
 * Import parsed pipeline rows into the queue.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<object>} rows
 * @param {{now?:number, source?:string}} [opts]
 * @returns {{imported:number, inserted:number, existing:number, malformed:number}}
 */
export function importRows(db, rows, { now = Date.now(), source = 'pipeline.md' } = {}) {
  const insert = db.prepare(INSERT_PIPELINE_SQL);
  // `changes` cannot distinguish an insert from a verdict-update, so ask first.
  const exists = db.prepare('SELECT 1 FROM jobs WHERE canonical_url = ?');
  let inserted = 0, existing = 0, malformed = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of rows) {
      const canonical = canonicalizeUrl(r.url);
      if (!canonical) { malformed++; continue; }
      if (exists.get(canonical)) existing++; else inserted++;
      insert.run(canonical, r.url, r.company ?? '', r.title ?? '', source,
        r.postedAt ?? null, r.confidence ?? 'unknown', now, now,
        r.queueStatus, r.skipReason ?? null);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { imported: rows.length - malformed, inserted, existing, malformed };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const PIPELINE = 'data/pipeline.md';

  if (!existsSync(PIPELINE)) {
    console.error(`Error: ${PIPELINE} not found (run from the project root).`);
    process.exit(1);
  }

  const rows = parsePipeline(readFileSync(PIPELINE, 'utf8'));
  const tally = {};
  for (const r of rows) {
    const k = r.queueStatus === 'skipped' ? `skipped (${r.skipReason})` : r.queueStatus;
    tally[k] = (tally[k] ?? 0) + 1;
  }
  console.log(`Parsed ${rows.length} rows from ${PIPELINE}:`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(6)}  ${k}`);
  }

  if (dry) { console.log('\n--dry-run: nothing written.'); return; }

  const db = await openQueue();
  const a = importRows(db, rows);
  console.log(`\npipeline.md   inserted ${a.inserted}, already present ${a.existing}, malformed ${a.malformed}`);
  const total = db.prepare('SELECT COUNT(*) c FROM jobs').get().c;
  const queued = db.prepare("SELECT COUNT(*) c FROM jobs WHERE queue_status = 'new'").get().c;
  console.log(`\nqueue now holds ${total} rows, ${queued} awaiting the gate.`);
  db.close();
}

const invoked = process.argv[1] && (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href);
if (invoked) await main();
