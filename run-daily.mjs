#!/usr/bin/env node
/**
 * run-daily.mjs — the whole pipeline as one command (step 9).
 *
 * Every stage of this system worked before this file existed, but using it meant
 * remembering six scripts in the right order with the right flags:
 *
 *   scan-ats-full → queue-migrate → gate → fetch-jds → screen-queue --apply → score-queue --apply
 *
 * and getting that order wrong does not error. Each stage only touches rows the
 * previous stage produced, so a stage run too early finds an empty input and
 * exits 0 — "it ran and did nothing" is indistinguishable from "there was
 * nothing to do". For something meant to run every morning, that is the worst
 * available failure mode, so the order lives here once instead of in memory.
 *
 * ── The three rules ────────────────────────────────────────────────────────
 *
 * 1. DRY RUN BY DEFAULT, like every other stage in this repo. `--apply` is what
 *    lets a stage write.
 * 2. SCORING IS OPT-IN AND ALWAYS BUDGETED. It is the only stage that spends
 *    money, so `--apply` alone never triggers it; it needs `--score N`. There is
 *    no way to accidentally turn "run the daily thing" into an unbounded spend.
 * 3. A SELECTOR THAT MATCHES NOTHING IS AN ERROR. A typo'd stage name would
 *    otherwise look exactly like a clean run with no work to do.
 *
 * Usage:
 *   node run-daily.mjs                          # dry run: the plan + the funnel
 *   node run-daily.mjs --apply                  # the free stages, for real
 *   node run-daily.mjs --apply --score 25       # ... and score 25 rows (costs money)
 *   node run-daily.mjs --apply --skip scan      # everything but a fresh scan
 *   node run-daily.mjs --apply --from gate      # resume after a crash
 *   node run-daily.mjs --apply --only fetch     # one stage
 *   node run-daily.mjs --apply --score 25 --full-access   # lift the codex sandbox
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The pipeline, in the only order its data dependencies allow.
 *
 * `costly` marks the one stage that spends money. `writes` is the argv a stage
 * needs in order to actually write (dry-run scripts here differ in how they say
 * it: some take --apply, gate/queue-migrate take --dry-run instead, so the
 * inverse is expressed per stage rather than assumed).
 */
export const STAGES = [
  {
    key: 'scan',
    label: 'scan job boards',
    script: 'scan-ats-full.mjs',
    // BOUNDED AND SHUFFLED, both deliberately.
    //
    // Unbounded, this walks the entire public aggregator dataset — 8,333
    // greenhouse companies alone, and Workday is larger. Measured 2026-07-24 at
    // ~5.7 companies/sec, so a full sweep is hours, not minutes. Run without a
    // limit it looks exactly like a hang: no output (the summary prints at the
    // end), and long quiet stretches with no open sockets. It is not hanging,
    // it is just far larger than a daily habit can absorb.
    //
    // --shuffle is what makes the cap honest. sampleCompanies takes the
    // dataset's ALPHABETICAL prefix by default, so a capped daily scan would
    // see "0x, 100x, abinbev, abnormalsecurity..." every single day and never
    // reach the rest of the alphabet. Shuffled, each run samples a different
    // slice and coverage accumulates across days instead of standing still.
    base: ['--since', '7', '--limit', '600', '--shuffle'],
    writes: [],
    dry: ['--dry-run'],
    costly: false,
    note: 'network only, no model; 600 companies/ATS, shuffled',
  },
  {
    key: 'migrate',
    label: 'import scan results into the queue',
    script: 'queue-migrate.mjs',
    base: [],
    writes: [],
    dry: ['--dry-run'],
    costly: false,
    note: 'pipeline.md → queue.db',
  },
  {
    key: 'gate',
    label: 'gate: freshness, US location, seniority, E-Verify',
    script: 'gate.mjs',
    base: [],
    writes: [],
    dry: ['--dry-run'],
    costly: false,
    note: 'free',
  },
  {
    key: 'fetch',
    label: 'download the job ads',
    script: 'fetch-jds.mjs',
    base: [],
    writes: [],
    dry: null, // fetch-jds has no dry mode; it is skipped entirely on a dry run
    costly: false,
    note: 'network only, no model',
  },
  {
    key: 'screen',
    label: 'screen the ads (experience bars, hard gates)',
    script: 'screen-queue.mjs',
    base: [],
    writes: ['--apply'],
    dry: [],
    costly: false,
    note: 'free',
  },
  {
    key: 'score',
    label: 'score with Codex workers',
    script: 'score-queue.mjs',
    base: [],
    writes: ['--apply'],
    dry: [],
    costly: true,
    note: 'COSTS MONEY',
  },
];

