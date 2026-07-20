#!/usr/bin/env node
/**
 * screen-sponsorship.mjs — zero-token JD pre-screen for hard eligibility gates.
 *
 * Evaluation is the expensive step. A JD that says "no visa sponsorship" or
 * "must be graduating Spring 2027" is worth zero to a candidate who fails that
 * gate, no matter how well the title matches. This reads the JD text that
 * check-liveness.mjs already fetches (and discards) from the ATS JSON API and
 * flags those gates before a single evaluation runs.
 *
 * DESIGN: classify SENTENCES, not raw text. Nearly every false positive is a
 * pattern that matched inside a sentence which negates it ("clearance is not
 * required"), reframes it ("relocation sponsorship"), or merely asks about it
 * ("Please indicate whether you require sponsorship" — asked by sponsors too).
 * Guards therefore operate on the containing sentence, not the match.
 *
 * A false "blocked" is worse than a miss: it makes the user skip a real job.
 * When a sentence is ambiguous, prefer `unknown`.
 *
 * Usage:
 *   node screen-sponsorship.mjs <url> [<url>...]
 *   node screen-sponsorship.mjs --pipeline            # screen data/pipeline.md Pending
 *   node screen-sponsorship.mjs --pipeline --summary  # table instead of JSON
 *   node screen-sponsorship.mjs --pipeline --annotate # write markers into pipeline.md
 *
 * Exit 0 always: a screen is advisory. "unknown" is a real answer — a JD that
 * is silent on sponsorship has not refused it.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveAtsApi, isAtsPosting } from './liveness-api.mjs';

const CONCURRENCY = 6;
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- guards

// An interrogative asks about sponsorship; it does not refuse it. Every US
// employer's form asks "will you require sponsorship?", sponsors included.
const INTERROGATIVE = /^(?:are|do|does|did|will|would|can|could|have|has|is|if)\b|^(?:please\s+(?:indicate|confirm|select|specify|answer))\b|\?\s*$/i;

// "Security clearance is not required." / "preferred, but not necessary."
const SOFTENED = /\b(?:not required|no[t]? necessary|not mandatory|preferred|a plus|nice to have|beneficial|optional|desirable|bonus|not used|do(?:es)? not need)\b/i;

// Relocation sponsorship and visa sponsorship are different products, so
// "we do not provide relocation sponsorship" must not read as a visa refusal.
//
// But employers bundle both denials into one sentence:
//   "We do not offer Visa sponsorship or relocation assistance at this time."
// Suppress only when relocation is the SOLE object: the sentence never names a
// visa, H-1B, immigration, or work authorization. A blanket /relocation/ guard
// blinds the screen to real refusals (Bloomerang, greenhouse job 4634354005).
const VISA_OBJECT = /\b(?:visas?|H-?1B|immigration|work authoriz\w*|green card|employment authoriz\w*)\b/i;
const RELOCATION_ONLY = (s) => /\brelocation\b/i.test(s) && !VISA_OBJECT.test(s);

// ---------------------------------------------------------------- patterns

// Explicit refusals of WORK-AUTHORIZATION sponsorship.
// `[^.!?]` spans are avoided: "U.S." would truncate them. Sentences are already
// split, so `.{0,N}` inside one sentence is safe.
const REFUSES = [
  /\b(?:not|unable|cannot|can not|can't|won't|will not|do not|does not|are not|is not)\b.{0,70}?\b(?:provide|offer|support|sponsor|consider|accept|eligible)\b.{0,50}?\b(?:sponsorship|visas?|H-?1B|work authoriz\w*|STEM OPT|OPT\/CPT|CPT\/OPT)\b/i,
  /\b(?:sponsorship|visas?|H-?1B)\b.{0,50}?\b(?:not\s+(?:be\s+)?(?:available|offered|provided|possible|considered|eligible)|unavailable|will not be provided)\b/i,
  /\bno\s+(?:visa\s+|H-?1B\s+)?sponsorship\b/i,
  /\bnot\s+(?:currently\s+)?sponsoring\b/i,
  /\b(?:candidates?|applicants?)\b.{0,60}?\brequir\w*\b.{0,30}?\bsponsorship\b.{0,40}?\b(?:not|ineligible|will not)\b/i,
  /\bmust\s+not\s+require\b.{0,40}?\bsponsorship\b/i,
  /\b(?:unrestricted|permanent)\s+(?:U\.?S\.?\s+)?work authoriz\w*/i,
  /\bmust be\b.{0,50}?\bauthorized to work\b.{0,60}?\bwithout\b.{0,30}?\bsponsorship\b/i,
];

