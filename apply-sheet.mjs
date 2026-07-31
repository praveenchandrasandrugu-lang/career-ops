#!/usr/bin/env node
/**
 * apply-sheet.mjs — publish the day's ranked shortlist as an Obsidian note.
 *
 * The markdown table this replaces was fine for a machine and poor for a human:
 * one flat 34-row grid where the 4.0 you should think twice about looked exactly
 * like the 3.5 you should just send. This groups by decision instead of by score,
 * turns each row into a checkbox you tick as you submit, and puts the caveats in
 * callouts where they cannot be skimmed past.
 *
 * The vault lives OUTSIDE the repo on purpose. career-ops' fork is public and
 * `data/` here is gitignored file-by-file rather than wholesale, so every new
 * user-layer filename is one forgotten .gitignore line away from being published.
 * A vault at a sibling path cannot be committed by accident at all.
 *
 * Usage:
 *   node apply-sheet.mjs                     # publish to the default vault
 *   node apply-sheet.mjs --min 3.5           # keepers only (default 3.0)
 *   node apply-sheet.mjs --liveness          # re-check every URL first (slow, worth it)
 *   node apply-sheet.mjs --vault D:/notes    # somewhere else
 *   node apply-sheet.mjs --dry-run           # print the plan, write nothing
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VAULT = process.env.CAREER_VAULT || 'W:/career-vault';

/** States that mean "this one is already dealt with, never re-offer it". */
const CLOSED_STATES = /\|\s*(Applied|Interview|Responded|Offer|Rejected|SKIP|Discarded)\s*\|/;

function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const DRY = process.argv.includes('--dry-run');

/**
 * Report numbers already resolved in the tracker.
 *
 * report_num arrives from SQLite as a string on some rows and a number on others,
 * so every comparison goes through String(Number(x)). Skipping that normalisation
 * silently offers you roles you already applied to — the Set lookup just never
 * matches and nothing errors.
 */
function closedReportNums(trackerPath) {
  if (!existsSync(trackerPath)) return new Set();
  const closed = new Set();
  for (const line of readFileSync(trackerPath, 'utf8').split('\n')) {
    if (!CLOSED_STATES.test(line)) continue;
    const m = line.match(/reports\/(\d+)-/);
    if (m) closed.add(String(Number(m[1])));
  }
  return closed;
}

/**
 * Tailored CVs on disk, indexed by every report number in the filename.
 *
 * One PDF can serve several near-identical reqs, and those are named for all of
 * them (`cv-candidate-707-706-bi-analyst-...`), so each number maps to the file.
 */
function cvIndex(outputDir) {
  const byReport = new Map();
  if (!existsSync(outputDir)) return byReport;
  for (const f of readdirSync(outputDir)) {
    if (!f.startsWith('cv-candidate-') || !f.endsWith('.pdf')) continue;
    const ids = f.slice('cv-candidate-'.length).split('-');
    for (const part of ids) {
      if (!/^\d+$/.test(part)) break; // the numeric run ends where the slug starts
      const key = String(Number(part));
      // Newest wins: a rebuilt CV should replace yesterday's for the same req.
      const prev = byReport.get(key);
      if (!prev || f > prev) byReport.set(key, f);
    }
  }
  return byReport;
}

/**
 * Companies on the opt-in do-not-apply ledger.
 *
 * Tracker state cannot carry this. A row can be SKIP'd, but the next scan finds
 * the same employer under a new req number with no tracker row at all — Arkansas
 * Blue Cross was SKIP'd as report 372 and came straight back as an orphan 560.
 * The ledger is per-EMPLOYER, which is the level the decision was actually made at.
 *
 * Format: one company per line, `#` comments ignored. Matching is loose on both
 * sides because the scanner's slug (`arkbluecross`) and the legal name
 * (`USAble Mutual`) are rarely the same string.
 */
function blacklistMatcher(path) {
  if (!existsSync(path)) return () => false;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const entries = readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map(norm)
    .filter((s) => s.length >= 4); // a 3-char entry would match half the dataset
  if (!entries.length) return () => false;
  return (company) => {
    const c = norm(company);
    return c.length > 0 && entries.some((e) => c.includes(e) || e.includes(c));
  };
}

/** An ad nobody is named in still came from somewhere; say where. */
function isAnonymous(row) {
  return row.company === '?' || /jobgether/i.test(row.company || '');
}

function tierOf(row, minKeeper) {
  if (row.liveness === 'uncertain') return 'uncertain';
  if (isAnonymous(row)) return 'anonymous';
  return row.score >= minKeeper ? 'clean' : 'marginal';
}

