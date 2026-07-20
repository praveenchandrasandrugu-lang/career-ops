#!/usr/bin/env node
/**
 * lca-query.mjs — sponsorship intelligence queries over data/lca/lca-rows.tsv
 * (built by lca-index.mjs). Zero-token: pure aggregation, no LLM.
 *
 * Subcommands:
 *   socs [--adjacent]        SOC-code landscape: filings, entry-level share,
 *                            employers, median wage. --adjacent filters to
 *                            data/analyst-adjacent occupations.
 *   employers --soc <re>     Employers filing for SOC codes/titles matching a
 *                            regex, ranked low-competition-first (small filers,
 *                            entry-level, new employment, not H-1B dependent).
 *                            Options: --state CA --max-filings 30 --min-filings 1
 *   check <company>          Sponsor check for one company (substring match):
 *                            filings by SOC/level/state, verdict line for
 *                            evaluation reports.
 *   capexempt [--soc <re>]   Likely cap-exempt employers (university/hospital/
 *                            research name patterns), optionally per SOC.
 *   states [--soc <re>]      Worksite-state competition map: where sponsorship
 *                            happens relative to how many employers file there.
 *                            High filings-per-employer + low absolute volume =
 *                            employers that sponsor because they can't hire
 *                            locally (hard-to-staff locations).
 *
 * All output JSON unless --summary (human table).
 */
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';

const IDX = 'data/lca/lca-rows.tsv';
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(name);

// Occupations where a data/analytics degree is a defensible specialty match.
const ADJACENT = /analyst|analytics|data|statistic|research|intelligence|logistic|supply chain|operations research|economist|mathematic|actuar|epidemiol|biostat|planner|forecast/i;

// Cap-exempt heuristic: institutions of higher education, nonprofit research,
// and university-affiliated hospitals. Name-based, so it's a lead list, not proof.
const CAP_EXEMPT = /universit|college\b|school of|institute of|hospital|medical center|health system|med ctr|research (?:center|centre|institute|foundation)|academy|laborator/i;

let COLS = null;
async function* rows() {
  // Fail with a pointer, not a stream stack trace, when the index isn't built
  // yet (a fresh clone before the DOL data zip is unpacked and indexed).
  if (!existsSync(IDX)) {
    console.error(`LCA index missing (${IDX}).\nUnpack the DOL data into data/FY20*/ then run: node lca-index.mjs`);
    process.exit(1);
  }
  const rl = createInterface({ input: createReadStream(IDX), crlfDelay: Infinity });
  for await (const line of rl) {
    const parts = line.split('\t');
    if (!COLS) { COLS = Object.fromEntries(parts.map((c, i) => [c, i])); continue; }
    yield parts;
  }
}
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

function usable(r) {
  // Certified (incl. certified-withdrawn: still proves intent) H-1B filings only.
  return r[COLS.CASE_STATUS].startsWith('Certified') && r[COLS.VISA_CLASS] === 'H-1B';
}
const isEntry = (r) => r[COLS.PW_WAGE_LEVEL] === 'I' || r[COLS.PW_WAGE_LEVEL] === 'II';

// ---------------------------------------------------------------- socs

async function cmdSocs() {
  const bySoc = new Map();
  for await (const r of rows()) {
    if (!usable(r)) continue;
    const key = r[COLS.SOC_CODE];
    let s = bySoc.get(key);
    if (!s) bySoc.set(key, s = { soc: key, title: r[COLS.SOC_TITLE], filings: 0, entry: 0, newEmp: 0, employers: new Set(), wages: [] });
    s.filings++;
    if (isEntry(r)) s.entry++;
    s.newEmp += parseInt(r[COLS.NEW_EMPLOYMENT], 10) || 0;
    s.employers.add(r[COLS.EMPLOYER_NAME].toUpperCase());
    const w = parseInt(r[COLS.PREVAILING_ANNUAL], 10);
    if (w > 20000 && w < 500000) s.wages.push(w);
  }
  let list = [...bySoc.values()]
    .filter((s) => !flag('--adjacent') || ADJACENT.test(s.title))
    .map((s) => ({
      soc: s.soc, title: s.title, filings: s.filings,
      entryLevelPct: pct(s.entry, s.filings),
      newEmployment: s.newEmp, employers: s.employers.size,
      medianWage: median(s.wages),
    }))
    .sort((a, b) => b.filings - a.filings);
  const min = parseInt(opt('--min-filings', '25'), 10);
  list = list.filter((s) => s.filings >= min);
  output(list, ['soc', 'title', 'filings', 'entryLevelPct', 'newEmployment', 'employers', 'medianWage']);
}

