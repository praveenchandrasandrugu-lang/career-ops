/**
 * jd-fetch.test.mjs — the job-ad text fetcher (jd-fetch.mjs).
 *
 * The queue has always stored pointers (url/company/title) and verdicts
 * (everify_status, level_status) but never the EVIDENCE: no row has ever held
 * the job ad itself. That is why the funnel stops dead at llm_ready — every
 * gate so far could only look at metadata. This module is the missing step:
 * turn a posting URL into its plain-text job description, at zero token cost,
 * using the same JSON endpoints the careers pages themselves call.
 *
 * Four ATSs cover 97% of the queue (workday 1819, greenhouse 258, ashby 199,
 * lever 106). Every fixture below is shaped from a LIVE probe of that ATS on
 * 2026-07-21, not from memory — a fixture that invents field names would make
 * these tests pass while the fetcher returns nothing in production.
 *
 * Two shapes drive the design and are pinned here:
 *   - Ashby has NO per-job endpoint. Its public API returns the whole board,
 *     descriptions included, so cost is one request per ORG, not per job.
 *   - Lever splits the ad: descriptionPlain is only the intro, and the actual
 *     requirements live in lists[].content. Reading one field silently drops
 *     the exact text a skill screen needs.
 *
 * Run: node tests/jd-fetch.test.mjs  (or via test-all.mjs)
 */
import { pass, fail } from './helpers.mjs';
import { detailApiFor, htmlToText, extractJdText, fetchJd } from '../jd-fetch.mjs';

const T = (label, cond) => (cond ? pass(label) : fail(label));
const eq = (label, got, want) => T(`${label}${got === want ? '' : ` (got ${JSON.stringify(got)})`}`, got === want);
const has = (label, got, needle) => T(`${label}${String(got).includes(needle) ? '' : ` (got ${JSON.stringify(String(got).slice(0, 120))})`}`, String(got).includes(needle));

// ── detailApiFor: posting URL → the JSON endpoint that holds the ad ─────────

eq('detailApiFor: workday job URL maps to its CXS detail endpoint',
  detailApiFor('https://wf.wd1.myworkdayjobs.com/wellsfargojobs/job/JAMESTOWN-ND/Branch-Ops_R-559821')?.api,
  'https://wf.wd1.myworkdayjobs.com/wday/cxs/wf/wellsfargojobs/job/JAMESTOWN-ND/Branch-Ops_R-559821');
eq('detailApiFor: workday board root (no /job/ segment) is not a posting',
  detailApiFor('https://wf.wd1.myworkdayjobs.com/wellsfargojobs'), null);

eq('detailApiFor: greenhouse job URL maps to boards-api',
  detailApiFor('https://job-boards.greenhouse.io/kargo/jobs/6120133004')?.api,
  'https://boards-api.greenhouse.io/v1/boards/kargo/jobs/6120133004');
eq('detailApiFor: greenhouse EU board keeps the EU api host (a US host 404s)',
  detailApiFor('https://job-boards.eu.greenhouse.io/acme/jobs/42')?.api,
  'https://boards-api.eu.greenhouse.io/v1/boards/acme/jobs/42');

eq('detailApiFor: lever job URL maps to the v0 postings endpoint',
  detailApiFor('https://jobs.lever.co/zoox/d4108968-e83d-4d87-a92c-e4cd1823801c')?.api,
  'https://api.lever.co/v0/postings/zoox/d4108968-e83d-4d87-a92c-e4cd1823801c');

// Ashby's endpoint is the ORG's whole board, so it is shared by every posting
// at that org. `shared` is what lets the caller fetch it once for all 199 rows.
eq('detailApiFor: ashby job URL maps to its org board',
  detailApiFor('https://jobs.ashbyhq.com/openai/596e543a-0ab9-471e-a1ff-40fd55c74fce')?.api,
  'https://api.ashbyhq.com/posting-api/job-board/openai');
eq('detailApiFor: ashby endpoint is marked shared (one board serves every job at that org)',
  detailApiFor('https://jobs.ashbyhq.com/openai/596e543a')?.shared, true);
eq('detailApiFor: a per-job endpoint is NOT shared',
  detailApiFor('https://job-boards.greenhouse.io/kargo/jobs/6120133004')?.shared, false);

