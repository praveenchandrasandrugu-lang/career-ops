/**
 * scan-workday-targeted.test.mjs — error observability + dead-tenant handling.
 *
 * Root cause (2026-07-20 investigation): a diagnostic scan reported "Fetch
 * errors: 156" with NO status breakdown — 156 turned out to be exactly 2 dead
 * tenants (21cf → 422, 4flow_campus → 404) queried once per keyword (78 each).
 * The scanner collapsed every failure into one opaque counter and hammered a
 * dead board 78 times.
 *
 * The fix (refined after a code review):
 *   - classifyFetchError buckets a status into gone / suspect / throttled /
 *     transient / other.
 *   - gone (404/410) = the endpoint is provably gone → abort the tenant on the
 *     first hit (keyword-independent: the URL path itself is invalid).
 *   - suspect (400/403/422) = could be a dead board OR one bad keyword → abort
 *     only after N consecutive, so a single bad searchText can't false-abort a
 *     live tenant, but a truly dead board still stops after a few, not 78.
 *   - throttled (429) / transient (5xx, network) = per-keyword coverage holes,
 *     never abort; every failure is recorded by status and counts as skipped,
 *     never as a completed query.
 *
 * Run: node tests/scan-workday-targeted.test.mjs  (or via test-all.mjs)
 */
import { pass, fail } from './helpers.mjs';
import { classifyFetchError, queryKeyword, scanTenant } from '../scan-workday-targeted.mjs';

const T = (label, cond) => (cond ? pass(label) : fail(label, 'assertion failed'));
const err = (status) => Object.assign(new Error(`HTTP ${status ?? 'network'}`), status == null ? {} : { status });
const T_API = { tenant: 'deadco', host: 'deadco.wd1.myworkdayjobs.com', api: 'https://deadco/jobs' };
const freshStats = () => ({
  errors: 0, completed: 0, undated: 0, boundedStale: 0, repeatedPage: 0,
  stillCapped: [], errorsByStatus: {}, skipped: [], deadTenants: [],
});

// ── classifyFetchError: pure status → kind ──────────────────────────────────
T('classifyFetchError: 429 → throttled', classifyFetchError(err(429)).kind === 'throttled');
T('classifyFetchError: 503 → transient', classifyFetchError(err(503)).kind === 'transient');
T('classifyFetchError: 500 → transient', classifyFetchError(err(500)).kind === 'transient');
T('classifyFetchError: no status (network/timeout) → transient', classifyFetchError(err(null)).kind === 'transient');
T('classifyFetchError: 404 → gone', classifyFetchError(err(404)).kind === 'gone');
T('classifyFetchError: 410 → gone', classifyFetchError(err(410)).kind === 'gone');
T('classifyFetchError: 422 → suspect', classifyFetchError(err(422)).kind === 'suspect');
T('classifyFetchError: 403 → suspect', classifyFetchError(err(403)).kind === 'suspect');
T('classifyFetchError: 400 → suspect', classifyFetchError(err(400)).kind === 'suspect');
T('classifyFetchError: 418 (teapot) → other', classifyFetchError(err(418)).kind === 'other');

// ── queryKeyword: throws a classified error on any fetch failure ─────────────
async function queryKeywordThrows() {
  const cases = [[404, 'gone'], [422, 'suspect'], [429, 'throttled'], [null, 'transient']];
  for (const [status, kind] of cases) {
    const ctx = { fetchJson: async () => { throw err(status); } };
    let threw = null;
    try { await queryKeyword(ctx, T_API, 'analyst', 0, 7, [], new Set(), freshStats()); }
    catch (e) { threw = e; }
    T(`queryKeyword: ${status ?? 'network'} throws with fetchKind=${kind}`, threw != null && threw.fetchKind === kind);
    T(`queryKeyword: ${status ?? 'network'} carries status`, threw != null && threw.status === (status ?? null));
  }
}

