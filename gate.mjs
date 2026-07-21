#!/usr/bin/env node
/**
 * gate.mjs — the zero-token promoter: queue_status 'new' → 'llm_ready' | 'skipped'.
 *
 * This is the wall between a 6,800-row scan dump and an LLM. Every gate here is
 * free (no network, no model), and they run cheapest-first so each one shrinks
 * the input to the next:
 *
 *   1. freshness  stale / undated never reaches an LLM (freshness.mjs policy)
 *   2. location   non-US is unworkable on F-1 STEM OPT
 *   3. level      Senior/Staff/Principal/Lead/Manager/Director/Fellow titles
 *
 * ── The asymmetry that governs every classifier below ──────────────────────
 * A duplicate costs one wasted look. A wrongly-skipped row costs a job. So
 * `unknown` always PASSES: only a positive match on a disqualifying signal
 * skips a row. That is why "2 Locations" (the most common Workday location
 * value, and pure noise) promotes rather than skips.
 *
 * Verdicts are RECORDED on the row (level_status, skip_reason), not just acted
 * on, so a later audit can answer "why is this not queued?" without re-deriving
 * anything.
 *
 * Usage:
 *   node gate.mjs             # promote/skip every `new` row
 *   node gate.mjs --dry-run   # report the verdicts, write nothing
 */
import { openQueue } from './queue.mjs';
import { classifyFreshness } from './freshness.mjs';

// ── location ────────────────────────────────────────────────────────────────
//
// Only a POSITIVE foreign signal skips a row. Two US signals are recognised:
// a state (abbreviation or full name) and an explicit country name.
const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN',
  'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA',
  'WA', 'WV', 'WI', 'WY', 'DC'];
const US_STATE_NAMES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah',
  'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming'];

// Countries that actually appear in this corpus, plus the ISO-3166 alpha-3 /
// alpha-2 prefixes Workday embeds in a location ("IND-Pune", "London-GB").
const FOREIGN_NAMES = ['germany', 'france', 'spain', 'italy', 'netherlands', 'belgium', 'poland',
  'portugal', 'ireland', 'sweden', 'norway', 'denmark', 'finland', 'austria', 'switzerland',
  'czech', 'romania', 'hungary', 'greece', 'turkey', 'israel', 'india', 'china', 'japan', 'korea',
  'singapore', 'malaysia', 'philippines', 'indonesia', 'thailand', 'vietnam', 'australia',
  'new zealand', 'canada', 'mexico', 'brazil', 'argentina', 'chile', 'colombia', 'peru',
  'costa rica', 'panama', 'guatemala', 'kenya', 'nigeria', 'south africa', 'egypt', 'morocco',
  'united kingdom', 'england', 'scotland', 'wales', 'united arab emirates', 'saudi arabia',
  'qatar', 'pakistan', 'bangladesh', 'sri lanka', 'ukraine', 'bulgaria', 'slovakia', 'croatia',
  'serbia', 'lithuania', 'latvia', 'estonia', 'luxembourg', 'iceland', 'taiwan', 'hong kong'];
const FOREIGN_CODES = ['IND', 'DEU', 'GBR', 'FRA', 'ESP', 'ITA', 'NLD', 'BEL', 'POL', 'PRT', 'IRL',
  'SWE', 'NOR', 'DNK', 'FIN', 'AUT', 'CHE', 'CZE', 'ROU', 'HUN', 'GRC', 'TUR', 'ISR', 'CHN', 'JPN',
  'KOR', 'SGP', 'MYS', 'PHL', 'IDN', 'THA', 'VNM', 'AUS', 'NZL', 'CAN', 'MEX', 'BRA', 'ARG', 'CHL',
  'COL', 'PER', 'CRI', 'KEN', 'NGA', 'ZAF', 'EGY', 'MAR', 'ARE', 'SAU', 'QAT', 'PAK', 'BGD', 'LKA',
  'UKR', 'BGR', 'SVK', 'HRV', 'SRB', 'LTU', 'LVA', 'EST', 'LUX', 'ISL', 'TWN', 'HKG', 'GB'];