eq('detailApiFor: an unrecognized careers site returns null (no endpoint to guess)',
  detailApiFor('https://www.compass.com/careers/some-role'), null);
eq('detailApiFor: junk input returns null instead of throwing',
  detailApiFor('not a url'), null);

// ── htmlToText: ATS ads are HTML; screening reads sentences ────────────────

eq('htmlToText: strips tags and decodes entities',
  htmlToText('<p>Python &amp; SQL</p>'), 'Python & SQL');

// Requirements arrive as <li> bullets. Without a line break they concatenate
// into "5 years of PythonBachelor degree", which reads as one bogus sentence
// and corrupts any downstream requirement parse.
T('htmlToText: list items become separate lines, never one run-on sentence',
  htmlToText('<ul><li>5 years of Python</li><li>Bachelor degree</li></ul>').split('\n').filter(Boolean).length === 2);

// Greenhouse serves its ad as ENTITY-ESCAPED html inside a JSON string, so the
// tags only appear after decoding. Stripping before decoding leaves literal
// "<p>" in the output.
eq('htmlToText: handles greenhouse entity-escaped markup (decode before strip)',
  htmlToText('&lt;p&gt;Own the data pipeline&lt;/p&gt;'), 'Own the data pipeline');

eq('htmlToText: null/undefined input returns an empty string', htmlToText(null), '');

// ── extractJdText: pull the ad out of each ATS's own payload shape ──────────

eq('extractJdText: workday reads jobPostingInfo.jobDescription',
  extractJdText('workday', { jobPostingInfo: { jobDescription: '<p>Branch Operations</p>' } }),
  'Branch Operations');

eq('extractJdText: greenhouse reads content',
  extractJdText('greenhouse', { content: '&lt;p&gt;Kargo is hiring&lt;/p&gt;' }),
  'Kargo is hiring');

// The lists are the requirements. A fetcher that returns only descriptionPlain
// looks like it worked and silently drops the part screening depends on.
{
  const lever = {
    descriptionPlain: 'About Zoox',
    lists: [{ text: 'Requirements', content: '<ul><li>5 years of Python</li></ul>' }],
    additionalPlain: 'Zoox is an equal opportunity employer',
  };
  const got = extractJdText('lever', lever);
  has('extractJdText: lever keeps the intro', got, 'About Zoox');
  has('extractJdText: lever keeps the lists[] requirements (not just descriptionPlain)', got, '5 years of Python');
  has('extractJdText: lever keeps the additional section', got, 'equal opportunity');
}

// Ashby hands back the whole board, so the right job has to be picked out of
// it. Matching on the job id from the URL is the only stable key: jobUrl in the
// payload can carry tracking params the queue's canonical URL has stripped.
{
  const board = {
    jobs: [
      { id: 'aaa', jobUrl: 'https://jobs.ashbyhq.com/openai/aaa', descriptionPlain: 'Wrong job' },
      { id: '596e543a', jobUrl: 'https://jobs.ashbyhq.com/openai/596e543a', descriptionPlain: 'Research Engineer, Alignment' },
    ],
  };
  eq('extractJdText: ashby picks the posting matching the job id in the URL',
    extractJdText('ashby', board, { url: 'https://jobs.ashbyhq.com/openai/596e543a' }),
    'Research Engineer, Alignment');
  eq('extractJdText: ashby returns empty when the board no longer lists that job',
    extractJdText('ashby', board, { url: 'https://jobs.ashbyhq.com/openai/deleted-id' }), '');
}

eq('extractJdText: a payload missing its description field returns empty, not undefined',
  extractJdText('workday', {}), '');

// ── fetchJd: the network step, with fetch injected so tests stay offline ────

{
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ jobPostingInfo: { jobDescription: '<p>Hello</p>' } }) };
  };
  const r = await fetchJd('https://wf.wd1.myworkdayjobs.com/site/job/ND/Role_R-1', { fetchImpl: fakeFetch });
  eq('fetchJd: returns the extracted text on 200', r.text, 'Hello');
  eq('fetchJd: reports the ats it used', r.ats, 'workday');
  eq('fetchJd: succeeds', r.ok, true);
}

