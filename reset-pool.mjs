#!/usr/bin/env node

/**
 * reset-pool.mjs — Discard the pending job pool and start from an empty one.
 *
 * Usage:
 *   node reset-pool.mjs              # dry run: say what would happen
 *   node reset-pool.mjs --apply      # actually do it
 *
 * ── Why this script exists ──────────────────────────────────────────────────
 *
 * "Clear the pool" looks like a one-liner against data/queue.db, and that is the
 * trap. queue.db is a DERIVED view: queue-migrate.mjs rebuilds it from
 * data/pipeline.md on every run-daily pass. Delete every row in the database and
 * the next pipeline run silently restores all of them, because pipeline.md is the
 * durable system of record and it was never touched. The reset appears to work,
 * the queue refills with the same stale postings, and the only visible symptom is
 * that a "fresh" pool is full of postings weeks past the freshness ceiling.
 *
 * So a real reset has to clear BOTH, in that order, which is what this does.
 *
 * ── What is deliberately kept ───────────────────────────────────────────────
 *
 * data/scan-history.tsv and data/applications.md are dedup ledgers, not pool
 * state. scan.mjs builds its seen-URL set from four sources: scan-history.tsv,
 * pipeline.md, applications.md, and the queue. Keeping the two ledgers means a
 * reset pool cannot re-surface a posting you already saw or already applied to,
 * so the refill contains genuinely new postings instead of a replay. Clearing
 * them would turn the next scan into a re-run of the last month's work.
 *
 * Both files this script does touch are archived to data/archive/ first, which is
 * gitignored (the archive holds copies of already-ignored personal data).
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const PIPELINE = 'data/pipeline.md';
const QUEUE = 'data/queue.db';
const ARCHIVE_DIR = 'data/archive';

// Ledgers this script must never touch. Listed explicitly so the reason travels
// with the code rather than living only in the comment above.
const KEPT = [
  ['data/scan-history.tsv', 'dedup ledger: stops the refill replaying postings you already saw'],
  ['data/applications.md', 'dedup ledger: stops the refill re-surfacing roles you already applied to'],
];

const apply = process.argv.includes('--apply');

function pipelineHeader(stamp) {
  return `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.

Reset ${stamp} by reset-pool.mjs. The previous pool was archived to
\`${ARCHIVE_DIR}/\`. \`data/scan-history.tsv\` and \`data/applications.md\` were kept, so
nothing already seen or already applied to can re-enter this file.

## Pending

`;
}

function countPending(text) {
  return (text.match(/^- \[[ x]\] https?:\/\//gm) || []).length;
}

const stamp = new Date().toISOString().slice(0, 10);
const plan = [];

let pipelineLines = 0;
let pipelinePending = 0;
if (existsSync(PIPELINE)) {
  const text = readFileSync(PIPELINE, 'utf8');
  pipelineLines = text.split('\n').length;
  pipelinePending = countPending(text);
  plan.push(`${PIPELINE}: ${pipelineLines} lines, ${pipelinePending} pending URL(s) -> archived, reset to an empty inbox`);
} else {
  plan.push(`${PIPELINE}: absent, will be created empty`);
}

let queueRows = 0;
if (existsSync(QUEUE)) {
  const db = new DatabaseSync(QUEUE, { readOnly: true });
  queueRows = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  db.close();
  plan.push(`${QUEUE}: ${queueRows} row(s) -> archived, all rows deleted (schema kept)`);
} else {
  plan.push(`${QUEUE}: absent, nothing to clear`);
}

console.log(apply ? 'Resetting the job pool.\n' : 'DRY RUN — nothing will be changed. Re-run with --apply.\n');
for (const line of plan) console.log('  ' + line);

console.log('\nKept on purpose:');
for (const [path, why] of KEPT) {
  console.log(`  ${existsSync(path) ? '✅' : '—'} ${path}  (${why})`);
}

if (!apply) {
  console.log('\nNothing changed. Re-run with --apply to perform the reset.');
  process.exit(0);
}

mkdirSync(ARCHIVE_DIR, { recursive: true });

if (existsSync(PIPELINE)) {
  copyFileSync(PIPELINE, `${ARCHIVE_DIR}/pipeline-${stamp}-preflush.md`);
}
writeFileSync(PIPELINE, pipelineHeader(stamp));

if (existsSync(QUEUE)) {
  copyFileSync(QUEUE, `${ARCHIVE_DIR}/queue-${stamp}-preflush.db`);
  const db = new DatabaseSync(QUEUE);
  db.exec('DELETE FROM jobs');
  db.exec('VACUUM');
  const left = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  db.close();
  if (left !== 0) {
    console.error(`\nERROR: queue still holds ${left} row(s) after the delete.`);
    process.exit(1);
  }
}

console.log(`\n✅ Pool reset. Archived to ${ARCHIVE_DIR}/*-${stamp}-preflush.*`);
console.log('   Refill it with: node run-daily.mjs --apply');
