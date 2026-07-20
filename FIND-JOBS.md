# How to find jobs now (2026-07-20)

The one-line goal: **surface only postings worth your attention, at employers that
can legally hire you on STEM OPT.** Everything below is zero-token (no LLM cost)
unless noted.

## The daily run

```bash
# 1. Thin-market, high-yield: big employers on Workday, keyword-targeted.
#    This is the highest-yield scan. It breaks Workday's 2000-posting ceiling.
CAREER_OPS_PORTALS=portals-harsh.yml node scan-workday-targeted.mjs --limit 200 --since 14

# 2. Everything else on the major ATS platforms (nationwide, incl. remote).
node scan-ats-full.mjs --since 7

# 3. Employers with no supported ATS, straight off their careers page.
node scan-direct-sites.mjs --file data/direct-sites.txt --since 30
```

Then, before spending real attention on anything:

```bash
node everify-check.mjs check "<Company>" --summary   # can they hire you at all?
node screen-level.mjs <url>                          # do you clear the experience bar?
```

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