// A 404 is real information: the posting is gone. It must be distinguishable
// from a transient failure, or a dead job gets retried forever.
{
  const fakeFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const r = await fetchJd('https://jobs.lever.co/acme/uuid-1', { fetchImpl: fakeFetch });
  eq('fetchJd: a 404 is reported as gone, not as a transient error', r.reason, 'gone');
  eq('fetchJd: a 404 does not succeed', r.ok, false);
}

{
  const fakeFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const r = await fetchJd('https://jobs.lever.co/acme/uuid-1', { fetchImpl: fakeFetch });
  eq('fetchJd: a 5xx is reported as a retryable http error, not as gone', r.reason, 'http_503');
}

{
  const fakeFetch = async () => { throw new Error('boom'); };
  const r = await fetchJd('https://jobs.lever.co/acme/uuid-1', { fetchImpl: fakeFetch });
  eq('fetchJd: a thrown network error is caught, not propagated', r.ok, false);
  has('fetchJd: the network error reason names the failure', r.reason, 'boom');
}

{
  const r = await fetchJd('https://www.compass.com/careers/role', { fetchImpl: async () => { throw new Error('should not be called'); } });
  eq('fetchJd: an unsupported site is skipped without a request', r.reason, 'unsupported');
}

// The whole point of the shared-board design: 129 Ashby orgs, not 199 requests.
{
  let hits = 0;
  const board = { jobs: [{ id: 'a1', jobUrl: 'https://jobs.ashbyhq.com/openai/a1', descriptionPlain: 'Job A' },
                         { id: 'b2', jobUrl: 'https://jobs.ashbyhq.com/openai/b2', descriptionPlain: 'Job B' }] };
  const fakeFetch = async () => { hits++; return { ok: true, status: 200, json: async () => board }; };
  const cache = new Map();
  const a = await fetchJd('https://jobs.ashbyhq.com/openai/a1', { fetchImpl: fakeFetch, cache });
  const b = await fetchJd('https://jobs.ashbyhq.com/openai/b2', { fetchImpl: fakeFetch, cache });
  eq('fetchJd: two jobs at one ashby org cost ONE board request', hits, 1);
  eq('fetchJd: the first ashby job still gets its own text', a.text, 'Job A');
  eq('fetchJd: the second ashby job gets ITS text, not the cached first one', b.text, 'Job B');
}

// A per-job endpoint must NOT be cached across different jobs — that would
// hand every posting the first one's description.
{
  let hits = 0;
  const fakeFetch = async (url) => {
    hits++;
    return { ok: true, status: 200, json: async () => ({ content: url.endsWith('/1') ? 'First ad' : 'Second ad' }) };
  };
  const cache = new Map();
  const a = await fetchJd('https://job-boards.greenhouse.io/acme/jobs/1', { fetchImpl: fakeFetch, cache });
  const b = await fetchJd('https://job-boards.greenhouse.io/acme/jobs/2', { fetchImpl: fakeFetch, cache });
  eq('fetchJd: two greenhouse jobs each cost their own request', hits, 2);
  eq('fetchJd: greenhouse job 2 gets its own ad, not job 1 cached', b.text, 'Second ad');
  eq('fetchJd: greenhouse job 1 is unaffected', a.text, 'First ad');
}

// Concurrency, not just repetition. The drain runs several fetches at once, so
// two jobs at the same ashby org can be in flight BEFORE either has populated
// the cache. Caching the resolved value only helps the second caller if it
// arrives late; caching the PROMISE is what makes the dedup hold under
// concurrency (the same lesson capexempt-screen.mjs learned with its model load).
{
  let hits = 0;
  const board = { jobs: [{ id: 'a1', jobUrl: 'https://jobs.ashbyhq.com/openai/a1', descriptionPlain: 'Job A' },
                         { id: 'b2', jobUrl: 'https://jobs.ashbyhq.com/openai/b2', descriptionPlain: 'Job B' }] };
  const fakeFetch = async () => {
    hits++;
    await new Promise((r) => setTimeout(r, 10)); // a real request is not instant
    return { ok: true, status: 200, json: async () => board };
  };
  const cache = new Map();
  const [a, b] = await Promise.all([
    fetchJd('https://jobs.ashbyhq.com/openai/a1', { fetchImpl: fakeFetch, cache }),
    fetchJd('https://jobs.ashbyhq.com/openai/b2', { fetchImpl: fakeFetch, cache }),
  ]);
  eq('fetchJd: two CONCURRENT jobs at one ashby org still cost one board request', hits, 1);
  eq('fetchJd: concurrent job A gets its own text', a.text, 'Job A');
  eq('fetchJd: concurrent job B gets its own text', b.text, 'Job B');
}

