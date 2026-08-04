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
 *   node apply-sheet.mjs --min 3.0           # include the marginal band (default 3.5: keepers only)
 *   node apply-sheet.mjs --vault D:/notes    # somewhere else
 *   node apply-sheet.mjs --dry-run           # print the plan, write nothing
 *   node apply-sheet.mjs --sync              # read your [x] ticks: mark Applied + write Applied/<date>.md
 *   node apply-sheet.mjs --sync --date 2026-07-31   # ... from an earlier day's sheet
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VAULT = process.env.CAREER_VAULT || 'W:/career-vault';

/**
 * Today where the user is, not in UTC.
 *
 * These notes are named for a person's working day. toISOString() reports the UTC
 * day, so west of Greenwich every evening rolls the filename forward: the sheet
 * published on the evening of the 31st would be born as the 1st, and `--sync`
 * would then look for ticks in a file that does not exist. Nothing errors, it
 * just silently finds nothing.
 */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
    // Two numbers can identify one closed application: the row's own # and the
    // report it links to. They diverge when a duplicate posting is collapsed
    // onto a single row — #564 links to report 580, #570 to 619 — and reading
    // only the link leaves the queue row under the other number looking unsent.
    // That is how Tempus and O'Reilly returned to the sheet as fresh targets
    // the day after they were applied to.
    const link = line.match(/reports\/(\d+)-/);
    if (link) closed.add(String(Number(link[1])));
    const rowNum = line.match(/^\s*\|\s*(\d+)\s*\|/);
    if (rowNum) closed.add(String(Number(rowNum[1])));
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

// No liveness tier. Removed 2026-08-04 on the user's instruction: the checker
// called live Workday reqs expired (3 of 3 false), so it deleted real keepers
// from the sheet and bought nothing. A dead link costs one click to discover;
// a keeper silently dropped is never seen again.
function tierOf(row, minKeeper) {
  if (isAnonymous(row)) return 'anonymous';
  return row.score >= minKeeper ? 'clean' : 'marginal';
}

const TABLE_HEAD = [
  '| Score | Company | Role | CV file (in `output/`) | Report | Apply |',
  '|------:|---------|------|------------------------|-------:|-------|',
].join('\n');

function tableRow(row, cvFile) {
  const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const company = row.company === '?' ? '**?** _(not named)_' : cell(row.company);
  const cv = cvFile ? `\`${cvFile}\`` : '**none yet**';
  return `| **${row.score}** | ${company} | ${cell(row.title)} | ${cv} | ${Number(row.report_num)} | [open](${row.canonical_url}) |`;
}


/**
 * The one place with real, clickable checkboxes.
 *
 * Obsidian renders an interactive checkbox only for a LIST item; inside a table
 * cell the same `[ ]` stays literal text. Tables read better and lists tick
 * better, so the sheet carries both: the tables above are for deciding, this is
 * for recording. Kept deliberately thin (report, company, role) because the
 * detail is thirty lines up and duplicating it twice invites the two copies to
 * disagree.
 */
function checklistFor(allRows) {
  const L = ['## Mark as sent', '',
    '> [!tip] Click a box as you submit, then run `node apply-sheet.mjs --sync`.',
    '> That marks each one Applied in the tracker, seeds its follow-up date, and files it',
    '> under `Applied/` for the day.', ''];
  for (const r of allRows) {
    const title = String(r.title ?? '').replace(/\s+/g, ' ').trim();
    L.push(`- [ ] \`${Number(r.report_num)}\` ${r.company === '?' ? '(employer not named)' : r.company} — ${title}`);
  }
  return L.join('\n');
}

function tableFor(rows, cvs) {
  return [TABLE_HEAD, ...rows.map((r) => tableRow(r, cvs.get(String(Number(r.report_num)))))].join('\n');
}

