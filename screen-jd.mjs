#!/usr/bin/env node
/**
 * screen-jd.mjs — the zero-token screen over stored job-ad text (step 7).
 *
 * Until `jd_text` existed there was nothing to screen: every gate could only see
 * a title, a company and a URL. This module reads the ad and drops the postings
 * that are plainly ineligible, so a model is only ever paid for the rest.
 *
 * The gates are not invented here. `modes/_custom.md` names the hard gates —
 * citizenship / clearance / permanent-authorization demands, a graduation-cohort
 * window the candidate fails, a licensed certification, and a terminated E-Verify
 * employer (the last runs in `everify-check.mjs`). The experience bar USED to be
 * a hard gate too; as of 2026-07-23 it only quarantines (see screenJd's doctrine
 * note), because a bar is inflatable and 15% of good postings carry one.
 *
 * THE ASYMMETRY THAT SETS EVERY THRESHOLD BELOW: a false positive silently
 * deletes a job the candidate should have seen, and he never learns what he
 * missed. A false negative costs one look. So each gate fires only on an
 * explicit, unambiguous statement, anything unstated passes, and an ad with no
 * text is `unknown` rather than dropped.
 *
 * Deliberately NOT used: `jd-skill-gap.mjs`. Measured against 60 real ads it
 * extracted nothing from 57 of them, and where it did fire it labelled "Lunch",
 * "PTO" and "Health" as missing skills. It is a reporting aid, not a filter; as
 * a filter it would delete jobs for having a benefits section.
 *
 * The experience/cohort patterns are lifted from `screen-level.mjs`, which had
 * them right but re-fetched every JD over the network (it predates jd_text) and
 * kept them as CLI-internal constants.
 */

// Numbers are spelled out as often as they are typed. Measured on real ads,
// the single most common bar screen-jd USED to miss was the written-out form:
// "Six or more years", "a minimum of four years". Ordered longest-first so the
// alternation prefers "fourteen" over "four" at the same position.
const NUM_WORD = {
  fifteen: 15, fourteen: 14, thirteen: 13, twelve: 12, eleven: 11, ten: 10,
  nine: 9, eight: 8, seven: 7, six: 6, five: 5, four: 4, three: 3, two: 2, one: 1,
};
const NUM_SRC = ['\\d+', ...Object.keys(NUM_WORD)].join('|');

// "5+ years", "3-5 years", "minimum of 2 years", "at least four years",
// "Six or more years".
const YOE_RE = new RegExp(
  `(?:\\b(?:at least|minimum of|a minimum of)\\s+)?\\b(${NUM_SRC})\\s*(?:\\+|\\s*-\\s*\\d+|\\s+or\\s+more)?\\s*years?\\b[^.;•\\n]{0,120}`,
  'gi',
);
// A captured token is either digits or one of the spelled-out words above.
const toYears = (token) => NUM_WORD[String(token).toLowerCase()] ?? Number(token);

