# Lean scorer: score on CV fit alone, stop paying for what only matters after you decide to apply

Date: 2026-07-28
Status: approved, implementing

## Problem

Scoring one job costs roughly 18,700 tokens: ~14,500 in, ~4,200 out. Input dominates
by 3.5x, and almost all of it is re-sent per job.

Measured on `reports/458-ryder-2026-07-28.md` (16,854 chars, block sizes exclude the
heading line, independently reproduced by a Codex review pass):

| Block | chars | share | web calls |
|---|---|---|---|
| D) Comp and Demand | 5,049 | 30% | ~8 |
| B) CV Match | 4,087 | 24% | 0 |
| G) Posting Legitimacy | 1,777 | 11% | some |
| A) Role Summary | 1,731 | 10% | 0 |
| C) Level and Strategy | 1,057 | 6% | 0 |

Per-job input, verified: `batch-prompt.md` 24,942 chars + `_custom.md` 15,132 +
`_profile.md` 7,232 + `cv.md` 3,939 + `profile.yml` 6,545 = 57,790 chars before the JD.
(`article-digest.md` and `llms.txt` do not exist in this install.)

Two observations drive the design:

1. **Everything except B is only actionable after the candidate decides to apply.**
   Comp research, negotiation questions, level strategy and ghost-job analysis are
   worth paying for on a job he will pursue. On the 12 of 14 that scored below the
   bar last run, they were pure waste.

2. **The worker-side rejections are not free.** 22 rows in the live queue carry
   `worker:` skip reasons, meaning the model had already loaded the full prompt and
   the JD before rejecting. That is ~320K input tokens spent to say no. Only the
   free `gate` (1,727 rows) and `screen-queue` (67 rows) rejections cost nothing.

## Design

A dedicated lean prompt for the scorer. It emits Block B and nothing else, keeps
every machine-readable contract intact, and reorders its own work so the cheapest
rejection happens first.

### Worker order

```
1. read JD text only
2. hard-reject stage 1: citizenship/clearance, non-US    <- ad alone, nothing else read
   reject -> emit skipped payload, STOP
3. read cv.md + config/profile.yml
4. hard-reject stage 2: cert, cohort, experience floor   <- needs candidate context
   reject -> emit skipped payload, STOP
5. read _profile.md + _custom.md, compact archetype pass (internal, not printed)
6. Block B: requirement-by-requirement match, gaps, score
7. write report (header + Machine Summary + B), TSV, final JSON
8. PDF only when score >= auto_pdf_score_threshold (unchanged, currently 4.0)
```

The reject scan is split deliberately. A first draft put the whole hard-reject list
before any candidate file was read, which is incoherent: "a certification he does not
hold", "a cohort he is not in" and "an experience floor he cannot clear" are all
unjudgeable without knowing what he holds, when he graduated, and how long he has
worked. Only citizenship/clearance and non-US are decidable from the ad alone.

Splitting keeps most of the benefit anyway, because those two are the most common
rejects in practice: the last screen pass dropped 29 on citizenship/clearance and 31
on non-US. Stage 2 costs nothing extra, since Step 3 has to read those files regardless.

### What is dropped

Block A prose, Block C, Block D and its web research, Block G's web research, the
cover-letter draft, the extracted-keywords block.

### What is deliberately kept

- **Archetype detection, as an internal pass.** Block B is archetype-adapted
  (`modes/oferta.md:78`) and `orderForSpend` in `score-queue.mjs` ranks the spend
  queue by the archetype fit tiers in `config/profile.yml:38-58`. Those tiers are the
  candidate's own, tuned 2026-07-13. Removing the pass would silently break his spend
  ordering and drift the score. It is computed and written to the header and Machine
  Summary, but no longer printed as a prose block.
- **The full `## Machine Summary` YAML contract.** Parsed by `analyze-patterns.mjs:28`,
  `upskill.mjs:155` and `salary-gap.mjs:101`.
- **Header `**URL:**` and `**Score:**`.** The crash-recovery path at
  `score-queue.mjs:675` reads them off disk.
- **The 9-column tracker TSV.** `merge-tracker.mjs:306`.
- **`advertised_comp`, quoted verbatim from the JD.** Zero cost, the figure is already
  in loaded text, and it keeps `salary-gap.mjs` fed.
- **`legitimacy_tier`, assessed from the JD text alone.** No web research. Ghost-job
  phrasing, absent comp, vague scope and agency-posting signals are all readable in
  text already loaded. Liveness is separately covered free by the `refreshJd`
  re-check at `score-queue.mjs:382`.

### Score comparability

The old score folded in legitimacy, comp transparency, role realism, culture and red
flags. The lean score is CV fit plus hard stops. It is a different number and the 3.5
keeper bar does not carry over unchanged.

Machine Summary gains `score_model: "lean-v2"`. Old reports have no such key and read
as `legacy-v1`. Nothing silently compares the two.

## Implementation

New file `batch/score-prompt.md`. `score-queue.mjs` loads it when present and falls
back to `batch/batch-prompt.md`, overridable with `CAREER_OPS_SCORE_PROMPT`.

This is deliberately **not** a `modes/_custom.md` override. `batch/batch-prompt.md`
declares itself self-contained and instructs the worker to "complete every block
below"; a house-rule file cannot reliably countermand that, and the test suite would
keep passing while the live worker stayed contradictory. A new file also sidesteps
`update-system.mjs` SYSTEM_PATHS, which contains both `batch/batch-prompt.md` and
`modes/oferta.md`.

`modes/oferta.md` is not touched. It keeps all seven block headings, which
`test-all.mjs:7587` asserts and the web report parser depends on. This mirrors how the
E/F cut was done on 2026-07-24: trimmed in `batch/batch-prompt.md`, left intact in
`modes/oferta.md`.

The one-line loader change in `score-queue.mjs` is system-layer and will be reverted
by `node update-system.mjs apply`. It goes in the LOCAL PATCHES list in
`modes/_custom.md` alongside the adaptive-limiter and SSRF patches.

## Expected saving

Per job, roughly 18,700 tokens down to ~8,000, and web calls from 8-10 to zero.
Hard rejects drop from full context to JD-plus-short-prompt.

This is arithmetic from the byte counts above, not a measured run. It must be
measured on a real batch and the actual figure recorded here.

## Risks

- The lean score is a new scale. Mitigated by `score_model`, not eliminated.
- Ghost-job detection weakens without web research. Mitigated by the free liveness
  re-check and JD-text signals, but it is genuinely weaker.
- A wrongly low score is invisible damage: the candidate never learns the job existed.
  This is why the bail is a *score*, recorded and auditable, rather than a silent skip.