function buildNote({ date, tiers, counts, minKeeper, outputDir, cvs, marginalCap }) {
  const L = [];
  L.push('---');
  L.push(`date: ${date}`);
  L.push('type: apply-sheet');
  L.push(`total: ${counts.total}`);
  L.push(`clean: ${counts.clean}`);
  L.push(`anonymous: ${counts.anonymous}`);
  L.push(`marginal: ${counts.marginal}`);
  L.push('tags: [career/apply-sheet]');
  L.push('---');
  L.push('');
  L.push(`# Apply sheet — ${date}`);
  L.push('');
  L.push(`> [!info] ${counts.total} targets. Nothing here is submitted.`);
  L.push(`> Ranked within each group. Anything already in the tracker is gone before you see this.`);
  L.push(`> Links are not liveness-checked — if one 404s, that is the check.`);
  L.push('');

  if (tiers.clean.length) {
    L.push(`## Send these first — named employer, ${minKeeper}+`);
    L.push('');
    L.push(tableFor(tiers.clean, cvs));
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
    L.push(tableFor(tiers.anonymous, cvs));
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
    L.push(tableFor(shown, cvs));
    L.push('');
  }

  const everyRow = [...tiers.clean, ...tiers.anonymous, ...tiers.marginal];
  if (everyRow.length) { L.push(checklistFor(everyRow)); L.push(''); }

  L.push('---');
  L.push(`_Generated by \`apply-sheet.mjs\` on ${date}._`);
  return L.join('\n') + '\n';
}

/**
 * Rows you ticked in a published sheet.
 *
 * Parsed out of the rendered note rather than tracked in a database, because the
 * note is the thing you actually touch. Anything else would need you to record
 * the same fact twice.
 */
function tickedRows(notePath) {
  if (!existsSync(notePath)) return [];
  const reports = [];
  for (const line of readFileSync(notePath, 'utf8').split('\n')) {
    // Only the checklist carries state. Obsidian writes `- [x]` when you click,
    // and accepts a typed X, so both forms are matched.
    const m = line.match(/^\s*-\s*\[[xX]\]\s*`(\d+)`/);
    if (m) reports.push(Number(m[1]));
  }
  // Details are read back from the queue, never re-parsed out of the rendered
  // note. The note is a view; the database is the fact.
  return [...new Set(reports)];
}

/**
 * Hand each ticked row to the canonical writers.
 *
 * set-status.mjs owns the tracker (shared lock, strict state validation, atomic
 * write) and followup-seed.mjs owns the follow-up date. Neither is reimplemented
 * here: a second writer to data/applications.md is exactly the thing set-status
 * exists to prevent.
 */
function markApplied(rows, { dryRun, date }) {
  const results = [];
  for (const r of rows) {
    // The note carries the sheet's date, not today's. followup-seed.mjs resolves
    // its anchor from the "Applied YYYY-MM-DD" text in this note, so stamping
    // today onto a sheet ticked three days ago would push every follow-up three
    // days late for applications that already went out.
    const args = [String(r.report), 'Applied', '--note', `Applied ${date} via vault sheet`, '--json'];
    if (dryRun) args.push('--dry-run');
    const status = spawnSync('node', ['set-status.mjs', ...args], { cwd: HERE, encoding: 'utf8' });
    const ok = status.status === 0;
    let followup = null;
    if (ok && !dryRun) {
      const seed = spawnSync('node', ['followup-seed.mjs', String(r.report), '--json'], { cwd: HERE, encoding: 'utf8' });
      followup = seed.status === 0 ? 'seeded' : 'failed';
    }
    results.push({
      ...r,
      ok,
      followup,
      // The row can be absent from the tracker entirely (an orphan report), so a
      // failure here is reported, never swallowed — a silent miss would leave a
      // sent application untracked and unfollowed-up.
      error: ok ? null : (status.stderr || status.stdout || '').trim().split('\n').slice(-1)[0],
    });
  }
  return results;
}