// ── Codex review 2026-07-21: confirmed defects, each pinned before the fix ──

// The worst of them. Decoding entities BEFORE stripping tags turned an ESCAPED
// comparison operator into a real one, and the tag stripper then ate everything
// up to the next '>'. "<p>Latency &lt; 100ms and availability &gt; 99.9%</p>"
// came out as "Latency 99.9%" — requirement text deleted with no error. It is
// exactly the silent-loss failure this pipeline refuses.
//
// Greenhouse needs decode-before-strip (its whole ad is escaped). Every other
// ATS needs strip-before-decode. Applying both passes to every input was the bug.
eq('htmlToText: keeps an escaped < in real HTML instead of eating the text after it',
  htmlToText('<p>Latency &lt; 100ms and availability &gt; 99.9%</p>'),
  'Latency < 100ms and availability > 99.9%');
eq('htmlToText: keeps generic type syntax (Map<String, Integer>)',
  htmlToText('<li>Use Map&lt;String, Integer&gt; daily</li>'),
  'Use Map<String, Integer> daily');
eq('htmlToText: still unescapes a fully escaped greenhouse ad (the other case)',
  htmlToText('&lt;ul&gt;&lt;li&gt;Own the pipeline&lt;/li&gt;&lt;/ul&gt;'),
  'Own the pipeline');
eq('htmlToText: an escaped ad containing a double-escaped operator keeps the operator',
  htmlToText('&lt;p&gt;Uptime &amp;gt; 99%&lt;/p&gt;'), 'Uptime > 99%');

// A 404 on a SHARED endpoint is not evidence about one posting — it is one
// failed board request. Treating it as terminal 'gone' would park every row at
// that org permanently on a single bad response or a slug-mapping mistake.
{
  const fakeFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const shared = await fetchJd('https://jobs.ashbyhq.com/acme/uuid-1', { fetchImpl: fakeFetch, cache: new Map() });
  eq('fetchJd: a 404 on a shared board endpoint is retryable, NOT terminal gone', shared.reason, 'http_404');
  const perJob = await fetchJd('https://job-boards.greenhouse.io/acme/jobs/1', { fetchImpl: fakeFetch });
  eq('fetchJd: a 404 on a per-job endpoint is still terminal gone', perJob.reason, 'gone');
}

// The caller re-raises 429/503 so the adaptive limiter can halve its window.
// With a cached board error, every waiter at that org would re-raise the SAME
// one response, halving the window repeatedly and tripping the circuit breaker
// against jobs that never made a request. The caller needs to know the answer
// came from cache so it punishes the limiter once, not N times.
{
  let hits = 0;
  const fakeFetch = async () => { hits++; return { ok: false, status: 429, json: async () => ({}) }; };
  const cache = new Map();
  const a = await fetchJd('https://jobs.ashbyhq.com/acme/j1', { fetchImpl: fakeFetch, cache });
  const b = await fetchJd('https://jobs.ashbyhq.com/acme/j2', { fetchImpl: fakeFetch, cache });
  eq('fetchJd: a throttled board is requested once, not once per waiting job', hits, 1);
  eq('fetchJd: the caller that actually made the request is not marked fromCache', a.fromCache, false);
  eq('fetchJd: every later waiter IS marked fromCache (so the limiter is punished once)', b.fromCache, true);
}

{
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ content: 'An ad' }) });
  const r = await fetchJd('https://job-boards.greenhouse.io/acme/jobs/1', { fetchImpl: fakeFetch });
  eq('fetchJd: a fresh per-job success is never fromCache', r.fromCache, false);
}

// Workday locale segments are display-only. /en-US/ was handled; /en/ and
// /zh-Hans/ were not, and an unmatched locale makes the whole posting
// unsupported rather than merely mis-parsed.
eq('detailApiFor: workday /en-US/ locale segment is dropped from the CXS path',
  detailApiFor('https://acme.wd1.myworkdayjobs.com/en-US/careers/job/NY/Analyst_R1')?.api,
  'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/careers/job/NY/Analyst_R1');
