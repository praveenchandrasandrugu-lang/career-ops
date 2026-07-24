/**
 * run-daily.test.mjs — the one-command daily run (step 9).
 *
 * Everything in this pipeline works, but using it means remembering six scripts
 * in the right order with the right flags: scan, queue-migrate, gate, fetch-jds,
 * screen-queue --apply, score-queue --apply. Getting the order wrong does not
 * error — it silently does nothing, because each stage only touches rows the
 * previous stage produced. That is the worst possible failure mode for a daily
 * habit, so the order is encoded here once instead of being remembered.
 *
 * The design rules this file pins down:
 *   1. Dry run by default, like every other stage in this repo.
 *   2. Scoring is the ONLY stage that costs money, so it is opt-in per run and
 *      always carries an explicit row budget. It can never be implied.
 *   3. A stage selector that matches nothing is an ERROR, never a silent no-op.
 *      "It ran and did nothing" is indistinguishable from success otherwise.
 *   4. Stage order is fixed by data dependency and cannot be reordered by flags.
 *
 * Run: node tests/run-daily.test.mjs  (or via test-all.mjs)
 */
import { pass, fail } from './helpers.mjs';
import { STAGES, planRun, renderFunnel } from '../run-daily.mjs';

const T = (label, cond) => (cond ? pass(label) : fail(label));
const eq = (label, got, want) => T(`${label}${got === want ? '' : ` (got ${JSON.stringify(got)})`}`, got === want);
const keys = (plan) => plan.stages.map((s) => s.key).join(',');

// ── the stage order is a data dependency, not a preference ──────────────────
// Each stage consumes what the previous one wrote: migrate makes 'new' rows,
// gate turns those into 'llm_ready', fetch fills jd_text on llm_ready rows,
// screen reads jd_text, score reads screened rows. Run out of order and every
// stage finds an empty input and exits 0.
eq('STAGES: the pipeline order is fixed', STAGES.map((s) => s.key).join(','),
  'scan,migrate,gate,fetch,screen,score');
T('STAGES: every stage declares what it costs', STAGES.every((s) => typeof s.costly === 'boolean'));
eq('STAGES: exactly one stage costs money', STAGES.filter((s) => s.costly).length, 1);
eq('STAGES: the costly stage is scoring', STAGES.find((s) => s.costly).key, 'score');

// ── dry run is the default ──────────────────────────────────────────────────
{
  const plan = planRun([]);
  eq('planRun: no flags is a DRY RUN', plan.apply, false);
  T('planRun: a dry run still plans the free stages', plan.stages.length > 0);
}

// ── scoring is opt-in and always budgeted ──────────────────────────────────
// The one stage that spends real money must never be implied by --apply. It
// takes an explicit row budget, so "run the daily thing" can never turn into an
// unbounded spend.
{
  const plan = planRun(['--apply']);
  T('planRun: --apply alone does NOT include the costly scoring stage',
    !plan.stages.some((s) => s.key === 'score'));
}
{
  const plan = planRun(['--apply', '--score', '25']);
  T('planRun: --score opts into the costly stage', plan.stages.some((s) => s.key === 'score'));
  eq('planRun: --score carries its row budget', plan.scoreLimit, 25);
}
{
  const plan = planRun(['--apply', '--score', '0']);
  T('planRun: --score 0 is a budget of nothing, so scoring is not planned',
    !plan.stages.some((s) => s.key === 'score'));
}
T('planRun: --score with no number is rejected rather than guessed at',
  planRun(['--apply', '--score']).error !== null);
T('planRun: a negative budget is rejected', planRun(['--apply', '--score', '-5']).error !== null);

// ── selectors ───────────────────────────────────────────────────────────────
{
  const plan = planRun(['--apply', '--skip', 'scan']);
  eq('planRun: --skip drops that stage', keys(plan), 'migrate,gate,fetch,screen');
}
{
  const plan = planRun(['--apply', '--skip', 'scan,fetch']);
  eq('planRun: --skip takes a list', keys(plan), 'migrate,gate,screen');
}
{
  const plan = planRun(['--apply', '--only', 'gate,screen']);
  eq('planRun: --only runs just those, still in pipeline order', keys(plan), 'gate,screen');
}
{
  const plan = planRun(['--apply', '--only', 'screen,gate']);
  eq('planRun: --only cannot reorder the pipeline', keys(plan), 'gate,screen');
}
{
  const plan = planRun(['--apply', '--from', 'gate']);
  eq('planRun: --from resumes at a stage and runs the rest', keys(plan), 'gate,fetch,screen');
}
{
  const plan = planRun(['--apply', '--from', 'gate', '--score', '10']);
  eq('planRun: --from still honours the opt-in score stage', keys(plan), 'gate,fetch,screen,score');
}