// ── scanTenant: gone aborts immediately, records exactly one error ───────────
async function goneAbortsImmediately() {
  const stats = freshStats();
  const ctx = { fetchJson: async () => { throw err(404); } };
  await scanTenant(ctx, T_API, ['a', 'b', 'c'], 0, 7, [], new Set(), stats);
  T('scanTenant: gone (404) aborts tenant on first keyword', stats.errorsByStatus['404'] === 1);
  T('scanTenant: gone records one dead tenant', stats.deadTenants.length === 1);
  T('scanTenant: gone runs no further keywords (completed 0)', stats.completed === 0);
  // The triggering keyword FAILED — it must count as a coverage hole (skipped),
  // consistent with the suspect path, so the coverage numbers never overstate.
  T('scanTenant: gone records the triggering keyword as skipped', stats.skipped.length === 1);
}

// ── scanTenant: transient (network/5xx) is skipped, never aborts ─────────────
async function transientIsSkippedNotAborted() {
  const stats = freshStats();
  const ctx = { fetchJson: async () => { throw err(503); } };
  await scanTenant(ctx, T_API, ['a', 'b'], 0, 7, [], new Set(), stats, { suspectAbortThreshold: 3 });
  T('scanTenant: transient (503) never aborts the tenant', stats.deadTenants.length === 0);
  T('scanTenant: transient keywords are NOT counted as completed', stats.completed === 0);
  T('scanTenant: transient keywords are counted as skipped', stats.skipped.length === 2);
  T('scanTenant: transient recorded by status', stats.errorsByStatus['503'] === 2);
}

// ── scanTenant: suspect aborts only after N consecutive ─────────────────────
async function suspectAbortsAfterThreshold() {
  const stats = freshStats();
  const ctx = { fetchJson: async () => { throw err(422); } };
  await scanTenant(ctx, T_API, ['a', 'b', 'c', 'd', 'e'], 0, 7, [], new Set(), stats, { suspectAbortThreshold: 3 });
  T('scanTenant: suspect (422) aborts after 3 consecutive', stats.errorsByStatus['422'] === 3);
  T('scanTenant: suspect abort stops the remaining keywords (d,e not tried)', stats.deadTenants.length === 1);
}

// ── scanTenant: a lone suspect between successes does NOT abort ──────────────
async function loneSuspectDoesNotAbort() {
  const stats = freshStats();
  const seq = [422, 200, 200]; // first keyword bad, next two fine
  let i = 0;
  const ctx = { fetchJson: async () => { const s = seq[Math.min(i++, seq.length - 1)]; if (s === 200) return { total: 0, jobPostings: [] }; throw err(s); } };
  await scanTenant(ctx, T_API, ['a', 'b', 'c'], 0, 7, [], new Set(), stats, { suspectAbortThreshold: 3 });
  T('scanTenant: lone suspect does not abort the tenant', stats.deadTenants.length === 0);
  T('scanTenant: two good keywords count as completed', stats.completed === 2);
  T('scanTenant: the one suspect is recorded as skipped', stats.skipped.length === 1);
  T('scanTenant: the one suspect is bucketed by status', stats.errorsByStatus['422'] === 1);
}

// ── scanTenant: throttled never aborts, never counts as completed ────────────
async function throttledIsSkippedNotCompleted() {
  const stats = freshStats();
  const ctx = { fetchJson: async () => { throw err(429); } };
  await scanTenant(ctx, T_API, ['a', 'b'], 0, 7, [], new Set(), stats, { suspectAbortThreshold: 3 });
  T('scanTenant: throttled never aborts the tenant', stats.deadTenants.length === 0);
  T('scanTenant: throttled keywords are NOT counted as completed', stats.completed === 0);
  T('scanTenant: throttled keywords are counted as skipped (coverage holes)', stats.skipped.length === 2);
  T('scanTenant: throttled recorded by status', stats.errorsByStatus['429'] === 2);
}

await queryKeywordThrows();
await goneAbortsImmediately();
await transientIsSkippedNotAborted();
await suspectAbortsAfterThreshold();
await loneSuspectDoesNotAbort();
await throttledIsSkippedNotCompleted();
