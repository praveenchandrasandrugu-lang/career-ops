#!/usr/bin/env node
/**
 * everify-check.mjs — zero-token E-Verify enrollment checks over the official
 * USCIS E-Verify Employer Search export at data/everify/everify_{STATE}.csv
 * (UTF-16LE, tab-separated, one file per hiring-site state; employers with
 * sites in N states appear in N files).
 *
 * WHY: on F-1 STEM OPT the employer MUST be enrolled in E-Verify (and remain
 * in good standing) — this is the legal gate, independent of H-1B sponsorship.
 * A company can sponsor H-1B yet not be E-Verify enrolled, and vice versa.
 *
 * Subcommands:
 *   index                    Build/refresh data/everify/everify-rows.tsv
 *                            (dedup of exact duplicate rows across state
 *                            files; conflicting rows are all preserved).
 *   check <company>          Enrollment verdict for one company. Matching is
 *                            confidence-tiered (exact > prefix > word > raw
 *                            substring after stripping legal suffixes);
 *                            ENROLLED requires a high-confidence Open match,
 *                            weaker hits yield POSSIBLE MATCH.
 *   states                   Per-state enrolled-employer counts + state
 *                            E-Verify-mandate tier. Mandate states = higher
 *                            odds that ANY local employer already qualifies
 *                            for STEM OPT.
 *
 * All output JSON unless --summary (human table). Exit 0 always: advisory.
 * "not-found" is NOT proof of non-enrollment — employers enroll under legal
 * names the public may not recognize; confirm with the recruiter before
 * ruling a company out.
 */
import { createReadStream, existsSync, readdirSync, createWriteStream, renameSync } from 'fs';
import { createInterface } from 'readline';

const DIR = 'data/everify';
const IDX = `${DIR}/everify-rows.tsv`;
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => args.includes(name);

// State E-Verify mandates for PRIVATE employers. Each threshold traced to the
// statute or the state agency administering it (verified 2026-07-20; an
// earlier from-memory version of this map had FOUR wrong entries, so do not
// edit these without re-checking the citation).
//
//   AL  all    Ala. Code 31-13-15
//   AZ  all    A.R.S. 23-214
//   MS  all    Miss. Code 71-11-3
//   SC  all    SC Code 41-8-20 (llr.sc.gov/immigration/verification.aspx)
//   NC  25+    NCGS 64-25; NC DOL: "private employers with 24 or fewer
//              employees are not required to use E-Verify"
//   GA  11+    GA Code 36-60-6 says "more than 10 employees"
//   FL  25+    Fla. Stat. 448.095 (2023 SB 1718)
//   TN  35+    T.C.A. 50-1-703, 35+ FTE under one FEIN, eff. 2023-01-01
//              (was 50+). NOTE: 2026 HB1194 drops this to 1+ employee
//              effective 2027-01-01 — revisit this entry then.
//   UT  150+   Utah Code 13-47 (Private Employer Verification Act); HB 252
//              (2022) raised the threshold from 15 to 150.
//   LA  option La. R.S. 23:995 — private employers may use E-Verify OR retain
//              documents, so enrollment is NOT implied. Public-works
//              contractors must use E-Verify.
//
// Read the thresholds correctly: they say which employers are REQUIRED to
// enroll, not which ones did. Plenty of sub-threshold employers enroll
// voluntarily (for liability protection), and a federal contractor of any
// size must enroll regardless of state law. So a state mandate raises the
// PRIOR that a given employer is enrolled — it never substitutes for the
// per-employer `check` against the actual USCIS data.
const MANDATE = {
  AL: 'all', AZ: 'all', MS: 'all', SC: 'all',
  NC: '25+', FL: '25+', GA: '11+', TN: '35+', UT: '150+', LA: 'option',
};

