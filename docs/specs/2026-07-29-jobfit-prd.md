# PRD: jobfit

**Status:** revised after Codex review
**Date:** 2026-07-29
**Replaces:** career-ops (fork of santifer/career-ops)

---

## 1. Why replace what exists

career-ops was built for a Head-of-Applied-AI search in Spain. Measured on 2026-07-28:

| | |
|---|---|
| top-level `.mjs` scripts | 106 (45,208 lines) |
| scripts in the live path | ~27 |
| mode files | 137, of which 36 are non-English market variants |
| tracked files | 789 |

Roughly three quarters of the code is not in the live path. The unused parts are
not badly written; they are shaped for a different person's search. Carrying them
forward costs comprehension on every change.

Three separate failures in one session all traced to a single blurred boundary,
which is what this rebuild exists to fix:

1. The scoring model **picked a number out of the air.** No rubric existed
   anywhere, so changing the prompt changed the score for an unchanged candidate
   and job, and a keeper bar could not survive the edit.
2. The model was asked to **launch a browser inside its own sandbox.** Chromium
   cannot spawn there, so every role scoring at or above the CV threshold failed,
   retried, and failed again. The pipeline was systematically destroying the best
   roles it found, and the distribution looked merely disappointing rather than
   broken.
3. A **12-turn coding-agent loop** was used for what is one text judgment,
   re-sending its whole context each turn to read files the orchestrator already
   had open.

## 2. The principle

> **The LLM does judgment. Plain code does everything deterministic.**

Discovery, filtering, arithmetic, rendering, file writes and tracking are code.
Reading an ad and judging fit against a CV is the model. Every failure above is
this line being crossed.

**Where the boundary sits.** The model emits a judgment table as JSON. Everything
downstream of that JSON is pure, reproducible and unit-tested. Everything upstream
of it is a language model and is not reproducible. This distinction is load
bearing and is restated in section 12, because the temptation is to believe a band
is more stable than its inputs.

## 3. Who it is for

One user: a May-2025 MS Data Analytics graduate on STEM OPT, searching the US.

The constraints that actually drive design:

- **E-Verify enrollment is a hard employment constraint, but not a pipeline
  gate.** A company-name miss is not evidence of non-enrolment, so an employer
  that is not found in the index passes discovery, enrichment and scoring
  untouched, carrying an `everify: unknown` label. The constraint is enforced at
  **apply time**: `jobfit apply` refuses to proceed on an `unknown` or `not
  enrolled` employer until he confirms explicitly. This is the only place in the
  system where E-Verify blocks anything.
- Targets entry-level Business Analyst / Data Analyst / BI roles, where **stated
  requirements are routinely inflated** beyond what the job needs.
- Relocates anywhere in the US. **No salary floor.** Neither is ever a filter.
- Applies manually. The system's job ends at "here is what is worth your time".

## 4. What this optimises for

**Making false negatives visible, not minimising tokens.**

A role wrongly hidden costs a job. A wasted evaluation costs fractions of a cent.
Every gate is therefore conservative: unknown passes, uncertainty is recorded
rather than resolved by guessing, and borderline roles are surfaced for human
review instead of silently dropped.

A direct consequence: **there is no spend ordering in v1.** Ordering evaluations
by predicted cost is cost choreography that contradicts the sentence above, and it
buys nothing at single-user volume. It can return when real volume forces it.

## 5. Non-goals

Deliberately absent, each having existed in career-ops and earned its removal:

mode files and a mode dispatcher; a plugin system; a self-update mechanism;
non-English market variants; Go and Next.js dashboards; batch runners; interview
prep; salary negotiation; LaTeX CV generation; cover letters; the A-G report
format; the embedding-based semantic ranker (the repo's own notes record it
failing to validate at rho 0.18, p 0.46).

**No migration.** Fresh repo, fresh database, fresh jobs. The 485 existing
reports, the old tracker rows and the old pipeline are not carried over in any
form, and no second score scale exists. `cv.md` and the profile are re-authored as
new inputs, not imported as state.

## 6. Stages

One direction of flow. Each stage reads the previous stage's state and writes its
own. No stage calls another; `jobfit run` invokes them in order.

