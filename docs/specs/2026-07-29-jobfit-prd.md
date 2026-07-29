# PRD: a minimal job-fit pipeline

**Status:** draft for review
**Date:** 2026-07-29
**Replaces:** career-ops (fork of santifer/career-ops)

---

## 1. Why replace what exists

career-ops was built for a Head-of-Applied-AI search in Spain. Measured on 2026-07-28:

| | |
|---|---|
| top-level `.mjs` scripts | 106 (45,208 lines) |
| scripts reachable from the live pipeline | ~27 |
| mode files | 137, of which 36 are non-English market variants |
| tracked files | 789 |

Roughly three quarters of the code has never run. The unused parts are not badly
written; they are shaped for a different person's search. Carrying them forward
costs comprehension on every change.

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

## 3. Who it is for

One user: a May-2025 MS Data Analytics graduate on STEM OPT, searching the US.

The constraints that actually drive design:

- **E-Verify enrollment is a hard employment gate.** But a company-name match is
  not proof either way, so "not found" must never be treated as "not enrolled".
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

## 5. Non-goals

Deliberately absent, each having existed in career-ops and earned its removal:

mode files and a mode dispatcher; a plugin system; a self-update mechanism;
non-English market variants; Go and Next.js dashboards; batch runners; interview
prep; salary negotiation; LaTeX CV generation; cover letters; the A-G report
format; the embedding-based semantic ranker (the repo's own notes record it
failing to validate at rho 0.18, p 0.46).

## 6. Stages

One direction of flow. Each stage reads the previous stage's state and writes its
own. No stage calls another.

```
1 DISCOVER   code   ATS APIs (Greenhouse, Lever, Ashby, Workday) -> new postings
2 ENRICH     code   fetch the ad, liveness, E-Verify lookup, URL canonicalisation
3 GATE       code   deterministic exclusions + spend ordering
4 SCORE      LLM    one call: judge each requirement
             code   compute the band from those judgements
5 TRACK      code   applications and outcomes
   TAILOR    LLM    CV bullets, ON DEMAND only
   RENDER    code   HTML -> PDF, OUTSIDE any sandbox, + fact verifier
```

**TAILOR does not run automatically.** It is the highest-cost, highest-risk step
(it is the one artefact that reaches an employer under his name) and it runs when
he decides to apply, not when a score crosses a line.

## 7. The scorer contract

One model call per job. Everything inlined. **No tool calls.** The model returns
JSON on stdout and writes nothing.

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

## 8. Banding

Computed in JS from the table above. Deterministic, unit-tested, and independent
of prompt wording.

```
credit  met 1.0   partial 0.5   gap 0.0
weight  required 1.0            preferred 0.3

fit = sum(credit * weight) / sum(weight)
```

| band | rule |
|---|---|
| `strong_apply` | fit >= 0.70, no hard stop |
| `maybe` | fit >= 0.45, no hard stop |
| `skip` | fit < 0.45 |
| `needs_question` | any requirement with `confidence: low`, or a hard stop with `fit >= 0.70` |

**`needs_question` is the point of the design.** It is where a role that looks
disqualified on paper but is worth a human glance goes, instead of into `skip`.
An inflated years-of-experience line on an entry-level posting lands here.

A hard stop **caps** the band at `skip` rather than zeroing the fit, so a
near-miss stays distinguishable from a hopeless one. Thresholds are config, not
constants, and start unvalidated: no outcome data exists on this scale yet.

**No decimal score is published.** The fit ratio exists internally for ordering
within a band. Publishing a decimal invites trust the inputs do not support.

## 9. Data

One SQLite database. Not markdown: dedup, claims, freshness, retries and crash
recovery all need real state, and the previous system already migrated away from
markdown queues for exactly this reason.

- `jobs` — one row per posting: url, company, title, location, source, posted_at,
  the enrichment results, the gate verdict, the band, the fit ratio, the raw
  requirement JSON.
- `applications` — what he applied to, when, and what came back.

The requirement JSON is stored so a band can be **recomputed when the rules
change, without paying to re-score**. That is the single most valuable thing the
old system could not do.

## 10. Ported, not rewritten

Load-bearing and expensive to re-derive:

- ATS provider fetchers, especially Workday pagination and backoff, Ashby board
  behaviour, Lever fields, Greenhouse custom domains
- `jd-fetch.mjs`: ATS URL parsing and HTML-to-text handling
- `freshness.mjs`
- `liveness-api.mjs` + `liveness-core.mjs` (browser tier runs outside any sandbox)
- `everify-check.mjs` and the E-Verify index
- URL canonicalisation and the queue claim/fencing semantics from `queue.mjs`
- `verify-cv-facts.mjs`
- The conservative gate philosophy: unknown passes, inflated years are not an
  automatic skip, E-Verify not-found is not proof of non-enrolment
- `cv.md`, `config/profile.yml`, the applications tracker

## 11. Success criteria

1. A full run is one command and needs no babysitting.
2. Re-banding every stored job after a rule change costs zero tokens.
3. No failure mode can silently discard a role. Every drop is attributable to a
   named gate and countable.
4. Changing the scorer's prompt wording does not change any band.
5. The whole system is small enough to read in one sitting. Target under 3,000
   lines and under 20 files.

## 12. Open questions

- Band thresholds (0.70 / 0.45) are guesses. They need outcome data before they
  mean anything, and the PRD should not pretend otherwise.
- Whether `preferred` weight 0.3 survives contact with real JDs.
- Migration: the 485 existing reports carry no requirement table, so they cannot
  be re-banded. They stay on their old scale and are never mixed with new ones.
- Project name.