// City-level lists, because a large share of real rows name only a city. These
// cover the values actually observed in this corpus rather than trying to be a
// gazetteer. Deliberately EXCLUDES ambiguous names that exist on both sides
// (San Jose is in both California and Costa Rica) — those fall through to the
// country/state check above them, or stay unknown.
const US_CITIES = ['san francisco', 'los angeles', 'new york', 'chicago', 'boston', 'seattle',
  'austin', 'atlanta', 'denver', 'dallas', 'houston', 'phoenix', 'miami', 'philadelphia',
  'detroit', 'minneapolis', 'portland', 'san diego', 'pittsburgh', 'cleveland', 'columbus',
  'charlotte', 'nashville', 'baltimore', 'milwaukee', 'kansas city', 'st louis', 'saint louis',
  'salt lake city', 'las vegas', 'sacramento', 'orlando', 'tampa', 'raleigh', 'indianapolis',
  'cincinnati', 'louisville', 'memphis', 'oklahoma city', 'albuquerque', 'tucson', 'omaha',
  'des moines', 'madison', 'ann arbor', 'palo alto', 'mountain view', 'sunnyvale', 'santa clara',
  'redmond', 'bellevue', 'boulder', 'fort worth', 'san antonio', 'jacksonville', 'buffalo'];
const FOREIGN_CITIES = ['bengaluru', 'bangalore', 'hyderabad', 'pune', 'chennai', 'mumbai',
  'new delhi', 'gurugram', 'gurgaon', 'noida', 'kolkata', 'ahmedabad', 'cairo', 'bucharest',
  'buenos aires', 'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', 'edmonton',
  'winnipeg', 'halifax', 'mississauga', 'prague', 'london', 'dublin',
  'glasgow', 'edinburgh', 'manchester', 'birmingham', 'belfast', 'berlin', 'munich',
  'münchen', 'cologne', 'köln', 'hamburg', 'frankfurt', 'stuttgart', 'düsseldorf', 'jena',
  'paris', 'lyon', 'toulouse', 'guyancourt', 'madrid', 'barcelona', 'valencia', 'lisbon',
  'lisboa', 'porto', 'amsterdam', 'rotterdam', 'utrecht', 'brussels', 'antwerp', 'warsaw',
  'warszawa', 'krakow', 'kraków', 'wroclaw', 'budapest', 'sofia', 'belgrade', 'zagreb',
  'ljubljana', 'bratislava', 'vilnius', 'riga', 'tallinn', 'stockholm', 'gothenburg', 'oslo',
  'copenhagen', 'helsinki', 'reykjavik', 'zurich', 'zürich', 'geneva', 'basel', 'vienna',
  'wien', 'milan', 'milano', 'rome', 'roma', 'turin', 'athens', 'istanbul', 'ankara',
  'tel aviv', 'jerusalem', 'haifa', 'dubai', 'abu dhabi', 'doha', 'riyadh', 'tokyo', 'osaka',
  'kyoto', 'seoul', 'shanghai', 'beijing', 'shenzhen', 'guangzhou', 'hangzhou', 'taipei',
  'singapore', 'kuala lumpur', 'jakarta', 'manila', 'bangkok', 'hanoi', 'ho chi minh',
  'sydney', 'melbourne', 'brisbane', 'perth', 'auckland', 'wellington', 'mexico city',
  'guadalajara', 'monterrey', 'sao paulo', 'são paulo', 'rio de janeiro', 'bogota', 'bogotá',
  'lima', 'santiago', 'montevideo', 'nairobi', 'lagos', 'johannesburg', 'cape town',
  'casablanca', 'karachi', 'lahore', 'dhaka', 'colombo', 'kyiv', 'kiev'];

const anyWord = (words, flags = 'i') =>
  new RegExp(`(?:^|[^\\p{L}])(?:${words.join('|')})(?:[^\\p{L}]|$)`, `${flags}u`);

// Two-letter codes are matched CASE-SENSITIVELY, both for US states and foreign
// countries. Lowercase "de"/"in"/"or"/"me"/"la" are ordinary words in Spanish,
// French and English, and a case-insensitive match reads them as Delaware,
// Indiana, Oregon, Maine, Louisiana — which misclassified real foreign postings
// as US. Real postings write these codes uppercase, so nothing is lost.
const US_STATE_RE = anyWord(US_STATES, '');
const US_NAME_RE = anyWord([...US_STATE_NAMES, 'united states', 'usa', 'u\\.s\\.a?']);
// "US", "US - Remote (Any location)", "Remote (us/canada)". Case-INSENSITIVE on
// purpose: in a location field the pronoun "us" is vanishingly rare, and the two
// possible errors are not symmetric — reading "Join us in Berlin" as US costs
// one wasted look, while missing "Remote (us/canada)" costs a job.
const US_BARE_RE = /(?:^|[^\p{L}])u\.?s\.?(?:[^\p{L}]|$)/iu;
const US_CITY_RE = anyWord(US_CITIES);
const FOREIGN_NAME_RE = anyWord([...FOREIGN_NAMES, 'uk', 'u\\.k\\.']);
const FOREIGN_CODE_RE = anyWord(FOREIGN_CODES, '');
const FOREIGN_CITY_RE = anyWord(FOREIGN_CITIES);

