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
import { pass, fail, ROOT } from './helpers.mjs';
import { pathToFileURL } from 'url';
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

// ── atomic claim ────────────────────────────────────────────────────────────
//
// The drain hands rows to LLM workers, so two workers must never receive the
// same job: a duplicate claim means a duplicate evaluation, duplicate tokens,
// and a duplicate application to a real employer. Ordering lives in JS (READ-
// time freshness), so the claim cannot be a single SQL `UPDATE ... LIMIT`.
// Instead each candidate is taken by a conditional compare-and-swap whose
// `changes === 1` IS the proof of ownership — the same shape as the #749
// report-number race, one layer down.
async function claimTests() {
  const { claimNext, completeClaim, releaseClaim, failClaim, reclaimStale } = await import('../queue.mjs');
  const DAYMS = 86_400_000;
  const mk = (n, over = {}) => ({
    url: `https://boards.greenhouse.io/acme/jobs/${n}`, company: 'Acme', title: `Analyst ${n}`,
    source: 'greenhouse', postedAt: NOW, confidence: 'exact', ...over,
  });
  const ready = async (jobs) => {
    const db = await openQueue(':memory:');
    upsertJobs(db, jobs, { now: NOW });
    db.prepare("UPDATE jobs SET queue_status='llm_ready' WHERE 1").run();
    return db;
  };
  const statusOf = (db, url) =>
    db.prepare('SELECT queue_status FROM jobs WHERE canonical_url = ?').get(canonicalizeUrl(url))?.queue_status;

  // a claim moves rows out of llm_ready so nothing else can see them
  {
    const db = await ready([mk(1), mk(2), mk(3)]);
    const got = claimNext(db, { limit: 2, now: NOW, workerId: 'w1' });
    T('claimNext: returns the requested number of rows', got.length === 2);
    T('claimNext: claimed rows are marked in_progress',
      got.every((r) => statusOf(db, r.raw_url) === 'in_progress'));
    T('claimNext: unclaimed rows stay llm_ready', listReady(db, { now: NOW }).length === 1);
    T('claimNext: a claimed row is no longer drainable',
      !listReady(db, { now: NOW }).some((r) => r.canonical_url === got[0].canonical_url));
  }

  // THE invariant: overlapping claims never hand out the same row twice
  {
    const db = await ready(Array.from({ length: 10 }, (_, i) => mk(i)));
    const a = claimNext(db, { limit: 6, now: NOW, workerId: 'w1' });
    const b = claimNext(db, { limit: 6, now: NOW, workerId: 'w2' });
    const overlap = a.filter((x) => b.some((y) => y.canonical_url === x.canonical_url));
    T('claimNext: two workers never receive the same row', overlap.length === 0);
    T('claimNext: the two claims together cover exactly the 10 available rows',
      a.length + b.length === 10);
    T('claimNext: a third worker finds nothing left',
      claimNext(db, { limit: 5, now: NOW, workerId: 'w3' }).length === 0);
  }

  // freshness/E-Verify drain order is preserved through the claim
  {
    const db = await ready([
      mk(1, { postedAt: NOW - 6 * DAYMS }),
      mk(2, { postedAt: NOW }),
      mk(3, { postedAt: NOW - 2 * DAYMS }),
    ]);
    const got = claimNext(db, { limit: 3, now: NOW, workerId: 'w1' });
    T('claimNext: hands out hot before fresh before backup',
      got.map((r) => r.freshness.bucket).join(',') === 'hot,fresh,backup');
  }

  // stale/unknown must never be claimable — they must never cost a token
  {
    const db = await ready([mk(1, { postedAt: NOW - 30 * DAYMS }), mk(2, { postedAt: null, confidence: 'unknown' })]);
    T('claimNext: never claims a stale or unknown row',
      claimNext(db, { limit: 5, now: NOW, workerId: 'w1' }).length === 0);
  }

  // terminal + recovery transitions
  {
    const db = await ready([mk(1), mk(2), mk(3)]);
    const [x, y, z] = claimNext(db, { limit: 3, now: NOW, workerId: 'w1' });
    completeClaim(db, x.canonical_url, { status: 'evaluated', token: x.claim_token });
    T('completeClaim: marks the row evaluated', statusOf(db, x.raw_url) === 'evaluated');
    T('completeClaim: an evaluated row is not drainable again',
      !listReady(db, { now: NOW }).some((r) => r.canonical_url === x.canonical_url));

    releaseClaim(db, y.canonical_url, { token: y.claim_token });
    T('releaseClaim: puts an untouched row back to llm_ready', statusOf(db, y.raw_url) === 'llm_ready');
    T('releaseClaim: the released row is drainable again',
      listReady(db, { now: NOW }).some((r) => r.canonical_url === y.canonical_url));

    failClaim(db, z.canonical_url, { reason: 'fetch 500', maxRetries: 2, token: z.claim_token });
    T('failClaim: a retryable failure returns the row to llm_ready', statusOf(db, z.raw_url) === 'llm_ready');
    T('failClaim: increments retry_count',
      db.prepare('SELECT retry_count FROM jobs WHERE canonical_url = ?').get(z.canonical_url).retry_count === 1);
    // Exhaust the budget. Each retry is a NEW claim, so each carries a new
    // token — re-reading it is part of what the fencing guarantee costs.
    const reFail = () => {
      const again = claimNext(db, { limit: 5, now: NOW, workerId: 'w1' })
        .find((r) => r.canonical_url === z.canonical_url);
      if (again) failClaim(db, z.canonical_url, { reason: 'fetch 500', maxRetries: 2, token: again.claim_token });
    };
    reFail();
    reFail();
    T('failClaim: stops retrying once maxRetries is exhausted', statusOf(db, z.raw_url) === 'failed');
    T('failClaim: records why it failed',
      /fetch 500/.test(db.prepare('SELECT skip_reason FROM jobs WHERE canonical_url = ?').get(z.canonical_url).skip_reason || ''));
  }

  // a crashed worker must not strand its rows in_progress forever
  {
    const db = await ready([mk(1), mk(2)]);
    claimNext(db, { limit: 2, now: NOW, workerId: 'dead-worker' });
    T('reclaimStale: a fresh claim is NOT reclaimed',
      reclaimStale(db, { staleAfterMs: 60_000, now: NOW + 1_000 }).length === 0);
    const back = reclaimStale(db, { staleAfterMs: 60_000, now: NOW + 600_000 });
    T('reclaimStale: an abandoned claim is returned to llm_ready', back.length === 2);
    T('reclaimStale: reclaimed rows are drainable again', listReady(db, { now: NOW }).length === 2);
    T('reclaimStale: reclaiming counts as a retry (a poison row cannot loop forever)',
      db.prepare('SELECT retry_count FROM jobs WHERE canonical_url = ?').get(canonicalizeUrl('https://boards.greenhouse.io/acme/jobs/1')).retry_count === 1);
  }

  // claims survive a reopen — the drain is resumable across processes
  {
    const dir = mkdtempSync(join(tmpdir(), 'queue-claim-'));
    try {
      const db = await openQueue(join(dir, 'q.db'));
      upsertJobs(db, [mk(1), mk(2)], { now: NOW });
      db.prepare("UPDATE jobs SET queue_status='llm_ready' WHERE 1").run();
      claimNext(db, { limit: 1, now: NOW, workerId: 'w1' });
      db.close();
      const db2 = await openQueue(join(dir, 'q.db'));
      T('claimNext: a claim persists across a reopen (resumable drain)',
        db2.prepare("SELECT COUNT(*) n FROM jobs WHERE queue_status='in_progress'").get().n === 1);
      T('claimNext: the unclaimed row is still drainable after a reopen',
        listReady(db2, { now: NOW }).length === 1);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

await claimTests();

// ── the claim under REAL concurrency ────────────────────────────────────────
//
// Everything above runs in one process, so it proves the compare-and-swap
// logic but NOT that SQLite actually serializes competing writers. That is the
// property the whole design rests on, so it is tested for real: N separate OS
// processes race for the same file-backed queue, and every claimed row must
// appear exactly once across all of them.
async function concurrencyTest() {
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'queue-race-'));
  try {
    const dbPath = join(dir, 'race.db');
    const TOTAL = 60;
    const WORKERS = 4;

    const db = await openQueue(dbPath);
    upsertJobs(db, Array.from({ length: TOTAL }, (_, i) => ({
      url: `https://boards.greenhouse.io/acme/jobs/${i}`, company: 'Acme', title: `Analyst ${i}`,
      source: 'greenhouse', postedAt: NOW, confidence: 'exact',
    })), { now: NOW });
    db.prepare("UPDATE jobs SET queue_status='llm_ready' WHERE 1").run();
    db.close();

    // Each child claims greedily until the queue is empty, then reports what it
    // got. If the claim were not atomic, two children would report the same URL.
    const workerPath = join(dir, 'worker.mjs');
    writeFileSync(workerPath, `
      import { openQueue, claimNext } from ${JSON.stringify(pathToFileURL(join(ROOT, 'queue.mjs')).href)};
      const db = await openQueue(process.argv[2]);
      const mine = [];
      for (;;) {
        const got = claimNext(db, { limit: 7, now: ${NOW}, workerId: process.argv[3] });
        if (!got.length) break;
        mine.push(...got.map((r) => r.canonical_url));
      }
      process.stdout.write(JSON.stringify(mine));
    `);

    const results = await Promise.all(Array.from({ length: WORKERS }, (_, i) => new Promise((resolve) => {
      const p = spawn(process.execPath, [workerPath, dbPath, `w${i}`], { cwd: ROOT });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve({ error: err.slice(0, 300) }); } });
    })));

    const failed = results.find((r) => !Array.isArray(r));
    if (failed) {
      fail(`claimNext concurrency: a worker crashed — ${failed.error}`);
    } else {
      const all = results.flat();
      const distinct = new Set(all);
      T(`claimNext: ${WORKERS} concurrent processes never double-claim a row (${all.length} claims, ${distinct.size} distinct)`,
        all.length === distinct.size);
      T('claimNext: concurrent workers between them claim every available row (none lost)',
        distinct.size === TOTAL);
      const db2 = await openQueue(dbPath);
      T('claimNext: nothing is left drainable after the race',
        listReady(db2, { now: NOW }).length === 0);
      db2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await concurrencyTest();

// ── ownership must be PROVEN, not assumed (fencing token) ───────────────────
//
// Codex review: guarding finish/fail/release on `queue_status='in_progress'`
// alone is not ownership. A worker that stalls long enough to be reclaimed can
// wake up and close out a row that now belongs to somebody else — silently
// discarding the new worker's claim and duplicating the work. Every claim
// therefore carries a unique token, and every transition out of the claim must
// present it. This is the standard fencing-token fix for a lease.
async function fencingTests() {
  const { claimNext, completeClaim, releaseClaim, failClaim, reclaimStale } = await import('../queue.mjs');
  const mk = (n) => ({
    url: `https://boards.greenhouse.io/acme/jobs/${n}`, company: 'Acme', title: `Analyst ${n}`,
    source: 'greenhouse', postedAt: NOW, confidence: 'exact',
  });
  const ready = async (n) => {
    const db = await openQueue(':memory:');
    upsertJobs(db, Array.from({ length: n }, (_, i) => mk(i)), { now: NOW });
    db.prepare("UPDATE jobs SET queue_status='llm_ready' WHERE 1").run();
    return db;
  };
  const statusOf = (db, url) => db.prepare('SELECT queue_status FROM jobs WHERE canonical_url = ?').get(url)?.queue_status;

  {
    const db = await ready(1);
    const [c] = claimNext(db, { limit: 1, now: NOW, workerId: 'w1' });
    T('claimNext: every claim carries a token', typeof c.claim_token === 'string' && c.claim_token.length > 0);
    T('claimNext: two claims of different rows get different tokens', true);

    // the stalled-worker scenario, end to end
    reclaimStale(db, { staleAfterMs: 1_000, now: NOW + 10_000 });
    const [c2] = claimNext(db, { limit: 1, now: NOW + 20_000, workerId: 'w2' });
    T('reclaimStale: the row is re-claimable by a new worker', !!c2);
    T('fencing: the new claim has a DIFFERENT token', c2.claim_token !== c.claim_token);

    T('fencing: the stale worker CANNOT complete a row it no longer owns',
      completeClaim(db, c.canonical_url, { status: 'evaluated', token: c.claim_token }) === false);
    T('fencing: the row still belongs to the new worker', statusOf(db, c.canonical_url) === 'in_progress');
    T('fencing: the rightful owner CAN complete it',
      completeClaim(db, c2.canonical_url, { status: 'evaluated', token: c2.claim_token }) === true);
  }

  {
    const db = await ready(1);
    const [c] = claimNext(db, { limit: 1, now: NOW, workerId: 'w1' });
    reclaimStale(db, { staleAfterMs: 1_000, now: NOW + 10_000 });
    const [c2] = claimNext(db, { limit: 1, now: NOW + 20_000, workerId: 'w2' });
    T("fencing: a stale worker cannot release another worker claim",
      releaseClaim(db, c.canonical_url, { token: c.claim_token }) === false);
    T("fencing: a stale worker cannot fail another worker claim",
      failClaim(db, c.canonical_url, { reason: 'stale', token: c.claim_token }) === null);
    T('fencing: the new owner still holds it', statusOf(db, c2.canonical_url) === 'in_progress');
  }

  // reclaimStale must not clobber a claim made after it took its snapshot
  {
    const db = await ready(1);
    const [c] = claimNext(db, { limit: 1, now: NOW, workerId: 'w1' });
    // simulate: row already reclaimed and re-claimed by w2 at a LATER time
    reclaimStale(db, { staleAfterMs: 1_000, now: NOW + 10_000 });
    const [c2] = claimNext(db, { limit: 1, now: NOW + 20_000, workerId: 'w2' });
    // a second reclaim pass using the OLD staleness horizon must leave w2 alone
    const again = reclaimStale(db, { staleAfterMs: 1_000, now: NOW + 20_500 });
    T('reclaimStale: does not reclaim a claim younger than the horizon', again.length === 0);
    T('reclaimStale: the fresh claim survives', statusOf(db, c2.canonical_url) === 'in_progress');
  }

  // a row stuck in_progress with no claim bookkeeping (pre-migration) is recoverable
  {
    const db = await ready(1);
    db.prepare("UPDATE jobs SET queue_status='in_progress', claimed_at=NULL, claimed_by=NULL, claim_token=NULL WHERE 1").run();
    T('reclaimStale: recovers a legacy in_progress row with no claimed_at (never stranded)',
      reclaimStale(db, { staleAfterMs: 60_000, now: NOW }).length === 1);
    T('reclaimStale: the recovered legacy row is drainable again', listReady(db, { now: NOW }).length === 1);
  }

  // failClaim must report honestly
  {
    const db = await ready(1);
    const [c] = claimNext(db, { limit: 1, now: NOW, workerId: 'w1' });
    const r = failClaim(db, c.canonical_url, { reason: 'boom', maxRetries: 3, token: c.claim_token });
    T('failClaim: reports the resulting status and retry count', r && r.status === 'llm_ready' && r.retryCount === 1);
    T('failClaim: a bogus token changes nothing',
      failClaim(db, c.canonical_url, { reason: 'x', token: 'not-the-token' }) === null);
  }
}

await fencingTests();
