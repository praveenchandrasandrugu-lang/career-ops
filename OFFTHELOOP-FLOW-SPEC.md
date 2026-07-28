# The "Recruiter-in-a-Box" Flow — Session Teardown & OffTheLoop Spec

> A reusable design spec, reverse-engineered from a live career-ops session that took a candidate from a blank install to application-ready (tailored CVs, recruiter outreach, interview kit) in one sitting. Written so it can be rebuilt as a product flow inside **OffTheLoop**.

---

## 0. The one-sentence thesis

**A great job-search product is not a search engine. It's a recruiter that onboards you once, then does the cheap work broadly and the expensive work narrowly — and is brutally honest about fit.**

Everything below is downstream of that sentence.

---

## 1. Why this flow felt good (the qualities to replicate)

These are the UX properties worth protecting when you rebuild it:

| Property | What it looked like | Why it worked |
|---|---|---|
| **Answer-first** | Every step led with the conclusion, then the detail. | Users want the verdict, not a lecture. |
| **Cheap-before-expensive** | Free portal scan (1,402 roles) → free filter (55) → paid evaluation (5) → paid tailoring (2). | Never spend the expensive resource until the cheap one has narrowed the field. |
| **Honest calibration** | Candidate said "my coding is basic, I build with AI." The system re-scored around that instead of flattering the resume. | Trust. A tool that tells you to *skip* a role is more believable when it says *apply*. |
| **Hard filters, not soft scores** | Visa sponsorship was a kill-switch, not a -0.3 penalty. | Some constraints are binary. Treating them as binary saves wasted applications. |
| **Never fabricate** | CVs injected only keywords backed by the source resume; gaps were listed, not invented. | Anything written can resurface in the interview. Fabrication is a landmine. |
| **Stop before submit** | Drafts, PDFs, messages — all generated, none sent. | The human keeps the final call. Always.|
| **Visible reasoning** | Each role showed score + sponsorship + interview-risk + a one-line verdict. | The "why" is the product. A bare number isn't trustworthy. |

---

## 2. The end-to-end flow

```
   ONBOARD ─────────────────────────────────────────────────────┐
   (once)   resume ingest  →  4 targeting questions  →  guardrails│
                                                                  ▼
   SCAN ──────────────►  FILTER ──────────►  EVALUATE ──────►  RANK
   (free, wide)          (free, rules)       (LLM, narrow)     (verdicts)
   1,402 roles           55 realistic        5 scored          apply/skip
                                                                  │
                          ┌───────────────────────────────────────┤
                          ▼                    ▼                   ▼
                    TAILOR CV            OUTREACH             INTERVIEW PREP
                    (only fit >= 4.0)    (confirm blockers)   (only where applying)
                          │                    │                   │
                          └──────────► REVIEW & SEND (human) ◄──────┘
```

The key move is the **funnel narrows as cost rises**. 1,402 → 55 costs nothing. Only 5 got the expensive LLM pass. Only the 4.0+ roles got a tailored CV. Only the role being applied to got an interview kit.

---

## 3. Onboarding — the questions (the part worth stealing)

Onboarding is two beats: **ingest what exists**, then **ask only what you can't infer**.

### Beat 1 — Ingest (no questions, just do it)

Parse the resume into structured fields (summary, experience, projects, skills, education). Everything you can extract, you must NOT ask about. Asking users to retype their resume is where products die.

### Beat 2 — The four questions

Ask *only* what changes the downstream behavior. Each question below earns its place because the answer **reshapes targeting or scoring** — not because it's nice to know.

**Q1 — Target roles** *(multi-select, wide)*
> "What roles should I primarily target for you?"
> Options framed by *evidence*, not just title:
> - Data / Analytics Engineer — *"Strongly backed by your real experience. Safest in interviews, fastest to offer."*
> - AI Engineer / App Developer — *"Backed by your project. Higher ceiling, expect deeper technical grilling."*
> - Forward-Deployed / Solutions — *"Values shipping fast over deep CS fundamentals."*
> - AI Product / Technical PM — *"Leans on communication, less on hand-coding."*

*Design intent:* every option names the **trade-off**, so the user chooses with eyes open. The magic is annotating each choice with "here's what this costs you," not just listing titles.

**Q2 — Visa / work authorization** *(single-select, this is a HARD filter)*
> "What's your US work authorization / visa status?"
> - Need sponsorship (F-1/OPT/STEM)
> - Authorized, no sponsorship needed
> - Need sponsorship now (H-1B/other)

*Design intent:* this is the single highest-leverage question in the whole flow. It flips a binary gate that eliminates a huge fraction of roles. Ask it early, treat it as a kill-switch, and surface a sponsorship verdict on *every* role.

**Q3 — Target compensation** *(single-select, with an escape hatch)*
> "What's your target total compensation range?"
> - $70K–100K / $100K–140K / $140K+ / **Open — whatever lands fastest**

*Design intent:* the "open / fastest" option is the tell. It captures *urgency*, which changes whether you recommend bridge roles. Comp questions should always allow "I care more about speed than the number."

**Q4 — Work arrangement** *(single-select)*
> "What work arrangement do you want?"
> - Remote only / Remote + regional hybrid / **Open to anything**

*Design intent:* "open to anything" widens the pool for people who prioritize landing over location. Don't force a single city.

### The rule behind the questions

> **Ask a question only if the answer changes what the system does next.** If you can infer it, infer it. If it doesn't change targeting or scoring, don't ask it.