/**
 * ANY US signal wins, at any specificity, before a foreign signal is even
 * considered. A multi-location posting like "London, UK / Boston" offers a
 * workable US site, and skipping it is the expensive error. Ambiguity is
 * resolved by what the lists contain, not by ordering: San Jose is deliberately
 * absent from US_CITIES, so "SAN JOSE, COSTA RICA" falls through to the country
 * check while "San Jose, CA" is caught by the state.
 *
 * @param {string} text  a posting's location field
 * @returns {'us'|'non_us'|'unknown'}
 */
export function classifyLocation(text) {
  const s = String(text ?? '').trim();
  if (!s) return 'unknown';
  if (US_STATE_RE.test(s) || US_NAME_RE.test(s) || US_BARE_RE.test(s) || US_CITY_RE.test(s)) return 'us';
  if (FOREIGN_NAME_RE.test(s) || FOREIGN_CODE_RE.test(s) || FOREIGN_CITY_RE.test(s)) return 'non_us';
  return 'unknown';
}

// ── level ───────────────────────────────────────────────────────────────────
//
// Mirrors the filter this tracker already applied by hand ("title not
// Senior/Staff/Principal/Lead/Manager/Director/Fellow"), with word boundaries so
// "Leadership" is not "Lead" and "Management" is not "Manager".
const SENIOR_RE = /(?:^|[^a-z])(?:senior|sr\.?|staff|principal|lead|leader|manager|director|head of|vp|vice president|fellow|chief|architect|supervisor)(?:[^a-z]|$)/i;

// "Senior" is not always a seniority word. In healthcare it names the patient
// population ("Senior Living", "Senior Care"), and those are exactly the
// entry-level health-system roles this search wants. Neutralise that phrase
// before testing, so a REAL seniority word elsewhere in the title still counts.
const SENIOR_POPULATION_RE = /senior\s+(?:living|care|center|centre|services|nutrition|housing|health|community|adult)/gi;

// An explicit junior signal OUTRANKS an occupational noun. In "Associate Product
// Manager", "Manager Trainee" and "Program Manager, New Graduate", the word
// Manager names the FUNCTION, not the level — and these are precisely the
// entry-level roles this search exists to find. Found by code review.
const JUNIOR_RE = /(?:^|[^a-z])(?:intern|interns|internship|trainee|apprentice|graduate|grad|junior|jr\.?|entry.level|associate|assistant|co.op)(?:[^a-z]|$)/i;

// ...except when "Associate"/"Assistant" is itself a seniority modifier. An
// Associate Director outranks a Director's team; it is not an entry-level role.
const SENIOR_MODIFIER_RE = /(?:associate|assistant|deputy)\s+(?:director|vice\s+president|vp|principal|partner|dean|professor|manager\s+of|head)/i;

/**
 * @param {string} title
 * @returns {'ok'|'too_senior'}
 */
export function classifyLevel(title) {
  const raw = String(title ?? '');
  const s = raw.replace(SENIOR_POPULATION_RE, ' ');
  if (JUNIOR_RE.test(s) && !SENIOR_MODIFIER_RE.test(s)) return 'ok';
  return SENIOR_RE.test(s) ? 'too_senior' : 'ok';
}

