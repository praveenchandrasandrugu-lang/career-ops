/**
 * screen-jd.test.mjs — the zero-token screen over stored job-ad text.
 *
 * Step 7 of the pipeline. Now that jd_text exists, the ad can be read for free
 * and the plainly-ineligible postings dropped before any model is paid.
 *
 * The gates implemented here are NOT invented: modes/_custom.md names exactly
 * four hard gates (citizenship / clearance / permanent-authorization demands, a
 * graduation-cohort window the candidate fails, an experience bar he does not
 * clear, and a terminated E-Verify employer). The first three are readable from
 * the ad; the fourth already runs elsewhere.
 *
 * The asymmetry that governs every threshold below: a false positive here
 * silently deletes a job the candidate should have seen, and he never finds out
 * what he missed. A false negative only costs one look. So every gate fires
 * only on an explicit, unambiguous statement, and anything unstated passes.
 *
 * Each case below is drawn from a real outcome recorded in screen-level.mjs's
 * header or in modes/_custom.md, not from imagination.
 *
 * Run: node tests/screen-jd.test.mjs  (or via test-all.mjs)
 */
import { pass, fail } from './helpers.mjs';
import { findExperienceBar, findCitizenshipGate, findCohortGate, findNamedCertGate, screenJd } from '../screen-jd.mjs';

const T = (label, cond) => (cond ? pass(label) : fail(label));
const eq = (label, got, want) => T(`${label}${got === want ? '' : ` (got ${JSON.stringify(got)})`}`, got === want);

// ── the experience bar ─────────────────────────────────────────────────────
// Real rejections: Anthropic DE (2.7) and Boomi (3.4) both turned on "5+ years".

eq('findExperienceBar: reads the number out of "5+ years"',
  findExperienceBar('We need 5+ years of backend experience.').minYears, 5);
eq('findExperienceBar: reads a range as its LOWER bound ("2-4 years" is a 2-year bar)',
  findExperienceBar('2-4 years of demonstrated experience in dashboards').minYears, 2);
eq('findExperienceBar: reads "at least 3 years"',
  findExperienceBar('Candidates need at least 3 years in analytics.').minYears, 3);
eq('findExperienceBar: takes the LOWEST bar when an ad states several',
  findExperienceBar('8 years of leadership preferred. Minimum of 2 years of SQL required.').minYears, 2);
eq('findExperienceBar: an ad with no stated bar reports null, never 0',
  findExperienceBar('You will own the data platform.').minYears, null);

// ── written-out numbers (the 127-job leak) ─────────────────────────────────
// YOE_RE only captured \d+, so "six years" and "Six or more years" sailed
// through as clear. Measured on real ads: 30.8% of level_status='clear' rows
// carried a bar screen-jd missed, 127 of them above the candidate's 2.3 years.
// The single most common miss was the number spelled out.
eq('findExperienceBar: reads a WRITTEN-OUT number ("six years of experience")',
  findExperienceBar('We need six years of backend experience.').minYears, 6);
eq('findExperienceBar: reads "Six or more years"',
  findExperienceBar('Six or more years of relevant experience required.').minYears, 6);
eq('findExperienceBar: reads "a minimum of four years"',
  findExperienceBar('A minimum of four years in analytics is required.').minYears, 4);
eq('findExperienceBar: a written-out bar under three years still parses',
  findExperienceBar('Two years of experience with dashboards.').minYears, 2);
eq('findExperienceBar: "one year" is not confused with a larger word-number',
  findExperienceBar('One year of relevant experience required.').minYears, 1);

// Target #017 (scored 4.4) was viable precisely because of this clause, while
// Target FP&A (3.8) was not — same number of years, opposite outcome. Missing
// the escape hatch would throw away the better of the two jobs.
T('findExperienceBar: spots the "or masters" escape hatch',
  findExperienceBar('3+ years of experience OR a masters level education').hasEscapeHatch === true);
T('findExperienceBar: spots "or equivalent experience"',
  findExperienceBar('5 years of experience or equivalent practical experience').hasEscapeHatch === true);
T('findExperienceBar: does not invent an escape hatch that is not there',
  findExperienceBar('3+ years AS A Data Analyst').hasEscapeHatch === false);