```
1 DISCOVER   code   ATS boards (Greenhouse, Lever, Ashby, Workday) to new postings
2 ENRICH     code   fetch the ad, liveness, E-Verify lookup, URL canonicalisation
3 GATE       code   deterministic exclusions only
4 SCORE      LLM    one call: judge each requirement
             code   compute the band from those judgements
5 TRACK      code   applications and outcomes
   TAILOR    LLM    CV bullets, ON DEMAND only
   RENDER    code   HTML to PDF, OUTSIDE any sandbox, + fact verifier
```

**Greenhouse, Lever and Ashby expose uniform public JSON boards. Workday does
not.** Workday needs per-tenant seeds and its own pagination and backoff handling,
and it silently re-serves page 1 past a 2,000-result cap. It is a separate
provider implementation, not a fourth entry in a loop.

**TAILOR does not run automatically.** It is the highest-cost, highest-risk step
(it is the one artefact that reaches an employer under his name) and it runs when
he decides to apply, not when a score crosses a line.

**Liveness is HTTP-first.** The browser tier is reserved for apply-time
verification and for postings whose HTTP response is ambiguous. Rendering a
browser for every discovered job is what the old system did, and it is what put
Chromium inside a sandbox.

## 7. The scorer contract

One model call per job, run as a single-shot `codex exec` subprocess. Everything
inlined. **No tool calls.** The model returns JSON on stdout and writes nothing.

```json
{
  "requirements": [
    {
      "text": "5+ years of Python",
      "kind": "required",
      "verdict": "partial",
      "evidence": "exact line quoted from cv.md, or null",
      "missing": "what specifically is absent",
      "confidence": "high"
    }
  ],
  "hard_stops": ["a named tool, certification or tenure with zero evidence"],
  "notes": "one line, optional"
}
```

Rules the prompt enforces:

- **Never invent.** Reorder, reframe and re-emphasise what `cv.md` says. If a
  claim is not in `cv.md`, it does not exist.
- `evidence` must be a verbatim line from `cv.md` or `null`. Nothing paraphrased.
- Judge fit only. No pricing the role, no judging the company, no research.

The orchestrator validates the JSON against a schema and retries once on a
malformed response. A second failure marks the job `score_failed` with the raw
output kept, and never leaves a partial row that could heal into a band later.

## 8. Banding

Computed in Python from the table above. Pure, unit-tested, and independent of
prompt wording **given a fixed judgment table**.

```
credit  met 1.0   partial 0.5   gap 0.0
weight  required 1.0            preferred 0.3

fit = sum(credit * weight) / sum(weight)
```

The band is decided by the first matching rule, in order. This is exhaustive by
construction, which the previous draft was not: it left a hard stop with a fit
between 0.45 and 0.69 matching no band at all.

| # | condition | band |
|---|---|---|
| 1 | a hard stop exists **and** fit >= 0.70 | `needs_question` |
| 2 | a hard stop exists | `skip` |
| 3 | any **required** requirement has `confidence: low` | `needs_question` |
| 4 | fit >= 0.70 | `strong_apply` |
| 5 | fit >= 0.45 | `maybe` |
| 6 | otherwise | `skip` |

Two things this ordering settles:

**A hard stop caps rather than zeroes.** It never touches the fit ratio, so a
near-miss stays distinguishable from a hopeless one, and rule 1 rescues the case
the design exists for: an inflated years-of-experience line on an entry-level
posting where everything else matches. That is `needs_question`, not `skip`.

**Low confidence only counts on required lines** (rule 3). The previous draft
promoted on *any* low-confidence requirement, which meant one fuzzy preferred
bullet could drag an obvious skip into the review pile. The review queue has to
stay small enough to actually read.

**No decimal score is published.** The fit ratio exists internally for ordering
within a band. Publishing a decimal invites trust the inputs do not support.
Thresholds are config, not constants, and start unvalidated: no outcome data
exists on this scale yet.

## 9. Data

One SQLite database, the sole operational source of truth. Not markdown: dedup,
freshness, retries and crash recovery all need real state, and the previous system
already migrated away from markdown queues for exactly this reason.

- `jobs`: one row per posting. url, canonical_url (unique), company, title,
  location, source, posted_at, the enrichment results, the gate verdict, the band,
  the fit ratio, the raw requirement JSON.
