#!/usr/bin/env node
/**
 * scan-workday-targeted.mjs — keyword-targeted Workday scanning that breaks the
 * 2000-posting visibility ceiling.
 *
 * THE PROBLEM (measured empirically 2026-07-20, not assumed):
 * Workday's CXS API caps an unfaceted board query at total=2000. Worse, offsets
 * past 2000 are silently ignored — the API returns page 1 again:
 *
 *     offset     0  total=2000  first: /job/Netherlands---Zwolle/Operator-Weighing
 *     offset  2000  total=2000  first: /job/Netherlands---Zwolle/Operator-Weighing
 *     offset  4000  total=2000  first: /job/Netherlands---Zwolle/Operator-Weighing
 *     offset  9000  total=2000  first: /job/Netherlands---Zwolle/Operator-Weighing
 *     (80 postings fetched across 4 offsets -> only 20 unique)
 *
 * So at every large employer — Abbott, ABB, Accenture, Advance Auto, Ascension —
 * scan-ats-full.mjs walks 100 pages, reports "2000 of 2000", and stops. Those
 * are exactly the employers most likely to be E-Verify enrolled and to hire
 * analysts. Everything past the first 2000 postings is INVISIBLE, and the first
 * 2000 are ordered by Workday's own relevance, which skews international
 * (Abbott's #1 is a weighing operator in Zwolle, Netherlands).
 *
 * THE FIX: don't ask for the whole board. Ask one query per title keyword.
 * `searchText` narrows the result set below the ceiling, so it becomes fully
 * reachable:
 *
 *     searchText=""                  total=2000   (capped, unreachable tail)
 *     searchText="analyst"           total=607    (fully reachable)
 *     searchText="data analyst"      total=381
 *     searchText="financial analyst" total=220
 *
 * This is strictly better on three axes at once: it sees postings that were
 * previously unreachable, it fetches far FEWER pages (220 relevant beats 2000
 * irrelevant), and fewer requests means less rate-limit pressure.
 *
 * Usage:
 *   node scan-workday-targeted.mjs --tenants abbott,abb --dry-run
 *   node scan-workday-targeted.mjs --limit 100 --since 30 --dry-run
 *   CAREER_OPS_PORTALS=portals-harsh.yml node scan-workday-targeted.mjs --limit 200
 *
 * Filters (title/location) come from the same portals.yml the other scanners
 * use, so a preset like portals-harsh.yml applies unchanged.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import yaml from 'js-yaml';
import { buildTitleFilter, buildLocationFilter, loadSeenUrls, appendToPipeline, appendToScanHistory } from './scan.mjs';
import { AdaptiveLimiter, limitHttpCtx } from './adaptive-limiter.mjs';
import { makeHttpCtx } from './providers/_http.mjs';

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const DATASET = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/workday_companies.json';
const CACHE_DIR = 'data/cache/ats-companies';
const CACHE_FILE = `${CACHE_DIR}/workday_companies.json`;
const CACHE_TTL_MS = 24 * 3600 * 1000;
const PAGE = 20;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;

// Workday's hard ceiling. A narrowed query returning >= this is still truncated
// and must be reported, never silently accepted as complete.
const WORKDAY_CAP = 2000;

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(n);

const cfg = existsSync(PORTALS_PATH) ? yaml.load(readFileSync(PORTALS_PATH, 'utf8')) : {};
const titleOk = buildTitleFilter(cfg.title_filter);
const locationOk = buildLocationFilter(cfg.location_filter);

// One query per positive title keyword. Multi-word keywords are what make this
// work — "analyst" alone still returns 607 at a big employer, while
// "financial analyst" returns 220. Keywords are deduped and lowercased.
const KEYWORDS = [...new Set((cfg.title_filter?.positive || [])
  .filter((k) => typeof k === 'string' && k.trim().length >= 3)
  .map((k) => k.trim().toLowerCase()))];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadTenants(ctx) {
  if (existsSync(CACHE_FILE) && Date.now() - statSync(CACHE_FILE).mtimeMs < CACHE_TTL_MS) {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  }
  const list = await ctx.fetchJson(DATASET);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(list));
  return list;
}

// Dataset lines are "tenant|instance|site" triples. Validate every component
// before interpolating it into a URL (same guard as scan-ats-full.mjs).
function parseTenant(line) {
  const [tenant, instance, site] = String(line).split('|');
  if (![tenant, instance, site].every((p) => p && SLUG_RE.test(p))) return null;
  const host = `${tenant}.${instance}.myworkdayjobs.com`;
  return { tenant, host, api: `https://${host}/wday/cxs/${tenant}/${site}/jobs` };
}

/**
 * Workday exposes only relative strings on the list payload ("Posted Today",
 * "Posted 5 Days Ago", "Posted 30+ Days Ago") — never an absolute date.
 *
 * The "+" matters and was originally mishandled: "Posted 30+ Days Ago" is a
 * LOWER BOUND, not a measurement. The posting is at least 30 days old and could
 * be 300. Treating it as exactly 30 made it land precisely on a `--since 30`
 * cutoff and slip through as fresh. Returns {at, exact} so the caller can treat
 * a bound differently from a real age.
 */
