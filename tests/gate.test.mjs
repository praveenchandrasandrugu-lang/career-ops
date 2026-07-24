/**
 * gate.test.mjs — the zero-token promoter: queue_status 'new' → 'llm_ready' or
 * 'skipped' (gate.mjs).
 *
 * Nothing reaches an LLM until it clears this. The gates run cheapest-first so
 * each one shrinks the input to the next, and every one of them is free:
 *
 *   1. freshness  stale / undated never reaches an LLM (freshness.mjs policy)
 *   2. location   non-US is unworkable on F-1 STEM OPT
 *   3. level      Senior/Staff/Principal/Lead/Manager/Director/Fellow titles
 *
 * The asymmetry that governs every classifier here: a duplicate costs one wasted
 * look, a wrongly-skipped row costs a job. So `unknown` always PASSES. Only a
 * positive match on a disqualifying signal skips a row.
 *
 * Run: node tests/gate.test.mjs  (or via test-all.mjs)
 */
import { pass, fail } from './helpers.mjs';
import { openQueue, upsertJobs, listReady } from '../queue.mjs';
import { classifyLocation, classifyLocationDeep, classifyLevel, runGate } from '../gate.mjs';

const T = (label, cond) => (cond ? pass(label) : fail(label, 'assertion failed'));
const eq = (label, got, want) => T(`${label}${got === want ? '' : ` (got ${JSON.stringify(got)})`}`, got === want);

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 6, 20);

// ── location ────────────────────────────────────────────────────────────────
eq('classifyLocation: US state abbreviation', classifyLocation('JAMESTOWN, ND'), 'us');
eq('classifyLocation: mixed-case state abbreviation', classifyLocation('Denver, CO'), 'us');
eq('classifyLocation: spelled-out country', classifyLocation('Austin, United States'), 'us');
eq('classifyLocation: USA', classifyLocation('Remote - USA'), 'us');
eq('classifyLocation: bare US (40 rows in the real corpus)', classifyLocation('US'), 'us');
eq('classifyLocation: US - Remote', classifyLocation('US - Remote (Any location)'), 'us');
eq('classifyLocation: full state name', classifyLocation('Minneapolis, Minnesota'), 'us');

// Two-letter state codes must be matched CASE-SENSITIVELY. Found by sampling
// real output: a case-insensitive match reads the Spanish "de" as Delaware and
// the English "in" as Indiana, so
// "Las Condes, Region Metropolitana de Valparaiso, Chile" was classified US.
// Real postings write state codes uppercase, so nothing is lost.
eq('classifyLocation: Spanish "de" is not Delaware',
  classifyLocation('Las Condes, Region Metropolitana de Valparaiso, Chile'), 'non_us');
eq('classifyLocation: "in" is not Indiana',
  classifyLocation('Working in Berlin, Germany'), 'non_us');

// City-level coverage, because a large share of real rows name only a city.
eq('classifyLocation: major US city', classifyLocation('San Francisco'), 'us');
eq('classifyLocation: another US city', classifyLocation('Los Angeles'), 'us');
eq('classifyLocation: major foreign city', classifyLocation('Bengaluru'), 'non_us');
eq('classifyLocation: foreign city with a diacritic', classifyLocation('Köln'), 'non_us');
eq('classifyLocation: Hyderabad', classifyLocation('Hyderabad'), 'non_us');
eq('classifyLocation: Pune with a site suffix', classifyLocation('Pune, Gera Commerzone SEZ'), 'non_us');
eq('classifyLocation: UK', classifyLocation('UK'), 'non_us');
// Canada is the likeliest non-US leak for a US-targeted search, so its major
// cities are covered by name (spotted in real drain output: "Calgary").
eq('classifyLocation: Calgary', classifyLocation('Calgary'), 'non_us');
eq('classifyLocation: Edmonton', classifyLocation('Edmonton'), 'non_us');

// An explicit country beats an ambiguous city name: San Jose exists in both
// California and Costa Rica, so the country decides. (San Jose is deliberately
// absent from the US city list for exactly this reason.)
eq('classifyLocation: country wins over an ambiguous city',
  classifyLocation('SAN JOSE, COSTA RICA'), 'non_us');
eq('classifyLocation: state wins for the US San Jose', classifyLocation('San Jose, CA'), 'us');

// Code review (High): a multi-location posting that offers a US site must pass.
// Skipping it is the expensive error — it costs a job the candidate could take.
eq('classifyLocation: a US city alongside a foreign one still passes',
  classifyLocation('London, UK / Boston'), 'us');
