// Probe: how many llm_ready rows would a HARD-WALL skill screen drop?
// Hard wall = named cert / licensed credential / cert-gated platform / clearance
// / domain tenure, per modes/_custom.md 2026-07-17. NOT transferable tooling.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(join(ROOT, 'data/queue.db'));

const WALLS = {
  'clinical-cert': /\b(Epic(?:\s+(?:Resolute|Clarity|Caboodle|Cogito|Bridges|Willow|Beaker|EpicCare))?\s+certif|Cerner|Meditech|\bCCS\b|\bCCA\b|\bRHIA\b|\bRHIT\b|\bCPC\b|\bCPMA\b|\bCDIP\b|\bRN\b licen|registered nurse|\bLPN\b|\bBLS\b certif|\bACLS\b|pharmacy technician|\bPTCB\b)/i,
  'finance-cert': /\b(CPA\b|certified public accountant|\bCFA\b|\bCMA\b certif|Series\s?(?:7|63|65|66)\b|\bEA\b enrolled agent)/i,
  'eng-license': /\b(PE\s+licen|professional engineer licen|\bEIT\b certif|licensed (?:electrical|mechanical|civil) engineer)/i,
  'it-cert': /\b(PMP\b|CISSP|CISA\b|CISM\b|Security\+|CompTIA|CCNA|CCNP|ITIL\s+(?:certif|founda)|Six Sigma (?:Green|Black) Belt)/i,
  'platform-cert': /\b(SAP\s+(?:S\/4HANA|ABAP|certif)|Salesforce\s+(?:Administrator|Developer|Platform)\s+certif|Workday\s+(?:HCM|Financials|Pro)\s+certif|PeopleSoft|Oracle\s+EBS|ServiceNow\s+certif)/i,
  'clearance': /\b(TS\/SCI|top secret|secret clearance|security clearance|public trust|polygraph|\bDoD\b clearance)/i,
  'domain-tenure': /\b\d+\+?\s*(?:\+|or more)?\s*years?[^.]{0,60}\b(hospital billing|revenue cycle|clinical|claims adjudication|underwriting|actuarial|pharmacy|radiology|nursing|patient account)/i,
};

// Escape hatches: presence of these near the match means NOT a wall.
const ESCAPE = /\b(preferred|a plus|nice to have|desired|desirable|or equivalent|willing to obtain|must obtain|within \d+ (?:months|days) of hire|we will train|not required)\b/i;

const rows = db.prepare(
  "SELECT canonical_url, company, title, level_status, jd_text FROM jobs " +
  "WHERE queue_status='llm_ready' AND jd_status='ok'"
).all();

let flagged = 0, escaped = 0;
const byCat = {}, byCatClear = {};
let clearTotal = 0, clearFlagged = 0;
const samples = [];

for (const r of rows) {
  const t = r.jd_text || '';
  const isClear = r.level_status === 'clear';
  if (isClear) clearTotal++;

  // Split into sentences so the escape hatch is judged LOCALLY, not doc-wide.
  const sentences = t.split(/(?<=[.!?;:\n])\s+/);
  let hit = null;
  for (const s of sentences) {
    for (const [cat, re] of Object.entries(WALLS)) {
      const m = re.exec(s);
      if (!m) continue;
      if (ESCAPE.test(s)) { escaped++; continue; }
      hit = { cat, sentence: s.trim().slice(0, 160) };
      break;
    }
    if (hit) break;
  }
  if (!hit) continue;
  flagged++;
  byCat[hit.cat] = (byCat[hit.cat] || 0) + 1;
  if (isClear) {
    clearFlagged++;
    byCatClear[hit.cat] = (byCatClear[hit.cat] || 0) + 1;
    if (samples.length < 12) samples.push({ company: r.company, title: r.title, ...hit });
  }
}

console.log('llm_ready rows with ad text :', rows.length);
console.log('  flagged as hard wall      :', flagged, `(${(100 * flagged / rows.length).toFixed(1)}%)`);
console.log('  sentence-level escapes    :', escaped, '(kept, had preferred/or-equivalent/runway)');
console.log('');
console.log('level_status=clear total    :', clearTotal);
console.log('  flagged                   :', clearFlagged, `(${(100 * clearFlagged / clearTotal).toFixed(1)}%)`);
console.log('  would SURVIVE to scoring  :', clearTotal - clearFlagged);
console.log('');
console.log('--- by category (clear rows) ---');
for (const [k, v] of Object.entries(byCatClear).sort((a, b) => b[1] - a[1])) {
  console.log('  ', String(v).padStart(4), k);
}
console.log('');
console.log('--- sample drops (eyeball these for false positives) ---');
for (const s of samples) {
  console.log(`  [${s.cat}] ${s.company} :: ${s.title}`);
  console.log(`      "${s.sentence}"`);
}