// Affirmative signals. These do NOT prove sponsorship for a given req, but a JD
// that volunteers "we sponsor H-1B" differs meaningfully from one that is silent.
// "OPT" is never matched case-insensitively: every cookie banner says "opt-in".
const SPONSORS = [
  /\b(?:we|company)\s+(?:do|will|can|does)\s+sponsor\b/i,
  /\b(?:visa\s+)?sponsorship\s+(?:is\s+)?(?:available|offered|provided)\b/i,
  /\bwill sponsor\b.{0,40}?\b(?:visas?|H-?1B)\b/i,
  /\bsponsors?\b.{0,40}?\bH-?1B\b/i,
  /\b(?:support|sponsor|accept)\w*\b.{0,30}?\b(?:STEM OPT|F-1 OPT|OPT\/CPT|CPT\/OPT)\b/,
  /\bimmigration support\b/i,
];

// Cohort gates. "New Grad" is sometimes a level and sometimes a graduation
// window — Palantir uses it both ways on the same board. Only the text knows.
const COHORT = [
  /\bmust be graduating\b/i,
  /\bgraduat(?:e|ing)\b.{0,20}?\b(?:in|by|between)\b.{0,40}?\b20\d{2}\b/i,
  /\bclass of\s+20\d{2}\b/i,
  /\bexpected graduation\b/i,
  /\bcurrently enrolled\b.{0,50}?\b(?:degree|program|university|post-secondary)\b/i,
];

// Clearance gates. Usually fatal for visa holders — clearance needs citizenship.
const CLEARANCE = [
  /\b(?:active\s+)?security clearance\b/i,
  /\bTS\/SCI\b/,
  /\bmust be a\b.{0,20}?\bU\.?S\.?\s+citizen\b/i,
  /\bU\.?S\.?\s+citizenship\b.{0,30}?\brequired\b/i,
  /\bU\.?S\.?\s+Person\s+Required\b/i,
];

// ---------------------------------------------------------------- text

