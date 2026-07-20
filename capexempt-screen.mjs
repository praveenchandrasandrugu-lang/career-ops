#!/usr/bin/env node
/**
 * capexempt-screen.mjs — zero-token gate screen for capexempt-live-jobs.json.
 *
 * For every opening found by capexempt-live.mjs, fetch the full JD from the
 * Workday CXS job-detail endpoint and classify the hard gates BEFORE any LLM
 * evaluation is spent (same philosophy as screen-level.mjs / screen-sponsorship.mjs):
 *
 *   - YoE gates ("3+ years", "minimum of 5 years")
 *   - degree-alternative escape hatches ("...or master's degree") — the
 *     clause that made Target #017 viable for an M.S. holder
 *   - cohort gates ("must be graduating in...", "currently enrolled")
 *   - sponsorship-refusal sentences (rare at cap-exempt orgs; flag, not kill —
 *     the user's bar is E-Verify, STEM OPT first)
 *   - advertised salary range when present (comp-band seniority check)
 *   - REQUIRED-skill gaps: skills demanded in the JD's minimum/required
 *     qualifications section that appear nowhere in cv.md/profile.yml
 *     (reuses jd-skill-gap.mjs's extractor+classifier; "Preferred
 *     Qualifications" sections are deliberately NOT mined — a preferred
 *     skill you lack is not a reason to skip)
 *
 * Verdicts:
 *   CLEAR — no YoE gate, or min <= 1 year, or a master's escape hatch
 *   CHECK — min 2 years, ambiguous wording, or 2-3 required-skill gaps
 *   GATED — min >= 3 years with no escape hatch, a cohort gate, or 4+
 *           required-skill gaps
 *
 * Output: data/lca/capexempt-shortlist.md (CLEAR first, freshest first;
 *         ranked by fit with --rank)
 *         data/lca/capexempt-screened.json (machine)
 *
 * --rank: opt-in local semantic ranking of the CLEAR bucket, on top of the
 * regex gates above. Chunks the JD into sentences (boilerplate stripped),
 * embeds each with a local SBERT model (Xenova/all-MiniLM-L6-v2, runs
 * on-device via @xenova/transformers — no API calls, no per-job token cost),
 * takes each sentence's best match against cv.md's chunks, and averages the
 * top 3 — the JD's strongest-matching requirement lines, not the median of a
 * JD that's mostly EEO/benefits/marketing prose (that averaging-everything
 * version was tried first and correlated worse than no ranking at all).
 * Validated 2026-07-17 against reports/ with known scores: whole-document
 * embedding rho=0.15 (p=0.47, noise) vs this chunk-max-pool method rho=0.27
 * (p=0.20) on n=24 — directionally right, not yet proven at n=24. Opt-in
 * because: (1) the correlation isn't statistically significant yet at small
 * n — validate at full scale before trusting it as more than a sort order;
 * (2) it's a genuinely new, heavier dependency (~80 packages, native ONNX
 * bindings) for a project meant to stay lightweight for other users;
 * (3) it adds real wall-clock time (one embedding call per JD sentence),
 * unlike the regex gates above which are instant. It only ever REORDERS the
 * CLEAR bucket — it never moves a job in or out of CLEAR/CHECK/GATED.
 *
 * Usage:
 *   node capexempt-screen.mjs               # screen everything
 *   node capexempt-screen.mjs --limit 20    # smoke test
 *   node capexempt-screen.mjs --rank        # + rank CLEAR bucket by fit
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { classifySkillGaps } from './jd-skill-gap.mjs';

const IN_PATH = 'data/lca/capexempt-live-jobs.json';
const OUT_MD = 'data/lca/capexempt-shortlist.md';
const OUT_JSON = 'data/lca/capexempt-screened.json';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const limIdx = args.indexOf('--limit');
const LIMIT = limIdx !== -1 ? Number(args[limIdx + 1]) : Infinity;
const RANK = args.includes('--rank');

// job URL → CXS detail API:
// https://{tenant}.{inst}.myworkdayjobs.com/{site}/job/... →
// https://{tenant}.{inst}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/...
function detailApi(jobUrl) {
  const m = jobUrl.match(/^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/([^/]+)(\/job\/.*)$/);
  if (!m) return null;
  const [, tenant, inst, site, path] = m;
  return `https://${tenant}.${inst}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${path}`;
}

// Known-skill corpus: cv.md is canonical; profile.yml narrative also counts
// (both are in-scope source-of-truth files; skills are classified, never added).
const CV_TEXT = [
  existsSync('cv.md') ? readFileSync('cv.md', 'utf8') : '',
  existsSync('config/profile.yml') ? readFileSync('config/profile.yml', 'utf8') : '',
].join('\n');

// ---------------------------------------------------------------- --rank

// Boilerplate that shows up in nearly every JD and matches *something* in any
// resume weakly — averaging it in (instead of filtering it out) is exactly
// why the first version of this ranking scored worse than no ranking at all.
const BOILERPLATE = /\bequal opportunity\b|\bEEO\b|\bdiversity\b|\binclusion\b|\bbenefits? (?:include|package)\b|\bhealth insurance\b|\b401\(?k\)?\b|\bpaid time off\b|\bapply now\b|\bcompetitive salary\b|\bwe are (?:an?|proud)\b|\bwho we are\b|\bwww\.|https?:\/\/|\bhow to apply\b|\bequal employment\b|\breasonable accommodation\b/i;

// Paragraph-level CV chunks (cv.md only — profile.yml is YAML config, not
// prose to match against). One chunk per non-trivial line.
const CV_CHUNKS = RANK
  ? [...new Set(
      (existsSync('cv.md') ? readFileSync('cv.md', 'utf8') : '')
        .split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).filter(l => l.length > 20)
    )]
  : [];

// A promise, not the resolved value: under concurrent workers, `??=` on an
// awaited RHS would let a second worker start a second model load before the
// first assignment lands. Caching the promise itself closes that race.
let extractorPromise = null;
function getExtractor() {
  extractorPromise ??= import('@xenova/transformers').then(m => m.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2'));
  return extractorPromise;
}
async function embed(text) {
  const ext = await getExtractor();
  const out = await ext(text.slice(0, 6000), { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

let cvChunkEmbsPromise = null; // same race-safe promise-cache pattern as getExtractor
function getCvChunkEmbs() {
  cvChunkEmbsPromise ??= Promise.all(CV_CHUNKS.map(embed));
  return cvChunkEmbsPromise;
}
// For each JD sentence (boilerplate stripped), find its single best-matching
// CV chunk, then average the top 3 sentence-level maxes. Top-3, not all
// sentences: most of a JD is not the requirements section, and a plain
// average over every sentence dilutes the fit signal back to noise.
async function rankScore(sentences) {
  const cvChunkEmbs = await getCvChunkEmbs();
  if (!cvChunkEmbs.length) return null;
  const candidates = sentences.filter(s => s.length > 25 && s.length < 400 && !BOILERPLATE.test(s)).slice(0, 60);
  if (!candidates.length) return null;
  const maxes = [];
  for (const s of candidates) {
    const sEmb = await embed(s);
    let best = -1;
    for (const ce of cvChunkEmbs) { const c = cosine(sEmb, ce); if (c > best) best = c; }
    maxes.push(best);
  }
  maxes.sort((a, b) => b - a);
  const top = maxes.slice(0, 3);
  return top.reduce((a, b) => a + b, 0) / top.length;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

// HTML → lines, bullets preserved as "- " so jd-skill-gap's extractor sees them.
function htmlToLines(html) {
  return decodeEntities(String(html)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(p|h\d|div|br|ul|ol|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// University/Workday JDs head their hard-requirement block with wording the
// stock header regex misses ("Minimum Qualifications", "Basic Qualifications",
// "What you'll need"). Preferred/desired sections are excluded on purpose.
const REQ_HEADER = /^(minimum|basic|required|must[- ]have|essential)?\s*(qualifications?|requirements?|skills? (?:required|needed))\b|^what you(?:['’]ll)? (?:need|bring)\b/i;
const NONREQ_HEADER = /^(preferred|desired|nice[- ]to[- ]have|bonus|plus|about|why|benefits?|compensation|salary|responsibilities|duties|what you(?:['’]ll)? do|working conditions|physical|equal|eeo|application|how to apply)/i;
const HEADERISH = (l) => l.length <= 80 && (/:$/.test(l) || /^[A-Z][^.!?]{0,70}$/.test(l));

// Closed lexicon of concrete, checkable tools/technologies for analyst-family
// roles. Open-ended token extraction over prose flagged "We", "Please", and
// degree fields as missing skills — a whitelist cannot hallucinate a
// requirement. Curated for data/BI/research/university-ops JDs.
const LEXICON = [
  // query/programming
  'SQL', 'Python', 'R', 'SAS', 'SPSS', 'Stata', 'MATLAB', 'VBA', 'Java',
  'JavaScript', 'TypeScript', 'C++', 'C#', 'Scala', 'Julia',
  // BI / viz
  'Tableau', 'Power BI', 'PowerBI', 'Looker', 'Qlik', 'Cognos', 'MicroStrategy',
  'Crystal Reports', 'SSRS', 'Alteryx', 'Excel', 'Power Query', 'Smartsheet', 'Visio',
  // data eng / cloud
  'ETL', 'SSIS', 'Snowflake', 'Redshift', 'BigQuery', 'Databricks', 'dbt',
  'Spark', 'Hadoop', 'Kafka', 'Airflow', 'Informatica', 'AWS', 'Azure', 'GCP',
  'SQL Server', 'MySQL', 'PostgreSQL', 'Oracle', 'MongoDB', 'Docker', 'Kubernetes',
  'Terraform', 'Git', 'Linux', 'Unix',
  // ML / stats
  'Machine Learning', 'Deep Learning', 'NLP', 'TensorFlow', 'PyTorch',
  'scikit-learn', 'Pandas', 'NumPy',
  // enterprise / university / clinical systems
  'Workday', 'PeopleSoft', 'Banner', 'Ellucian', 'Colleague', 'Jenzabar', 'Slate',
  'Epic', 'Cerner', 'REDCap', 'Qualtrics', 'Salesforce', 'SAP', 'NetSuite',
  'ServiceNow', 'SharePoint', 'JIRA', 'Kronos', 'ADP', 'QuickBooks', 'Hyperion',
  'Essbase', 'Anaplan', 'Maximo', 'Tririga',
  // domain-specific
  'ArcGIS', 'GIS', 'AutoCAD', 'HL7', 'FHIR', 'ICD-10', 'CPT', 'LIMS',
  'Security+', 'CISSP', 'Splunk',
];

function lexiconHit(term, text) {
  if (term === 'R') {
    // Case-sensitive standalone R; exclude R&D, R+, R. abbreviations.
    return /(?<![\w&+.\/])R(?![\w&+#.\/])/.test(text);
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i').test(text);
}

// A "preferred" sentence inside a Minimum Qualifications block is still not a
// must-skill.
const SOFT_LINE = /\b(preferred|a plus|desirable|nice to have|bonus|is advantageous|would be an asset)\b/i;

// Pull ONLY the required-qualification block(s) and classify lexicon skills
// found there against the CV corpus. Returns null when no required section
// parses (skill screen inconclusive, never a downgrade); returns required: 0
// when the section exists but demands no concrete tools.
function requiredSkillGaps(html) {
  const lines = htmlToLines(html);
  const collected = [];
  let inReq = false;
  for (const line of lines) {
    if (REQ_HEADER.test(line) && HEADERISH(line)) { inReq = true; continue; }
    if (inReq && HEADERISH(line) && (NONREQ_HEADER.test(line) || REQ_HEADER.test(line))) {
      inReq = REQ_HEADER.test(line) && !NONREQ_HEADER.test(line);
      continue;
    }
    if (inReq && !SOFT_LINE.test(line)) collected.push(line);
  }
  if (!collected.length) return null;
  const text = collected.join('\n');
  const skills = LEXICON.filter(t => lexiconHit(t, text));
  if (!skills.length) return { required: 0, known: 0, gap: [] };
  const { existing, supportedByResume, gap } = classifySkillGaps(skills, CV_TEXT);
  return { required: skills.length, known: existing.length + supportedByResume.length, gap };
}

function htmlToSentences(html) {
  const text = String(html)
    .replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  return text.split(/(?<=[.;!?])\s+|(?=•)/).map(s => s.trim()).filter(s => s.length > 5);
}

// "5+ years", "3-5 years", "minimum of 2 years", "at least 4 years"
const YOE = /\b(\d+)\s*(?:\+|-\s*\d+|\s+or\s+more)?\s*years?\b/i;
const YOE_CONTEXT = /\b(experience|work history|background|in a similar|related)\b/i;
const DEGREE_ALT = /\b(?:or|and\/or)\b[^.;•]{0,60}\b(?:master'?s?|graduate degree|advanced degree|MS|M\.S\.|PhD|equivalent (?:experience|education|practical experience|combination))\b/i;
const MASTERS_SUB = /\bmaster'?s?\b[^.;•]{0,80}\b(?:may substitute|in lieu of|substitutes? for|counts? (?:as|toward)|equivalent to \d+ years?)\b/i;
const COHORT = /\b(?:must be graduating|graduating (?:in|by)|class of\s*20\d{2}|expected graduation|currently enrolled)\b/i;
// Sentence-level refusal (screen-sponsorship design: an interrogative asks, it
// does not refuse — every US employer's form asks).
const SPONSOR_REFUSE = /\b(?:no|not|unable to|cannot|will not|won'?t|do(?:es)? not)\b[^.;•]{0,60}\bsponsor/i;
const SPONSOR_ASK = /\b(?:indicate|require|will you|do you)\b[^.;•]{0,60}\bsponsor/i;
const SALARY = /\$\s?([\d,]{4,})(?:\.\d\d)?\s*(?:-|to|–)\s*\$?\s?([\d,]{4,})/;

async function fetchDetail(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': UA },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) return null;
      return await r.json();
    } catch {
      if (attempt === 2) return null;
      await new Promise(res => setTimeout(res, 700 * (attempt + 1) + Math.random() * 300));
    }
  }
  return null;
}

function screen(sentences) {
  const out = { minYears: null, yoeEvidence: [], degreeAlt: null, cohort: null, sponsorFlag: null, salary: null };
  for (const s of sentences) {
    const y = s.match(YOE);
    if (y && YOE_CONTEXT.test(s) && !/\bpreferred|a plus|nice to have|bonus\b/i.test(s)) {
      const n = Number(y[1]);
      if (n >= 1 && n <= 15) {
        if (out.minYears === null || n < out.minYears) out.minYears = n;
        if (out.yoeEvidence.length < 3) out.yoeEvidence.push(s.slice(0, 200));
      }
    }
    if (!out.degreeAlt && (DEGREE_ALT.test(s) || MASTERS_SUB.test(s)) && YOE.test(s)) out.degreeAlt = s.slice(0, 200);
    if (!out.cohort && COHORT.test(s)) out.cohort = s.slice(0, 160);
    if (!out.sponsorFlag && SPONSOR_REFUSE.test(s) && !SPONSOR_ASK.test(s)) out.sponsorFlag = s.slice(0, 200);
    if (!out.salary) {
      const m = s.match(SALARY);
      if (m) {
        const lo = Number(m[1].replace(/,/g, '')), hi = Number(m[2].replace(/,/g, ''));
        if (lo >= 20000 && hi > lo) out.salary = { lo, hi };
      }
    }
  }
  return out;
}

function verdict(g, skills) {
  if (g.cohort) return 'GATED';
  let v;
  if (g.minYears === null || g.minYears <= 1) v = 'CLEAR';
  else if (g.degreeAlt) v = 'CLEAR';
  else if (g.minYears === 2) v = 'CHECK';
  else return 'GATED';
  // Must-skill gaps (closed-lexicon, required sections only, preferred
  // sentences excluded — so a hit is a real demand): 2+ missing tools means
  // the required profile isn't his — not ideal to apply. 1 missing tool
  // downgrades to CHECK: often learnable or negotiable, read the JD.
  const gaps = skills?.gap?.length || 0;
  if (gaps >= 2) return 'GATED';
  if (gaps === 1 && v === 'CLEAR') return 'CHECK';
  return v;
}

async function pool(items, worker, concurrency) {
  const results = []; let i = 0;
  async function run() { while (i < items.length) { const idx = i++; results[idx] = await worker(items[idx]); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

async function main() {
  const { jobs } = JSON.parse(readFileSync(IN_PATH, 'utf8'));
  // Postdocs are PhD-gated by definition — noise for an M.S. candidate.
  const eligible = jobs.filter(j => !/\bpostdoc/i.test(j.title));
  const targets = eligible.slice(0, LIMIT);
  console.error(`screening ${targets.length} openings (${jobs.length - eligible.length} postdocs dropped)...`);
  let done = 0;
  const screened = await pool(targets, async (job) => {
    const api = detailApi(job.url);
    const detail = api ? await fetchDetail(api) : null;
    done++;
    if (done % 50 === 0) console.error(`  ${done}/${targets.length}`);
    if (!detail?.jobPostingInfo?.jobDescription) return { ...job, verdict: 'UNREACHABLE', gates: null, skills: null };
    // Cap-exempt H-1B is US law — a London/Hyderabad posting on a matched
    // board is out of scope no matter how good the title looks.
    const country = detail.jobPostingInfo?.country?.descriptor
      || detail.jobPostingInfo?.jobRequisitionLocation?.country?.descriptor || '';
    if (country && !/united states/i.test(country)) return { ...job, verdict: 'NON_US', gates: null, skills: null };
    const jd = detail.jobPostingInfo.jobDescription;
    const jdSentences = htmlToSentences(jd);
    const gates = screen(jdSentences);
    const skills = requiredSkillGaps(jd);
    const v = verdict(gates, skills);
    // Ranking only ever reorders CLEAR — it never decides membership.
    const rank = RANK && v === 'CLEAR' ? await rankScore(jdSentences) : null;
    return { ...job, gates, skills, verdict: v, rank };
  }, RANK ? Math.min(CONCURRENCY, 4) : CONCURRENCY);

  writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), screened }, null, 2));

  const buckets = { CLEAR: [], CHECK: [], GATED: [], UNREACHABLE: [], NON_US: [] };
  for (const s of screened) buckets[s.verdict].push(s);
  const fresh = (a, b) => (b.postedAt || 0) - (a.postedAt || 0);
  const fmt = (j) => {
    const age = j.postedAt ? `${Math.round((Date.now() - j.postedAt) / 86_400_000)}d` : '30d+';
    const sal = j.gates?.salary ? ` | $${j.gates.salary.lo.toLocaleString()}-$${j.gates.salary.hi.toLocaleString()}` : '';
    const why = j.verdict === 'CLEAR'
      ? (j.gates?.degreeAlt ? `escape hatch: "${j.gates.degreeAlt}"` : (j.gates?.minYears === null ? 'no YoE gate found' : `min ${j.gates.minYears} yr`))
      : (j.gates?.cohort ? `cohort: "${j.gates.cohort}"` : (j.gates?.yoeEvidence?.[0] ? `"${j.gates.yoeEvidence[0]}"` : ''));
    const spon = j.gates?.sponsorFlag ? ` | ⚠ sponsor: "${j.gates.sponsorFlag}"` : '';
    const sk = j.skills
      ? (j.skills.gap.length
        ? ` | skills: ${j.skills.known}/${j.skills.required} known, missing: ${j.skills.gap.join(', ')}`
        : (j.skills.required
          ? ` | skills: all ${j.skills.required} required known`
          : ' | skills: no specific tools required'))
      : ' | skills: no req section parsed';
    const rk = typeof j.rank === 'number' ? ` | rank: ${j.rank.toFixed(3)}` : '';
    return `- [${j.title}](${j.url}) — **${j.employer}**, ${j.location || 'see posting'} (${age})${sal}\n  ${why}${sk}${spon}${rk}`;
  };
  // Ranked mode sorts CLEAR by fit (best-match sentences vs cv.md); jobs
  // without a rank score (parse failure, e.g.) sink to the bottom rather than
  // vanishing. Unranked mode is unchanged: freshest first.
  const byRank = (a, b) => (b.rank ?? -1) - (a.rank ?? -1);
  const clearOrder = RANK ? [...buckets.CLEAR].sort(byRank) : [...buckets.CLEAR].sort(fresh);
  const lines = [
    `# Cap-Exempt Shortlist (gate-screened${RANK ? ', ranked by fit' : ''})`,
    ``,
    `Generated: ${new Date().toISOString().slice(0, 10)} | Screened: ${screened.length} | CLEAR: ${buckets.CLEAR.length} | CHECK: ${buckets.CHECK.length} | GATED: ${buckets.GATED.length} | Non-US (dropped): ${buckets.NON_US.length} | Unreachable: ${buckets.UNREACHABLE.length}`,
    ``,
    `CLEAR = no YoE gate (or min <=1 yr / master's escape hatch) AND all required tools known. CHECK = 2 yrs, ambiguous, or 1 required tool missing. GATED = 3+ yrs hard, cohort gate, or 2+ required tools missing. Regex screen — read the JD before applying.`,
    ``,
    `## CLEAR (${buckets.CLEAR.length})`, ``,
    ...clearOrder.map(fmt), ``,
    `## CHECK (${buckets.CHECK.length})`, ``,
    ...buckets.CHECK.sort(fresh).map(fmt), ``,
    `## GATED (${buckets.GATED.length})`, ``,
    ...buckets.GATED.sort(fresh).map(j => {
      const reason = j.gates?.cohort ? 'cohort'
        : (j.skills?.gap?.length >= 2 ? `missing skills: ${j.skills.gap.slice(0, 6).join(', ')}`
          : `min ${j.gates?.minYears} yrs`);
      return `- [${j.title}](${j.url}) — ${j.employer} (${reason})`;
    }),
  ];
  if (buckets.UNREACHABLE.length) {
    lines.push(``, `## Unreachable (${buckets.UNREACHABLE.length}) — retry manually`, ``,
      ...buckets.UNREACHABLE.map(j => `- [${j.title}](${j.url}) — ${j.employer}`));
  }
  writeFileSync(OUT_MD, lines.join('\n'));
  console.log(JSON.stringify({
    screened: screened.length,
    clear: buckets.CLEAR.length, check: buckets.CHECK.length,
    gated: buckets.GATED.length, nonUs: buckets.NON_US.length,
    unreachable: buckets.UNREACHABLE.length,
    out: [OUT_MD, OUT_JSON],
  }));
}

main().catch(e => { console.error(e); process.exit(1); });