T('findExperienceBar: reports the sentence it matched, so a human can check it',
  /5\+ years/.test(findExperienceBar('Requires 5+ years of Python.').evidence || ''));

// A number far out of range is almost always something else ("25 years in
// business", "founded 30 years ago"), and reading it as a requirement would
// drop a junior role.
eq('findExperienceBar: ignores an implausible figure (company age, not a requirement)',
  findExperienceBar('Acme has served customers for 30 years.').minYears, null);

// ── citizenship / clearance ────────────────────────────────────────────────
// STEM OPT is temporary authorization, so these are genuine bars (_custom.md).

T('findCitizenshipGate: "must be a US citizen" is a bar',
  findCitizenshipGate('Applicants must be a US citizen.').gated === true);
T('findCitizenshipGate: "US citizens only" is a bar',
  findCitizenshipGate('This role is open to US citizens only.').gated === true);
T('findCitizenshipGate: a permanent-authorization demand is a bar',
  findCitizenshipGate('Must have permanent work authorization in the United States.').gated === true);
T('findCitizenshipGate: an active-clearance requirement is a bar',
  findCitizenshipGate('This position requires an active TS/SCI clearance.').gated === true);

// modes/_custom.md is explicit: "a clearance line under 'What We Value' is a
// preference, not a bar." Treating every mention of the word as a bar would
// delete a large number of perfectly open roles.
T('findCitizenshipGate: a clearance listed as PREFERRED is not a bar',
  findCitizenshipGate('Security clearance preferred but not required.').gated === false);
// REVERSED 2026-07-24, on evidence. "Obtainable after hire" is a runway for a
// US citizen and a wall for this candidate: the US Government requires US
// citizenship to hold a clearance, so a clearance he must obtain is one he can
// never obtain. Three Boeing F-22 roles reached the PAID scorer behind this
// exemption and scored 1.4, 1.6 and 1.8 -- the ad said "requires the ability to
// obtain a US Security Clearance for which the US Government requires US
// Citizenship", and the sentence's own "ability to obtain" rescued it from the
// gate. The softener still applies to everything else (a cert obtainable after
// hire IS obtainable), so only clearances change.
T('findCitizenshipGate: an ability to OBTAIN a clearance is a bar (he cannot obtain one)',
  findCitizenshipGate('Must be able to obtain a security clearance after hire.').gated === true);
T('findCitizenshipGate: the real Boeing F-22 phrasing is a bar',
  findCitizenshipGate('This position requires the ability to obtain a US Security Clearance for which the US Government requires US Citizenship as a condition of employment.').gated === true);
T('findCitizenshipGate: "US Citizenship only" is a bar',
  findCitizenshipGate('US Citizenship only. Applicants must be able to work in a secure facility.').gated === true);
// The softener must survive for everything that is genuinely obtainable, or
// this fix trades one silent loss for another.
T('findNamedCertGate: an obtainable certification is STILL not a bar after the clearance fix',
  findNamedCertGate('Must obtain Epic certification within 12 months of hire.').gated === false);
T('findExperienceBar: an obtainable-phrased years line is unaffected',
  findExperienceBar('5 years of experience preferred.').minYears === null);
T('findCitizenshipGate: merely naming clearance work is not a bar',
  findCitizenshipGate('Our customers include agencies where clearance work happens.').gated === false);

// A plain sponsorship refusal stopped being a kill on 2026-07-19 — the
// candidate does not need sponsorship on STEM OPT. It must not gate here.
T('findCitizenshipGate: a plain "we do not sponsor" line is NOT a bar (STEM OPT needs no sponsorship)',
  findCitizenshipGate('We are unable to sponsor visas for this role.').gated === false);

// ── graduation cohort ──────────────────────────────────────────────────────
// Palantir FDSE (3.3): "Must be graduating in December 2026 or Spring 2027".

T('findCohortGate: a graduation-window demand is caught',
  findCohortGate('Must be graduating in December 2026 or Spring 2027.').gated === true);
T('findCohortGate: "currently enrolled" is caught',
  findCohortGate('Candidates must be currently enrolled in a degree program.').gated === true);
