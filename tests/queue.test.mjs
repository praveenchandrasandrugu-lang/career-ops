/**
 * queue.test.mjs — SQLite job queue (queue.mjs).
 *
 * The queue replaces the flat pipeline.md as the scanners' write target: every
 * discovered posting is upserted as a normalized row, dedup is a DB lookup, and
 * freshness is computed at READ time (never stored — a stored bucket rots as
 * `now` advances). pipeline.md becomes a rendered view.
 *
 * canonicalizeUrl is the dedup key and the single riskiest decision (code
 * review): it must strip tracking noise WITHOUT collapsing two distinct jobs
 * into one. So it strips a denylist of pure-tracking params and preserves
 * everything else (a Greenhouse embed keys the job on ?gh_jid=N — dropping the
 * whole query would be data loss). Host is lowercased (case-insensitive), the
 * PATH is not (company slugs and job ids are case-sensitive).
 *
 * Run: node tests/queue.test.mjs  (or via test-all.mjs)
 */
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail } from './helpers.mjs';
import { canonicalizeUrl, openQueue, upsertJobs, listReady, allUrls } from '../queue.mjs';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed reference so tests are deterministic

const T = (label, cond) => (cond ? pass(label) : fail(label, 'assertion failed'));
const eq = (label, got, want) => T(`${label}${got === want ? '' : ` (got ${got})`}`, got === want);

// ── host/scheme normalization ───────────────────────────────────────────────
eq('canonicalizeUrl: lowercases the host only',
  canonicalizeUrl('https://Boards.Greenhouse.IO/Acme/jobs/123'),
  'https://boards.greenhouse.io/Acme/jobs/123');
eq('canonicalizeUrl: forces https (http→https, same resource)',
  canonicalizeUrl('http://jobs.lever.co/acme/uuid-1'),
  'https://jobs.lever.co/acme/uuid-1');
eq('canonicalizeUrl: drops the fragment',
  canonicalizeUrl('https://jobs.ashbyhq.com/acme/uuid#apply'),
  'https://jobs.ashbyhq.com/acme/uuid');
eq('canonicalizeUrl: strips a single trailing slash',
  canonicalizeUrl('https://boards.greenhouse.io/acme/jobs/123/'),
  'https://boards.greenhouse.io/acme/jobs/123');

// ── tracking params stripped, identity preserved ────────────────────────────
eq('canonicalizeUrl: strips gh_src + utm_* (Greenhouse)',
  canonicalizeUrl('https://boards.greenhouse.io/Acme/jobs/123?gh_src=abc&utm_medium=email'),
  'https://boards.greenhouse.io/Acme/jobs/123');
eq('canonicalizeUrl: strips lever-origin + utm (Lever)',
  canonicalizeUrl('https://jobs.lever.co/acme/uuid-1?lever-origin=applied&utm_source=x'),
  'https://jobs.lever.co/acme/uuid-1');
eq('canonicalizeUrl: strips utm params on Workday',
  canonicalizeUrl('https://acme.wd1.myworkdayjobs.com/en-US/careers/job/NY/Analyst_R1?utm_source=LinkedIn'),
  'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/NY/Analyst_R1');
eq('canonicalizeUrl: PRESERVES an ambiguous param (?source) — could be a direct-site job id (collision-safe)',
  canonicalizeUrl('https://careers.example.com/job?source=42'),
  'https://careers.example.com/job?source=42');
eq('canonicalizeUrl: PRESERVES an id-bearing param (gh_jid), drops only tracking',
  canonicalizeUrl('https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=42&utm_source=x'),
  'https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=42');
eq('canonicalizeUrl: sorts remaining params for a stable key',
  canonicalizeUrl('https://boards.greenhouse.io/embed/job_app?gh_jid=42&for=acme'),
  'https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=42');

// ── locale suffixes are display-only, never job identity (#2065) ─────────────
// A personio posting served as ?language=en and the bare canonical form are the
// same job; a locale param must not defeat dedup.
eq('canonicalizeUrl: strips ?language= locale suffix (#2065 personio case)',
  canonicalizeUrl('https://acme.jobs.personio.com/job/2670127?language=en'),
  'https://acme.jobs.personio.com/job/2670127');
eq('canonicalizeUrl: strips ?lang= locale suffix',
  canonicalizeUrl('https://careers.example.com/jobs/123?lang=de'),
  'https://careers.example.com/jobs/123');
eq('canonicalizeUrl: strips ?locale= suffix',
  canonicalizeUrl('https://careers.example.com/jobs/123?locale=fr_FR'),
  'https://careers.example.com/jobs/123');
T('canonicalizeUrl: same job in two display languages dedups equal (#2065)',
  canonicalizeUrl('https://acme.jobs.personio.com/job/2670127?language=en')
  === canonicalizeUrl('https://acme.jobs.personio.com/job/2670127?language=de'));
eq('canonicalizeUrl: strips locale alongside a preserved id param',
  canonicalizeUrl('https://careers.costco.com/jobs/28927?lang=en-us'),
  'https://careers.costco.com/jobs/28927');