/** One note per day listing what actually went out, separate from the shortlist. */
function writeAppliedNote(vault, date, results) {
  const dir = join(vault, 'Applied');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${date}.md`);
  const sent = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  // Append rather than overwrite: syncing twice in one day must not erase the
  // morning's applications.
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const seen = new Set([...existing.matchAll(/\|\s*(\d+)\s*\|/g)].map((m) => m[1]));
  const fresh = sent.filter((r) => !seen.has(String(r.report)));

  const L = [];
  if (!existing) {
    L.push('---', `date: ${date}`, 'type: applied', 'tags: [career/applied]', '---', '');
    L.push(`# Applied — ${date}`, '');
    L.push('> [!success] Sent, tracked, and follow-up dated. Generated from the ticks on the apply sheet.', '');
    L.push('| Score | Company | Role | CV sent | Report | Posting |');
    L.push('|------:|---------|------|---------|-------:|---------|');
  }
  for (const r of fresh) {
    L.push(`| ${r.score} | ${r.company} | ${r.title} | \`${r.cv}\` | ${r.report} | [open](${r.url}) |`);
  }
  if (failed.length) {
    L.push('', '> [!failure] Not recorded in the tracker, needs a look');
    for (const r of failed) L.push(`> - ${r.report} ${r.company}: ${r.error}`);
  }
  writeFileSync(path, existing + L.join('\n') + '\n');
  return { path, added: fresh.length, alreadyThere: sent.length - fresh.length, failed: failed.length };
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

/**
 * --sync: read the ticks, record them, and republish the shortlist without them.
 *
 * The republish is deliberate and safe: a row you ticked is now `Applied` in the
 * tracker, so closedReportNums() filters it out on the next build. Your ticks are
 * consumed rather than preserved, which is why they are written to the Applied
 * note FIRST — if the republish were the record, a regeneration would erase it.
 */
async function sync({ vault, date }) {
  const notePath = join(vault, 'Apply Sheets', `${date}.md`);
  const reports = tickedRows(notePath);
  if (!reports.length) {
    console.log(JSON.stringify({ ok: true, ticked: 0, note: notePath, hint: 'Nothing ticked under "Mark as sent" on the sheet for this date.' }, null, 2));
    return;
  }
  const { openQueue } = await import('./queue.mjs');
  const db = await openQueue();
  const cvs = cvIndex(join(HERE, 'output'));
  const rows = reports.map((report) => {
    const j = db.prepare('SELECT score, company, title, canonical_url FROM jobs WHERE CAST(report_num AS INTEGER) = ?').get(report) || {};
    return {
      report,
      score: j.score ?? '?',
      company: j.company === '?' || !j.company ? '(not named)' : j.company,
      title: j.title ?? '',
      url: j.canonical_url ?? '',
      cv: cvs.get(String(report)) ?? 'none',
    };
  });

  const results = markApplied(rows, { dryRun: DRY, date });
  if (DRY) {
    console.log(JSON.stringify({ ok: true, dryRun: true, wouldMark: results.map((r) => ({ report: r.report, company: r.company, ok: r.ok, error: r.error })) }, null, 2));
    return;
  }
  const written = writeAppliedNote(vault, date, results);
  console.log(JSON.stringify({ ok: true, ticked: reports.length, ...written }, null, 2));
}

async function main() {
  const vault = flag('--vault', DEFAULT_VAULT);
  const min = Number(flag('--min', '3.5'));
  const minKeeper = Number(flag('--keeper', '3.5'));
  const marginalCap = Number(flag('--marginal-cap', '20'));
  const outputDir = join(HERE, 'output');
  // A sheet is only syncable on the day it was published unless the day can be
  // named. Ticks are recorded in the note and consumed by --sync, so a sheet
  // ticked on Friday and synced on Monday would otherwise strand every
  // application on it: --sync reads today's note, finds nothing, and exits ok.
  const date = flag('--date', localDate());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`--date must be YYYY-MM-DD: ${date}`);
    process.exit(1);
  }

  if (process.argv.includes('--sync')) return sync({ vault, date });

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

  // Cap the marginal tail so the deep, near-identical fill does not bury the
  // rows above it.
  const preTier = { clean: [], anonymous: [], marginal: [] };
  for (const r of rows) preTier[tierOf(r, minKeeper)].push(r);
  const marginalTotal = preTier.marginal.length;
  preTier.marginal = preTier.marginal.slice(0, marginalCap);
  rows = [...preTier.clean, ...preTier.anonymous, ...preTier.marginal];

  const tiers = { clean: [], anonymous: [], marginal: [] };
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
  };

  const note = buildNote({ date, tiers, counts, minKeeper, outputDir, cvs: cvIndex(outputDir), marginalCap });

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