// BLS unemployed-persons-per-job-opening, seasonally adjusted, Dec 2025
// (bls.gov/charts/state-job-openings-and-labor-turnover). US average: 1.1.
// LOWER = tighter labor market = employer competing for the candidate rather
// than the reverse. This is the real evidence behind the "thin market" thesis,
// replacing a pure weather heuristic. Caveat that matters: this measures
// market tightness overall, NOT applicants-per-posting for analyst roles
// specifically — no public dataset gives that.
const TIGHTNESS = {
  ND: 0.5, SD: 0.5, OK: 0.7, ID: 0.8, ME: 0.8, MS: 0.8, MT: 0.8, NE: 0.8,
  VT: 0.8, WV: 0.8, AR: 0.9, IA: 0.9, KS: 0.9, WY: 0.9, AK: 1.1, NM: 1.3,
};
const US_TIGHTNESS = 1.1;

// 2024 Census population estimates, millions, rounded — coarse denominator so
// enrollment density (enrolled employers per 10k residents) can be computed
// from the data itself instead of trusting the law list alone.
const POP = {
  AL: 5.2, AK: 0.7, AZ: 7.6, AR: 3.1, CA: 39.4, CO: 6.0, CT: 3.7, DE: 1.1,
  DC: 0.7, FL: 23.0, GA: 11.2, HI: 1.4, ID: 2.0, IL: 12.6, IN: 6.9, IA: 3.2,
  KS: 3.0, KY: 4.6, LA: 4.6, ME: 1.4, MD: 6.3, MA: 7.1, MI: 10.1, MN: 5.8,
  MS: 2.9, MO: 6.2, MT: 1.1, NE: 2.0, NV: 3.3, NH: 1.4, NJ: 9.5, NM: 2.1,
  NY: 19.9, NC: 11.0, ND: 0.8, OH: 11.8, OK: 4.1, OR: 4.3, PA: 13.0, RI: 1.1,
  SC: 5.5, SD: 0.9, TN: 7.2, TX: 31.0, UT: 3.5, VT: 0.6, VA: 8.8, WA: 8.0,
  WV: 1.8, WI: 6.0, WY: 0.6, PR: 3.2,
};

// Thin/tight labor markets: states where BLS reports FEWER unemployed people
// per job opening than the US average (1.1) — i.e. employers are competing for
// candidates. Derived from TIGHTNESS above, not asserted by hand.
//
// This CORRECTS an earlier hand-written "harsh weather" list (2026-07-19) that
// was folk reasoning. Two of its members fail on the data and were dropped:
// New Mexico (1.3 — worse than the national average) and Alaska (1.1 — merely
// average). Cold winters and a thin labor market are correlated, but the
// labor-market number is the thing that actually matters, so use it directly.
const THIN = new Set(Object.entries(TIGHTNESS).filter(([, v]) => v < US_TIGHTNESS).map(([k]) => k));

const COLS = ['employer', 'dba', 'status', 'everifyPlus', 'enrolled', 'terminated', 'workforce', 'states', 'sites'];

// Legal-suffix noise stripped before matching. "WALMART INC." and "Walmart"
// must meet; a bare query of "Inc" or "The" must never match anything.
// Order matters: dots are removed FIRST so "L.L.C." collapses to the LLC
// token instead of splintering into L/L/C, THEN punctuation becomes spaces,
// THEN noise tokens are dropped whole.
const NOISE = new Set(['INC', 'INCORPORATED', 'LLC', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'LP', 'LLP', 'PLLC', 'PC', 'PA', 'GROUP', 'HOLDING', 'HOLDINGS', 'THE']);
const norm = (s) => s.toUpperCase().replace(/\./g, '').replace(/[^A-Z0-9 ]/g, ' ')
  .split(/\s+/).filter((t) => t && !NOISE.has(t)).join(' ');

const parseDate = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s || '');
  return m ? new Date(+m[3], +m[1] - 1, +m[2]) : null;
};

// ---------------------------------------------------------------- index