/** Collapse an ATS JSON / HTML payload to plain text. */
function toText(raw) {
  let s = raw;
  // Unescape JSON string encoding first, so `<script>` becomes a real
  // tag and gets stripped below rather than surviving as literal text.
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\[nrt]/g, ' ').replace(/\\"/g, '"').replace(/\\\//g, '/');

  const decode = (t) => {
    const ents = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&rsquo;': "'", '&ndash;': '-', '&mdash;': '-' };
    return t
      .replace(/&(?:amp|lt|gt|quot|#39|nbsp|rsquo|ndash|mdash);/g, (m) => ents[m] ?? m)
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
  };

  // Decode, then strip. Twice: escaped markup (`&lt;p&gt;`) only becomes a tag
  // after the first decode, and would otherwise survive the single strip pass.
  for (let i = 0; i < 2; i++) {
    s = decode(s);
    // Script/style bodies are not prose. They carry cookie-consent copy and CSS
    // that leaks into excerpts and trips patterns.
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
    s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    // </li> and <br> are sentence boundaries in JD markup; mark before stripping.
    s = s.replace(/<\/(?:li|p|div|h[1-6])>|<br\s*\/?>/gi, ' • ');
    s = s.replace(/<[^>]+>/g, ' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

// Abbreviations whose periods must not end a sentence.
const ABBREV = /\b(U\.S\.A|U\.S|e\.g|i\.e|etc|Inc|Ltd|Corp|vs|Dr|Mr|Ms|St|approx)\./gi;

/** Split into sentences, protecting abbreviations from the boundary walker. */
export function sentences(text) {
  // Park abbreviation periods on a sentinel that cannot occur in JD prose, so
  // "unable to provide U.S. visa sponsorship" stays one sentence.
  const DOT = "\u0001";
  const guarded = text.replace(ABBREV, (m) => m.replace(/\./g, DOT));
  return guarded
    .split(/(?<=[.!?•])\s+/)
    .map((s) => s.split(DOT).join(".").replace(/^[\s•]+|[\s•]+$/g, "").trim())
    .filter((s) => s.length > 8);
}

/**
 * Find the first sentence matching `patterns` that survives `guards`.
 * Returns the whole sentence — "Security clearance" reads like a blocker;
 * "Active US Security clearance, or eligibility and willingness to obtain one,
 * is beneficial but not necessary" plainly does not.
 */
function findSentence(sents, patterns, guards = []) {
  for (const s of sents) {
    if (!patterns.some((rx) => rx.test(s))) continue;
    if (guards.some((g) => (typeof g === 'function' ? g(s) : g.test(s)))) continue;
    return s.slice(0, 260);
  }
  return null;
}

/**
 * Pure classifier over already-scoped posting text. Exported so the guard rules
 * can be tested against adversarial sentences without touching the network.
 */
export function classifyText(text) {
  const sents = sentences(text);
  // A refusal sentence must be declarative, unsoftened, and about visas — not
  // relocation, and not a form question that sponsoring employers also ask.
  const refusal = findSentence(sents, REFUSES, [INTERROGATIVE, RELOCATION_ONLY]);
  const affirm = findSentence(sents, SPONSORS, [INTERROGATIVE]);
  return {
    // A refusal beats an affirmation: "we sponsor OPT but not H-1B" must read as blocked.
    verdict: refusal ? 'blocked' : affirm ? 'sponsor-signal' : 'unknown',
    reason: refusal ?? affirm ?? null,
    cohort: findSentence(sents, COHORT, [INTERROGATIVE, SOFTENED]),
    clearance: findSentence(sents, CLEARANCE, [INTERROGATIVE, SOFTENED]),
  };
}

// ---------------------------------------------------------------- fetch

async function fetchText(url, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json, text/html' } });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    return { ok: true, raw: await res.text() };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reduce an API payload to text for THIS posting only.
 *
 * Greenhouse and Lever expose per-job endpoints, so the whole body is in scope.
 * Ashby exposes only a board-wide endpoint (130+ jobs, ~2MB) — regexing the raw
 * payload matches sentences from unrelated postings. `liveness-api.mjs` avoids
 * this by selecting the job by id first (classifyAshbyBoard); do the same here.
 */
function scopeToPosting(ats, raw, url) {
  // Never regex serialized JSON. Extract only fields carrying EMPLOYER prose.
  //
  // The critical exclusion is Greenhouse `questions[].fields[].values[]` -- the
  // multiple-choice ANSWERS. They are written in the candidate's voice ("I am
  // authorized... and do not need a company to sponsor my visa") and read as
  // refusals to any negation-based pattern. Vercel sponsors, yet 15 of its reqs
  // were blocked on that answer text. Question *labels* are employer statements
  // and stay in: PolyAI's real refusal lives in one.
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return ats === 'none' ? toText(raw) : null;
  }

  if (ats === 'greenhouse') {
    const labels = (j.questions ?? []).map((q) => q?.label).filter(Boolean);
    return toText([j.title, j.content, ...labels].filter(Boolean).join(' • '));
  }

  if (ats === 'lever') {
    const lists = (j.lists ?? []).map((l) => `${l.text ?? ''}: ${l.content ?? ''}`);
    return toText([j.text, j.descriptionPlain ?? j.description, ...lists, j.additionalPlain ?? j.additional].filter(Boolean).join(' • '));
  }

  if (ats === 'ashby') {
    // Ashby ids are UUIDs today, but do not hard-code the shape resolveAtsApi accepts.
    const jobId = url.match(/jobs\.ashbyhq\.com\/[^/?#]+\/([^/?#]+)/i)?.[1];
    if (!jobId) return null;
    const jobs = Array.isArray(j?.jobs) ? j.jobs : [];
    const job = jobs.find((x) => x && x.id === jobId);
    if (!job) return null;
    return toText([job.title, job.descriptionHtml ?? job.descriptionPlain, job.location].filter(Boolean).join(' • '));
  }

  return toText(raw);
}

async function screenOne(url) {
  const resolved = isAtsPosting(url) ? resolveAtsApi(url) : null;
  const ats = resolved?.ats ?? 'none';

  // Sponsorship policy usually lives in the APPLICATION FORM, not the job body.
  // Greenhouse hides those behind ?questions=true; the default endpoint omits
  // them entirely, which is exactly how PolyAI's refusal escaped the first pass.
  let apiUrl = resolved?.apiUrl ?? null;
  if (apiUrl && ats === 'greenhouse') {
    apiUrl += (apiUrl.includes('?') ? '&' : '?') + 'questions=true';
  }

  const sources = [];
  if (apiUrl) sources.push(['api', apiUrl, resolved.timeoutMs ?? TIMEOUT_MS]);
  // The rendered page is a second, free source of gate text — but only where a
  // page maps to one posting. Ashby's board page is a SPA hydrated from the same
  // board-wide payload, so reading it reintroduces cross-job contamination.
  // Where an API already answered, the page is only consulted for non-ATS hosts.
  if (ats === 'none') sources.push(['page', url, TIMEOUT_MS]);

  const parts = [];
  const failures = [];
  for (const [kind, u, t] of sources) {
    const r = await fetchText(u, t);
    if (!r.ok) {
      failures.push(`${kind}: ${r.reason}`);
      continue;
    }
    const text = kind === 'api' ? scopeToPosting(ats, r.raw, url) : toText(r.raw);
    if (text) parts.push([kind, text]);
    else failures.push(`${kind}: posting not found in payload`);
  }

  if (!parts.length) {
    return { url, ats, verdict: 'fetch-failed', reason: failures.join('; '), cohort: null, clearance: null, source: null };
  }

  // Classify each source independently; the strongest verdict across sources wins.
  let best = { verdict: 'unknown', reason: null, cohort: null, clearance: null, source: null };
  for (const [kind, text] of parts) {
    const c = classifyText(text);
    if (c.verdict === 'blocked' && best.verdict !== 'blocked') best = { ...c, source: kind };
    else if (c.verdict === 'sponsor-signal' && best.verdict === 'unknown') best = { ...c, source: kind };
    best.cohort ??= c.cohort;
    best.clearance ??= c.clearance;
  }

  return { url, ats, ...best };
}

// ---------------------------------------------------------------- driver

async function pool(items, worker, limit) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        // One malformed payload must never abort the whole screen.
        try {
          out[idx] = await worker(items[idx], idx);
        } catch (e) {
          out[idx] = { url: items[idx], ats: null, verdict: 'fetch-failed', reason: `worker error: ${e.message}`, cohort: null, clearance: null, source: null };
        }
      }
    })
  );
  return out;
}

function readPending(file = 'data/pipeline.md') {
  const src = readFileSync(file, 'utf8');
  // Pending runs from its heading to the next h2. Archived rows must not be rescreened.
  const start = src.indexOf('## Pending');
  const rest = src.slice(start);
  const end = rest.indexOf('\n## ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);
  return section
    .split('\n')
    .map((l) => l.match(/^- \[ \] (\S+)/))
    .filter(Boolean)
    .map((m) => m[1]);
}

// Importing this module (for tests) must not run the CLI.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!invokedDirectly) {
  // Exported: sentences, classifyText. Nothing else to do on import.
} else {

const args = process.argv.slice(2);
const usePipeline = args.includes('--pipeline');
const summary = args.includes('--summary');
const annotate = args.includes('--annotate');
const urls = usePipeline ? readPending() : args.filter((a) => !a.startsWith('--'));

if (!urls.length) {
  console.error('usage: node screen-sponsorship.mjs <url>... | --pipeline [--summary] [--annotate]');
  process.exit(1);
}

const results = await pool(urls, screenOne, CONCURRENCY);
const blocked = results.filter((r) => r.verdict === 'blocked');
const gated = results.filter((r) => r.verdict !== 'blocked' && (r.cohort || r.clearance));

if (summary) {
  const tally = results.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {});
  console.log(`\nScreened ${results.length} postings\n`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  if (blocked.length) {
    console.log(`\n❌ SPONSORSHIP REFUSED (${blocked.length}) — do not evaluate:\n`);
    for (const r of blocked) console.log(`  ${r.url}\n      "${r.reason}"`);
  }
  if (gated.length) {
    // Advisory, not fatal: softened gates are filtered out, but "required" is
    // still a judgement call. Print the sentence and let the reader decide.
    console.log(`\n⚠️  GATES TO CHECK (${gated.length}):\n`);
    for (const r of gated) {
      if (r.cohort) console.log(`  ${r.url}\n      cohort:    "${r.cohort}"`);
      if (r.clearance) console.log(`  ${r.url}\n      clearance: "${r.clearance}"`);
    }
  }
  console.log('');
} else {
  console.log(JSON.stringify({ screened: results.length, blocked: blocked.length, gated: gated.length, results }, null, 2));
}

if (annotate) {
  const file = 'data/pipeline.md';
  let src = readFileSync(file, 'utf8');
  const mark = new Map();
  for (const r of blocked) mark.set(r.url, `⛔ no-sponsorship`);
  for (const r of gated) mark.set(r.url, r.cohort ? `⚠️ cohort-gate` : `⚠️ clearance-gate`);
  let n = 0;
  src = src
    .split('\n')
    .map((line) => {
      const m = line.match(/^- \[ \] (\S+)/);
      if (!m || !mark.has(m[1]) || line.includes('⛔') || line.includes('⚠️')) return line;
      n++;
      return `${line}  <!-- ${mark.get(m[1])} -->`;
    })
    .join('\n');
  writeFileSync(file, src);
  console.error(`annotated ${n} line(s) in ${file}`);
}

}