// A years bar with an alternative route is not a bar. Target #017 (4.4) was
// viable on exactly this clause while Target FP&A (3.8), same number of years
// without it, was not — so missing the hatch throws away the better job.
// "or equivalent combination of education and experience" is the single most
// common real wording and was missing at first, so ads that explicitly offered
// a route around the bar were being deleted for having the bar.
const ESCAPE_HATCH_RE = /\b(?:or|and\/or)\b[^.;•\n]{0,40}\b(?:master'?s?|graduate degree|advanced degree|M\.?S\.?|Ph\.?D|equivalent (?:experience|practical experience|work experience|combination))\b/i;

// A figure this large is company age or market history, not a requirement, and
// reading it as one would drop a junior role.
const MAX_PLAUSIBLE_YEARS = 25;

// "at least 18 years old" is an AGE rule. Read as an experience bar it gated an
// entry-level Financial Analyst role — precisely the kind of job being hunted.
const AGE_RULE_RE = /\byears?\s+(?:old|of age)\b/i;
// A number of years has to be tied to experience to be a bar. Without this,
// "certificates are valid for 5 years, and" dropped a Fall 2026 student role and
// "serving customers for 25 years" dropped an analyst role on the firm's age.
const EXPERIENCE_CONTEXT_RE = /\b(?:experience|expertise|background|working|worked|industry|hands-?on|track record|tenure)\b/i;
// A requirement phrasing counts even without the word "experience", because
// "at least 3 years in analytics" is unmistakably a bar.
const REQUIREMENT_PREFIX_RE = /^\s*(?:at least|minimum of|a minimum of)\b/i;
// "N years of/in/as <something>" is a bar even with no other cue: "5+ years of
// Python" states a requirement as plainly as "5 years of experience" does.
const YEARS_OF_SUBJECT_RE = /\byears?['’]?s?\s*(?:of|in|as)\s+\w/i;
// A DURATION, not a requirement. "valid for 5 years", "within the last 2 years"
// and "serving customers for 25 years" all state how long something lasts.
// Catching the second of those also fixes a subtler bug: an ad asking for "8+
// years of experience, with recent experience within the last 2 years" was
// having its bar read as 2.
const DURATION_PREFIX_RE = /\b(?:for|within the last|in the last|over the (?:last|past)|past|every|valid for|lasts?|after)\s+$/i;

// Phrasings that survive on the CANDIDATE's status, not the employer's
// willingness. STEM OPT is temporary authorization, so these are real bars.
const CITIZENSHIP_RE = /\b(?:must be (?:a |an )?u\.?s\.?(?:\.)? citizens?|u\.?s\.?(?:\.)? citizenship (?:is )?required|(?:open to )?u\.?s\.?(?:\.)? citizens only|citizens? only|must (?:have|hold|possess) (?:permanent|unrestricted|lawful permanent) work authorization)\b/i;
// An ACTIVE clearance demand is a bar; see PREFERENCE_RE for what is not.
const CLEARANCE_REQ_RE = /\b(?:requires?|must (?:possess|have|hold)|active)\s+(?:an?\s+)?(?:active\s+)?(?:ts\/sci|top secret|secret|dod|security)\s*(?:clearance)\b|\bclearance is required\b/i;
// modes/_custom.md: "a clearance line under 'What We Value' is a preference,
// not a bar." And a clearance obtainable after hire is a runway, not a wall.
// Erring wide here is the safe direction: over-recognising a preference costs
// one extra look, while missing one deletes a job the candidate could have had.
const PREFERENCE_RE = /\b(?:preferred|preferably|preferable|ideally|a plus|nice to have|desirable|desired|a bonus|not required|able to obtain|ability to obtain|willing(?:ness)? to obtain|eligible to obtain)\b/i;

const COHORT_RE = /\b(?:must be graduating|graduating (?:in|by)|class of\s*20\d{2}|expected graduation(?: date)?|must be currently enrolled|currently enrolled in)\b[^.;•\n]{0,80}/i;

// A named certification or licence has no honest equivalency argument, unlike a
// generic years bar (modes/_custom.md, added after report #228).
// Naming a product is not demanding a certification in it: Epic Clarity is a
// database these analysts READ FROM, and matching the bare product name gated a
// Data Analyst role for using a tool. Every branch now requires explicit
// certification or licence wording.
const NAMED_CERT_RE = /\b(?:Epic(?:\s+\w+){0,2}\s+certif\w*|certif\w+\s+in\s+Epic\b|(?:active\s+)?(?:CCS|RHIA|RHIT|CPC|CPA|PMP|CFA|PE)\s+(?:certif\w*|licen[sc]\w*)|licen[sc]ed (?:registered nurse|RN|CPA|PE|attorney|professional engineer)|must be a licen[sc]ed|registered nurse licen[sc]\w*)\b/i;
// A list introduced by "such as" describes credentials other people hold; it is
// not a demand on the applicant.
const DESCRIPTIVE_LIST_RE = /\b(?:such as|familiar\w*\s+with|including|e\.g\.|for example)\b/i;

/**
 * The sentence a match sits in, so a human can audit the verdict.
 *
 * Bounded by sentence punctuation, NOT just newlines. Many ads arrive as one
 * very long line, and quoting from the start of that line showed EEO
 * boilerplate as the "reason" a job was dropped — which makes a correct verdict
 * unauditable and a wrong one undiagnosable. It also matters for correctness,
 * not only display: a whole-line preference test would read "8 years preferred.
 * Minimum 2 years required." as one preference and discard the real bar.
 */
function sentenceAround(text, index) {
  // A period only ends a sentence when whitespace or the end of the text
  // follows it. Without that check "You must be a U.S. citizen" is quoted as
  // "You must be a U." — a correct verdict rendered unauditable.
  const isBoundary = (i) => {
    const ch = text[i];
    if (ch === undefined) return true;
    if (';•\n!?'.includes(ch)) return true;
    return ch === '.' && (i + 1 >= text.length || /\s/.test(text[i + 1]));
  };
  let start = index;
  while (start > 0 && !isBoundary(start - 1)) start--;
  let end = index;
  while (end < text.length && !isBoundary(end)) end++;
  return text.slice(start, Math.min(end + 1, start + 260)).trim();
}

/** True when the sentence carrying the match softens it into a preference. */
function isPreference(text, index) {
  return PREFERENCE_RE.test(sentenceAround(text, index));
}

/**
 * The lowest years-of-experience bar the ad states, and whether it offers a
 * route around it.
 * @param {unknown} jdText
 * @returns {{minYears:number|null, hasEscapeHatch:boolean, evidence:string|null}}
 */
export function findExperienceBar(jdText) {
  const text = String(jdText ?? '');
  let minYears = null;
  let evidence = null;
  for (const m of text.matchAll(YOE_RE)) {
    const n = toYears(m[1]);
    if (!Number.isFinite(n) || n > MAX_PLAUSIBLE_YEARS) continue;
    const span = m[0];
    if (AGE_RULE_RE.test(span)) continue;
    if (DURATION_PREFIX_RE.test(text.slice(Math.max(0, m.index - 24), m.index))) continue;
    if (!EXPERIENCE_CONTEXT_RE.test(span) && !REQUIREMENT_PREFIX_RE.test(span) && !YEARS_OF_SUBJECT_RE.test(span)) continue;
    // "5+ years warehouse experience PREFERRED" is not a bar. This softener was
    // originally applied only to clearances, and the omission was dropping real
    // jobs whose years line was explicitly optional.
    if (isPreference(text, m.index)) continue;
    // The LOWEST stated bar is the one that governs: an ad asking for "2 years
    // of SQL, 8 years of leadership preferred" is a 2-year job.
    if (minYears === null || n < minYears) { minYears = n; evidence = m[0].trim(); }
  }
  return { minYears, hasEscapeHatch: ESCAPE_HATCH_RE.test(text), evidence };
}

/**
 * A demand the candidate cannot satisfy by being hired: citizenship, permanent
 * authorization, or a clearance he must already hold.
 * @returns {{gated:boolean, evidence:string|null}}
 */
export function findCitizenshipGate(jdText) {
  const text = String(jdText ?? '');
  for (const re of [CITIZENSHIP_RE, CLEARANCE_REQ_RE]) {
    const m = re.exec(text);
    if (m && !isPreference(text, m.index)) return { gated: true, evidence: sentenceAround(text, m.index) };
  }
  return { gated: false, evidence: null };
}

/** A graduation window, which a candidate who has already graduated fails. */
export function findCohortGate(jdText) {
  const text = String(jdText ?? '');
  const m = COHORT_RE.exec(text);
  return m ? { gated: true, evidence: sentenceAround(text, m.index) } : { gated: false, evidence: null };
}

/** A named certification or licence that must be held before hire. */
export function findNamedCertGate(jdText) {
  const text = String(jdText ?? '');
  const m = NAMED_CERT_RE.exec(text);
  if (!m) return { gated: false, evidence: null };
  const sentence = sentenceAround(text, m.index);
  // "Preferred", or a post-hire runway ("obtain within 12 months"), is
  // learnable rather than a wall — the doctrine's two carve-outs.
  if (PREFERENCE_RE.test(sentence) || DESCRIPTIVE_LIST_RE.test(sentence)
      || /\bwithin \d+ (?:months?|years?) of hire\b|\bmust obtain\b/i.test(sentence)) {
    return { gated: false, evidence: null };
  }
  return { gated: true, evidence: sentence };
}

// A stated bar at or above this many years is surfaced as a stretch. It is NOT
// a drop: see the doctrine note on screenJd. Set from recorded outcomes, not
// taste — 3-year roles have been cleared, so anything under this reads as clear.
const STRETCH_YEARS = 3;

/**
 * The combined verdict for one ad.
 *
 * DOCTRINE (changed 2026-07-23, Codex review + measured lift): an experience
 * bar QUARANTINES a job, it never drops it. Two measured facts force this: 15%
 * of good postings (score >=3.5) still cite a failing bar, and years
 * requirements are routinely inflated, negotiable, or met by internships and
 * graduate work. So a bar becomes a 'stretch' (kept, flagged), never 'gated'.
 * Only a wall the candidate cannot cross by being hired still gates:
 * citizenship / permanent-authorization, a graduation cohort he has missed, or
 * a licensed certification. The experience bar was the last non-absolute gate
 * and it has been removed from the drop path.
 *
 * @param {unknown} jdText
 * @returns {{verdict:'clear'|'stretch'|'gated'|'unknown', reasons:Array<{gate:string, evidence:string|null}>}}
 *   'unknown' means the ad could not be read — never a reason to drop a job,
 *   because that would lose a posting to a failed fetch rather than to a fact
 *   about the posting.
 */
export function screenJd(jdText) {
  const text = String(jdText ?? '').trim();
  if (!text) return { verdict: 'unknown', reasons: [] };

  const reasons = [];
  const citizenship = findCitizenshipGate(text);
  if (citizenship.gated) reasons.push({ gate: 'citizenship_or_clearance', evidence: citizenship.evidence });
  const cohort = findCohortGate(text);
  if (cohort.gated) reasons.push({ gate: 'graduation_cohort', evidence: cohort.evidence });
  const cert = findNamedCertGate(text);
  if (cert.gated) reasons.push({ gate: 'named_certification', evidence: cert.evidence });

  if (reasons.length) return { verdict: 'gated', reasons };

  // No hard wall fired. The experience bar can only downgrade clear -> stretch,
  // never drop. The escape hatch is irrelevant to that call now that a bar is
  // never a drop; the stated NUMBER alone decides whether the fit is a stretch.
  const bar = findExperienceBar(text);
  if (bar.minYears !== null && bar.minYears >= STRETCH_YEARS) return { verdict: 'stretch', reasons: [] };
  return { verdict: 'clear', reasons: [] };
}