eq('detailApiFor: a bare /en/ locale segment is dropped too',
  detailApiFor('https://acme.wd1.myworkdayjobs.com/en/careers/job/NY/Analyst_R1')?.api,
  'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/careers/job/NY/Analyst_R1');
eq('detailApiFor: a script-subtag locale (zh-Hans) is dropped too',
  detailApiFor('https://acme.wd1.myworkdayjobs.com/zh-Hans/careers/job/NY/Analyst_R1')?.api,
  'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/careers/job/NY/Analyst_R1');
// The site slug is NOT a locale, and mistaking it for one would drop the real
// site and build a broken endpoint.
eq('detailApiFor: a non-locale first segment is treated as the site, not a locale',
  detailApiFor('https://acme.wd1.myworkdayjobs.com/careers/job/NY/Analyst_R1')?.api,
  'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/careers/job/NY/Analyst_R1');

// ── ashby board-absence is a CLOSURE, not an empty ad ───────────────────────
//
// Ashby has no per-job endpoint, so the 404/410 rule that proves a workday or
// greenhouse posting is dead can never fire for it. A removed ashby posting
// simply stops appearing in the org board, which the extractor collapsed into
// '' — indistinguishable from a job that IS listed but carries no description.
// That single collapse hid every ashby closure from the score-time refresh.
//
// Measured on the live queue 2026-07-24: 11 of 94 ashby rows in the scoreable
// pool (11.7%) were already unlisted, versus ~2% dead among the per-job ATSs.
// Ashby is the highest-death-rate source in the pool and was the one source
// whose deaths were invisible.
//
// The discriminator is board MEMBERSHIP, which liveness-api.mjs has always used
// (classifyAshbyBoard → 'expired' on ashby_api_unlisted). A failed board
// REQUEST still stays retryable — one bad response must never mark every job at
// that org dead.
{
  const board = (jobs) => async () => ({ ok: true, status: 200, json: async () => ({ jobs }) });

  const listed = await fetchJd('https://jobs.ashbyhq.com/acme/j1', {
    fetchImpl: board([{ id: 'j1', jobUrl: 'https://jobs.ashbyhq.com/acme/j1', descriptionPlain: 'Real ad' }]),
  });
  eq('fetchJd: an ashby job still on the board is ok', listed.ok, true);

  const removed = await fetchJd('https://jobs.ashbyhq.com/acme/j1', {
    fetchImpl: board([{ id: 'other', jobUrl: 'https://jobs.ashbyhq.com/acme/other', descriptionPlain: 'A different job' }]),
  });
  eq('fetchJd: an ashby job MISSING from a healthy board is gone, not empty', removed.reason, 'gone');
  eq('fetchJd: a removed ashby job is not ok', removed.ok, false);

  // Listed but description-less is genuinely ambiguous and must stay 'empty':
  // the posting exists, so closing it would be a false positive.
  const blank = await fetchJd('https://jobs.ashbyhq.com/acme/j1', {
    fetchImpl: board([{ id: 'j1', jobUrl: 'https://jobs.ashbyhq.com/acme/j1', descriptionPlain: '' }]),
  });
  eq('fetchJd: an ashby job that IS listed but has no text stays empty (never closed)', blank.reason, 'empty');

  // A board whose shape changed (no jobs array) proves nothing about any one
  // posting — degrade to empty rather than declaring the whole org dead.
  const weird = await fetchJd('https://jobs.ashbyhq.com/acme/j1', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) }),
  });
  eq('fetchJd: an unrecognised ashby board shape is not a closure', weird.reason, 'empty');

  // And a failed board REQUEST is still retryable, exactly as before.
  const down = await fetchJd('https://jobs.ashbyhq.com/acme/j1', {
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  eq('fetchJd: a 404 on the SHARED board is still retryable, never a per-job closure', down.reason, 'http_404');
}

// ── lever publishes the salary in its own field ─────────────────────────────
// Lever splits an ad across descriptionPlain, lists[], additionalPlain AND
// salaryDescriptionPlain. Dropping the last one made the scorer report "no
// advertised salary figure" for roles that publish a real band, which feeds
// straight into the report's advertised_comp field.
{
  const got = extractJdText('lever', {
    descriptionPlain: 'About the role',
    lists: [{ text: 'Requirements', content: '<li>Python</li>' }],
    salaryDescriptionPlain: 'The base salary range for this role is $182,000 - $257,000.',
    additionalPlain: 'We are an equal opportunity employer.',
  });
  has('extractJdText: lever keeps the advertised salary band', got, '$182,000 - $257,000');
  has('extractJdText: lever still keeps the intro', got, 'About the role');
  has('extractJdText: lever still keeps the closing section', got, 'equal opportunity');
}
eq('extractJdText: lever with no salary field is unchanged',
  extractJdText('lever', { descriptionPlain: 'Just an intro' }), 'Just an intro');

// ── greenhouse job-board URLs that carry the id as ?gh_jid= ────────────────
// 64 llm_ready rows (Stripe, Coinbase, Databricks, Airbnb, Waymo, Block...)
// host their board on their OWN domain and pass the posting id as a gh_jid
// query param. detailApiFor only matched greenhouse.io hosts, so every one of
// them was written off 'unsupported' — a permanent, silent loss of exactly the
// employers most worth applying to.
eq('detailApiFor: a gh_jid URL maps to the greenhouse API when the board token is known',
  detailApiFor('https://boards.greenhouse.io/embed/job_app?for=acme&gh_jid=12345', { boardToken: 'acme' })?.api,
  'https://boards-api.greenhouse.io/v1/boards/acme/jobs/12345');
eq('detailApiFor: a gh_jid URL on the company\'s own domain still resolves',
  detailApiFor('https://stripe.com/jobs/listing/analyst?gh_jid=6789', { boardToken: 'stripe' })?.api,
  'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/6789');
eq('detailApiFor: gh_jid without a board token stays unsupported (never guessed)',
  detailApiFor('https://stripe.com/jobs/listing/analyst?gh_jid=6789'), null);
eq('detailApiFor: a gh_jid URL is a per-job endpoint, so a 404 there IS a closure',
  detailApiFor('https://stripe.com/jobs/x?gh_jid=1', { boardToken: 'stripe' })?.shared, false);
eq('detailApiFor: a non-numeric gh_jid is not trusted',
  detailApiFor('https://stripe.com/jobs/x?gh_jid=../../etc', { boardToken: 'stripe' }), null);

// ── a guessed board token must never be able to declare a job dead ─────────
// The gh_jid fallback derives the greenhouse board token from the queue's
// company slug, which is right about 5 times in 6 (probed live 2026-07-24:
// stripe, abnormalsecurity, fieldwire, place, clerkie all 200; astspacemobile
// 404s under its slug). A 404 from a WRONG token is proof the token was wrong,
// not proof the posting closed — and the per-job 404 rule would otherwise
// permanently kill a live job over a naming mismatch. Derived endpoints are
// therefore marked, and their 404 degrades to unsupported instead of 'gone'.
eq('detailApiFor: a gh_jid endpoint is marked derived (its token was inferred)',
  detailApiFor('https://stripe.com/jobs/x?gh_jid=1', { boardToken: 'stripe' })?.derived, true);
eq('detailApiFor: a real greenhouse.io URL is NOT derived (its token is in the URL)',
  detailApiFor('https://job-boards.greenhouse.io/acme/jobs/1')?.derived, false);
{
  const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const derived = await fetchJd('https://ast-science.com/careers?gh_jid=4716870005', {
    fetchImpl: notFound, boardToken: 'astspacemobile',
  });
  eq('fetchJd: a 404 from a GUESSED board token is unsupported, never a closure', derived.reason, 'unsupported');

  const real = await fetchJd('https://job-boards.greenhouse.io/acme/jobs/1', { fetchImpl: notFound });
  eq('fetchJd: a 404 from a URL-supplied token IS still a closure', real.reason, 'gone');
}
{
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ content: '<p>Real ad</p>' }) });
  const r = await fetchJd('https://stripe.com/jobs/search?gh_jid=8075469', { fetchImpl: ok, boardToken: 'stripe' });
  eq('fetchJd: a gh_jid posting with a good token fetches its ad', r.ok, true);
  has('fetchJd: the recovered ad carries real text', r.text, 'Real ad');
}
