# analysis/ — one-off measurement probes

Read-only probes that answer "is this filter worth building?" against real data
(`data/queue.db`, `reports/*.md`). They never write. Run from anywhere:

```bash
node analysis/probe-whatkills.mjs     # what actually drives a low score
node analysis/probe-yoe-leak.mjs      # experience bars that screen-jd.mjs missed
node analysis/probe-hardwall.mjs      # named cert / clearance walls
node analysis/probe-clean-pool.mjs    # the scoreable pool, by freshness bucket
```

## Findings, 2026-07-21

Measured before building the step-8 scorer, to decide what to pre-screen.

### What drives a low score (269 reports, `probe-whatkills.mjs`)

| theme | low <3.5 | high >=3.5 | lift |
|---|---|---|---|
| years-of-experience | 123 (57%) | 8 (15%) | **3.95** |
| work-auth-or-clearance | 73 (34%) | 7 (13%) | 2.68 |
| comp-or-location | 45 (21%) | 2 (4%) | 5.78 |
| depth-of-coding | 28 (13%) | 1 (2%) | 7.20 |
| domain-knowledge | 98 (46%) | 22 (40%) | 1.14 |
| **named-tool-or-cert** | 68 (32%) | 20 (36%) | **0.87** |

**The experience bar is the killer. Named tools and certifications are not a
discriminator at all** (lift below 1: they appear slightly *more* often in good
reports than bad ones). Screening on "requires a skill I lack" would remove
roughly as many good jobs as bad. Do not build it.

Raw frequency in the bad group is not evidence. Only the ratio against the base
rate in the good group is.

### The experience screen leaks (`probe-yoe-leak.mjs`)

Of 1,290 rows tagged `level_status='clear'` (supposedly bar-free), **30.8%
contain an experience bar** and 127 have one above the candidate's 2.3 years.
`screen-jd.mjs` misses written-out numbers ("Six or more years") and several
phrasings.

Two shapes generate false positives and must be handled, both named in
`modes/_custom.md`:

- **bands** — "Minimum 2 to 4 years" is cleared by 2.3. Take the floor, not the ceiling.
- **OR-equivalency** — "Bachelor's degree OR five years experience" is a door, not a wall.

Eyeballing 10 samples, 3 to 4 were false positives, so the true leak is nearer
60 to 90 rows.

### Generic certification extraction does not work (`probe-hardwall.mjs`)

Top "X certification" phrases across 1,763 ads: `Coding` (3), `Professional`
(2), then a tail of 1s including `Generate`, `Work`, `Other`, `Excelencia`,
`Forklift`. Same failure mode as `jd-skill-gap.mjs`. Any skill screen needs a
**controlled vocabulary**, never open-ended extraction.

The narrow hard-wall set (clearance plus *licensed* credentials only) flags 117
of 1,290 clear rows, but **88 of those are security clearance** that the
existing citizenship screen missed. The genuine named-cert wall is only ~29 rows
(2.2%).

### The resulting scoreable pool (`probe-clean-pool.mjs`)

```
bucket    total   barFail   wall   CLEAN
hot         145        17     17     113
fresh       285        20     19     247
backup      860        92     55     717
TOTAL      1290       129     91    1077  (83.5%)
```