eq('classifyLocation: lowercase us in a multi-country remote posting',
  classifyLocation('Remote (us/canada)'), 'us');
eq('classifyLocation: U.S. with periods', classifyLocation('Remote - U.S./Canada'), 'us');

eq('classifyLocation: named foreign country', classifyLocation('Berlin, Germany'), 'non_us');
eq('classifyLocation: foreign country, uppercase', classifyLocation('SAN JOSE, COSTA RICA'), 'non_us');
eq('classifyLocation: ISO-ish country prefix', classifyLocation('IND-Pune-Smartworks'), 'non_us');
eq('classifyLocation: GB suffix', classifyLocation('London-GB'), 'non_us');

// The single most common Workday value is a count, not a place. It carries no
// information, so it must NOT be read as non-US — that would skip 1,000+ rows
// on no evidence.
eq('classifyLocation: a location COUNT is unknown, never non-US', classifyLocation('2 Locations'), 'unknown');
eq('classifyLocation: 31 Locations is unknown', classifyLocation('31 Locations'), 'unknown');
eq('classifyLocation: empty is unknown', classifyLocation(''), 'unknown');
eq('classifyLocation: bare Remote is unknown (could be anywhere)', classifyLocation('Remote'), 'unknown');

// A US city inside a multi-country string still proves a US option exists.
eq('classifyLocation: US signal anywhere in the string wins',
  classifyLocation('Home Working Kenya, Austin TX'), 'us');

// ── level ───────────────────────────────────────────────────────────────────
eq('classifyLevel: Senior is too senior', classifyLevel('Senior Data Engineer'), 'too_senior');
eq('classifyLevel: Sr. abbreviation', classifyLevel('Sr. Financial Analyst'), 'too_senior');
eq('classifyLevel: Sr without the dot', classifyLevel('Sr Product Manager'), 'too_senior');
eq('classifyLevel: Staff', classifyLevel('Staff Software Engineer'), 'too_senior');
eq('classifyLevel: Principal', classifyLevel('Principal Analyst'), 'too_senior');
eq('classifyLevel: Lead', classifyLevel('Lead Data Scientist'), 'too_senior');
eq('classifyLevel: Manager', classifyLevel('Product Manager'), 'too_senior');
eq('classifyLevel: Director', classifyLevel('Director of Analytics'), 'too_senior');
eq('classifyLevel: Head of', classifyLevel('Head of Data'), 'too_senior');
eq('classifyLevel: VP', classifyLevel('VP, Engineering'), 'too_senior');
eq('classifyLevel: Fellow', classifyLevel('Research Fellow'), 'too_senior');

eq('classifyLevel: plain analyst passes', classifyLevel('Business Analyst'), 'ok');
eq('classifyLevel: coordinator passes', classifyLevel('Operations Coordinator'), 'ok');
eq('classifyLevel: Analyst 1 passes', classifyLevel('Analyst 1 (San Diego)'), 'ok');
eq('classifyLevel: empty title passes (no evidence to skip on)', classifyLevel(''), 'ok');

// "Senior" is not always a seniority word. In healthcare it names the PATIENT
// population, and skipping those would throw away entry-level roles at exactly
// the health systems this search targets.
eq('classifyLevel: Senior Living is a population, not a level',
  classifyLevel('Senior Living Coordinator'), 'ok');
eq('classifyLevel: Senior Care likewise', classifyLevel('Senior Care Scheduler'), 'ok');
eq('classifyLevel: Senior Services likewise', classifyLevel('Senior Services Assistant'), 'ok');
// ...but a real seniority word elsewhere in the same title still counts.
eq('classifyLevel: Senior Living + Manager is still too senior',
  classifyLevel('Senior Living Program Manager'), 'too_senior');

// Code review (Medium): an explicit junior signal outranks an occupational
// noun. "Manager"/"Lead" name the FUNCTION in these titles, not the level, and
// killing them throws away exactly the entry-level roles this search wants.
eq('classifyLevel: Associate Product Manager is entry level',
  classifyLevel('Associate Product Manager'), 'ok');
eq('classifyLevel: an internship is entry level', classifyLevel('Product Manager Intern'), 'ok');
eq('classifyLevel: new-graduate programs', classifyLevel('Program Manager, New Graduate'), 'ok');
eq('classifyLevel: trainee', classifyLevel('Manager Trainee'), 'ok');
eq('classifyLevel: junior', classifyLevel('Junior Project Manager'), 'ok');
eq('classifyLevel: assistant to a manager', classifyLevel('Senior Care Manager Assistant'), 'ok');
eq('classifyLevel: New College Grad', classifyLevel('Systems Software Engineer, New College Grad 2026'), 'ok');