const KEYS = STAGES.map((s) => s.key);

/** Split a comma/space separated selector into clean tokens. */
function tokens(value) {
  return String(value ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Turn argv into a concrete, ordered plan.
 *
 * Returns `{ stages, apply, scoreLimit, fullAccess, error }`. `error` is a
 * string when the request cannot be honoured — the caller must exit non-zero on
 * it rather than running a truncated plan. Selector validation is strict on
 * purpose (rule 3 above): the whole value of this file is that a run which does
 * nothing is loud.
 *
 * @param {string[]} argv
 */
export function planRun(argv = []) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const bad = (error) => ({ stages: [], apply: false, scoreLimit: 0, fullAccess: false, error });

  const apply = argv.includes('--apply');
  const fullAccess = argv.includes('--full-access');

  // --score is the money flag, so it is parsed strictly. A missing or
  // unparseable budget is refused rather than defaulted: guessing a spend is
  // never the right call.
  let scoreLimit = 0;
  if (argv.includes('--score')) {
    const raw = arg('--score');
    if (raw === undefined) return bad('--score needs a row budget, e.g. --score 25');
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return bad(`--score needs a whole, non-negative row budget (got ${JSON.stringify(raw)})`);
    scoreLimit = n;
  }

  const unknown = (flag, list) => {
    const bogus = list.filter((k) => !KEYS.includes(k));
    return bogus.length ? `${flag}: unknown stage ${bogus.map((b) => `"${b}"`).join(', ')}. Valid stages: ${KEYS.join(', ')}` : null;
  };

  // Start from the free stages. Scoring is opt-in (rule 2), so it only joins
  // the plan when a budget was actually requested.
  let chosen = STAGES.filter((s) => !s.costly || scoreLimit > 0);

  const only = arg('--only');
  if (argv.includes('--only')) {
    const list = tokens(only);
    if (!list.length) return bad('--only needs at least one stage name');
    const err = unknown('--only', list);
    if (err) return bad(err);
    // Filter the pipeline rather than mapping the selector, so --only can never
    // reorder the stages into an order their data dependencies forbid.
    chosen = STAGES.filter((s) => list.includes(s.key));
  }

  const from = arg('--from');
  if (argv.includes('--from')) {
    const list = tokens(from);
    if (list.length !== 1) return bad('--from takes exactly one stage name');
    const err = unknown('--from', list);
    if (err) return bad(err);
    const at = KEYS.indexOf(list[0]);
    chosen = chosen.filter((s) => KEYS.indexOf(s.key) >= at);
  }

  const skip = arg('--skip');
  if (argv.includes('--skip')) {
    const list = tokens(skip);
    if (!list.length) return bad('--skip needs at least one stage name');
    const err = unknown('--skip', list);
    if (err) return bad(err);
    chosen = chosen.filter((s) => !list.includes(s.key));
  }

  if (!chosen.length) {
    return bad(`nothing left to run after the stage selectors. Valid stages: ${KEYS.join(', ')}`);
  }

  const stages = chosen.map((s) => {
    const args = [...s.base];
    if (apply) args.push(...s.writes);
    else if (s.dry) args.push(...s.dry);
    if (s.key === 'score') {
      args.push('--limit', String(scoreLimit));
      if (fullAccess) args.push('--full-access');
    }
    return { ...s, args };
  });

  return { stages, apply, scoreLimit, fullAccess, error: null };
}

/**
 * The human answer to "what happened and what do I do now".
 *
 * A funnel of raw numbers is only half of it — an empty pipeline has to say so
 * in words, because a column of zeros reads identically to a broken run.
 *
 * @param {Record<string, number>} counts  queue_status → row count
 * @param {{keepers?:number}} [extra]
 */
export function renderFunnel(counts = {}, { keepers = 0 } = {}) {
  const n = (k) => Number(counts[k] || 0);
  const total = KEYS.length && Object.values(counts).reduce((a, b) => a + Number(b || 0), 0);

  if (!total) {
    return [
      '',
      'The queue is EMPTY — nothing has been scanned into it yet.',
      'Run: node run-daily.mjs --apply',
      '',
    ].join('\n');
  }

  const rows = [
    ['waiting to be gated', n('new')],
    ['queued for scoring', n('llm_ready')],
    ['already scored', n('evaluated')],
    ['filtered out', n('skipped')],
  ];
  const width = Math.max(...rows.map((r) => r[0].length));
  const lines = ['', 'queue:'];
  for (const [label, value] of rows) lines.push(`  ${label.padEnd(width)}  ${String(value).padStart(6)}`);

  lines.push('');
  if (keepers > 0) {
    lines.push(`${keepers} keeper${keepers === 1 ? '' : 's'} waiting in data/apply-queue.md — start at the top.`);
  } else if (n('evaluated') > 0) {
    lines.push('No keepers yet (nothing scored at or above 3.5). data/apply-queue.md is empty.');
  } else {
    lines.push('Nothing scored yet. Run with --score 25 to spend a model on the queue.');
    lines.push('Results land in data/apply-queue.md.');
  }
  lines.push('');
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// The I/O shell — runs only on direct invocation.
// ════════════════════════════════════════════════════════════════════════════

/** Read the queue's status counts without importing sqlite at module load. */
async function queueCounts() {
  const dbPath = process.env.CAREER_OPS_QUEUE_DB || join(HERE, 'data', 'queue.db');
  if (!existsSync(dbPath)) return {};
  const { openQueue } = await import('./queue.mjs');
  const db = await openQueue(dbPath);
  const rows = db.prepare('SELECT queue_status, COUNT(*) n FROM jobs GROUP BY 1').all();
  const counts = Object.fromEntries(rows.map((r) => [r.queue_status, r.n]));
  const keepers = db.prepare('SELECT COUNT(*) n FROM jobs WHERE score IS NOT NULL AND score >= 3.5').get()?.n ?? 0;
  return { counts, keepers };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`
run-daily.mjs — the whole job pipeline as one command.

  node run-daily.mjs                     dry run: show the plan and the queue
  node run-daily.mjs --apply             run the free stages for real
  node run-daily.mjs --apply --score 25  ... and score 25 rows (COSTS MONEY)

  --skip a,b     drop stages          --from x   resume at a stage
  --only a,b     run only these       --full-access  lift the codex sandbox

Stages, in order: ${KEYS.join(' -> ')}
`.trim());
    return;
  }

  const plan = planRun(argv);
  if (plan.error) {
    console.error(`\n${plan.error}\n`);
    process.exit(2);
  }

  console.error(`\n${plan.apply ? 'RUNNING' : 'DRY RUN (nothing will be written; pass --apply)'}`);
  console.error('\nplan:');
  for (const s of plan.stages) {
    console.error(`  ${s.costly ? '$' : ' '} ${s.key.padEnd(8)} ${s.label}  [${s.note}]`);
  }
  if (plan.scoreLimit > 0 && plan.apply) {
    console.error(`\n  scoring up to ${plan.scoreLimit} row(s) with Codex${plan.fullAccess ? ' (SANDBOX LIFTED)' : ' (sandboxed)'}.`);
  }

  const before = await queueCounts();
  console.error(renderFunnel(before.counts, { keepers: before.keepers }));

  if (!plan.apply && plan.stages.every((s) => !s.dry)) {
    console.error('(every selected stage is write-only, so a dry run has nothing to show)');
  }

  const results = [];
  for (const stage of plan.stages) {
    // fetch-jds has no dry mode and always hits the network, so a dry run must
    // not execute it. Reporting the skip is the point: a silent omission here
    // would make a dry run look like it covered more than it did.
    if (!plan.apply && stage.dry === null) {
      console.error(`\n── ${stage.key}: skipped on a dry run (no dry mode; it would hit the network)`);
      results.push({ stage: stage.key, status: 'skipped-dry' });
      continue;
    }

    console.error(`\n── ${stage.key}: ${stage.label} ${'─'.repeat(Math.max(0, 40 - stage.label.length))}`);
    const started = Date.now();
    const res = spawnSync(process.execPath, [join(HERE, stage.script), ...stage.args], {
      cwd: HERE, stdio: 'inherit',
    });
    const secs = ((Date.now() - started) / 1000).toFixed(0);

    if (res.error || res.status !== 0) {
      // Stop at the first failure. Continuing would run later stages against a
      // half-built input and report a funnel that looks like a real result.
      console.error(`\n${stage.key} FAILED after ${secs}s (${res.error?.message || `exit ${res.status}`}).`);
      console.error(`Nothing after it ran. Fix, then resume with: node run-daily.mjs --apply --from ${stage.key}`);
      results.push({ stage: stage.key, status: 'failed', code: res.status ?? null });
      console.log(JSON.stringify({ ok: false, apply: plan.apply, results }, null, 2));
      process.exit(1);
    }
    console.error(`   ${stage.key} ok (${secs}s)`);
    results.push({ stage: stage.key, status: 'ok', seconds: Number(secs) });
  }

  const after = await queueCounts();
  console.error(renderFunnel(after.counts, { keepers: after.keepers }));
  console.log(JSON.stringify({
    ok: true, apply: plan.apply, scoreLimit: plan.scoreLimit, results,
    queue: after.counts, keepers: after.keepers,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
