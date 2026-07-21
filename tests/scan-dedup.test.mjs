/**
 * scan-dedup.test.mjs — URL dedup normalization (#2065).
 *
 * The bug: loadSeenUrls() and its consumers dedup on EXACT URL string equality,
 * so a cosmetic variation (a ?language=en locale suffix, a utm_* tracking param,
 * a trailing slash) defeats dedup and re-emits an already-processed role. Real
 * impact: a 2026-07-20 personio scan re-emitted 11 already-seen 1Komma5° roles
 * whose history rows carried ?language=en while the provider now builds the bare
 * canonical URL.
 *
 * The fix: loadSeenUrls returns a canonicalizing set — every add() and has() runs
 * the URL through queue.mjs's canonicalizeUrl (the shared dedup key) — so any
 * cosmetic variant of a seen URL is treated as seen. loadQueueSeenUrls folds the
 * SQLite queue in as an additional dedup source (a no-op when the DB is absent).
 *
 * loadSeenUrls reads data/scan-history.tsv relative to cwd, so these tests build
 * a temp workspace and chdir into it.
 *
 * Run: node tests/scan-dedup.test.mjs  (or via test-all.mjs)
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { pass, fail } from './helpers.mjs';

const T = (label, cond) => (cond ? pass(label) : fail(label, 'assertion failed'));

const SCAN_MJS = pathToFileURL(join(process.cwd(), 'scan.mjs')).href;
const QUEUE_MJS = pathToFileURL(join(process.cwd(), 'queue.mjs')).href;

const origCwd = process.cwd();
const work = mkdtempSync(join(tmpdir(), 'scan-dedup-'));
mkdirSync(join(work, 'data'), { recursive: true });

// A scan-history.tsv whose personio row was recorded WITH the ?language=en
// suffix (as agent-driven scans / the old feed path did), plus a Costco row
// recorded with ?lang=en-us. The provider now emits the bare form.
const HISTORY =
  'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n' +
  'https://acme.jobs.personio.com/job/2670127?language=en\t2026-07-06\tpersonio-api\tPM\tAcme\tadded\tRemote\n' +
  'https://careers.costco.com/jobs/28927?lang=en-us\t2026-07-06\tworkday-api\tAnalyst 1\tCostco\tadded\tSan Diego\n';
writeFileSync(join(work, 'data', 'scan-history.tsv'), HISTORY);

async function main() {
  process.chdir(work);
  const { loadSeenUrls, loadQueueSeenUrls } = await import(SCAN_MJS);
  const { openQueue, upsertJobs } = await import(QUEUE_MJS);

  // ── #2065 core: a locale-suffixed history row makes the bare URL "seen" ─────
  const { seen } = loadSeenUrls();
  T('loadSeenUrls: bare personio URL matches a ?language=en history row (#2065)',
    seen.has('https://acme.jobs.personio.com/job/2670127'));
  T('loadSeenUrls: bare Costco URL matches a ?lang=en-us history row (#2065)',
    seen.has('https://careers.costco.com/jobs/28927'));
  T('loadSeenUrls: a DIFFERENT personio job id is NOT falsely deduped (no collision)',
    !seen.has('https://acme.jobs.personio.com/job/9999999'));

  // ── the returned set canonicalizes on BOTH add and has ─────────────────────
  T('loadSeenUrls: has() ignores a utm_* tracking param on a seen URL',
    seen.has('https://acme.jobs.personio.com/job/2670127?utm_source=linkedin'));
  seen.add('https://job-boards.greenhouse.io/acme/jobs/555');
  T('loadSeenUrls set: add() then has() a trailing-slash variant matches',
    seen.has('https://job-boards.greenhouse.io/acme/jobs/555/'));
  T('loadSeenUrls set: preserves the identifying ?gh_jid param (distinct jobs stay distinct)',
    (seen.add('https://x.io/e?gh_jid=1'),
      seen.has('https://x.io/e?gh_jid=1') && !seen.has('https://x.io/e?gh_jid=2')));

  // ── queue-folding: the SQLite queue is an additional dedup source ──────────
  // Absent DB → no-op (and must NOT create an empty DB as a side effect).
  const dbPath = join(work, 'data', 'queue.db');
  const before = loadSeenUrls().seen;
  await loadQueueSeenUrls(before, { dbPath });
  T('loadQueueSeenUrls: no-op when the queue DB does not exist',
    !before.has('https://queued.example.com/jobs/77'));
  // openQueue() CREATEs on a missing path, so a read-only dedup load must guard
  // on existence — assert it did not bring a DB into being as a side effect.
  T('loadQueueSeenUrls: does NOT create the queue DB as a side effect',
    !existsSync(dbPath));

  // Present DB → its canonical URLs are folded in.
  const db = await openQueue(dbPath);
  upsertJobs(db, [{ url: 'https://queued.example.com/jobs/77?utm_source=x', company: 'Q', title: 'Eng' }]);
  db.close();
  const withDb = loadSeenUrls().seen;
  await loadQueueSeenUrls(withDb, { dbPath });
  T('loadQueueSeenUrls: folds a queued job URL into the seen set',
    withDb.has('https://queued.example.com/jobs/77'));
  T('loadQueueSeenUrls: folded URL is canonicalized (tracking-param variant matches)',
    withDb.has('https://queued.example.com/jobs/77?utm_source=other'));
}

main()
  .catch((err) => { fail('scan-dedup suite', err?.stack || String(err)); })
  .finally(() => {
    process.chdir(origCwd);
    rmSync(work, { recursive: true, force: true });
  });