// ...but "Associate"/"Assistant" as a SENIORITY modifier still disqualifies.
eq('classifyLevel: Associate Director is still senior', classifyLevel('Associate Director, Data'), 'too_senior');
eq('classifyLevel: Assistant Vice President is still senior',
  classifyLevel('Assistant Vice President, Risk'), 'too_senior');

// Substring false positives that must NOT trip the matcher.
eq('classifyLevel: "Leadership" is not "Lead"', classifyLevel('Leadership Development Associate'), 'ok');
eq('classifyLevel: "Management" is not "Manager"', classifyLevel('Management Trainee'), 'ok');
eq('classifyLevel: "Directory" is not "Director"', classifyLevel('Directory Services Technician'), 'ok');

// ── runGate ─────────────────────────────────────────────────────────────────
const job = (over = {}) => ({
  url: `https://boards.greenhouse.io/acme/jobs/${over.id ?? 1}`,
  company: 'Acme', title: 'Business Analyst', location: 'Austin, TX',
  postedAt: NOW, confidence: 'exact', ...over,
});

async function seed(rows) {
  const db = await openQueue(':memory:');
  upsertJobs(db, rows, { now: NOW });
  for (const r of rows) {
    if (r.location != null) {
      db.prepare('UPDATE jobs SET location = ? WHERE raw_url = ?').run(r.location, r.url);
    }
  }
  return db;
}
const statusOf = (db, id) =>
  db.prepare('SELECT queue_status, skip_reason FROM jobs WHERE canonical_url LIKE ?').get(`%jobs/${id}%`);