/** Run the real liveness checker rather than trusting a score from hours ago. */
function checkLiveness(urls) {
  const res = spawnSync('node', ['check-liveness.mjs', '--throttle=400', ...urls], {
    cwd: HERE, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const status = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^(✅ active|❌ expired|⚠️ uncertain)\s+(?:\(api\)\s+)?(\S+)/);
    if (m) status.set(m[2], m[1].includes('active') ? 'active' : m[1].includes('expired') ? 'expired' : 'uncertain');
  }
  return status;
}

function taskLine(row, cvFile, outputDir) {
  const cv = cvFile
    ? `[CV](file:///${join(outputDir, cvFile).replace(/\\/g, '/')})`
    : '_no tailored CV_';
  const company = row.company === '?' ? '**?** (employer not named)' : row.company;
  return [
    `- [ ] **${row.score}** · ${company} — ${row.title}`,
    `    - [Apply](${row.canonical_url}) · ${cv} · report \`${Number(row.report_num)}\``,
  ].join('\n');
}

function buildNote({ date, tiers, counts, minKeeper, outputDir, cvs, livenessRan, marginalCap }) {
  const L = [];
  L.push('---');
  L.push(`date: ${date}`);
  L.push('type: apply-sheet');
  L.push(`total: ${counts.total}`);
  L.push(`clean: ${counts.clean}`);
  L.push(`anonymous: ${counts.anonymous}`);
  L.push(`marginal: ${counts.marginal}`);
  L.push(`liveness_checked: ${livenessRan}`);
  L.push('tags: [career/apply-sheet]');
  L.push('---');
  L.push('');
  L.push(`# Apply sheet — ${date}`);
  L.push('');
  L.push(`> [!info] ${counts.total} live targets. Nothing here is submitted; ticking a box is your record, not an action.`);
  L.push(`> Ranked within each group. Expired postings and anything already in the tracker are gone before you see this.`);
  L.push('');

  if (tiers.clean.length) {
    L.push(`## Send these first — named employer, ${minKeeper}+`);
    L.push('');
    L.push(tiers.clean.map((r) => taskLine(r, cvs.get(String(Number(r.report_num))), outputDir)).join('\n'));
    L.push('');
  }

  if (tiers.anonymous.length) {
    L.push('## Employer not named');
    L.push('');
    L.push('> [!warning] Read the score differently here');
    L.push('> These ads say the role is listed on behalf of an unnamed partner. E-Verify cannot be');
    L.push('> checked, so your hard employer gate does not apply. They also score *high because');
    L.push('> information is missing*: no sponsorship clause, no clearance line and no named cert');
    L.push('> means nothing was there to pull the score down. A 4.1 here is not better than a 3.7');
    L.push('> from a named company.');
    L.push('');
    L.push(tiers.anonymous.map((r) => taskLine(r, cvs.get(String(Number(r.report_num))), outputDir)).join('\n'));
    L.push('');
  }

  if (tiers.marginal.length) {
    // Capped, and the cap is stated. An uncapped marginal group is 40+ rows of
    // near-identical fill that buries the 15 above it — the exact problem a flat
    // table had. Silent truncation would be worse than no cap: it reads as "that
    // was everything".
    const shown = tiers.marginal;
    const hidden = (tiers.marginalTotal ?? shown.length) - shown.length;
    L.push(`## Marginal — below ${minKeeper}`);
    L.push('');
    L.push('> [!caution] Fill material, not targets. Send these only after the groups above are done.');
    if (hidden > 0) {
      L.push(`> Showing the top ${shown.length} of ${tiers.marginalTotal}; ${hidden} lower-scoring row(s) omitted.`);
      L.push(`> Run \`node apply-sheet.mjs --marginal-cap ${tiers.marginalTotal}\` to see all of them.`);
    }
    L.push('');
    L.push(shown.map((r) => taskLine(r, cvs.get(String(Number(r.report_num))), outputDir)).join('\n'));
    L.push('');
  }

  if (tiers.uncertain.length) {
    L.push('## Liveness uncertain');
    L.push('');
    L.push('> [!question] The page loaded but no apply control was found. Open it before writing anything.');
    L.push('');
    L.push(tiers.uncertain.map((r) => taskLine(r, cvs.get(String(Number(r.report_num))), outputDir)).join('\n'));
    L.push('');
  }

  L.push('---');
  L.push(`_Generated by \`apply-sheet.mjs\` on ${date}._`);
  return L.join('\n') + '\n';
}

