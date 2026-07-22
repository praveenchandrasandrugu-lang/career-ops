// Probe: the CLEAN scoreable pool = clear + has ad text + no failing
// experience bar + no hard wall, broken out by freshness bucket.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyFreshness } from '../freshness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new DatabaseSync(join(ROOT, 'data/queue.db'));

const WORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const NUM = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)';
const BAR = new RegExp(
  `(?:minimum(?:\\s+of)?\\s+)?${NUM}\\s*(?:\\+|or more|plus)?\\s*years?[^.\\n]{0,40}?\\b(?:experience|background|professional)`,
  'gi'
);
const DOOR = /\b(or (?:a )?(?:master|advanced|graduate|bachelor)|or equivalent|in lieu of|equivalent combination|may substitute)\b/i;
const PREF = /\b(preferr?ed|preferably|a plus|nice to have|desirable|desired|ideal|bonus)\b/i;
const WALL = /\b(TS\/SCI|top secret|secret clearance|security clearance|public trust|polygraph|Epic\s+certif|Cerner|\bCCS\b|\bRHIA\b|\bRHIT\b|\bCPC\b|CPA\b|\bCFA\b|\bPMP\b|CISSP|PE\s+licen)\b/i;

const rows = db.prepare(
  "SELECT posted_at, posted_at_confidence, level_status, jd_text FROM jobs " +
  "WHERE queue_status='llm_ready' AND jd_status='ok' AND level_status='clear'"
).all();

const out = {};
for (const r of rows) {
  const t = r.jd_text || '';
  const sents = t.split(/(?<=[.!?;\n])\s+/);
  let fail = false, wall = false;

  for (const s of sents) {
    if (WALL.test(s) && !PREF.test(s)) wall = true;
    BAR.lastIndex = 0;
    let m;
    while ((m = BAR.exec(s))) {
      if (PREF.test(s) || DOOR.test(s)) continue;
      const y = WORD[(m[1] || '').toLowerCase()] ?? parseInt(m[1], 10);
      if (Number.isFinite(y) && y > 2.3 && y <= 20) fail = true;
    }
  }

  const b = classifyFreshness({ postedAt: r.posted_at, confidence: r.posted_at_confidence }).bucket;
  out[b] = out[b] || { total: 0, clean: 0, barFail: 0, wall: 0 };
  out[b].total++;
  if (fail) out[b].barFail++;
  if (wall) out[b].wall++;
  if (!fail && !wall) out[b].clean++;
}

console.log("level_status='clear' + has ad text, by freshness");
console.log('bucket    total   barFail   wall   CLEAN(scoreable)');
let ct = 0, cc = 0;
for (const b of ['hot', 'fresh', 'backup']) {
  const v = out[b];
  if (!v) continue;
  ct += v.total; cc += v.clean;
  console.log(
    b.padEnd(9), String(v.total).padStart(5), String(v.barFail).padStart(9),
    String(v.wall).padStart(6), String(v.clean).padStart(10)
  );
}
console.log('');
console.log(`TOTAL clear: ${ct}   CLEAN and scoreable: ${cc}  (${(100 * cc / ct).toFixed(1)}%)`);