T('findCohortGate: an ordinary degree requirement is not a cohort gate',
  findCohortGate('Bachelor degree in Computer Science required.').gated === false);

// ── named certifications ───────────────────────────────────────────────────
// _custom.md, added 2026-07-17 after report #228: a named cert has no honest
// equivalency argument, unlike a generic years bar.

T('findNamedCertGate: a named platform certification is caught',
  findNamedCertGate('Epic certification in Resolute HB required.').gated === true);
T('findNamedCertGate: a professional license is caught',
  findNamedCertGate('Must be a licensed Registered Nurse.').gated === true);

// The same doctrine carves out two exceptions, and both matter: a "preferred"
// cert and a post-hire runway are learnable, not a pre-hire wall.
T('findNamedCertGate: a PREFERRED certification is not a bar',
  findNamedCertGate('Epic certification preferred.').gated === false);
T('findNamedCertGate: a certification obtainable after hire is not a bar',
  findNamedCertGate('Must obtain Epic certification within 12 months of hire.').gated === false);

// ── the combined verdict ───────────────────────────────────────────────────

eq('screenJd: a wide-open ad is clear',
  screenJd('Join our team building data pipelines. Bachelor degree preferred.').verdict, 'clear');

// DOCTRINE CHANGE 2026-07-23 (Codex review + measured lift). An experience bar
// is NEVER a hard drop. It quarantines the job (verdict 'stretch', kept and
// flagged), it does not delete it. Two facts force this: 15% of GOOD jobs
// (score >=3.5) still cite a failing bar, and years requirements are routinely
// inflated, negotiable, or met by internships / graduate work. A wrong drop is
// invisible damage. Only a legally/administratively absolute wall
// (citizenship, permanent-authorization, graduation cohort, licensed cert)
// still gates. The experience bar was the last non-absolute gate; it is gone.
eq('screenJd: a 5-year bar with no escape hatch is a STRETCH, not a drop (quarantine doctrine)',
  screenJd('Requires 5+ years of production engineering.').verdict, 'stretch');
eq('screenJd: even a 10-year bar quarantines rather than dropping',
  screenJd('Requires 10+ years of engineering leadership.').verdict, 'stretch');
eq('screenJd: a written-out five-year bar also quarantines, not clear, not gated',
  screenJd('We require five years of production experience.').verdict, 'stretch');
// An escape hatch removes the BAR, it does not make the job a comfortable fit:
// a fresh graduate answering a 5-year ad on an equivalency clause is stretching,
// and calling that "clear" would overstate it. So the hatch decides gated vs
// not, and the number alone decides clear vs stretch.
eq('screenJd: the same 5-year bar WITH an escape hatch is a stretch, not a drop',
  screenJd('Requires 5+ years of experience or equivalent practical experience.').verdict, 'stretch');
eq('screenJd: a 3-year bar is a stretch, not a drop (he has cleared these before)',
  screenJd('Requires 3+ years of analytics experience.').verdict, 'stretch');
eq('screenJd: citizenship beats everything else',
  screenJd('Entry level, no experience needed. Must be a US citizen.').verdict, 'gated');

T('screenJd: a gated verdict always says which gate fired',
  screenJd('Requires an active TS/SCI clearance.').reasons.length > 0);
T('screenJd: a clear verdict carries no reasons',
  screenJd('Build dashboards with our team.').reasons.length === 0);

// An empty or missing ad must NOT be silently dropped: no text is not evidence
// of ineligibility, and dropping it would lose the job to a fetch failure.
eq('screenJd: an ad with no text is unknown, never gated', screenJd('').verdict, 'unknown');
eq('screenJd: null input is unknown, never gated', screenJd(null).verdict, 'unknown');

// ── false positives found by auditing 2,273 real ads (not hypotheticals) ────
//
// Each of the four below was DROPPING a real posting. They are the reason a
// green suite is not evidence: every one of these passed the tests above.

// "at least 5 years ... preferably" and "5+ years warehouse experience
// preferred" were both being treated as hard bars. A preference is not a bar,
// and the softener was only being applied to clearances, not to the years bar.
eq('screenJd: "5+ years ... preferred" is a preference, not a bar',
  screenJd('5+ years warehouse experience preferred. Entry level welcome.').verdict, 'clear');
