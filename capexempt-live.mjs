#!/usr/bin/env node
/**
 * capexempt-live.mjs — live openings from cap-exempt H-1B employers on Workday.
 *
 * Pipeline (zero LLM tokens):
 *   1. Load the cap-exempt roster (data/lca/capexempt-all.json, from lca-index.mjs).
 *   2. Load the public Workday tenant directory (job-board-aggregator dataset,
 *      shared cache with scan-ats-full.mjs).
 *   3. LOOSE name match roster<->tenant slug (high recall, low precision) —
 *      then VERIFY each candidate against the board's own org identity: fetch
 *      one job via CXS, GET its job-detail JSON, and require the employer's
 *      most distinctive name token in hiringOrganization.name / logoImage.alt
 *      (kills allstate<->"Ball State University"-class false positives).
 *      The board HTML is an empty SPA shell, so <title> is unusable.
 *   4. For each verified tenant, POST the CXS jobs endpoint with
 *      searchText='analyst' and searchText='data' — Workday filters
 *      server-side, so giant health-system boards cost a few pages, not 500.
 *   5. Local title filter: analyst/data/research family, entry-level only
 *      (drops senior/principal/director/manager) per the I-983
 *      specialty-occupation guardrail (analyst titles yes, clerk titles no).
 *
 * Output:
 *   data/lca/capexempt-live-jobs.json     — all matched openings + roster metadata
 *   data/lca/capexempt-live-openings.md   — human digest, grouped by employer
 *   data/lca/capexempt-uncovered.json     — top roster employers with NO
 *                                           Workday board (the browser-tier worklist)
 *
 * Usage:
 *   node capexempt-live.mjs                 # full run
 *   node capexempt-live.mjs --limit 20      # first 20 verified tenants (smoke test)
 *   node capexempt-live.mjs --min-entry 50  # only roster employers with >=50 entry-level LCA filings
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { calendarDayMs } from './freshness.mjs';

const ROSTER_PATH = 'data/lca/capexempt-all.json';
const DATASET_URL = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/workday_companies.json';
const CACHE_PATH = 'data/cache/ats-companies/workday_companies.json';
const OUT_JSON = 'data/lca/capexempt-live-jobs.json';
const OUT_MD = 'data/lca/capexempt-live-openings.md';
const OUT_UNCOVERED = 'data/lca/capexempt-uncovered.json';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAGE_SIZE = 20;
const MAX_PAGES_PER_QUERY = 25; // 500 results per searchText per site — plenty for 'analyst'
const TENANT_CONCURRENCY = 6;
const SEARCH_TERMS = ['analyst', 'data'];
const TIMEOUT_MS = 20_000;

// Generic tokens carry no identity — never use one as the distinctive token.
const GENERIC = new Set([
  'the', 'of', 'at', 'and', 'for', 'inc', 'llc', 'llp', 'co', 'corp', 'corporation',
  'university', 'college', 'school', 'institute', 'academy', 'center', 'centre',
  'medical', 'health', 'healthcare', 'hospital', 'hospitals', 'clinic', 'system',
  'systems', 'state', 'national', 'american', 'foundation', 'research', 'sciences',
  'science', 'children', 'childrens', 'community', 'regional', 'general', 'memorial',
  'saint', 'st', 'new', 'group',
]);

const args = process.argv.slice(2);
function flagVal(name) {
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const eq = args.find(a => a.startsWith(name + '='));
  return eq ? eq.split('=')[1] : null;
}
const LIMIT = Number(flagVal('--limit')) || Infinity;
const MIN_ENTRY = Number(flagVal('--min-entry')) || 0;

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const squash = s => norm(s).replace(/ /g, '');

function tokens(name) {
  return norm(name).split(' ').filter(t => t.length >= 3 && !GENERIC.has(t) && !/^\d+$/.test(t));
}

// Words that mark an institution (vs a bank/retailer sharing a place name).
const INSTITUTIONAL = new Set([
  'university', 'college', 'school', 'institute', 'academy', 'medical', 'health',
  'healthcare', 'hospital', 'hospitals', 'clinic', 'foundation', 'research',
]);

// Employers confirmed this session (2026-07-17, reports #215/#230/#231/#244/#254)
// to be for-profit orgs that keep loosely matching unrelated cap-exempt roster
// rows purely on a shared brand-like token ("baxter", "abbott", "alignment")
// plus a health/medical word that satisfies the single-token INSTITUTIONAL
// fallback below — a word-list heuristic can't reliably tell "Mayo Clinic" (a
// real nonprofit) apart from "Baxter Healthcare Corp" vs "Baxter County
// Regional Hospital" (two unrelated orgs that both use a health-adjacent
// word), so these are hard-excluded rather than risking a heuristic rewrite
// that could regress legitimate single-token matches. Extend this list
// whenever a downstream per-job evaluation (modes/oferta.md) confirms another
// false attribution — that per-job re-verification is the real safety net,
// this list only stops the SAME false positive from recurring on rerun.
const KNOWN_NON_CAPEXEMPT_ORG_TOKENS = new Set([
  'abbott', 'alignment healthcare', 'baxter healthcare', 'baxter international',
  'florida cancer specialists',
]);
function isKnownNonCapexempt(orgName) {
  const n = norm(orgName);
  for (const bad of KNOWN_NON_CAPEXEMPT_ORG_TOKENS) if (n.includes(bad)) return true;
  return false;
}

// Identity check. A single shared token ("columbia", "austin", "cancer") is
// NOT enough — Columbia Bank, the City of Austin, and Cancer Research UK all
// pass that bar. Accept when:
//   - 2+ distinctive employer tokens appear in the org name, OR
//   - every distinctive token of the ORG name appears in the employer name
//     (brand name ⊆ legal name: "Stanford University" ⊆ "The Leland Stanford,
//     Jr University"), OR
//   - the employer has exactly ONE distinctive token, it matches, and the org
//     name carries an institutional word ("Cornell University", "Mayo Clinic").
function verifyMatch(employerName, orgName) {
  const eT = tokens(employerName);
  if (!eT.length) return false;
  const oNorm = ` ${norm(orgName)} `;
  const oSquash = squash(orgName);
  const hits = eT.filter(t => oNorm.includes(` ${t}`) || (t.length >= 6 && oSquash.includes(t)));
  if (!hits.length) return false;
  if (hits.length >= 2) return true;
  const oT = tokens(orgName);
  const subset = oT.length > 0
    && oT.every(t => eT.some(e => e === t || e.startsWith(t) || t.startsWith(e)));
  // A single-token brand subset ("Vanguard" ⊆ "Vanguard University of Southern
  // California") matches for-profits sharing a name with a college — demand a
  // second token or an institutional word from the org itself.
  if (subset && (oT.length >= 2 || norm(orgName).split(' ').some(t => INSTITUTIONAL.has(t)))) return true;
  if (eT.length === 1) return norm(orgName).split(' ').some(t => INSTITUTIONAL.has(t));
  return false;
}

function fetchWithTimeout(url, opts = {}) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function loadDataset() {
  if (existsSync(CACHE_PATH)) {
    try { return JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { /* refetch */ }
  }
  const r = await fetchWithTimeout(DATASET_URL, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`dataset fetch failed: ${r.status}`);
  const data = await r.json();
  mkdirSync('data/cache/ats-companies', { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(data));
  return data;
}