eq('canonicalizeUrl: strips a subtagged locale (zh-Hans)',
  canonicalizeUrl('https://careers.example.com/jobs/123?locale=zh-Hans'),
  'https://careers.example.com/jobs/123');

// Collision safety: a locale-NAMED param carrying a non-locale VALUE is real
// data (a ?lang=java skills filter), not a display language. Stripping it would
// collapse two distinct postings — the one failure mode this canonicalizer
// refuses to risk. Only locale-SHAPED values (en, en-us, fr_FR) are dropped.
eq('canonicalizeUrl: PRESERVES ?lang= when the value is not locale-shaped (?lang=java)',
  canonicalizeUrl('https://careers.example.com/jobs?lang=java'),
  'https://careers.example.com/jobs?lang=java');
T('canonicalizeUrl: ?lang=java and ?lang=python stay distinct (no collision)',
  canonicalizeUrl('https://careers.example.com/jobs?lang=java')
  !== canonicalizeUrl('https://careers.example.com/jobs?lang=python'));

// ── collision safety: distinct jobs must NEVER collapse ─────────────────────
T('canonicalizeUrl: two different gh_jid stay distinct (no collision)',
  canonicalizeUrl('https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=1')
  !== canonicalizeUrl('https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=2'));
T('canonicalizeUrl: same job via different tracking params dedups equal',
  canonicalizeUrl('https://jobs.lever.co/acme/uuid-1?utm_source=a')
  === canonicalizeUrl('https://jobs.lever.co/acme/uuid-1?utm_source=b'));

// ── robustness ──────────────────────────────────────────────────────────────
eq('canonicalizeUrl: trims surrounding whitespace',
  canonicalizeUrl('  https://jobs.lever.co/acme/uuid-1  '),
  'https://jobs.lever.co/acme/uuid-1');
eq('canonicalizeUrl: unparseable input returns trimmed original (never throws)',
  canonicalizeUrl('not a url'),
  'not a url');
eq('canonicalizeUrl: null/undefined → empty string',
  canonicalizeUrl(null), '');