// ---------------------------------------------------------------- employers

async function cmdEmployers() {
  const socRe = new RegExp(opt('--soc', 'analyst'), 'i');
  const state = opt('--state', null)?.toUpperCase();
  const maxFilings = parseInt(opt('--max-filings', '40'), 10);
  const minFilings = parseInt(opt('--min-filings', '1'), 10);
  const byEmp = new Map();
  for await (const r of rows()) {
    if (!usable(r)) continue;
    const emp = r[COLS.EMPLOYER_NAME].toUpperCase().replace(/[.,]| (INC|LLC|LLP|CORP|CO|LTD)\b/g, '').trim();
    let e = byEmp.get(emp);
    if (!e) byEmp.set(emp, e = { employer: r[COLS.EMPLOYER_NAME], total: 0, match: 0, entry: 0, newEmp: 0, states: new Set(), socs: new Set(), titles: new Set(), wages: [], dependent: false, violator: false, capExempt: CAP_EXEMPT.test(emp), pocEmail: '' });
    e.total++;
    if (r[COLS.H_1B_DEPENDENT] === 'Yes') e.dependent = true;
    if (r[COLS.WILLFUL_VIOLATOR] === 'Yes') e.violator = true;
    const socHit = socRe.test(r[COLS.SOC_TITLE]) || socRe.test(r[COLS.JOB_TITLE]) || socRe.test(r[COLS.SOC_CODE]);
    if (!socHit) continue;
    if (state && r[COLS.WORKSITE_STATE].toUpperCase() !== state) continue;
    e.match++;
    if (isEntry(r)) e.entry++;
    e.newEmp += parseInt(r[COLS.NEW_EMPLOYMENT], 10) || 0;
    e.states.add(r[COLS.WORKSITE_STATE]);
    e.socs.add(r[COLS.SOC_TITLE]);
    if (e.titles.size < 5) e.titles.add(r[COLS.JOB_TITLE]);
    if (!e.pocEmail && r[COLS.EMPLOYER_POC_EMAIL]) e.pocEmail = r[COLS.EMPLOYER_POC_EMAIL];
    const w = parseInt(r[COLS.PREVAILING_ANNUAL], 10);
    if (w > 20000 && w < 500000) e.wages.push(w);
  }
  const list = [...byEmp.values()]
    .filter((e) => e.match >= minFilings && e.total <= maxFilings && !e.violator)
    .map((e) => ({
      employer: e.employer,
      matchFilings: e.match, totalFilings: e.total,
      entryLevel: e.entry, newEmployment: e.newEmp,
      capExempt: e.capExempt, h1bDependent: e.dependent,
      states: [...e.states].join(','), medianWage: median(e.wages),
      exampleTitles: [...e.titles].slice(0, 3).join(' | '),
      // low-competition score: entry-level new hires at small, non-staffing filers
      score: (e.entry * 2 + e.newEmp) * (e.dependent ? 0.3 : 1) * (e.capExempt ? 1.5 : 1) / Math.sqrt(e.total),
    }))
    .sort((a, b) => b.score - a.score);
  output(list.slice(0, parseInt(opt('--top', '100'), 10)),
    ['employer', 'matchFilings', 'totalFilings', 'entryLevel', 'newEmployment', 'capExempt', 'states', 'medianWage', 'exampleTitles']);
}

// ---------------------------------------------------------------- check