async function gateTests() {
  // a clean, fresh, US, entry-level row is promoted
  {
    const db = await seed([job({ id: 1 })]);
    const res = runGate(db, { now: NOW });
    eq('runGate: promotes a clean row to llm_ready', statusOf(db, 1).queue_status, 'llm_ready');
    eq('runGate: counts the promotion', res.promoted, 1);
    db.close();
  }

  // each gate skips for its own recorded reason
  {
    const db = await seed([
      job({ id: 1 }),                                              // clean
      job({ id: 2, postedAt: NOW - 30 * DAY }),                    // stale
      job({ id: 3, postedAt: null, confidence: 'unknown' }),       // undated
      job({ id: 4, location: 'Berlin, Germany' }),                 // non-US
      job({ id: 5, title: 'Senior Data Engineer' }),               // too senior
    ]);
    runGate(db, { now: NOW });
    eq('runGate: promotes only the clean row', statusOf(db, 1).queue_status, 'llm_ready');
    eq('runGate: skips a stale row', statusOf(db, 2).skip_reason, 'stale');
    eq('runGate: skips an undated row', statusOf(db, 3).skip_reason, 'undated');
    eq('runGate: skips a non-US row', statusOf(db, 4).skip_reason, 'non-US');
    eq('runGate: skips a too-senior row', statusOf(db, 5).skip_reason, 'too senior');
    db.close();
  }

  // an unknown location is NOT a reason to skip
  {
    const db = await seed([job({ id: 6, location: '2 Locations' })]);
    runGate(db, { now: NOW });
    eq('runGate: an unknown location still promotes', statusOf(db, 6).queue_status, 'llm_ready');
    db.close();
  }

  // the gate owns only `new` rows: it must not re-judge finished work
  {
    const db = await seed([job({ id: 7 })]);
    db.exec("UPDATE jobs SET queue_status = 'evaluated' WHERE canonical_url LIKE '%jobs/7%'");
    const res = runGate(db, { now: NOW });
    eq('runGate: leaves an evaluated row alone', statusOf(db, 7).queue_status, 'evaluated');
    eq('runGate: reports nothing considered', res.considered, 0);
    db.close();
  }

  // re-running is a no-op: a promoted row is no longer `new`
  {
    const db = await seed([job({ id: 8 })]);
    runGate(db, { now: NOW });
    const second = runGate(db, { now: NOW });
    eq('runGate: a second pass considers nothing', second.considered, 0);
    eq('runGate: the row stays llm_ready', statusOf(db, 8).queue_status, 'llm_ready');
    db.close();
  }

  // gates are recorded on the row, not just acted on, so a later audit can say
  // which gate made the call without re-deriving it
  {
    const db = await seed([job({ id: 9, title: 'Senior Data Engineer' })]);
    runGate(db, { now: NOW });
    const r = db.prepare("SELECT level_status FROM jobs WHERE canonical_url LIKE '%jobs/9%'").get();
    eq('runGate: records the level verdict on the row', r.level_status, 'too_senior');
    db.close();
  }

  // Code review (Low): promoting must CLEAR a stale skip_reason, or a promoted
  // row reads as both queued and rejected.
  {
    const db = await seed([job({ id: 11 })]);
    db.exec("UPDATE jobs SET skip_reason = 'non-US' WHERE canonical_url LIKE '%jobs/11%'");
    runGate(db, { now: NOW });
    const r = statusOf(db, 11);
    eq('runGate: promoting clears a stale skip_reason', r.skip_reason, null);
    eq('runGate: ...and the row is llm_ready', r.queue_status, 'llm_ready');
    db.close();
  }

  // Code review (Medium): upsertJobs is the scanners' write path, so it must
  // persist location — otherwise every scanner-written row reaches the location
  // gate blank and a foreign posting is promoted.
  {
    const db = await openQueue(':memory:');
    upsertJobs(db, [{ url: 'https://boards.greenhouse.io/acme/jobs/13', title: 'Business Analyst',
      location: 'Berlin, Germany', postedAt: NOW, confidence: 'exact' }], { now: NOW });
    runGate(db, { now: NOW });
    eq('upsertJobs: persists location so the gate can judge it',
      statusOf(db, 13).skip_reason, 'non-US');
    db.close();
  }

  // E-Verify RANKS, it never skips. The USCIS export lists only enrolled
  // employers, so a miss proves a name mismatch (brand vs legal name), not
  // non-enrollment — skipping on it would drop workable employers.
  {
    const db = await seed([job({ id: 14, company: 'Walmart' }), job({ id: 15, company: 'Nonexistent Widgets' })]);
    const lookup = new Map([
      ['Walmart', { status: 'enrolled', employer: 'WALMART INC' }],
      ['Nonexistent Widgets', { status: 'not_found' }],
    ]);
    runGate(db, { now: NOW, everify: lookup });
    eq('runGate: an enrolled employer is promoted', statusOf(db, 14).queue_status, 'llm_ready');
    eq('runGate: a not-found employer is ALSO promoted, never skipped',
      statusOf(db, 15).queue_status, 'llm_ready');
    eq('runGate: the enrolled verdict is recorded for ranking',
      db.prepare("SELECT everify_status FROM jobs WHERE canonical_url LIKE '%jobs/14%'").get().everify_status,
      'enrolled');
    eq('runGate: the not-found verdict is recorded too',
      db.prepare("SELECT everify_status FROM jobs WHERE canonical_url LIKE '%jobs/15%'").get().everify_status,
      'not_found');
    db.close();
  }

  // listReady must surface enrolled employers first, since that is the whole
  // point of recording a signal we refuse to gate on.
  {
    const db = await seed([job({ id: 16, company: 'Unknown Co' }), job({ id: 17, company: 'Walmart' })]);
    runGate(db, { now: NOW, everify: new Map([
      ['Unknown Co', { status: 'not_found' }],
      ['Walmart', { status: 'enrolled' }],
    ]) });
    const ready = listReady(db, { now: NOW });
    eq('listReady: both rows are drainable', ready.length, 2);
    eq('listReady: the E-Verify-enrolled employer comes first', ready[0].company, 'Walmart');
    db.close();
  }

  // cheapest-first ordering is observable: a stale row is skipped for staleness
  // even when it would ALSO fail a later gate. The reason names the first gate.
  {
    const db = await seed([job({ id: 10, postedAt: NOW - 30 * DAY, title: 'Senior Data Engineer' })]);
    runGate(db, { now: NOW });
    eq('runGate: the first failing gate owns the reason', statusOf(db, 10).skip_reason, 'stale');
    db.close();
  }
}

await gateTests();

// ── the two-letter code collision: IN is India as often as Indiana ─────────
//
// Found on the live queue 2026-07-24: "Hyderabad - TS - IN" — Workday's
// city-state-country format for an Indian posting — classified as **us**,
// because US_STATE_RE matched "IN" for Indiana. Not merely unknown: a
// confident FALSE US, which sails through the gate and reaches the paid
// scorer. 65 rows in the scoreable pool named a foreign city this way.
//
// The collision is broad, not a one-off: IN is Indiana and India, DE is
// Delaware and Germany, CA is California and Canada.
//
// The fix keeps the "any US signal wins" doctrine that protects multi-location
// postings, and narrows only the AMBIGUOUS signal: a bare two-letter code is
// the weakest US evidence there is, so an explicit foreign city or country
// name in the same string outranks it. A spelled-out US city, state name, or
// "US"/"USA" still wins outright.
eq('classifyLocation: Workday city-state-country for India is non-US, not Indiana',
  classifyLocation('Hyderabad - TS - IN'), 'non_us');