async function buildIndex() {
  const files = readdirSync(DIR).filter((f) => /^everify_[A-Z]+\.csv$/.test(f));
  if (!files.length) {
    console.error(JSON.stringify({ error: `no everify_*.csv files in ${DIR}` }));
    process.exit(0);
  }
  const seen = new Map(); // full-content key -> row (exact dupes only; conflicts all kept)
  let raw = 0;
  for (const f of files) {
    const rl = createInterface({
      input: createReadStream(`${DIR}/${f}`, { encoding: 'utf16le' }),
      crlfDelay: Infinity,
    });
    let header = null;
    const st = f.slice(8, -4); // everify_XX.csv -> XX
    for await (let line of rl) {
      line = line.replace(/^﻿/, '');
      const p = line.split('\t');
      if (!header) { header = Object.fromEntries(p.map((c, i) => [c.trim(), i])); continue; }
      if (p.length < 3) continue;
      raw++;
      const g = (col) => (p[header[col]] || '').trim();
      const employer = g('Employer');
      if (!employer) continue;
      const row = {
        employer, dba: g('Doing Business As'),
        status: g('Account Status'),
        everifyPlus: g('Opted into E-Verify+'),
        enrolled: g('Date Enrolled'),
        terminated: g('Date Terminated'),
        workforce: g('Workforce Size'),
        states: g('Hiring Site Locations'),
        sites: g('Number of Hiring Sites').replace(/,/g, ''),
      };
      // Key on EVERY meaningful column: rows that differ in workforce, states,
      // termination, etc. are distinct E-Verify accounts and must all survive.
      const key = COLS.map((c) => row[c].toUpperCase()).join('|');
      const prev = seen.get(key);
      if (prev) { prev.fileStates.add(st); continue; }
      row.fileStates = new Set([st]);
      seen.set(key, row);
    }
  }
  const tmp = `${IDX}.tmp`;
  const out = createWriteStream(tmp, { encoding: 'utf8' });
  out.write(COLS.join('\t') + '\n');
  for (const r of seen.values()) {
    // Some rows leave Hiring Site Locations blank; recover from which state
    // files the employer appeared in.
    const states = r.states || [...r.fileStates].filter((s) => s !== 'NULL').join(',');
    out.write(COLS.map((c) => String(c === 'states' ? states : r[c]).replace(/[\t\n\r]/g, ' ')).join('\t') + '\n');
  }
  await new Promise((res, rej) => { out.end(() => res()); out.on('error', rej); });
  renameSync(tmp, IDX); // atomic-ish: a crashed build never poisons the index
  console.log(JSON.stringify({ built: IDX, rawRows: raw, uniqueRows: seen.size, files: files.length }));
}

// ---------------------------------------------------------------- shared