- `applications`: what he applied to, when, and what came back.
- `runs`: one row per pipeline run, with per-gate drop counts, so success
  criterion 3 is queryable rather than aspirational.

`cv.md` stays a human-edited file and is never written by the system. Generated
markdown and PDFs are artefacts, not state.

**Concurrency is a run lock plus a unique constraint on `canonical_url`, not a
claim/fencing protocol.** The old queue's fencing semantics exist to coordinate
distributed workers. There is one user and one machine.

The requirement JSON is stored so a band can be **recomputed when thresholds or
weights change, without paying to re-score**. This is the single most valuable
thing the old system could not do, and its limit is worth stating plainly:
changing the prompt, the JSON schema, or the hard-stop definition invalidates the
stored judgments and does require re-scoring.

## 10. Tech stack

Python. Chosen over Node with the port list measured at 5,761 lines of existing
JS, on the grounds that what is expensive to re-derive is the *knowledge* (Workday
caps, ATS response shapes, rate-limit behaviour) rather than the code expressing
it, and that Python compounds into the language the target roles hire for.

| concern | choice | why |
|---|---|---|
| language | Python 3.13+, one pinned version, one venv | Slight existing lean, and the career-relevant language |
| store | stdlib `sqlite3` | Mature, zero install, no native build on Windows |
| HTTP | `httpx` | Retries, timeouts and connection pooling without hand-rolling |
| ad text | `trafilatura` | Turns a job ad page into clean text better than hand-written stripping |
| CLI | stdlib `argparse`, one entrypoint with subcommands | No magic to learn, and the 106-script sprawl is the disease being cured |
| tests | `pytest` | Readable assertions; the tests are how claims get verified |
| PDF | `playwright`, run outside any sandbox | The Chromium failure was a sandbox problem, not a Playwright problem |
| scorer | `subprocess` to `codex exec` | No new billing, no tool calls, no agent loop |

Four dependencies total. Every addition beyond these needs a reason written down.

`jobfit <subcommand>`: `discover`, `enrich`, `gate`, `score`, `list`, `apply`,
`tailor`, `render`, `run`, `doctor`. Each writes to stdout and returns a non-zero
exit code on failure.

## 11. Re-expressed, not ported

The old code is a reference to read, not a library to import, since the new repo
is a different language. What is being carried across is the knowledge:

- ATS provider behaviour: Workday pagination, backoff and the 2,000 cap; Ashby
  board behaviour; Lever fields; Greenhouse custom domains
- Adaptive rate limiting (measured at 63% more postings retrieved)
- `jd-fetch.mjs`: ATS URL parsing and the decode-then-strip ordering bug
- `freshness.mjs` and the five-way freshness model
- `liveness-core.mjs`: expired signals beat generic Apply text
- `everify-check.mjs` and the E-Verify index data
- URL canonicalisation
- A narrow fact verifier: every claim in a tailored CV must trace to a line in
  `cv.md`. Scope limited to that, rather than re-expressing `verify-cv-facts.mjs`
  wholesale
- The conservative gate philosophy: unknown passes, inflated years are not an
  automatic skip, E-Verify not-found is not proof of non-enrolment

## 12. Success criteria

1. A full run is one command and needs no babysitting.
2. Re-banding every stored job after a **threshold or weight** change costs zero
   tokens.
3. No failure mode can silently discard a role. Every drop is attributable to a
   named gate and is counted in `runs`.
4. **Banding is a pure function of the judgment table**, unit-tested against
   fixtures including every row of the section 8 decision table. Prompt wording is
   expected to move the judgments themselves; only the arithmetic downstream of
   the JSON is guaranteed stable. The previous draft claimed prompt wording could
   not change a band, which is not achievable and would have hidden real drift.
5. The whole system is small enough to read in one sitting. Target under 3,000
   lines and under 20 files.

## 13. Open questions

- Band thresholds (0.70 / 0.45) are guesses. They need outcome data before they
  mean anything, and the PRD should not pretend otherwise.
- Whether `preferred` weight 0.3 survives contact with real JDs.
- Discovery inputs are undefined and block the first line of code: which ATS
  tenants seed the search, the title filters and negative filters, the recency
  window, and the dedup key. These belong in the implementation plan.
- Requirement parsing rules: how the prompt distinguishes required from preferred
  when a JD does not label them, and how responsibilities are excluded from the
  table.