That discipline is why it felt fast instead of like a form.

---

## 4. The guardrails (the honesty engine)

After onboarding, freeze a small set of scoring rules that override the raw resume. In this session they were:

1. **Sponsorship is a hard filter.** Down-score / flag every employer that likely won't sponsor.
2. **Reward shipping-over-fundamentals roles.** "Can you build and deliver" > "reverse a red-black tree."
3. **Flag deep-CS interview risk honestly.** If a role implies a LeetCode gauntlet, say so.
4. **Speed matters.** Bridge/adjacent roles are valid, not "beneath" the candidate.
5. **Never fabricate seniority or skills.** Reformulate keywords, never invent them.

**Product translation:** these are per-user "scoring policies." Store them as structured config the scoring model reads on every evaluation. Let users see and edit them ("Actually, I *do* want to grind LeetCode — turn off the risk penalty").

---

## 5. The evaluation engine

Each shortlisted role gets a structured, multi-block evaluation. The blocks that mattered:

- **Role summary + archetype** — what kind of role is this, really?
- **CV match + gaps** — requirement-by-requirement, with a mitigation for each gap.
- **Level strategy** — "sell up without lying" + "if they down-level me" plan.
- **Comp demand** — the JD's own number first, then researched market data, sources cited.
- **Interview plan** — 6–10 STAR stories mapped to requirements, drawn only from real experience.
- **Posting legitimacy** — is this a real, live, non-ghost job? Sponsorship signal. Reposting check.

Output per role, always visible:
```
SCORE:          X.X / 5
SPONSORSHIP:    likely yes / no / unclear  (+ evidence)
INTERVIEW_RISK: low / medium / high        (+ why)
VERDICT:        apply / stretch / skip     (one sentence)
```

**Architecture note:** the 5 roles were evaluated by **5 parallel workers**, not sequentially. Independent work → fan out. Reserve IDs up front so parallel writers never collide. This is a ~5x wall-clock win and directly applicable to OffTheLoop's batch scoring.

---

## 6. Downstream actions (gated by verdict)

| Action | Gate | Output |
|---|---|---|
| **Tailored CV** | score ≥ 4.0 | 1-page, ATS-clean PDF, keywords injected only if true, gaps listed not faked |
| **Recruiter outreach** | blocker to confirm (e.g. sponsorship) | drafted message + found the actual contact + a scam-safety check |
| **Interview kit** | you're actually applying | likely loop, skill drills at your real level, STAR stories, honesty scripts |
| **Cover letter / form answers** | on request | draft-only, from source of truth |

Nothing auto-sends. The system produces; the human ships.

---

## 7. How to revamp this for OffTheLoop

Concrete mapping from this flow to your product:

1. **Onboarding wizard = the 4 questions.** Build them as annotated multi-select cards (each option shows its trade-off). Ingest the resume first; only ask the 4.
2. **Scoring policies = editable guardrails.** Expose sponsorship/interview-risk/speed as toggles the user controls. This is your differentiator — most tools score generically; you score *to the user's constraints*.
3. **The verdict card is the core UI unit.** Score + sponsorship + interview-risk + one-line verdict. Make *that* the thing users screenshot and share.
4. **Cheap-before-expensive as an architecture principle.** Your scan/enrich is free-ish (APIs); reserve LLM evaluation for the shortlist. Gate tailoring behind a fit threshold.
5. **Honesty as a brand.** A product that says "skip this, you'll get grilled" builds more trust than one that says "94% match!" to everything. Lean into it.
6. **"Confirm the blocker" as a first-class step.** Before a user sinks effort into a maybe-role, generate the one message that resolves the binary (sponsorship, location, clearance). Huge time-saver, very sticky.
7. **Draft, never send.** Keep the human in the loop at submit. It's an ethics stance *and* a trust feature.

---

## 8. Appendix — this session as a worked example

- **Input:** 1 resume + 4 answers (target: broad; visa: F-1 STEM OPT / needs sponsorship; comp: open; location: open).
- **Scan:** 1,402 raw roles across ~45 portals, zero LLM cost.
- **Filter:** → 55 realistic US entry/mid roles in-lane.
- **Evaluate:** 5 roles, in parallel.

| Role | Score | Sponsorship | Interview risk | Verdict |
|---|---|---|---|---|
| Clay — Data Analyst | 4.5 | verified sponsor | low | **Apply (top pick)** |
| Arize — Forward Deployed AI Eng | 4.1 | has filed H-1Bs, confirm | medium | Apply |
| Attio — Forward Deployed Eng | 3.5 | unlikely | medium | Confirm sponsorship first |
| Boomi — AI Full Stack Eng | 3.4 | likely | medium | Stretch |
| Anthropic — Data Engineer | 2.7 | yes | high | Skip (senior) |

- **Tailor:** 1-page ATS CVs for Clay, Arize, Attio (all truthful, gaps listed).
- **Outreach:** found the Arize TA lead; drafted a sponsorship-first message.
- **Prep:** Clay interview kit — SQL drills, dbt primer, 6 STAR stories, honesty scripts.
- **Sent:** nothing. Every artifact left for human review.

**Elapsed:** one session. **Setup reused forever after:** the resume, the 4 answers, and the guardrails now make every future batch nearly free to run.

---

*The whole thing rests on one idea: onboard like a recruiter (learn the person once), then work like a recruiter (cheap and wide, then expensive and narrow), and stay honest enough that "apply" means something.*