// ── DB layer: upsert, dedup, and READ-TIME freshness ────────────────────────
async function dbTests() {
  const job = (over = {}) => ({
    url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'Data Analyst',
    source: 'greenhouse', postedAt: NOW, confidence: 'exact', ...over,
  });

  // upsert inserts; re-upsert of the same canonical URL updates, never duplicates
  {
    const db = await openQueue(':memory:');
    const r1 = upsertJobs(db, [job()], { now: NOW });
    T('upsertJobs: first upsert inserts one row', r1.inserted === 1 && r1.updated === 0);
    // same job, different tracking param → same canonical URL → update, not insert
    const r2 = upsertJobs(db, [job({ url: 'https://boards.greenhouse.io/acme/jobs/1?utm_source=x' })], { now: NOW + DAY });
    T('upsertJobs: re-upsert of same canonical URL updates (no duplicate)', r2.inserted === 0 && r2.updated === 1);
    T('upsertJobs: dedup keeps exactly one row', allUrls(db).length === 1);
  }

  // upsert preserves first_seen_at and gate statuses across re-scan
  {
    const db = await openQueue(':memory:');
    upsertJobs(db, [job()], { now: NOW });
    db.prepare("UPDATE jobs SET everify_status='enrolled', queue_status='llm_ready' WHERE 1").run();
    upsertJobs(db, [job({ title: 'Senior Data Analyst' })], { now: NOW + 5 * DAY });
    const row = db.prepare('SELECT * FROM jobs').get();
    T('upsertJobs: re-scan preserves first_seen_at', row.first_seen_at === NOW);
    T('upsertJobs: re-scan bumps last_seen_at', row.last_seen_at === NOW + 5 * DAY);
    T('upsertJobs: re-scan preserves gate status (everify)', row.everify_status === 'enrolled');
    T('upsertJobs: re-scan refreshes changed title', row.title === 'Senior Data Analyst');
  }

  // an unknown-dated re-scan must NOT erase a previously-known exact date
  {
    const db = await openQueue(':memory:');
    upsertJobs(db, [job({ postedAt: NOW, confidence: 'exact' })], { now: NOW });
    upsertJobs(db, [job({ postedAt: null, confidence: 'unknown' })], { now: NOW + DAY });
    const row = db.prepare('SELECT * FROM jobs').get();
    T('upsertJobs: an unknown-dated re-scan does NOT erase a known exact date',
      row.posted_at === NOW && row.posted_at_confidence === 'exact');
    upsertJobs(db, [job({ postedAt: NOW + 2 * DAY, confidence: 'exact' })], { now: NOW + 2 * DAY });
    T('upsertJobs: a genuinely newer exact date DOES update',
      db.prepare('SELECT posted_at FROM jobs').get().posted_at === NOW + 2 * DAY);
  }

  // date-trust guard: an incoming date only wins when usable AND >= existing trust
  {
    const db = await openQueue(':memory:');
    upsertJobs(db, [job({ postedAt: NOW, confidence: 'exact' })], { now: NOW });
    // exact CLAIM but null date → effectively unknown → must NOT erase the date
    upsertJobs(db, [job({ postedAt: null, confidence: 'exact' })], { now: NOW + DAY });
    T('upsertJobs: an exact-claim re-scan with a null date does NOT erase the known date',
      db.prepare('SELECT posted_at FROM jobs').get().posted_at === NOW);
    // lower_bound is weaker than exact → must NOT overwrite
    upsertJobs(db, [job({ postedAt: NOW - 30 * DAY, confidence: 'lower_bound' })], { now: NOW + DAY });
    const row = db.prepare('SELECT * FROM jobs').get();
    T('upsertJobs: a lower_bound re-scan does NOT overwrite a known exact date',
      row.posted_at === NOW && row.posted_at_confidence === 'exact');
  }
  // invariant: an 'unknown' confidence never keeps a stored date — an untrusted
  // date is meaningless (freshness ignores it), and storing it would let an
  // equal-rank unknown re-scan later NULL out a real one.
  {
    const db = await openQueue(':memory:');
    upsertJobs(db, [job({ postedAt: NOW, confidence: 'unknown' })], { now: NOW });
    T('upsertJobs: unknown confidence stores a NULL date (posted_at IS NULL ⟺ unknown)',
      db.prepare('SELECT posted_at FROM jobs').get().posted_at === null);
  }

  // a lower_bound DOES fill a previously-unknown date (a floor beats nothing)
  {
    const db = await openQueue(':memory:');
    upsertJobs(db, [job({ postedAt: null, confidence: 'unknown' })], { now: NOW });
    upsertJobs(db, [job({ postedAt: NOW - 10 * DAY, confidence: 'lower_bound' })], { now: NOW + DAY });
    const row = db.prepare('SELECT * FROM jobs').get();
    T('upsertJobs: a lower_bound fills a previously-unknown date',
      row.posted_at === NOW - 10 * DAY && row.posted_at_confidence === 'lower_bound');
  }

  // malformed confidence must be coerced, never blow up the batch on the CHECK
  {
    const db = await openQueue(':memory:');
    let ok = true;
    try { upsertJobs(db, [job({ confidence: "exact','relative_exact" })], { now: NOW }); } catch { ok = false; }
    T('upsertJobs: malformed confidence does not throw / roll back the batch', ok);
    T('upsertJobs: malformed confidence is coerced to unknown',
      db.prepare('SELECT posted_at_confidence FROM jobs').get().posted_at_confidence === 'unknown');
  }

  // listReady drains ONLY llm_ready (gate-promoted) rows; freshness at READ time
  {
    const db = await openQueue(':memory:');
    upsertJobs(db, [job({ postedAt: NOW, confidence: 'exact' })], { now: NOW });
    T('listReady: a NEW (pre-gate) row is NOT drained — only llm_ready reaches an LLM',
      listReady(db, { now: NOW }).length === 0);
    db.prepare("UPDATE jobs SET queue_status='llm_ready' WHERE 1").run();
    const readNow = listReady(db, { now: NOW });
    T('listReady: an llm_ready job posted today is sendable now (hot)',
      readNow.length === 1 && readNow[0].freshness.bucket === 'hot');
    // NOTHING re-written — only `now` advances 10 days past the same stored row
    T('listReady: the SAME row is stale (excluded) 10 days later — freshness is read-time, not stored',
      listReady(db, { now: NOW + 10 * DAY }).length === 0);
  }

  // listReady excludes undated (even when llm_ready) and terminal-status rows
  {
    const db = await openQueue(':memory:');
    upsertJobs(db, [job({ url: 'https://x/1', postedAt: null, confidence: 'unknown' })], { now: NOW });
    upsertJobs(db, [job({ url: 'https://x/2', postedAt: NOW, confidence: 'exact' })], { now: NOW });
    db.prepare("UPDATE jobs SET queue_status='llm_ready' WHERE canonical_url='https://x/1'").run(); // drainable but undated
    db.prepare("UPDATE jobs SET queue_status='evaluated' WHERE canonical_url='https://x/2'").run();  // dated but terminal
    const ready = listReady(db, { now: NOW });
    T('listReady: excludes an undated job even when llm_ready', !ready.some(r => r.canonical_url === 'https://x/1'));
    T('listReady: excludes an already-evaluated (terminal) job', !ready.some(r => r.canonical_url === 'https://x/2'));
  }

  // file-backed DB actually enables WAL (the :memory: cases can't exercise it)
  {
    const dir = mkdtempSync(join(tmpdir(), 'queue-'));
    try {
      const db = await openQueue(join(dir, 'q.db'));
      const mode = db.prepare('PRAGMA journal_mode').get();
      T('openQueue: file-backed DB uses WAL journal mode',
        String(Object.values(mode)[0]).toLowerCase() === 'wal');
      upsertJobs(db, [job()], { now: NOW });
      T('openQueue: file-backed upsert + read round-trips', allUrls(db).length === 1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

await dbTests();