async function cmdCheck() {
  const needle = args.slice(1).filter((a) => !a.startsWith('--')).join(' ').toUpperCase();
  if (!needle) { console.error('usage: node lca-query.mjs check <company>'); process.exit(1); }
  const hits = { employerNames: new Set(), filings: 0, entry: 0, newEmp: 0, socs: new Map(), states: new Map(), levels: new Map(), wages: [], dependent: false, violator: false, pocEmails: new Set(), latest: '' };
  for await (const r of rows()) {
    const emp = r[COLS.EMPLOYER_NAME].toUpperCase();
    const dba = r[COLS.TRADE_NAME_DBA].toUpperCase();
    if (!emp.includes(needle) && !dba.includes(needle)) continue;
    if (!usable(r)) continue;
    hits.employerNames.add(r[COLS.EMPLOYER_NAME]);
    hits.filings++;
    if (isEntry(r)) hits.entry++;
    hits.newEmp += parseInt(r[COLS.NEW_EMPLOYMENT], 10) || 0;
    hits.socs.set(r[COLS.SOC_TITLE], (hits.socs.get(r[COLS.SOC_TITLE]) || 0) + 1);
    hits.states.set(r[COLS.WORKSITE_STATE], (hits.states.get(r[COLS.WORKSITE_STATE]) || 0) + 1);
    hits.levels.set(r[COLS.PW_WAGE_LEVEL] || '?', (hits.levels.get(r[COLS.PW_WAGE_LEVEL] || '?') || 0) + 1);
    if (r[COLS.H_1B_DEPENDENT] === 'Yes') hits.dependent = true;
    if (r[COLS.WILLFUL_VIOLATOR] === 'Yes') hits.violator = true;
    if (r[COLS.EMPLOYER_POC_EMAIL]) hits.pocEmails.add(r[COLS.EMPLOYER_POC_EMAIL]);
    if (r[COLS.RECEIVED_DATE] > hits.latest) hits.latest = r[COLS.RECEIVED_DATE];
    const w = parseInt(r[COLS.PREVAILING_ANNUAL], 10);
    if (w > 20000 && w < 500000) hits.wages.push(w);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`);
  const verdict = hits.filings === 0
    ? 'NO certified H-1B LCAs in FY2025-FY2026 data. Treat sponsorship as unlikely unless the JD says otherwise.'
    : `${hits.filings} certified H-1B LCAs (FY25-26), ${hits.entry} at entry wage levels, ${hits.newEmp} new-employment positions. Latest filing ${hits.latest}.${hits.dependent ? ' NOTE: H-1B dependent employer.' : ''}${hits.violator ? ' WARNING: willful violator flag.' : ''}`;
  const result = {
    query: needle, verdict,
    filings: hits.filings, entryLevel: hits.entry, newEmployment: hits.newEmp,
    matchedNames: [...hits.employerNames].slice(0, 8),
    topSocs: top(hits.socs, 8), wageLevels: top(hits.levels, 4), topStates: top(hits.states, 6),
    medianPrevailingWage: median(hits.wages),
    h1bDependent: hits.dependent, willfulViolator: hits.violator,
    immigrationPoc: [...hits.pocEmails].slice(0, 3),
  };
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------- capexempt

async function cmdCapExempt() {
  const socRe = opt('--soc', null) ? new RegExp(opt('--soc'), 'i') : null;
  const byEmp = new Map();
  for await (const r of rows()) {
    if (!usable(r)) continue;
    if (!CAP_EXEMPT.test(r[COLS.EMPLOYER_NAME])) continue;
    if (socRe && !socRe.test(r[COLS.SOC_TITLE]) && !socRe.test(r[COLS.JOB_TITLE])) continue;
    const emp = r[COLS.EMPLOYER_NAME].toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
    let e = byEmp.get(emp);
    if (!e) byEmp.set(emp, e = { employer: r[COLS.EMPLOYER_NAME], filings: 0, entry: 0, dataFilings: 0, states: new Set(), titles: new Set(), wages: [] });
    e.filings++;
    if (isEntry(r)) e.entry++;
    e.states.add(r[COLS.WORKSITE_STATE]);
    // Data-adjacent filings tracked separately so the full list stays useful
    // even when no --soc filter is applied; prefer those titles as examples.
    const adj = ADJACENT.test(r[COLS.SOC_TITLE]) || ADJACENT.test(r[COLS.JOB_TITLE]);
    if (adj) {
      e.dataFilings++;
      if (e.titles.size < 4) e.titles.add(r[COLS.JOB_TITLE]);
    }
    const w = parseInt(r[COLS.PREVAILING_ANNUAL], 10);
    if (w > 20000 && w < 500000) e.wages.push(w);
  }
  const list = [...byEmp.values()]
    .map((e) => ({ employer: e.employer, filings: e.filings, dataFilings: e.dataFilings, entryLevel: e.entry, states: [...e.states].filter(Boolean).join(','), medianWage: median(e.wages), exampleTitles: [...e.titles].join(' | ') }))
    .sort((a, b) => b.filings - a.filings)
    .slice(0, parseInt(opt('--top', '1000000'), 10));
  output(list, ['employer', 'filings', 'dataFilings', 'entryLevel', 'states', 'medianWage', 'exampleTitles']);
}

// ---------------------------------------------------------------- states

async function cmdStates() {
  const socRe = new RegExp(opt('--soc', 'analyst|data|statist|research|logistic'), 'i');
  const byState = new Map();
  for await (const r of rows()) {
    if (!usable(r)) continue;
    if (!socRe.test(r[COLS.SOC_TITLE]) && !socRe.test(r[COLS.JOB_TITLE])) continue;
    const st = r[COLS.WORKSITE_STATE].toUpperCase();
    if (!/^[A-Z]{2}$/.test(st)) continue;
    let s = byState.get(st);
    if (!s) byState.set(st, s = { state: st, filings: 0, entry: 0, newEmp: 0, employers: new Set(), wages: [] });
    s.filings++;
    if (isEntry(r)) s.entry++;
    s.newEmp += parseInt(r[COLS.NEW_EMPLOYMENT], 10) || 0;
    s.employers.add(r[COLS.EMPLOYER_NAME].toUpperCase());
    const w = parseInt(r[COLS.PREVAILING_ANNUAL], 10);
    if (w > 20000 && w < 500000) s.wages.push(w);
  }
  const list = [...byState.values()]
    .map((s) => ({
      state: s.state, filings: s.filings, employers: s.employers.size,
      entryLevelPct: pct(s.entry, s.filings), newEmployment: s.newEmp,
      medianWage: median(s.wages),
      // Scarcity signal: fewer total filings = fewer int'l candidates targeting
      // the state; sponsorship still happening = employers import talent anyway.
      filingsPerEmployer: Math.round((10 * s.filings) / s.employers.size) / 10,
    }))
    .sort((a, b) => a.filings - b.filings);
  output(list, ['state', 'filings', 'employers', 'entryLevelPct', 'newEmployment', 'medianWage', 'filingsPerEmployer']);
}

// ---------------------------------------------------------------- output

function output(list, cols) {
  if (!flag('--summary')) { console.log(JSON.stringify(list, null, 2)); return; }
  const widths = cols.map((c) => Math.max(c.length, ...list.map((r) => String(r[c] ?? '').length)));
  console.log(cols.map((c, i) => c.padEnd(Math.min(widths[i], 60))).join('  '));
  for (const r of list) {
    console.log(cols.map((c, i) => String(r[c] ?? '').slice(0, 60).padEnd(Math.min(widths[i], 60))).join('  '));
  }
}

const commands = { socs: cmdSocs, employers: cmdEmployers, check: cmdCheck, capexempt: cmdCapExempt, states: cmdStates };
if (!commands[cmd]) {
  console.error('usage: node lca-query.mjs <socs|employers|check|capexempt> [options]');
  process.exit(1);
}
await commands[cmd]();