// ---- step 3a: loose match (recall) ----------------------------------------
function looseMatches(roster, tenantLines) {
  // Group dataset lines by tenant so we verify once per tenant.
  const byTenant = new Map();
  const SLUG_RE = /^[A-Za-z0-9._-]+$/;
  for (const line of tenantLines) {
    const [tenant, instance, site] = String(line).split('|');
    if (![tenant, instance, site].every(p => p && SLUG_RE.test(p))) continue;
    if (!byTenant.has(tenant)) byTenant.set(tenant, []);
    byTenant.get(tenant).push({ tenant, instance, site });
  }
  const candidates = [];
  for (const [tenant, sites] of byTenant) {
    const tn = squash(tenant.replace(/[._-]/g, ' '));
    if (tn.length < 4) continue;
    const employers = [];
    for (const r of roster) {
      const rn = squash(r.employer);
      const rTokens = tokens(r.employer);
      const tokenHit = rTokens.some(t => t.length >= 5 && tn.includes(t));
      if (rn.includes(tn) || tn.includes(rn) || tokenHit) {
        employers.push(r);
        if (employers.length >= 8) break; // verification picks the real one
      }
    }
    if (employers.length) candidates.push({ tenant, sites, employers });
  }
  return candidates;
}

// ---- step 3b: verify against the board's own org identity ------------------
async function verifyTenant(cand) {
  const { tenant, sites, employers } = cand;
  // One site is enough to read the org identity; prefer the first.
  const s = sites[0];
  const origin = `https://${tenant}.${s.instance}.myworkdayjobs.com`;
  const first = await cxsPage(tenant, s.instance, s.site, '', 0);
  const posting = first?.jobPostings?.find(j => j?.externalPath);
  if (!posting) return null; // dead board or zero postings — nothing to scan anyway
  let detail;
  try {
    const r = await fetchWithTimeout(`${origin}/wday/cxs/${tenant}/${s.site}${posting.externalPath}`, {
      headers: { accept: 'application/json', 'user-agent': UA },
    });
    if (!r.ok) return null;
    detail = await r.json();
  } catch { return null; }
  // Cap-exempt status is a US-law concept — a non-US board can never qualify,
  // whatever its name says (kills Cancer Research UK matching MD Anderson).
  const countryDesc = detail?.jobPostingInfo?.country?.descriptor
    || detail?.jobPostingInfo?.jobRequisitionLocation?.country?.descriptor || '';
  const alpha2 = detail?.jobPostingInfo?.jobRequisitionLocation?.country?.alpha2Code || '';
  if (alpha2 ? alpha2 !== 'US' : (countryDesc && !/united states/i.test(countryDesc))) return null;
  const orgName = [detail?.hiringOrganization?.name, detail?.jobPostingInfo?.logoImage?.alt]
    .filter(Boolean).join(' ');
  if (!orgName.trim()) return null;
  // A confirmed for-profit board can never be the cap-exempt match, regardless
  // of what roster row it loosely matched — see KNOWN_NON_CAPEXEMPT_ORG_TOKENS.
  if (isKnownNonCapexempt(orgName)) return null;
  for (const employer of employers) {
    if (isKnownNonCapexempt(employer.employer)) continue; // roster row itself is a known for-profit
    if (verifyMatch(employer.employer, orgName)) {
      return { tenant, sites, employer, boardOrg: orgName.trim() };
    }
  }
  return null;
}

