/**
 * jd-fetch.mjs — turn a posting URL into the plain text of the job ad.
 *
 * The queue has always stored pointers (url/company/title) and verdicts
 * (everify_status, level_status), never the EVIDENCE: no row has ever held the
 * job ad itself. Every gate so far could therefore only reason about metadata,
 * which is why the funnel stops dead at `llm_ready`. This module is the missing
 * step, and it is deliberately zero-token: it calls the same JSON endpoints the
 * careers page itself calls, so no browser, no scraping, no model.
 *
 * Four ATSs cover 97% of the queue (workday 1819, greenhouse 258, ashby 199,
 * lever 106); anything else is reported `unsupported` rather than guessed at.
 * Every payload shape here was confirmed against a LIVE probe on 2026-07-21.
 *
 * Two of those shapes are not what you would assume, and both are load-bearing:
 *
 *   - **Ashby has no per-job endpoint.** Its public posting-api returns the
 *     ORG's entire board with descriptions included, so the cost is one request
 *     per company, not per job. `shared: true` plus the caller's cache is what
 *     turns 199 postings into 129 requests.
 *   - **Lever splits the ad across fields.** `descriptionPlain` is only the
 *     intro; the requirements live in `lists[].content`. Reading one field
 *     looks like success while dropping the exact text screening needs.
 */