// ── the gate ────────────────────────────────────────────────────────────────
//
// Ordered cheapest-first. The FIRST failing gate owns the skip reason, so the
// recorded reason names the cheapest disqualification rather than an arbitrary
// one — which is also the most useful thing to read back later.
const GATES = [
  {
    name: 'freshness',
    run: (row, { now }) => {
      const f = classifyFreshness({ postedAt: row.posted_at, confidence: row.posted_at_confidence, now });
      if (f.sendable) return null;
      return { reason: f.bucket === 'unknown' ? 'undated' : 'stale' };
    },
  },
  {
    name: 'location',
    column: 'liveness_status', // unused by this gate; location verdict is not stored separately
    run: (row) => (classifyLocation(row.location) === 'non_us' ? { reason: 'non-US' } : null),
  },
  {
    name: 'level',
    run: (row) => {
      const verdict = classifyLevel(row.title);
      return verdict === 'too_senior'
        ? { reason: 'too senior', set: { level_status: 'too_senior' } }
        : { pass: true, set: { level_status: 'ok' } };
    },
  },
];

/**
 * Promote or skip every `new` row. Only `new` is considered — a row that has
 * progressed reflects work already done and is never re-judged, which also makes
 * a second pass a no-op.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?:number, dryRun?:boolean}} [opts]
 * @returns {{considered:number, promoted:number, skipped:number, reasons:Record<string,number>}}
 */
export function runGate(db, { now = Date.now(), dryRun = false, everify = null } = {}) {
  const rows = db.prepare("SELECT * FROM jobs WHERE queue_status = 'new'").all();
  const setEverify = db.prepare('UPDATE jobs SET everify_status = ? WHERE canonical_url = ?');
  // Promotion CLEARS skip_reason, or a promoted row reads as queued and
  // rejected at once. Both writes are guarded on queue_status = 'new' so a row
  // whose status changed between this SELECT and the UPDATE is left alone
  // instead of being clobbered.
  const promote = db.prepare("UPDATE jobs SET queue_status = 'llm_ready', level_status = ?, skip_reason = NULL WHERE canonical_url = ? AND queue_status = 'new'");
  const skip = db.prepare("UPDATE jobs SET queue_status = 'skipped', skip_reason = ?, level_status = ? WHERE canonical_url = ? AND queue_status = 'new'");

  let promoted = 0, skipped = 0;
  const reasons = {};
  const writes = [];

  for (const row of rows) {
    let verdict = null;
    let level = row.level_status;
    for (const gate of GATES) {
      const out = gate.run(row, { now });
      if (out?.set?.level_status) level = out.set.level_status;
      if (out?.reason) { verdict = out.reason; break; }
    }
    if (verdict) {
      skipped++;
      reasons[verdict] = (reasons[verdict] ?? 0) + 1;
      writes.push(() => skip.run(verdict, level, row.canonical_url));
    } else {
      promoted++;
      writes.push(() => promote.run(level, row.canonical_url));
    }
    // E-Verify RANKS, it never skips — recorded on every row that got this far,
    // including skipped ones, so a later audit keeps the signal. The USCIS
    // export lists only enrolled employers, so a miss proves a name mismatch
    // (brand vs legal name), not that the employer cannot hire on STEM OPT.
    if (everify) {
      const verdict = everify.get(row.company)?.status ?? 'not_found';
      writes.push(() => setEverify.run(verdict, row.canonical_url));
    }
  }

  if (!dryRun && writes.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const w of writes) w();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { considered: rows.length, promoted, skipped, reasons };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = await openQueue();

  // One walk of the 63 MB USCIS index answers every distinct company at once.
  // Skipped with --no-everify because that walk dominates the runtime.
  let everify = null;
  if (!process.argv.includes('--no-everify')) {
    const companies = db.prepare("SELECT DISTINCT company FROM jobs WHERE queue_status = 'new' AND company <> ''")
      .all().map((r) => r.company);
    if (companies.length) {
      process.stderr.write(`E-Verify: matching ${companies.length} companies in one index pass...\n`);
      const { everifyLookup } = await import('./everify-check.mjs');
      everify = await everifyLookup(companies);
      const tally = {};
      for (const v of everify.values()) tally[v.status] = (tally[v.status] ?? 0) + 1;
      process.stderr.write(`E-Verify: ${JSON.stringify(tally)}\n`);
    }
  }

  const res = runGate(db, { dryRun, everify });

  console.log(`Gated ${res.considered} rows:`);
  console.log(`  ${String(res.promoted).padStart(6)}  llm_ready`);
  for (const [reason, n] of Object.entries(res.reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  skipped (${reason})`);
  }
  if (dryRun) console.log('\n--dry-run: nothing written.');
  db.close();
}

const invoked = process.argv[1] && (
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href);
if (invoked) await main();