function postedAtFrom(posted) {
  if (!posted) return null;
  const s = String(posted).toLowerCase();
  const mk = (days, exact) => ({ at: Date.now() - days * 86_400_000, exact, days });
  if (s.includes('today') || s.includes('just posted')) return mk(0, true);
  if (s.includes('yesterday')) return mk(1, true);
  const m = /(\d+)(\+?)\s*day/.exec(s);
  if (m) return mk(Number(m[1]), m[2] !== '+');
  const mo = /(\d+)(\+?)\s*month/.exec(s);
  if (mo) return mk(Number(mo[1]) * 30, mo[2] !== '+');
  return null;
}

async function queryKeyword(ctx, t, keyword, cutoff, sinceDays, out, seen, stats) {
  let offset = 0;
  let total = null;
  let lastSig = null;
  for (;;) {
    let json;
    try {
      json = await ctx.fetchJson(t.api, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset, searchText: keyword }),
      });
    } catch (err) {
      if (err.circuitOpen) throw err;
      stats.errors++;
      return;
    }
    if (total === null) {
      total = json.total ?? 0;
      if (total >= WORKDAY_CAP) {
        stats.stillCapped.push(`${t.tenant}/"${keyword}" (${total})`);
      }
    }
    const posts = json.jobPostings || [];
    if (!posts.length) return;

    // Loop guard: Workday ignores offsets past its cap and re-serves page 1.
    // Detect that directly rather than trusting `total`, so a duplicated page
    // is never mistaken for successful pagination.
    const sig = posts.map((p) => p.externalPath).join('|');
    if (sig === lastSig) { stats.repeatedPage++; return; }
    lastSig = sig;

    for (const p of posts) {
      const url = `https://${t.host}${p.externalPath}`;
      if (seen.has(url)) continue;
      const posted = postedAtFrom(p.postedOn);
      // Undated postings are dropped: this scan targets FRESH roles, and an
      // undated flood would swamp the pipeline. Counted, never silent.
      if (posted === null) { stats.undated++; continue; }
      // An inexact age ("30+ days") is a LOWER BOUND — the posting is at least
      // that old and could be far older. Compare day counts, not timestamps:
      // `cutoff` is computed once at startup while `posted.at` is computed per
      // posting, so a "30+ days" item on a --since 30 run lands a few seconds
      // AFTER the cutoff and slips through on a timestamp comparison.
      if (!posted.exact && posted.days >= sinceDays) { stats.boundedStale++; continue; }
      if (posted.at < cutoff) continue;
      if (!titleOk(p.title)) continue;
      if (!locationOk(p.locationsText || '')) continue;
      seen.add(url);
      out.push({ company: t.tenant, title: p.title, location: p.locationsText || '', url, postedAt: posted.at, exactDate: posted.exact, keyword });
    }

    // NOTE: there is deliberately NO early exit on a page of stale postings.
    // Workday orders `searchText` results by RELEVANCE, not recency — verified
    // live 2026-07-20 on americanfidelity/"analyst", where position 3 was
    // "30+ Days Ago" and position 14 was "11 Days Ago". Bailing out on a stale
    // page would silently skip fresh jobs deeper in the result set. Keyword
    // queries are small (15-600 results), so full pagination is affordable.
    offset += PAGE;
    if (offset >= Math.min(total, WORKDAY_CAP)) return;
  }
}