// ── a selector that matches nothing is an ERROR, never a silent success ─────
// This is the rule that makes the runner trustworthy. Every other script here
// exits 0 on an empty input (correctly — an empty queue is not an error), so a
// typo'd stage name would look exactly like a clean run that had no work to do.
T('planRun: an unknown --only stage is an error', planRun(['--only', 'gaet']).error !== null);
T('planRun: the error names the bad stage', /gaet/.test(planRun(['--only', 'gaet']).error || ''));
T('planRun: the error lists the valid stages', /migrate/.test(planRun(['--only', 'gaet']).error || ''));
T('planRun: an unknown --skip stage is an error', planRun(['--skip', 'fetchh']).error !== null);
T('planRun: an unknown --from stage is an error', planRun(['--from', 'nope']).error !== null);
T('planRun: skipping every stage is an error, not an empty success',
  planRun(['--apply', '--skip', 'scan,migrate,gate,fetch,screen']).error !== null);
T('planRun: a valid plan carries no error', planRun(['--apply']).error === null);

// ── the score budget flows to the stage that spends it ─────────────────────
{
  const plan = planRun(['--apply', '--score', '7']);
  const score = plan.stages.find((s) => s.key === 'score');
  T('planRun: the score stage argv carries the budget', score.args.join(' ').includes('--limit 7'));
  T('planRun: the score stage argv carries --apply', score.args.includes('--apply'));
}
{
  const plan = planRun(['--score', '7']); // no --apply
  const score = plan.stages.find((s) => s.key === 'score');
  T('planRun: without --apply the score stage is planned but NOT given --apply',
    score && !score.args.includes('--apply'));
}

// ── the funnel report ───────────────────────────────────────────────────────
// The point of the run is one readable answer to "what happened and what do I
// do now", so the funnel is rendered from real counts rather than left in JSON.
{
  const out = renderFunnel({ new: 120, llm_ready: 913, evaluated: 6, skipped: 8170 }, { keepers: 4 });
  T('renderFunnel: reports the queued pool', /913/.test(out));
  T('renderFunnel: reports keepers found', /4/.test(out));
  T('renderFunnel: points at the apply queue', /apply-queue\.md/.test(out));
}
{
  const out = renderFunnel({ new: 0, llm_ready: 0, evaluated: 0, skipped: 0 }, { keepers: 0 });
  T('renderFunnel: an empty pipeline says so plainly rather than printing zeros only',
    /nothing|empty|no /i.test(out));
}
// `evaluated` is not the same as "we paid a model for this". queue-migrate
// imports pipeline.md's `## Processed` section straight to `evaluated`, so on
// the live queue 150 rows are evaluated while only 28 carry a score. Reporting
// the whole bucket as "already scored" overstates the spend by 5x and hides how
// much of the pool has actually been through the scorer.
{
  const out = renderFunnel(
    { new: 0, llm_ready: 1811, evaluated: 150, skipped: 8264 },
    { keepers: 8, scored: 28 },
  );
  T('renderFunnel: reports what the model actually scored, not the whole evaluated bucket',
    /28/.test(out));
  T('renderFunnel: does not claim the 122 imported rows were scored',
    !/already scored\s+150/.test(out));
  T('renderFunnel: still accounts for the imported rows rather than dropping them',
    /122/.test(out));
}
// Nothing scored yet, but a pile of imported rows: the advice must still be
// "spend a model", not "no keepers found" -- the latter reads as a verdict on
// jobs no model ever looked at.
{
  const out = renderFunnel({ new: 0, llm_ready: 900, evaluated: 122, skipped: 10 }, { keepers: 0, scored: 0 });
  T('renderFunnel: zero scored with imported rows still prompts a scoring run',
    /--score/.test(out));
}

// ── the scan stage must be bounded AND shuffled ────────────────────────────
//
// Unbounded, scan-ats-full walks the whole aggregator dataset: 8,333 greenhouse
// companies alone, Workday larger, measured at ~5.7 companies/sec. That is
// hours, and because the summary only prints at the end it is indistinguishable
// from a hang -- exactly what happened on 2026-07-24 (72 minutes, no output,
// nothing written, and it was working the whole time).
//
// The cap alone is not enough: sampleCompanies takes the dataset's ALPHABETICAL
// prefix by default, so a capped daily scan would re-scan "0x, 100x, abinbev..."
// every day forever and never reach the rest. --shuffle makes coverage
// accumulate across runs instead of standing still.
{
  const scan = planRun(['--apply']).stages.find((s) => s.key === 'scan');
  T('scan stage: is bounded by a company limit', scan.args.includes('--limit'));
  T('scan stage: the limit is a real number', /^\d+$/.test(scan.args[scan.args.indexOf('--limit') + 1]));
  T('scan stage: is shuffled, so a capped run does not re-scan the same alphabetical prefix daily',
    scan.args.includes('--shuffle'));
  T('scan stage: still carries a freshness window', scan.args.includes('--since'));
}
