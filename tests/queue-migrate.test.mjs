/**
 * queue-migrate.test.mjs — one-time import of the legacy flat files into the
 * SQLite queue (queue.mjs).
 *
 * data/pipeline.md is not a homogeneous list. It is a Pending section plus an
 * audit trail: Processed (already evaluated), Hard-Filtered, and a large
 * Archived block whose rows are STILL written `- [ ]` even though they were
 * rejected months ago. A naive checkbox grep therefore reports ~7.9k "pending"
 * when only ~6.8k are real (the bug that motivated the queue in the first
 * place). So the importer must be SECTION-aware, never checkbox-aware.
 *
 * The archived rows still have to land in the DB: scan.mjs's loadSeenUrls()
 * matches a URL anywhere in pipeline.md regardless of section, so dropping them
 * would make every previously-rejected job re-emerge on the next scan. They are
 * imported as `skipped` (visible to dedup, invisible to the LLM drain).
 *
 * Date confidence is imported HONESTLY rather than guessed: providers/workday
 * `parsePostedOn` returns undefined for any "30+ Days Ago" label, so no
 * lower_bound date was ever written to pipeline.md. Every dated row is an
 * absolute timestamp (Greenhouse/Lever/Ashby → exact) or a specific relative
 * day count (Workday → relative_exact).
 *
 * Run: node tests/queue-migrate.test.mjs  (or via test-all.mjs)
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { pass, fail } from './helpers.mjs';
import { openQueue, upsertJobs, allUrls } from '../queue.mjs';
import { parsePipelineRow, parsePipeline, importRows } from '../queue-migrate.mjs';

const T = (label, cond) => (cond ? pass(label) : fail(label, 'assertion failed'));
const eq = (label, got, want) => T(`${label}${got === want ? '' : ` (got ${JSON.stringify(got)})`}`, got === want);

const NOW = Date.UTC(2026, 6, 21); // 2026-07-21T00:00:00Z, fixed for determinism

// ── row parsing ─────────────────────────────────────────────────────────────
{
  const line = '- [ ] https://xcelenergy.wd1.myworkdayjobs.com/external/job/Denver-CO-80205/Senior-Data-Engineer_JR114084 | xcelenergy | Senior Data Engineer | 2 Locations | posted: 2026-07-21';
  const r = parsePipelineRow(line);
  eq('parsePipelineRow: extracts the url', r.url, 'https://xcelenergy.wd1.myworkdayjobs.com/external/job/Denver-CO-80205/Senior-Data-Engineer_JR114084');
  eq('parsePipelineRow: extracts the company', r.company, 'xcelenergy');
  eq('parsePipelineRow: extracts the title', r.title, 'Senior Data Engineer');
  eq('parsePipelineRow: extracts the location', r.location, '2 Locations');
  eq('parsePipelineRow: extracts posted date as UTC epoch', r.postedAt, Date.UTC(2026, 6, 21));
  eq('parsePipelineRow: workday host → relative_exact (label-derived, not a timestamp)', r.confidence, 'relative_exact');
}

eq('parsePipelineRow: greenhouse host → exact (absolute first_published)',
  parsePipelineRow('- [ ] https://boards.greenhouse.io/acme/jobs/123 | Acme | Analyst | Remote | posted: 2026-07-20').confidence,
  'exact');
eq('parsePipelineRow: lever host → exact',
  parsePipelineRow('- [ ] https://jobs.lever.co/acme/uuid-1 | Acme | Analyst | NY | posted: 2026-07-20').confidence,
  'exact');
eq('parsePipelineRow: ashby host → exact',
  parsePipelineRow('- [ ] https://jobs.ashbyhq.com/acme/uuid-1 | Acme | Analyst | NY | posted: 2026-07-20').confidence,
  'exact');

// An undated row must import as unknown/null, never as "seen today" — inventing
// a date would smuggle a stale posting into the fresh drain.
{
  const r = parsePipelineRow('- [ ] https://boards.greenhouse.io/acme/jobs/9 | Acme | Analyst | NY');
  eq('parsePipelineRow: undated row → confidence unknown', r.confidence, 'unknown');
  eq('parsePipelineRow: undated row → postedAt null', r.postedAt, null);
}

// The Processed section uses a different shape: `- [x] #145 | url | company |
// title | 2.4/5 | PDF ❌`. The URL is the second field, not the first, so the
// parser locates it by scheme rather than by position.
{
  const r = parsePipelineRow('- [x] #145 | https://careers.fedex.com/aod-business-planning-analyst/job/P25-213582-3 | FedEx | AOD Business Planning Analyst | 2.4/5 | PDF ❌');
  eq('parsePipelineRow: finds the url in a Processed row (2nd field)', r.url, 'https://careers.fedex.com/aod-business-planning-analyst/job/P25-213582-3');
  eq('parsePipelineRow: Processed row company', r.company, 'FedEx');
}

T('parsePipelineRow: ignores a heading line', parsePipelineRow('## Pending') === null);
T('parsePipelineRow: ignores prose', parsePipelineRow('Filtered out of Pending on 2026-07-09.') === null);
T('parsePipelineRow: ignores a bullet with no url', parsePipelineRow('- [ ] no url here') === null);

// ── section awareness ───────────────────────────────────────────────────────
const DOC = `# Pipeline — Pending URLs

## Pending

- [ ] https://boards.greenhouse.io/acme/jobs/1 | Acme | Analyst | Austin TX | posted: 2026-07-20

## Processed

- [x] #145 | https://careers.fedex.com/x/job/P25-1 | FedEx | Planning Analyst | 2.4/5 | PDF ❌

## Hard-Filtered (years/sponsorship/clearance gate, screened before LLM eval on 2026-07-12)

- [ ] https://boards.greenhouse.io/acme/jobs/2 | Acme | Senior Analyst | NY | posted: 2026-07-01

## Archived (non-US / above entry-mid)

### Non-US (847)

- [ ] https://boards.greenhouse.io/acme/jobs/3 | Acme | Analyst | Berlin | posted: 2026-07-02
`;

{
  const rows = parsePipeline(DOC);
  eq('parsePipeline: parses every row across sections', rows.length, 4);

  const by = (u) => rows.find((r) => r.url.includes(u));
  eq('parsePipeline: Pending → queue_status new', by('jobs/1').queueStatus, 'new');
  eq('parsePipeline: Processed → evaluated', by('P25-1').queueStatus, 'evaluated');
  eq('parsePipeline: Hard-Filtered → skipped', by('jobs/2').queueStatus, 'skipped');
  eq('parsePipeline: Archived → skipped', by('jobs/3').queueStatus, 'skipped');

  // The skip reason must survive so a later audit can answer "why is this not
  // queued?" without re-reading the markdown.
  eq('parsePipeline: skip reason names the section', by('jobs/2').skipReason, 'hard-filtered');
  eq('parsePipeline: skip reason prefers the ### subsection', by('jobs/3').skipReason, 'archived: Non-US');

  // An archived row is written `- [ ]` (unchecked) but is NOT pending — this is
  // exactly the miscount the queue exists to make impossible.
  T('parsePipeline: an unchecked ARCHIVED row is not treated as pending',
    by('jobs/3').queueStatus === 'skipped');
  // ...and a Processed row is `- [x]`, but the section, not the box, decides.
  T('parsePipeline: section wins over the checkbox state',
    by('P25-1').queueStatus === 'evaluated');
}

// ── importing into the DB ───────────────────────────────────────────────────
async function dbTests() {
  // basic import: statuses land, dedup key applied
  {
    const db = await openQueue(':memory:');
    const res = importRows(db, parsePipeline(DOC), { now: NOW });
    eq('importRows: reports rows imported', res.imported, 4);
    eq('importRows: all 4 land in the DB', allUrls(db).length, 4);

    const row = (u) => db.prepare("SELECT * FROM jobs WHERE canonical_url LIKE ?").get(`%${u}%`);
    eq('importRows: pending row is new', row('jobs/1').queue_status, 'new');
    eq('importRows: archived row is skipped', row('jobs/3').queue_status, 'skipped');
    eq('importRows: archived row keeps its reason', row('jobs/3').skip_reason, 'archived: Non-US');
    eq('importRows: date imported as epoch', row('jobs/1').posted_at, Date.UTC(2026, 6, 20));
    // location is what the US/non-US gate reads; parsing it and then dropping it
    // would leave that gate with nothing to judge on.
    eq('importRows: location imported', row('jobs/1').location, 'Austin TX');
    eq('importRows: confidence imported', row('jobs/1').posted_at_confidence, 'exact');
    db.close();
  }

  // idempotence: the migration is a one-shot, but a re-run must not duplicate
  // rows or reset progress.
  {
    const db = await openQueue(':memory:');
    importRows(db, parsePipeline(DOC), { now: NOW });
    const second = importRows(db, parsePipeline(DOC), { now: NOW });
    eq('importRows: re-running does not duplicate', allUrls(db).length, 4);
    eq('importRows: re-run reports zero newly inserted', second.inserted, 0);
    db.close();
  }

  // A row that has since been evaluated must NOT be dragged back to `new` by a
  // re-import, or the migration would resurrect finished work.
  {
    const db = await openQueue(':memory:');
    importRows(db, parsePipeline(DOC), { now: NOW });
    db.exec("UPDATE jobs SET queue_status = 'evaluated' WHERE canonical_url LIKE '%jobs/1%'");
    importRows(db, parsePipeline(DOC), { now: NOW });
    eq('importRows: never downgrades an evaluated row back to new',
      db.prepare("SELECT queue_status FROM jobs WHERE canonical_url LIKE '%jobs/1%'").get().queue_status,
      'evaluated');
    db.close();
  }

  // Code review (High): a blanket "never touch an existing row" is too blunt. If
  // a scanner already inserted a URL as `new` (pre-gate, no decision made) and
  // the legacy file says it was archived as non-US, the archive verdict is a
  // REAL decision and must win — otherwise the migration silently re-queues a
  // job a human already rejected. `new` is the only state safe to overwrite.
  {
    const db = await openQueue(':memory:');
    upsertJobs(db, [{ url: 'https://boards.greenhouse.io/acme/jobs/3', company: 'Acme' }], { now: NOW });
    importRows(db, parsePipeline(DOC), { now: NOW });
    const r = db.prepare("SELECT * FROM jobs WHERE canonical_url LIKE '%jobs/3%'").get();
    eq('importRows: legacy archive verdict overrides an existing pre-gate `new` row', r.queue_status, 'skipped');
    eq('importRows: ...and records why', r.skip_reason, 'archived: Non-US');
    db.close();
  }

  // ...but a row that has PROGRESSED past `new` reflects work already done, so
  // the legacy file must never roll it back.
  {
    const db = await openQueue(':memory:');
    upsertJobs(db, [{ url: 'https://boards.greenhouse.io/acme/jobs/3', company: 'Acme' }], { now: NOW });
    db.exec("UPDATE jobs SET queue_status = 'in_progress' WHERE canonical_url LIKE '%jobs/3%'");
    importRows(db, parsePipeline(DOC), { now: NOW });
    eq('importRows: does not roll back a row already in_progress',
      db.prepare("SELECT queue_status FROM jobs WHERE canonical_url LIKE '%jobs/3%'").get().queue_status,
      'in_progress');
    db.close();
  }

  // A URL the scanners already wrote (via upsertJobs) must be recognised as the
  // same job, not inserted twice under a tracking-param variant.
  {
    const db = await openQueue(':memory:');
    upsertJobs(db, [{ url: 'https://boards.greenhouse.io/acme/jobs/1?utm_source=x', company: 'Acme' }], { now: NOW });
    importRows(db, parsePipeline(DOC), { now: NOW });
    eq('importRows: canonicalizes, so a tracking-param variant is one row', allUrls(db).length, 4);
    db.close();
  }

}

// ── the CLI write path ──────────────────────────────────────────────────────
//
// The unit tests above call importRows directly, so they cannot catch a break in
// main() itself — and one happened: removing a helper left a dangling call that
// every test still passed through. --dry-run returns before the write, so this
// drives the REAL write path end to end against a throwaway workspace.
{
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'queue-migrate.mjs');
  const work = mkdtempSync(join(tmpdir(), 'queue-migrate-cli-'));
  try {
    // A broken CLI must report a clean failure, not abort the whole suite and
    // hide every assertion after it.
    mkdirSync(join(work, 'data'), { recursive: true });
    writeFileSync(join(work, 'data', 'pipeline.md'), DOC);
    const dbPath = join(work, 'data', 'queue.db');
    const out = execFileSync('node', [script], {
      encoding: 'utf-8', timeout: 30000, cwd: work,
      env: { ...process.env, CAREER_OPS_QUEUE_DB: dbPath },
    });
    T('queue-migrate CLI: writes the queue and reports the pending count',
      /queue now holds 4 rows, 1 awaiting the gate/.test(out));

    // Re-running must be a no-op, not a second copy.
    const again = execFileSync('node', [script], {
      encoding: 'utf-8', timeout: 30000, cwd: work,
      env: { ...process.env, CAREER_OPS_QUEUE_DB: dbPath },
    });
    T('queue-migrate CLI: a second run inserts nothing', /inserted 0, already present 4/.test(again));

    const dry = execFileSync('node', [script, '--dry-run'], {
      encoding: 'utf-8', timeout: 30000, cwd: work,
      env: { ...process.env, CAREER_OPS_QUEUE_DB: dbPath },
    });
    T('queue-migrate CLI: --dry-run writes nothing', /--dry-run: nothing written/.test(dry));
  } catch (err) {
    fail('queue-migrate CLI', String(err?.stderr || err?.message || err).slice(0, 400));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await dbTests();