eq('classifyLocation: an IN-prefixed Indian location is non-US',
  classifyLocation('IN KA Bengaluru'), 'non_us');
eq('classifyLocation: Berlin, DE is Germany, not Delaware',
  classifyLocation('Berlin, DE'), 'non_us');
eq('classifyLocation: Toronto, CA is Canada, not California',
  classifyLocation('Toronto, CA'), 'non_us');

// ...but a real US posting that happens to use those same codes still reads US.
eq('classifyLocation: Indianapolis, IN is still Indiana', classifyLocation('Indianapolis, IN'), 'us');
eq('classifyLocation: a bare state code with no foreign signal is still US',
  classifyLocation('Fort Wayne, IN'), 'us');
eq('classifyLocation: Wilmington, DE is still Delaware', classifyLocation('Wilmington, DE'), 'us');

// ...and the multi-location rule the doctrine exists to protect is untouched:
// a posting offering a workable US site must never be skipped.
eq('classifyLocation: London / Boston still offers a US site',
  classifyLocation('London, UK / Boston, MA'), 'us');
eq('classifyLocation: a foreign city plus an explicit US state name is US',
  classifyLocation('Bangalore, India; Austin, Texas'), 'us');
eq('classifyLocation: a foreign city plus "Remote - US" is US',
  classifyLocation('Bengaluru / Remote - US'), 'us');

// ── the "N Locations" placeholder: resolve geography from the ad ───────────
//
// Workday's most common location value is a bare count ("2 Locations",
// "6 Locations"), which names nothing. 394 of the 921 scoreable rows carry a
// placeholder or empty location, so the gate can only answer `unknown` for
// them — correctly, since it runs before the ad is downloaded and its rule is
// that unknown always passes.
//
// By the SCREEN stage the ad exists, so the same question can be asked with
// real evidence. classifyLocationDeep reads the location field, the decoded
// URL path (Workday encodes the office into it) and the head of the ad. The
// asymmetry is unchanged: only a positive foreign signal with NO US signal
// anywhere gates a row.
{
  const deep = (row) => classifyLocationDeep(row);

  eq('classifyLocationDeep: a placeholder location resolves from the URL path',
    deep({ location: '6 Locations', canonical_url: 'https://x.wd1.myworkdayjobs.com/c/job/Bangalore-India/Analyst_R1', jd_text: '' }),
    'non_us');
  eq('classifyLocationDeep: a placeholder location resolves from the ad text',
    deep({ location: '2 Locations', canonical_url: 'https://x.wd1.myworkdayjobs.com/c/job/R1', jd_text: 'This role is based in our Hyderabad office.' }),
    'non_us');
  eq('classifyLocationDeep: an explicit US location still wins over a foreign mention in the ad',
    deep({ location: 'Austin, TX', canonical_url: 'https://x/job/R1', jd_text: 'You will partner with our Bangalore team.' }),
    'us');
  eq('classifyLocationDeep: a US signal ANYWHERE keeps the row (a US site is workable)',
    deep({ location: '3 Locations', canonical_url: 'https://x/job/Bangalore-India/R1', jd_text: 'Offices in Bengaluru and Austin, Texas.' }),
    'us');
  eq('classifyLocationDeep: no signal at all stays unknown, and unknown always passes',
    deep({ location: '2 Locations', canonical_url: 'https://x/job/R1', jd_text: 'We are hiring an analyst.' }),
    'unknown');
  eq('classifyLocationDeep: a URL-encoded foreign office is decoded before matching',
    deep({ location: '', canonical_url: 'https://x.wd1.myworkdayjobs.com/c/job/M%C3%BCnchen-Germany/Analyst', jd_text: '' }),
    'non_us');
  // Only the HEAD of the ad is read: an EEO footer naming global offices at the
  // bottom of a US posting must not drag it out of the queue.
  eq('classifyLocationDeep: a boilerplate footer far below the ad head is not evidence',
    deep({ location: '2 Locations', canonical_url: 'https://x/job/R1', jd_text: `We are hiring an analyst.${' filler'.repeat(400)} Our offices include Bangalore.` }),
    'unknown');
  // Missing/garbage input must never throw — this runs over every queued row.
  eq('classifyLocationDeep: an empty row is unknown, not a crash', deep({}), 'unknown');
}