/** Create the vault on first run so Obsidian opens it without a setup prompt. */
function ensureVault(vault) {
  const sheets = join(vault, 'Apply Sheets');
  mkdirSync(sheets, { recursive: true });
  const obsidian = join(vault, '.obsidian');
  mkdirSync(obsidian, { recursive: true });
  const appJson = join(obsidian, 'app.json');
  if (!existsSync(appJson)) {
    // Live preview + readable line length: the sheet is a reading document.
    writeFileSync(appJson, JSON.stringify({ readableLineLength: true, strictLineBreaks: false }, null, 2));
  }
  const home = join(vault, 'Home.md');
  if (!existsSync(home)) {
    writeFileSync(home, [
      '# Career vault', '',
      'Job-search working notes. Everything here is generated or hand-written locally and',
      'is deliberately OUTSIDE the career-ops repo, whose fork is public.', '',
      '## Apply sheets', '',
      'One note per scoring run, newest first, in `Apply Sheets/`.',
      'Regenerate the latest with `node apply-sheet.mjs` from the repo.', '',
    ].join('\n'));
  }
  return sheets;
}

/** Newest-first index so the vault has one obvious entry point. */
function writeIndex(sheetsDir) {
  const notes = readdirSync(sheetsDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse();
  const lines = ['# Apply sheets', '', 'Newest first.', ''];
  for (const n of notes) lines.push(`- [[${n.replace(/\.md$/, '')}]]`);
  writeFileSync(join(sheetsDir, 'Index.md'), lines.join('\n') + '\n');
  return notes.length;
}

async function main() {
  const vault = flag('--vault', DEFAULT_VAULT);
  const min = Number(flag('--min', '3.0'));
  const minKeeper = Number(flag('--keeper', '3.5'));
  const marginalCap = Number(flag('--marginal-cap', '20'));
  const outputDir = join(HERE, 'output');
  const date = new Date().toISOString().slice(0, 10);

  const { openQueue } = await import('./queue.mjs');
  const db = await openQueue();
  const closed = closedReportNums(join(HERE, 'data', 'applications.md'));

  const blacklisted = blacklistMatcher(join(HERE, 'data', 'blacklist.md'));

  const all = db.prepare('SELECT score, company, title, report_num, canonical_url FROM jobs WHERE score IS NOT NULL AND score >= ? ORDER BY score DESC')
    .all(min)
    .filter((r) => r.report_num != null && !closed.has(String(Number(r.report_num))));
  let rows = all.filter((r) => !blacklisted(r.company));
  const blocked = all.length - rows.length;
  if (blocked) console.error(`blacklist: ${blocked} row(s) held back by data/blacklist.md`);

  // Cap the marginal tail BEFORE the liveness pass, not after. Liveness is one
  // network round trip per URL and the deep tail is never published, so checking
  // it first spends minutes proving that rows nobody will read are still open.
  const preTier = { clean: [], anonymous: [], marginal: [], uncertain: [] };
  for (const r of rows) preTier[tierOf(r, minKeeper)].push(r);
  const marginalTotal = preTier.marginal.length;
  preTier.marginal = preTier.marginal.slice(0, marginalCap);
  rows = [...preTier.clean, ...preTier.anonymous, ...preTier.marginal];

  let livenessRan = false;
  if (process.argv.includes('--liveness') && rows.length) {
    const status = checkLiveness(rows.map((r) => r.canonical_url));
    livenessRan = true;
    const before = rows.length;
    rows = rows
      .map((r) => ({ ...r, liveness: status.get(r.canonical_url) ?? 'unknown' }))
      .filter((r) => r.liveness !== 'expired');
    console.error(`liveness: checked ${before}, dropped ${before - rows.length} expired`);
  }

  const tiers = { clean: [], anonymous: [], marginal: [], uncertain: [] };
  for (const r of rows) tiers[tierOf(r, minKeeper)].push(r);
  // Restore the true marginal total so the note reports what was omitted, not
  // the post-cap number, which would make a silent truncation look complete.
  tiers.marginalTotal = marginalTotal;
  const counts = {
    total: rows.length,
    clean: tiers.clean.length,
    anonymous: tiers.anonymous.length,
    marginal: tiers.marginal.length,
    marginalTotal,
    uncertain: tiers.uncertain.length,
  };

  const note = buildNote({ date, tiers, counts, minKeeper, outputDir, cvs: cvIndex(outputDir), livenessRan, marginalCap });

  if (DRY) {
    console.log(JSON.stringify({ ok: true, dryRun: true, vault, counts }, null, 2));
    return;
  }

  const sheetsDir = ensureVault(vault);
  const notePath = join(sheetsDir, `${date}.md`);
  writeFileSync(notePath, note);
  const indexed = writeIndex(sheetsDir);

  console.log(JSON.stringify({ ok: true, note: notePath, indexed, counts }, null, 2));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, '/').replace(/^([a-z]):/i, (m) => m.toUpperCase());
if (isMain || process.argv[1]?.endsWith('apply-sheet.mjs')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { closedReportNums, cvIndex, isAnonymous, tierOf, buildNote };