(async () => {
  const sinceDays = Number(opt('--since', '30'));
  const limit = Number(opt('--limit', '50'));
  const cutoff = Date.now() - sinceDays * 86_400_000;
  const dry = flag('--dry-run');

  if (!KEYWORDS.length) {
    console.error(`No title_filter.positive keywords in ${PORTALS_PATH} — nothing to search.`);
    process.exit(1);
  }

  // Workday throttles hard; the limiter halves the window on every 429 and
  // circuit-breaks a family that keeps refusing.
  const limiter = new AdaptiveLimiter({ max: Number(opt('--concurrency', '4')) });
  const ctx = limitHttpCtx(makeHttpCtx(), limiter);

  const explicit = opt('--tenants', null);
  let tenants;
  if (explicit) {
    const raw = await loadTenants(ctx);
    const want = new Set(explicit.split(',').map((s) => s.trim()));
    tenants = raw.map(parseTenant).filter((t) => t && want.has(t.tenant));
  } else {
    tenants = (await loadTenants(ctx)).map(parseTenant).filter(Boolean).slice(0, limit);
  }

  console.log(`Workday targeted scan — ${tenants.length} tenants x ${KEYWORDS.length} keywords, last ${sinceDays}d${dry ? ' (DRY RUN)' : ''}`);
  console.log(`Filters from ${PORTALS_PATH}\n`);

  // loadSeenUrls() returns { seen, recheckEligible } — unwrap it. Taking the
  // object directly makes seen.has() a TypeError, and only on non-dry runs,
  // so a dry run cannot surface the break.
  const seen = dry ? new Set() : loadSeenUrls().seen;
  const out = [];
  const stats = { errors: 0, undated: 0, boundedStale: 0, repeatedPage: 0, stillCapped: [], tenantsDone: 0, skipped: [] };
  const totalQueries = tenants.length * KEYWORDS.length;
  let queriesDone = 0;

  for (const t of tenants) {
    for (const kw of KEYWORDS) {
      try {
        await queryKeyword(ctx, t, kw, cutoff, sinceDays, out, seen, stats);
        queriesDone++;
      } catch (err) {
        // A skipped query is a COVERAGE HOLE, not a non-event. Record it so the
        // summary can never imply the scan was complete when it wasn't.
        stats.skipped.push(`${t.tenant}/"${kw}"`);
        if (err.circuitOpen) { console.error(`⚠️  circuit open on ${t.tenant} — cooling down`); await sleep(5000); }
      }
    }
    if (++stats.tenantsDone % 10 === 0) console.log(`  ${stats.tenantsDone}/${tenants.length} tenants, ${out.length} matches`);
  }

  out.sort((a, b) => b.postedAt - a.postedAt);

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Tenants:          ${tenants.length}`);
  // Report completed queries against attempted, never just the plan — a run
  // that skipped queries must not read as full coverage.
  console.log(`Queries:          ${queriesDone}/${totalQueries} completed${stats.skipped.length ? ` (${stats.skipped.length} SKIPPED — coverage incomplete)` : ''}`);
  console.log(`Undated dropped:  ${stats.undated}`);
  console.log(`Stale ("N+ days" past cutoff): ${stats.boundedStale}`);
  console.log(`Fetch errors:     ${stats.errors}`);
  console.log(`New matches:      ${out.length}`);

  if (stats.skipped.length) {
    console.log(`\n⚠️  ${stats.skipped.length} quer${stats.skipped.length === 1 ? 'y' : 'ies'} skipped (rate limiting) — these employers/keywords were NOT searched:`);
    for (const s of stats.skipped.slice(0, 12)) console.log(`     ${s}`);
    if (stats.skipped.length > 12) console.log(`     ...and ${stats.skipped.length - 12} more`);
    console.log(`     Re-run to cover them.`);
  }
  if (stats.repeatedPage) {
    console.log(`\n⚠️  ${stats.repeatedPage} quer${stats.repeatedPage === 1 ? 'y' : 'ies'} hit Workday's offset ceiling (page repeated) — tail unreachable.`);
  }

  // Honesty about coverage: a narrowed query that STILL hits 2000 has an
  // unreachable tail, and the user must know the scan was incomplete.
  if (stats.stillCapped.length) {
    console.log(`\n⚠️  Still capped at ${WORKDAY_CAP} (tail unreachable — narrow the keyword):`);
    for (const c of stats.stillCapped.slice(0, 10)) console.log(`     ${c}`);
    if (stats.stillCapped.length > 10) console.log(`     ...and ${stats.stillCapped.length - 10} more`);
  }

  const rate = limiter.report().filter((r) => r.throttled || r.circuitTrips);
  if (rate.length) {
    console.log('\nRate limiting (adaptive):');
    for (const r of rate) console.log(`  ${r.family}: ${r.throttled}/${r.requests} throttled (${r.throttlePct}%), window →${r.finalWindow}, waited ${r.waitedSec}s${r.circuitTrips ? `, circuit tripped ${r.circuitTrips}x` : ''}`);
  }

  if (out.length) {
    console.log('\nMatches:');
    for (const o of out) {
      console.log(`  + ${new Date(o.postedAt).toISOString().slice(0, 10)} | ${o.company} | ${o.title} | ${o.location}\n    ${o.url}`);
    }
  }

  if (!dry && out.length) {
    // appendToScanHistory(offers, date) needs the scan date as arg 2 — omitting
    // it writes an empty first_seen column, which shouldDedupScanHistoryRow then
    // reads as an unparseable date and pins the row as permanently-seen.
    const date = new Date().toISOString().slice(0, 10);
    const tagged = out.map((o) => ({ ...o, source: 'workday-targeted' }));
    appendToPipeline(tagged);
    appendToScanHistory(tagged, date);
    console.log(`\n✅ ${out.length} added to data/pipeline.md`);
  } else if (dry) {
    console.log('\n(dry run — nothing written)');
  }
})();
