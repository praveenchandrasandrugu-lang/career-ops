# Handoff prompt: semantic JD-to-CV scoring (what we tried, what happened, what's next)

Copy everything below the line into the other project's Claude.

---

I'm working on a job-search automation system and I want to build (or evaluate) semantic
matching between a candidate's CV and job descriptions. A sibling project already ran this
experiment and **parked it as not-yet-trustworthy**. Here is the complete record so you don't
repeat the dead ends. Please read it, then help me decide whether to revive, redesign, or drop
the approach.

## Goal

Rank a large pool of job postings by how well they match one candidate's CV, so the candidate
only spends attention on worthwhile postings. The ranking must be **local and zero-API-cost**
(the pool is 300+ jobs and re-ranked often, so per-job LLM calls are too expensive). It is a
*ranking* problem, not a classification problem: hard eligibility gates (years of experience,
graduation cohort, named certifications, work authorization) are already handled separately by
deterministic regex screens that are trusted and working. Semantic scoring is only meant to
sort the already-eligible bucket.

## What was built

`capexempt-screen.mjs --rank` — opt-in local semantic ranking, never changes which bucket a job
lands in, only the sort order within the eligible bucket.

- Library: `@xenova/transformers` (transformers.js), running fully locally, no API calls.
- Model: `Xenova/all-MiniLM-L6-v2`.
- Method: chunk `cv.md` into ~18 paragraph-level chunks; chunk each JD into sentences with
  boilerplate stripped by regex (EEO statements, benefits, "apply now"); for each JD sentence
  take its single best cosine similarity against any CV chunk; average the top-3 of those.
- Concurrency dropped from 8 to 4 in rank mode to bound CPU contention from embedding.

## What happened: it did not validate

Three backtests against real human-assigned evaluation scores (1-5 scale). None statistically
significant:

| Test | n | Spearman rho | p | Note |
|---|---|---|---|---|
| Broad mix, whole-doc mean-pooled embedding | 27 | 0.23 | 0.25 | weak |
| Broad mix, chunk-max-pool (top-3, boilerplate-filtered) | 24 | 0.27 | 0.20 | weak-moderate, right direction |
| Within the actual eligible population (the real target) | 19 | 0.18 | 0.46 | weakest |

The third row is the one that matters: ranking is only ever applied within the eligible bucket,
and *within* that bucket the signal nearly vanishes. Plausible reading: once hard gates remove
the obviously-unfit jobs, the remaining variance in human score is driven by things embeddings
don't capture (seniority nuance, domain-specific tooling, company quality, comp).

## The unresolved discrepancy (important, do not skip)

An **earlier** run of the same idea reported **rho = 0.43, p = 0.029, n = 26** — materially
better. The two runs differed in four ways simultaneously, and the cause was never isolated:

| | Better run (rho 0.43) | Worse run (rho 0.18-0.27) |
|---|---|---|
| Model | `all-mpnet-base-v2` (larger, stronger STS model) | `all-MiniLM-L6-v2` (smaller, faster) |
| CV chunk source | CV bullets **plus** a separate proof-points file | CV only |
| Averaging | top-5 | top-3 |
| JD text | cached text files | live-refetched |

Never cite the 0.43 figure without this caveat. Isolating which variable caused the gap is
probably the single highest-value next experiment: it is a 4-cell ablation, not a rewrite.

## Why it was parked rather than deleted

The decision was to keep using the deterministic regex gates (which are validated and trusted)
and not let an unvalidated ranking decide what to skip. The risk asymmetry matters: a bad
ranking that buries a good job is invisible damage — the candidate never sees what they missed.

## The core methodological problem

Only 19 of ~326 eligible jobs had a human evaluation score to validate against. Any correlation
measured on n=19 is nearly uninformative. The stated resume plan was to accumulate n>=40-50 real
scores — ideally via a **deliberate spread sample** (e.g. 10 top-ranked, 10 middle, 10 bottom
from the ranker's output) rather than organic accumulation, because organic scoring is itself
biased toward jobs the candidate already liked, which truncates the range and depresses
correlation.

## What I want from you

1. Is embedding cosine similarity even the right tool for "rank already-eligible jobs by fit"?
   Argue honestly, including the case that it is not — a weak-signal ranker may be worse than
   no ranker if it creates false confidence.
2. If the approach is worth reviving, design the ablation to isolate the 0.43-vs-0.18 gap with
   the fewest runs.
3. Suggest alternatives that stay zero-API-cost: TF-IDF or BM25 over required-qualifications
   sections; a small supervised model (logistic regression / gradient boosting) trained on the
   human scores using cheap explicit features (title tokens, years-required, seniority markers,
   named tools matched against a CV skills list, salary band, company size) — this may well beat
   embeddings at n<100 and has the large advantage of being *inspectable*.
4. Tell me what sample size and validation design would make the result trustworthy, and what
   evaluation metric fits the real use case better than Spearman rho over all jobs. Consider
   that the true objective is top-k precision (are the top 20 worth the candidate's time?), not
   global rank correlation.
5. Flag any statistical mistakes in the work described above.

Be skeptical. If the honest answer is "the data cannot support this yet, spend the effort
elsewhere," say so plainly.
