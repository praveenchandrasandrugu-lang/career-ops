// Probe: do rows tagged level_status='clear' actually contain an experience bar
// that screen-jd.mjs failed to detect? Candidate has ~2.3 yrs (28 months).
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(join(ROOT, 'data/queue.db'));
const CANDIDATE_YEARS = 2.3;

// Written-out numbers matter: "three years" is as common as "3 years".
const WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const NUM = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)';

// A bar = a number of years tied to experience language, in either order.
const BAR = new RegExp(
  `(?:minimum(?:\\s+of)?\\s+)?${NUM}\\s*(?:\\+|or more|plus)?\\s*(?:-\\s*\\d{1,2}\\s*)?years?[^.\\n]{0,40}?\\b(?:experience|exp\\.|background|working|professional|industry|relevant)`
  + `|\\b(?:experience|background)[^.\\n]{0,30}?\\b(?:of|at least|minimum(?: of)?)\\s+${NUM}\\s*(?:\\+|or more)?\\s*years?`,
  'gi'
);

// Escape hatches from modes/_custom.md: the difference between a wall and a door.
const DEGREE_ESCAPE = /\b(or (?:a )?(?:master'?s?|advanced|graduate|bachelor'?s?)(?: level)?(?: degree)?|master'?s? (?:degree )?(?:may substitute|in lieu|or equivalent)|or equivalent (?:experience|combination|education)|equivalent combination of education|in lieu of experience|education (?:may|can) substitute)\b/i;
const PREF_CONTEXT = /\b(preferred|a plus|nice to have|desirable|desired|ideal|bonus)\b/i;

const rows = db.prepare(
  "SELECT canonical_url, company, title, level_status, jd_text FROM jobs " +
  "WHERE queue_status='llm_ready' AND jd_status='ok' AND level_status='clear'"
).all();

let withBar = 0, barFailing = 0, escaped = 0, prefOnly = 0;
const dist = {};
const samples = [];

for (const r of rows) {
  const t = r.jd_text || '';
  const sentences = t.split(/(?<=[.!?;\n])\s+/);
  let worst = 0, worstSent = null, hadEscape = false, hadPrefOnly = false;

  for (const s of sentences) {
    BAR.lastIndex = 0;
    let m;
    while ((m = BAR.exec(s))) {
      const raw = (m[1] ?? m[2] ?? '').toLowerCase();
      const yrs = WORD[raw] ?? parseInt(raw, 10);
      if (!Number.isFinite(yrs) || yrs < 1 || yrs > 20) continue;
      if (PREF_CONTEXT.test(s)) { hadPrefOnly = true; continue; }
      if (DEGREE_ESCAPE.test(s)) { hadEscape = true; continue; }
      if (yrs > worst) { worst = yrs; worstSent = s.trim().slice(0, 150); }
    }
  }

  if (worst > 0) {
    withBar++;
    dist[worst] = (dist[worst] || 0) + 1;
    if (worst > CANDIDATE_YEARS) {
      barFailing++;
      if (samples.length < 10) samples.push({ company: r.company, title: r.title, yrs: worst, s: worstSent });
    }
  } else if (hadEscape) escaped++;
  else if (hadPrefOnly) prefOnly++;
}

console.log(`level_status='clear' rows with ad text : ${rows.length}`);
console.log(`  contain an UNDETECTED experience bar : ${withBar} (${(100 * withBar / rows.length).toFixed(1)}%)`);
console.log(`  bar EXCEEDS candidate's ${CANDIDATE_YEARS} yrs      : ${barFailing} (${(100 * barFailing / rows.length).toFixed(1)}%)`);
console.log(`  bar present but degree escape hatch   : ${escaped}  (correctly kept)`);
console.log(`  bar present but only under Preferred  : ${prefOnly} (correctly kept)`);
console.log(`  genuinely bar-free                    : ${rows.length - withBar - escaped - prefOnly}`);
console.log('');
console.log('--- distribution of the failing bar ---');
for (const [k, v] of Object.entries(dist).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  ${String(k).padStart(2)} yrs : ${String(v).padStart(4)} ${'#'.repeat(Math.round(v / 8))}`);
}
console.log('');
console.log('--- samples (rows that should NOT have been clear) ---');
for (const s of samples) {
  console.log(`  [${s.yrs}y] ${s.company} :: ${s.title}`);
  console.log(`       "${s.s}"`);
}