// ---- step 4: fetch openings -------------------------------------------------
// Relative Workday labels name a calendar DAY, not an instant — see
// calendarDayMs in freshness.mjs for why anchoring to the raw clock instant
// shifts the date by a day west/east of UTC. Same policy as providers/workday.mjs.
function parsePostedOn(label, now = Date.now()) {
  if (!label) return null;
  if (/posted\s+today/i.test(label)) return calendarDayMs(0, now);
  if (/posted\s+yesterday/i.test(label)) return calendarDayMs(1, now);
  const m = label.match(/posted\s+(\d+)(\+?)\s*day/i);
  if (!m || m[2] === '+') return null;
  return calendarDayMs(Number(m[1]), now);
}

async function cxsPage(tenant, instance, site, searchText, offset) {
  const origin = `https://${tenant}.${instance}.myworkdayjobs.com`;
  const api = `${origin}/wday/cxs/${tenant}/${site}/jobs`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetchWithTimeout(api, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json',
          'user-agent': UA, 'accept-language': 'en-US,en;q=0.9',
          origin, referer: `${origin}/${site}/`,
        },
        body: JSON.stringify({ limit: PAGE_SIZE, offset, searchText, appliedFacets: {} }),
      });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      if (attempt === 2) return null;
      await new Promise(res => setTimeout(res, 600 * (attempt + 1) + Math.random() * 300));
    }
  }
  return null;
}

// Entry-level analyst/data/research family. II is kept (roster shows
// "Research Associate II" as a real entry filing); III+ and leadership are not.
const TITLE_POS = /\b(analyst|analytics|data|business intelligence|statistician|biostatistic|research (associate|assistant|specialist|coordinator|technician))\b/i;
const TITLE_NEG = /\b(senior|sr\.?|principal|lead|staff|director|manager|chief|head|vp|vice president|iii|iv|architect|faculty|professor|dean|physician|nurse|rn|clerk|data entry|postdoc(?:toral)?)\b/i;

async function fetchTenantJobs(v) {
  const seen = new Set();
  const jobs = [];
  for (const s of v.sites) {
    for (const term of SEARCH_TERMS) {
      let total = null;
      for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
        const json = await cxsPage(v.tenant, s.instance, s.site, term, page * PAGE_SIZE);
        if (!json) break;
        if (total === null) total = typeof json.total === 'number' ? json.total : null;
        const postings = Array.isArray(json.jobPostings) ? json.jobPostings : [];
        for (const j of postings) {
          if (!j?.externalPath || !String(j.title || '').trim()) continue;
          const title = j.title.trim();
          const loc = j.locationsText || '';
          const key = `${title}|${loc}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!TITLE_POS.test(title) || TITLE_NEG.test(title)) continue;
          jobs.push({
            title, location: loc,
            url: `https://${v.tenant}.${s.instance}.myworkdayjobs.com/${s.site}${j.externalPath}`,
            postedAt: parsePostedOn(j.postedOn),
            employer: v.employer.employer,
          });
        }
        if (postings.length < PAGE_SIZE) break;
        if (total !== null && (page + 1) * PAGE_SIZE >= total) break;
        await new Promise(res => setTimeout(res, 150));
      }
    }
  }
  return jobs;
}

