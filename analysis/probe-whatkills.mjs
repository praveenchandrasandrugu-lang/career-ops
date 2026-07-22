// Probe: across 266 past reports, what actually drives a LOW score?
// Reads the Machine Summary YAML block from each report and clusters the
// stated hard_stops / soft_gaps / discard_reasons by theme.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS = join(ROOT, 'reports');
const files = readdirSync(REPORTS).filter(f => /^\d{3}-.*\.md$/.test(f));

const THEMES = {
  'years-of-experience': /\b(\d+\+?\s*(?:-\d+)?\s*years?|years of experience|experience requirement|yoe|tenure|seniority|senior|more experience)\b/i,
  'domain-knowledge': /\b(domain|industry|clinical|healthcare|patient|financial services|insurance|banking|manufacturing|higher.?ed|government|no direct .* experience)\b/i,
  'named-tool-or-cert': /\b(certification|certified|epic|cerner|workday|sap|salesforce|tableau|power bi|sas\b|databricks|spark|snowflake|informatica|oracle|peoplesoft)\b/i,
  'people-or-lead': /\b(lead|leadership|manage|managing|mentor|supervis|stakeholder management|people manage)\b/i,
  'depth-of-coding': /\b(deep|advanced|algorithms|data structures|computer science fundamentals|production.scale|distributed systems|low.level)\b/i,
  'work-auth-or-clearance': /\b(sponsor|visa|clearance|citizen|green card|authorization|opt\b|h-1b)\b/i,
  'comp-or-location': /\b(salary|compensation|relocat|onsite|on-site|hybrid|commute|location)\b/i,
};

const rows = [];
for (const f of files) {
  let txt;
  try { txt = readFileSync(join(REPORTS, f), 'utf8'); } catch { continue; }
  const m = txt.match(/## Machine Summary\s*```yaml\s*([\s\S]*?)```/);
  if (!m) continue;
  const yaml = m[1];
  const sm = yaml.match(/^score:\s*([0-9.]+)/m);
  if (!sm) continue;
  const score = parseFloat(sm[1]);

  // Collect list-item text under the three diagnostic keys.
  const collect = key => {
    const b = yaml.match(new RegExp(`^${key}:\\s*(\\[\\]|[\\s\\S]*?)(?=^\\w+:)`, 'm'));
    if (!b || b[1].trim() === '[]') return [];
    return [...b[1].matchAll(/^\s*-\s*"?(.+?)"?\s*$/gm)].map(x => x[1]);
  };
  rows.push({
    file: f, score,
    hard: collect('hard_stops'),
    soft: collect('soft_gaps'),
    disc: collect('discard_reasons'),
  });
}

const low = rows.filter(r => r.score < 3.5);
const high = rows.filter(r => r.score >= 3.5);
console.log(`reports parsed: ${rows.length}   low(<3.5): ${low.length}   high(>=3.5): ${high.length}`);
console.log(`reports with >=1 hard_stop: ${rows.filter(r => r.hard.length).length}`);
console.log('');

const tally = (set, pick) => {
  const t = {};
  for (const r of set) {
    const text = pick(r).join(' || ');
    for (const [name, re] of Object.entries(THEMES)) {
      if (re.test(text)) t[name] = (t[name] || 0) + 1;
    }
  }
  return t;
};

const lowAll = tally(low, r => [...r.hard, ...r.soft, ...r.disc]);
const highAll = tally(high, r => [...r.hard, ...r.soft, ...r.disc]);

console.log('theme                      low<3.5        high>=3.5      lift');
console.log('-------------------------  -------------  -------------  ----');
const names = [...new Set([...Object.keys(lowAll), ...Object.keys(highAll)])];
const scored = names.map(n => {
  const lp = (lowAll[n] || 0) / low.length;
  const hp = (highAll[n] || 0) / (high.length || 1);
  return { n, lc: lowAll[n] || 0, hc: highAll[n] || 0, lp, hp, lift: hp > 0 ? lp / hp : Infinity };
}).sort((a, b) => b.lp - a.lp);

for (const s of scored) {
  console.log(
    s.n.padEnd(26),
    `${String(s.lc).padStart(3)} (${(100 * s.lp).toFixed(0).padStart(2)}%)`.padEnd(15),
    `${String(s.hc).padStart(3)} (${(100 * s.hp).toFixed(0).padStart(2)}%)`.padEnd(15),
    (s.lift === Infinity ? 'inf' : s.lift.toFixed(2))
  );
}

console.log('');
console.log('--- most common hard_stops overall ---');
const hs = {};
for (const r of rows) for (const h of r.hard) {
  const k = h.toLowerCase().slice(0, 70);
  hs[k] = (hs[k] || 0) + 1;
}
for (const [k, v] of Object.entries(hs).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}
