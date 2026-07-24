#!/usr/bin/env node
/**
 * screen-queue.mjs — apply the zero-token screen to every stored job ad (step 7).
 *
 * Reads `jd_text` (filled by fetch-jds.mjs), runs screen-jd.mjs over it, and
 * records the verdict so a model is only ever paid for postings the candidate
 * could actually take. Costs nothing and touches no network.
 *
 * DRY RUN BY DEFAULT. Nothing is written without `--apply`, because a gated row
 * leaves the drain queue and a wrong gate is invisible damage: the candidate
 * never learns which job he stopped being shown. Read the funnel first.
 *
 * Verdicts written to `level_status`:
 *   clear    — no bar found
 *   stretch  — a 3+ year bar; still shown, flagged so the choice is informed
 *   gated    — an explicit bar from modes/_custom.md's hard-gate list; the row
 *              is moved to queue_status='skipped' with the evidence in
 *              skip_reason, so every drop can be audited and reversed
 *   unknown  — no ad text; NEVER dropped (that would lose a job to a failed
 *              fetch rather than to a fact about the job)
 *
 * Reversible: `node gate.mjs` re-promotes rows from scratch.
 *
 * Usage:
 *   node screen-queue.mjs             # dry run, prints the funnel
 *   node screen-queue.mjs --apply     # write the verdicts
 */
import { openQueue, listReady } from './queue.mjs';
import { screenJd } from './screen-jd.mjs';
import { classifyLocationDeep } from './gate.mjs';

const APPLY = process.argv.includes('--apply');
const db = await openQueue();

const rows = listReady(db, {});
const counts = { clear: 0, stretch: 0, gated: 0, unknown: 0 };
const byGate = {};
// Freshness is what the drain actually consumes, so report the funnel in those
// terms: the backlog matters far less than what is hot today.
const fresh = { hot: { before: 0, after: 0 }, fresh: { before: 0, after: 0 }, backup: { before: 0, after: 0 } };

const setVerdict = db.prepare('UPDATE jobs SET level_status = ? WHERE canonical_url = ?');
const dropRow = db.prepare("UPDATE jobs SET level_status = 'gated', queue_status = 'skipped', skip_reason = ? WHERE canonical_url = ? AND queue_status = 'llm_ready'");

if (APPLY) db.exec('BEGIN IMMEDIATE');
try {
  for (const row of rows) {
    const bucket = row.freshness?.bucket;
    if (fresh[bucket]) fresh[bucket].before++;

    // Geography, re-asked now that the ad exists. gate.mjs could only read the
    // location FIELD, and Workday's most common value there is a bare count
    // ("2 Locations") that names nothing — so 394 of 921 scoreable rows reached
    // this point with their geography unexamined, and 81 of them are actually
    // in Bangalore, Belo Horizonte, Berlin or London. On an F-1 STEM OPT search
    // those are unworkable, and each one otherwise costs a paid Codex call.
    // Same asymmetry as every other gate: a US signal anywhere keeps the row.
    const { verdict: screenVerdict, reasons } = classifyLocationDeep(row) === 'non_us'
      ? { verdict: 'gated', reasons: [{ gate: 'non-US location', evidence: row.location || row.canonical_url }] }
      : screenJd(row.jd_text);
    const verdict = screenVerdict;
    counts[verdict]++;
    if (fresh[bucket] && verdict !== 'gated') fresh[bucket].after++;

    if (verdict === 'gated') {
      for (const r of reasons) byGate[r.gate] = (byGate[r.gate] || 0) + 1;
      // The evidence travels with the drop. A gate you cannot audit is a gate
      // you cannot trust to be removing the right jobs.
      const why = reasons.map((r) => `${r.gate}: ${String(r.evidence || '').slice(0, 120)}`).join(' | ');
      if (APPLY) dropRow.run(why, row.canonical_url);
    } else if (APPLY) {
      setVerdict.run(verdict, row.canonical_url);
    }
  }
  if (APPLY) db.exec('COMMIT');
} catch (e) {
  if (APPLY) { try { db.exec('ROLLBACK'); } catch { /* connection already unusable */ } }
  throw e;
}

const line = (k) => `  ${k.padEnd(8)} ${String(fresh[k].before).padStart(5)} -> ${String(fresh[k].after).padStart(5)}`;
console.error(APPLY ? 'APPLIED' : 'DRY RUN (nothing written; pass --apply to write)');
console.error(`\nscreened ${rows.length} queued rows`);
console.error(`  clear   ${counts.clear}\n  stretch ${counts.stretch}\n  gated   ${counts.gated}\n  unknown ${counts.unknown} (no ad text; kept)`);
console.error('\ndrops by gate:');
for (const [g, n] of Object.entries(byGate).sort((a, b) => b[1] - a[1])) console.error(`  ${String(n).padStart(4)}  ${g}`);
console.error('\nsurvivors by freshness (before -> after):');
for (const k of ['hot', 'fresh', 'backup']) console.error(line(k));

console.log(JSON.stringify({ applied: APPLY, screened: rows.length, ...counts, byGate, freshness: fresh }, null, 2));
