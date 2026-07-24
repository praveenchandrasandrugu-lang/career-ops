# How to find jobs now (updated 2026-07-24)

The one-line goal: **surface only postings worth your attention, at employers that
can legally hire you on STEM OPT.** Every stage is zero-token (no LLM cost)
except the last one, which is the only place a model is ever paid.

## The daily run — one command

```bash
node run-daily.mjs                      # dry run: show the plan and the queue
node run-daily.mjs --apply              # the free stages, for real
node run-daily.mjs --apply --score 30   # ... and score 30 rows (THIS COSTS MONEY)
```

That is the whole pipeline, in the only order its data dependencies allow:

```
scan  ->  migrate  ->  gate  ->  fetch  ->  screen  ->  score  ->  data/apply-queue.md
```

| Stage | What it does | Cost |
|-------|--------------|------|
| `scan` | walk the ATS boards for new postings | network |
| `migrate` | import `data/pipeline.md` into `data/queue.db` | free |
| `gate` | drop stale, non-US and senior postings; record E-Verify | free |
| `fetch` | download each job ad into the row (`jd_text`) | network |
| `screen` | experience bars, hard gates, post-fetch geography | free |
| `score` | Codex workers write a full A-G report and a score | **money** |

Scoring is opt-in on every run and always carries a row budget, so "run the
daily thing" can never become an unbounded spend. Everything else is free.

Useful flags: `--skip scan` (work the existing queue), `--from gate` (resume
after a failure — the runner prints the exact command), `--only fetch` (one
stage). A stage name that does not exist is an error, never a silent no-op.

**Read `data/apply-queue.md` when it finishes.** That is the output: keepers
(score >= 3.5) highest first, 4.0+ on top, with the report link for each. Rows
you have already applied to drop off it automatically once the tracker says so.

Before spending real attention on any single posting:

```bash
node everify-check.mjs check "<Company>" --summary   # can they hire you at all?
node screen-level.mjs <url>                          # do you clear the experience bar?
```

### Running a stage on its own

The runner just sequences these, so any of them can still be run directly:

```bash
node queue-migrate.mjs           # pipeline.md -> queue.db (safe to re-run)
node gate.mjs                    # 'new' -> llm_ready | skipped
node fetch-jds.mjs --limit 400   # download ads, freshest first
node screen-queue.mjs --apply    # screen verdicts (dry run without --apply)
node score-queue.mjs             # dry run: show the scoreable pool
node score-queue.mjs --apply --limit 30 --concurrency 3
```

`score-queue` re-fetches each ad immediately before scoring it, so a posting
that closed since the last fetch is skipped for free rather than costing a full
evaluation. `--no-refresh` turns that off for an offline run or a deliberate
rescore.

## The old per-scanner commands

The runner's `scan` stage covers the broad ATS sweep. These remain for a
targeted run:

```bash
# Thin-market, high-yield: big employers on Workday, keyword-targeted.
# Breaks Workday's 2000-posting ceiling. Prefer this when the full sweep stalls.
CAREER_OPS_PORTALS=portals-harsh.yml node scan-workday-targeted.mjs --limit 200 --since 14

# Employers with no supported ATS, straight off their careers page.
node scan-direct-sites.mjs --file data/direct-sites.txt --since 30
```

⚠️ `scan-ats-full.mjs` can stall silently partway through a large Workday
directory (upstream issue #2136). Observed 2026-07-24: 72 minutes, zero output,
no open sockets, nothing written. If a scan goes quiet, kill it and use
`scan-workday-targeted.mjs` instead — the queue keeps everything already found.

## Why each piece exists

**`scan-workday-targeted.mjs`** — Workday's API caps an unfaceted board query at
2000 postings and silently re-serves page 1 past that, so at Abbott, ABB,
Accenture, Ascension and every other large employer, most of the board was
invisible. Searching one keyword at a time drops each query under the cap
(`"financial analyst"` = 220 results, fully reachable). It sees more, fetches
less, and gets throttled less. Greenhouse/Ashby/Lever have no such cap — they
return complete boards in one request — so this workaround is Workday-only.

**`scan-direct-sites.mjs`** — hospitals, universities, utilities and regional
employers often run no supported ATS. This reads schema.org `JobPosting`
structured data (JSON-LD, microdata, Next/Nuxt payloads) straight from their
careers pages. Add URLs to `data/direct-sites.txt`. If a site reports "no
structured job data," it needs a Playwright parser instead — that is reported
honestly rather than silently returning zero.

**`adaptive-limiter.mjs`** — scans used to lose real jobs to HTTP 429s (one run
fetched 60 of Amcor's 761 postings). It halves the request window per ATS family
on a throttle and widens it on success. Measured effect on an identical rerun:
zero rate-limit truncations and 63% more postings retrieved.

**`everify-check.mjs`** — the hard gate. On STEM OPT the employer must hold an
Open E-Verify account. Checks a company against the official USCIS export
(961k employers, local, instant). `NOT FOUND` is not a rejection — legal names
differ from brand names, so ask the recruiter.

**`portals-harsh.yml`** — the thin-market preset: 14 states where BLS reports
fewer unemployed people per job opening than the national average, meaning
employers compete for candidates rather than the reverse. Deliberately excludes
remote roles, which compete nationally. The main `portals.yml` still covers
remote and the rest of the country.

## Reading the output honestly

- `⚠️ Still capped at 2000` — that keyword is too broad; the tail is unreachable.
  Split it into more specific terms.
- `⚠️ No structured job data` — the scanner could not see that site, which is
  different from the site having no jobs.
- `Undated dropped: N` — postings with no date are dropped by default because
  this targets fresh roles. `--include-undated` keeps them.
- `Rate limiting (adaptive)` — a nonzero throttle percentage means an ATS pushed
  back and the limiter absorbed it. `circuit tripped` means a platform was cut
  off to stop wasting the run on doomed retries.

## Maintenance

- **After every `node update-system.mjs apply`**, re-apply the local patches
  listed in `modes/_custom.md` (the limiter wiring in `scan-ats-full.mjs`, the
  `upskill.mjs` SSRF fix, the CV template palette). Verify with the greps there.
- **Refresh the E-Verify data quarterly**: replace `data/everify/everify_*.csv`
  from the USCIS export, then `node everify-check.mjs index`.
- **Tennessee's E-Verify threshold drops to 1+ employee on 2027-01-01** (HB1194).
  Update the `MANDATE` map in `everify-check.mjs` then.
