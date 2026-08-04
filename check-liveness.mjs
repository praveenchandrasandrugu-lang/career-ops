#!/usr/bin/env node
/**
 * check-liveness.mjs — REMOVED 2026-08-04.
 *
 * This was a Playwright/API job-link liveness checker. It is now a refusal stub,
 * and the reason is measured rather than aesthetic: it called 3 of 3 live Workday
 * reqs "expired". A JS-rendered board serves a shell that reads as "insufficient
 * content" without a browser, so the verdict described the fetch, not the job.
 *
 * The error was asymmetric. A false "expired" silently deleted a real keeper from
 * the apply sheet, and nothing ever resurfaced it. A true "expired" saved one
 * click on a dead link. Paying a keeper to save a click is the wrong trade, so
 * the whole check is gone rather than tuned.
 *
 * The file survives as a stub instead of being deleted because it is a SYSTEM_PATH
 * in update-system.mjs: a deleted system file returns on the next update, and it
 * would return as the working checker. A stub that refuses cannot silently resume.
 *
 * Deliberately no imports. The previous version statically imported Playwright and
 * the liveness modules, which meant paying the module load before refusing.
 *
 * The liveness-*.mjs modules are still present and still exercised by test-all,
 * because unrelated code imports non-liveness helpers from them: resolveAtsApi and
 * isAtsPosting (screen-level.mjs, screen-sponsorship.mjs) and the SSRF host guard
 * plus LIVENESS_CONTEXT_OPTIONS (browser-extract.mjs).
 */

console.error('check-liveness.mjs was removed: it produced false "expired" verdicts and dropped live jobs.');
console.error('Nothing in the pipeline checks liveness any more. Open the link; that is the check.');
console.error('See the "NEVER run a liveness check" house rule in modes/_custom.md.');
process.exit(2);