eq('screenJd: "at least 5 years ... preferably" is a preference, not a bar',
  screenJd('Candidates with at least 5 years of experience preferably in research will also be considered.').verdict, 'clear');

// This is the escape hatch in its most common real wording, and it was not
// being recognised — so a job that explicitly offers a route around the bar was
// being deleted for having the bar.
eq('screenJd: "or equivalent combination of education and experience" is an escape hatch',
  screenJd('6+ years of business analysis experience or equivalent combination of education and experience.').verdict, 'stretch');

// A line about being FAMILIAR with credentials is not a demand to hold one.
// This was gating a Business Analyst role on somebody else's licence.
T('findNamedCertGate: familiarity with credentials is not a requirement to hold one',
  findNamedCertGate('Familiarity with continuing education requirements for professional credentials such as NASD licenses.').gated === false);

// Evidence must point at the match. Many ads arrive as one very long line, and
// quoting from the start of that line showed EEO boilerplate as the "reason" a
// job was dropped — which makes a correct verdict unauditable and a wrong one
// undiagnosable.
{
  const ad = 'We are an Equal Opportunity Employer without regard to race, color, religion, creed, sex, sexual orientation, gender identity, national origin, disability, or veteran status. This position requires an active TS/SCI clearance.';
  const ev = findCitizenshipGate(ad).evidence || '';
  T('findCitizenshipGate: evidence quotes the matched phrase, not the start of a long line',
    /TS\/SCI/i.test(ev));
  T('findCitizenshipGate: evidence does not lead with unrelated EEO boilerplate',
    !/^We are an Equal Opportunity/.test(ev));
}

// ── second audit pass over the same 2,273 ads ──────────────────────────────
// The first round of fixes exposed a further set, all of them real drops.

// "at least 18 years old" is an AGE requirement. It was being read as an
// experience bar, which gated an entry-level Financial Analyst role — the exact
// kind of job the candidate is looking for.
eq('findExperienceBar: "at least 18 years old" is an age rule, not an experience bar',
  findExperienceBar('Applicants must be at least 18 years old.').minYears, null);
eq('findExperienceBar: "21 years of age" is an age rule too',
  findExperienceBar('Must be 21 years of age or older.').minYears, null);

// A bare number of years with nothing tying it to experience is usually company
// history or a stray fragment. "5 years, and" was dropping a Fall 2026 student
// role; "25 years" was dropping an analyst role on the firm's own age.
eq('findExperienceBar: a bare "25 years" with no experience context is not a bar',
  findExperienceBar('Acme has been serving customers for 25 years.').minYears, null);
eq('findExperienceBar: a stray fragment is not a bar',
  findExperienceBar('Certificates are valid for 5 years, and renewals are automatic.').minYears, null);
// But a requirement phrasing still counts even without the word "experience".
eq('findExperienceBar: "at least 3 years in analytics" is still a bar',
  findExperienceBar('We want at least 3 years in analytics.').minYears, 3);

// Epic Clarity is a database these analysts READ FROM. Naming the product is
// not the same as demanding a certification in it, and treating it as one gated
// a Data Analyst role for using a tool.
T('findNamedCertGate: naming Epic Clarity as a data source is not a certification demand',
  findNamedCertGate('Extract data from Epic Clarity, then analyze it.').gated === false);
T('findNamedCertGate: an Epic CERTIFICATION demand is still caught',
  findNamedCertGate('Epic Clarity certification required.').gated === true);

// A list of credentials introduced by "such as" is descriptive, not a demand.
T('findNamedCertGate: credentials listed after "such as" are not a demand',
  findNamedCertGate('Works with advisors holding credentials such as Certified Public Accountant or Certified Financial Planner.').gated === false);

// Sentence splitting must not break on the periods inside an abbreviation, or
// the quoted reason reads "You must be a U." — technically a correct drop, but
// unauditable, which defeats the purpose of recording evidence at all.
T('findCitizenshipGate: evidence keeps "U.S." intact instead of cutting at the period',
  /U\.S\./i.test(findCitizenshipGate('You must be a U.S. citizen to apply.').evidence || ''));