import { decodeEntities } from './providers/_html-entities.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Workday: the careers page at /{site}/job/... is backed by /wday/cxs/{tenant}/{site}/job/...
// The optional locale segment (/en-US/) belongs to the display URL only and is
// not part of the CXS path, so it is matched and discarded.
const WORKDAY_RE = /^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Za-z]{2}\/)?([^/]+)(\/job\/.+)$/;
// Greenhouse serves the same board from two hosts, and the EU board is a
// SEPARATE api host — pointing an EU board at the US api returns 404.
const GREENHOUSE_RE = /^https:\/\/(?:job-boards|boards)(\.eu)?\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/;
const LEVER_RE = /^https:\/\/jobs\.lever\.co\/([^/]+)\/([^/?#]+)/;
const ASHBY_RE = /^https:\/\/jobs\.ashbyhq\.com\/([^/]+)\/([^/?#]+)/;

/**
 * Map a posting URL to the JSON endpoint that holds its ad.
 *
 * @param {unknown} jobUrl
 * @returns {{ats:string, api:string, shared:boolean}|null} null when the site
 *   has no known JSON endpoint — callers must skip it, never guess a URL.
 */
export function detailApiFor(jobUrl) {
  const url = String(jobUrl ?? '').trim();
  if (!url.startsWith('https://') && !url.startsWith('http://')) return null;
  const https = url.replace(/^http:/, 'https:');

  const wd = https.match(WORKDAY_RE);
  if (wd) {
    const [, tenant, instance, site, path] = wd;
    return { ats: 'workday', api: `https://${tenant}.${instance}.myworkdayjobs.com/wday/cxs/${tenant}/${site}${path}`, shared: false };
  }

  const gh = https.match(GREENHOUSE_RE);
  if (gh) {
    const [, eu, board, id] = gh;
    return { ats: 'greenhouse', api: `https://boards-api${eu || ''}.greenhouse.io/v1/boards/${board}/jobs/${id}`, shared: false };
  }

  const lv = https.match(LEVER_RE);
  if (lv) {
    const [, org, id] = lv;
    // Lever's own "/apply" page is the same posting; the id is what identifies it.
    if (id === 'apply') return null;
    return { ats: 'lever', api: `https://api.lever.co/v0/postings/${org}/${id}`, shared: false };
  }

  const ab = https.match(ASHBY_RE);
  if (ab) {
    const [, org] = ab;
    // Shared: this one response carries every posting at the org.
    return { ats: 'ashby', api: `https://api.ashbyhq.com/posting-api/job-board/${org}`, shared: true };
  }

  return null;
}

// Tags whose content is markup/styling, not ad text — dropped wholesale so a
// stylesheet or tracking script never lands in the JD body.
const DROP_SUBTREES = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;
// Block-level boundaries. Requirements arrive as <li> bullets; without a break
// they concatenate into "5 years of PythonBachelor degree", which reads as one
// bogus sentence and corrupts any downstream requirement parse.
const BLOCK_BOUNDARY = /<\/?(?:p|div|li|ul|ol|br|tr|h[1-6]|section|table)\b[^>]*>/gi;

/**
 * HTML (or entity-escaped HTML) to plain text, one line per block.
 *
 * Entities are decoded BEFORE tags are stripped because Greenhouse ships its ad
 * as entity-escaped markup inside a JSON string ("&lt;p&gt;"), where the tags
 * only exist after decoding. A second decode pass afterwards catches entities
 * that were inside the markup ("&amp;" between two tags).
 *
 * @param {unknown} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (html == null) return '';
  let s = decodeEntities(String(html));
  s = s.replace(DROP_SUBTREES, ' ');
  s = s.replace(BLOCK_BOUNDARY, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** The id segment of an Ashby posting URL — the stable key into its board. */
function ashbyIdOf(url) {
  const m = String(url ?? '').match(ASHBY_RE);
  return m ? m[2] : '';
}

/**
 * Pull the ad out of one ATS's payload and return it as plain text.
 *
 * @param {string} ats  one of workday|greenhouse|lever|ashby
 * @param {any} payload the parsed JSON response
 * @param {{url?:string}} [opts] the posting URL — required for ashby, whose
 *   payload is the whole board and must be narrowed to one job.
 * @returns {string} '' when the payload carries no description (never undefined)
 */
export function extractJdText(ats, payload, { url = '' } = {}) {
  if (!payload || typeof payload !== 'object') return '';

  if (ats === 'workday') return htmlToText(payload?.jobPostingInfo?.jobDescription);
  if (ats === 'greenhouse') return htmlToText(payload?.content);

  if (ats === 'lever') {
    // Order mirrors the page: intro, then each titled list (requirements,
    // responsibilities), then the closing section.
    const parts = [payload.descriptionPlain || payload.description];
    for (const list of Array.isArray(payload.lists) ? payload.lists : []) {
      parts.push(list?.text, list?.content);
    }
    parts.push(payload.additionalPlain || payload.additional);
    return htmlToText(parts.filter(Boolean).join('\n'));
  }

  if (ats === 'ashby') {
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    const id = ashbyIdOf(url);
    // Match on the id, not on jobUrl equality: the payload's jobUrl can carry
    // tracking params the queue's canonical URL has already stripped.
    const job = jobs.find((j) => j?.id === id) || (id ? jobs.find((j) => String(j?.jobUrl || '').includes(id)) : null);
    if (!job) return '';
    return htmlToText(job.descriptionPlain || job.descriptionHtml);
  }

  return '';
}

/**
 * Fetch one posting's ad text.
 *
 * `fetchImpl` is injected so the whole module is testable offline. `cache` is a
 * Map the caller owns; only `shared` endpoints (ashby boards) are stored in it,
 * because caching a per-job endpoint would hand every posting the first job's
 * description. Failures are cached too — otherwise 200 jobs at one dead org
 * each re-request the same broken board.
 *
 * @param {string} jobUrl
 * @param {{fetchImpl?:Function, cache?:Map<string,any>, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, text:string, ats:string|null, reason:string|null}>}
 *   `reason` distinguishes 'gone' (404/410 — the posting is dead, do not retry)
 *   from 'http_5xx'/'network:' (transient, retryable) from 'empty' (endpoint
 *   answered but carried no ad).
 */
export async function fetchJd(jobUrl, { fetchImpl = fetch, cache = null, timeoutMs = 20_000 } = {}) {
  const target = detailApiFor(jobUrl);
  if (!target) return { ok: false, text: '', ats: null, reason: 'unsupported' };
  const { ats, api, shared } = target;
  const cacheKey = shared && cache ? api : null;

  const load = async () => {
    try {
      const res = await fetchImpl(api, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // 404/410 is information, not a failure: the posting is gone. Conflating
        // it with a transient error makes a dead row retry until it burns out.
        return { error: res.status === 404 || res.status === 410 ? 'gone' : `http_${res.status}` };
      }
      return { payload: await res.json() };
    } catch (e) {
      return { error: `network: ${e?.message || e}` };
    }
  };

  // Cache the PROMISE, not the resolved value. The drain fetches several rows
  // at once, so two jobs at the same ashby org are typically both in flight
  // before either could have populated a value-cache — and a value-cache would
  // then fetch that board twice. Storing the in-flight promise is what makes
  // "one request per org" hold under concurrency.
  let outcome;
  if (cacheKey) {
    if (!cache.has(cacheKey)) cache.set(cacheKey, load());
    outcome = await cache.get(cacheKey);
  } else {
    outcome = await load();
  }
  if (outcome.error) return { ok: false, text: '', ats, reason: outcome.error };

  const text = extractJdText(ats, outcome.payload, { url: jobUrl });
  if (!text) return { ok: false, text: '', ats, reason: 'empty' };
  return { ok: true, text, ats, reason: null };
}