async function pool(items, worker, concurrency) {
  const results = [];
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

// ---- main -------------------------------------------------------------------
async function main() {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8'))
    .filter(e => e.entryLevel >= MIN_ENTRY);
  const dataset = await loadDataset();
  const tenantLines = Array.isArray(dataset) ? dataset : Object.values(dataset)[0];
  console.error(`roster: ${roster.length} employers | workday tenants: ${tenantLines.length}`);

  const candidates = looseMatches(roster, tenantLines);
  console.error(`loose candidates: ${candidates.length} tenants — verifying by board title...`);

  const verifiedAll = (await pool(candidates, verifyTenant, TENANT_CONCURRENCY)).filter(Boolean);
  const verified = verifiedAll.slice(0, LIMIT);
  console.error(`verified cap-exempt Workday boards: ${verifiedAll.length}${LIMIT !== Infinity ? ` (scanning first ${verified.length})` : ''}`);

  let done = 0;
  const perTenant = await pool(verified, async (v) => {
    const jobs = await fetchTenantJobs(v);
    done++;
    if (done % 20 === 0) console.error(`  scanned ${done}/${verified.length} boards...`);
    return { ...v, jobs };
  }, TENANT_CONCURRENCY);

  const allJobs = perTenant.flatMap(t => t.jobs);
  const coveredEmployers = new Set(perTenant.map(t => t.employer.employer));
  const uncovered = roster
    .filter(e => !coveredEmployers.has(e.employer))
    .sort((a, b) => b.entryLevel - a.entryLevel)
    .slice(0, 40);

  writeFileSync(OUT_JSON, JSON.stringify({
    generatedAt: new Date().toISOString(),
    boardsVerified: verifiedAll.length,
    boardsScanned: verified.length,
    jobs: allJobs,
  }, null, 2));
  writeFileSync(OUT_UNCOVERED, JSON.stringify(uncovered, null, 2));

  // Markdown digest, grouped by employer, sorted by roster entry-level volume.
  const byEmployer = new Map();
  for (const t of perTenant) {
    if (!t.jobs.length) continue;
    if (!byEmployer.has(t.employer.employer)) byEmployer.set(t.employer.employer, { meta: t.employer, board: t.boardOrg, jobs: [] });
    byEmployer.get(t.employer.employer).jobs.push(...t.jobs);
  }
  const groups = [...byEmployer.values()].sort((a, b) => b.meta.entryLevel - a.meta.entryLevel);
  const lines = [
    `# Cap-Exempt Live Openings (Workday tier)`,
    ``,
    `Generated: ${new Date().toISOString().slice(0, 10)} | Boards verified: ${verifiedAll.length} | Employers with matches: ${groups.length} | Openings: ${allJobs.length}`,
    ``,
    `Filter: analyst/data/research titles, entry-level (no senior/lead/manager). Source: public Workday CXS APIs, zero LLM tokens.`,
    ``,
  ];
  for (const g of groups) {
    lines.push(`## ${g.meta.employer}`);
    lines.push(`Board identifies as: **${g.board}** | LCA history: ${g.meta.filings} filings, ${g.meta.entryLevel} entry-level, median $${g.meta.medianWage?.toLocaleString?.() || g.meta.medianWage} | States: ${g.meta.states}`);
    lines.push(``);
    for (const j of g.jobs.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0))) {
      // postedAt is a day token, so age is a difference of calendar days — an
      // elapsed-millisecond span would render "Posted Today" as 1d whenever the
      // report is generated late in the local day.
      const age = j.postedAt
        ? `${Math.max(0, Math.round((calendarDayMs(0) - j.postedAt) / 86_400_000))}d`
        : '30d+';
      lines.push(`- [${j.title}](${j.url}) — ${j.location || 'location on posting'} (${age})`);
    }
    lines.push(``);
  }
  writeFileSync(OUT_MD, lines.join('\n'));

  console.log(JSON.stringify({
    boardsVerified: verifiedAll.length,
    boardsScanned: verified.length,
    employersWithMatches: groups.length,
    openings: allJobs.length,
    out: [OUT_JSON, OUT_MD, OUT_UNCOVERED],
  }));
}

main().catch(e => { console.error(e); process.exit(1); });