async function* rows() {
  if (!existsSync(IDX)) {
    console.error(`index missing — building ${IDX} first...`);
    await buildIndex();
  }
  let header = null;
  const rl = createInterface({ input: createReadStream(IDX, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const p = line.split('\t');
    if (!header) { header = true; continue; }
    if (p.length < COLS.length) continue;
    yield Object.fromEntries(COLS.map((c, i) => [c, p[i]]));
  }
}

const table = (list, cols) => {
  const widths = cols.map((c) => Math.max(c.length, ...list.map((r) => String(r[c] ?? '').length)));
  console.log(cols.map((c, i) => c.padEnd(widths[i])).join('  '));
  for (const r of list) console.log(cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  '));
};

// ---------------------------------------------------------------- check

// Confidence tiers: 0 exact (normalized), 1 prefix, 2 whole-word phrase,
// 3 raw substring. ENROLLED demands <=1; tiers 2-3 only ever say POSSIBLE.
function confidence(nq, r) {
  const ne = norm(r.employer);
  const nd = norm(r.dba);
  if (ne === nq || (nd && nd === nq)) return 0;
  if (ne.startsWith(nq + ' ') || (nd && nd.startsWith(nq + ' '))) return 1;
  if (` ${ne} `.includes(` ${nq} `) || (nd && ` ${nd} `.includes(` ${nq} `))) return 2;
  if (ne.includes(nq) || (nd && nd.includes(nq))) return 3;
  return -1;
}

async function cmdCheck(q) {
  if (!q) { console.error('usage: node everify-check.mjs check <company>'); process.exit(0); }
  const nq = norm(q);
  if (nq.length < 3) {
    console.log(JSON.stringify({ query: q, verdict: `QUERY TOO GENERIC — "${q}" normalizes to "${nq}"; pass a distinctive company name.` }));
    return;
  }
  const matches = [];
  for await (const r of rows()) {
    const conf = confidence(nq, r);
    if (conf < 0) continue;
    // A termination date on an Open account is a red flag even before the
    // status flips — surface it, don't count it as a clean enrollment.
    const termDate = parseDate(r.terminated);
    const clean = r.status === 'Open' && !termDate;
    const statusRank = clean ? 0 : r.status === 'Open' ? 1 : 2;
    matches.push({ conf, statusRank, enrolledAt: parseDate(r.enrolled)?.getTime() ?? 0, ...r });
  }
  matches.sort((a, b) => a.conf - b.conf || a.statusRank - b.statusRank || b.enrolledAt - a.enrolledAt || a.employer.localeCompare(b.employer));
  const strong = matches.filter((m) => m.conf <= 1);
  const strongClean = strong.filter((m) => m.statusRank === 0);
  const strongDirty = strong.filter((m) => m.statusRank === 1); // Open but termination date on record
  const strongTerm = strong.filter((m) => m.statusRank === 2);
  const weakOpen = matches.filter((m) => m.conf >= 2 && m.status === 'Open');

  let verdict;
  if (strongClean.length) {
    const caveats = [
      strongDirty.length ? `${strongDirty.length} Open account(s) with a termination date on record` : '',
      strongTerm.length ? `${strongTerm.length} terminated account(s)` : '',
    ].filter(Boolean).join(' and ');
    verdict = `ENROLLED — ${strongClean.length} clean Open E-Verify account(s) match "${q}"${caveats ? ` (also on record: ${caveats} — confirm which entity is hiring)` : ''}. STEM OPT eligible employer.`;
  } else if (strongDirty.length) {
    verdict = `ENROLLED (VERIFY) — Open account(s) match "${q}" but carry a termination date on record. Confirm current good standing with the recruiter before relying on it for STEM OPT.`;
  } else if (strongTerm.length) {
    verdict = `TERMINATED — only terminated E-Verify account(s) match "${q}". NOT currently valid for STEM OPT; confirm with recruiter (they may have re-enrolled under another legal name).`;
  } else if (weakOpen.length) {
    verdict = `POSSIBLE MATCH — no exact/prefix match for "${q}", but ${weakOpen.length} Open account(s) contain it (e.g. "${weakOpen[0].employer}"). Confirm the legal employer name with the recruiter; do not treat as verified.`;
  } else {
    verdict = `NOT FOUND — no E-Verify account matches "${q}". Not proof of non-enrollment (legal name may differ). Ask the recruiter: "Is ${q} enrolled in E-Verify?" before applying energy here.`;
  }
  const top = matches.slice(0, 15).map(({ conf, statusRank, enrolledAt, ...r }) => r);
  if (flag('--summary')) {
    console.log(verdict);
    if (top.length) table(top, ['employer', 'dba', 'status', 'enrolled', 'terminated', 'workforce', 'states']);
  } else {
    console.log(JSON.stringify({
      query: q, verdict,
      strongOpen: strongClean.length, strongOpenWithTermDate: strongDirty.length,
      strongTerminated: strongTerm.length, weakOpen: weakOpen.length,
      matches: top,
    }, null, 2));
  }
}

// ---------------------------------------------------------------- states

async function cmdStates() {
  const byState = new Map();
  for await (const r of rows()) {
    if (r.status !== 'Open') continue;
    for (const s of r.states.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!/^[A-Z]{2}$/.test(s)) continue;
      byState.set(s, (byState.get(s) || 0) + 1);
    }
  }
  const list = [...byState.entries()]
    .map(([state, employers]) => ({
      state, employers,
      per10k: POP[state] ? Math.round(employers / (POP[state] * 100)) : '',
      mandate: MANDATE[state] || '',
      unempPerOpening: TIGHTNESS[state] ?? '',
      thinMarket: THIN.has(state) ? 'yes' : '',
    }))
    .sort((a, b) => b.employers - a.employers);
  if (flag('--summary')) table(list, ['state', 'employers', 'per10k', 'mandate', 'unempPerOpening', 'thinMarket']);
  else console.log(JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------- main

if (cmd === 'index') await buildIndex();
else if (cmd === 'check') await cmdCheck(args.slice(1).filter((a) => !a.startsWith('--')).join(' '));
else if (cmd === 'states') await cmdStates();
else {
  console.log('usage: node everify-check.mjs <index|check <company>|states> [--summary]');
}
