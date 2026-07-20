#!/usr/bin/env node
/**
 * scan-direct-sites.mjs — pull jobs straight from a company's own careers page,
 * for employers that run no supported ATS.
 *
 * WHY: scan.mjs and scan-ats-full.mjs both require a recognized ATS provider
 * (Greenhouse / Lever / Ashby / Workday / etc). Plenty of employers — hospitals,
 * universities, utilities, municipal systems, regional manufacturers, exactly
 * the E-Verify-enrolled kind that hires in thin markets — publish jobs on their
 * own site with no supported API. Those are invisible to the current scanners.
 *
 * HOW: schema.org JobPosting structured data. Google requires it for a posting
 * to appear in Google Jobs, so most employers that want their roles found
 * publish it, whatever their stack. Three extraction strategies, cheapest first:
 *
 *   1. JSON-LD  <script type="application/ld+json"> containing JobPosting
 *      (also unwraps @graph containers and ItemList collection pages)
 *   2. Microdata itemtype="...schema.org/JobPosting" blocks
 *   3. Next.js / Nuxt hydration payloads (__NEXT_DATA__, __NUXT__) scanned for
 *      objects that look like postings
 *
 * Zero LLM tokens: pure HTTP + parsing. No Playwright, so a fully client-side
 * careers page with no structured data will legitimately return nothing — that
 * is reported honestly rather than silently passing.
 *
 * Usage:
 *   node scan-direct-sites.mjs --url https://careers.example.org/jobs --dry-run
 *   node scan-direct-sites.mjs --file data/direct-sites.txt --since 30
 *   CAREER_OPS_PORTALS=portals-harsh.yml node scan-direct-sites.mjs --file ... --dry-run
 *
 * data/direct-sites.txt: one URL per line, blank lines and # comments ignored.
 */
import { readFileSync, existsSync } from 'fs';
import yaml from 'js-yaml';
import { buildTitleFilter, buildLocationFilter, loadSeenUrls, appendToPipeline, appendToScanHistory } from './scan.mjs';
import { AdaptiveLimiter, limitHttpCtx } from './adaptive-limiter.mjs';
import { makeHttpCtx, BROWSER_LIKE_USER_AGENT } from './providers/_http.mjs';

const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = (n) => args.includes(n);

const cfg = existsSync(PORTALS_PATH) ? yaml.load(readFileSync(PORTALS_PATH, 'utf8')) : {};
const titleOk = buildTitleFilter(cfg.title_filter);
const locationOk = buildLocationFilter(cfg.location_filter);

// ── extraction ──────────────────────────────────────────────────────

const isPosting = (o) => o && typeof o === 'object'
  && (o['@type'] === 'JobPosting' || (Array.isArray(o['@type']) && o['@type'].includes('JobPosting')));

/** Recursively collect JobPosting objects from arbitrary nested JSON. */
function harvest(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) { for (const v of node) harvest(v, out, depth + 1); return; }
  if (isPosting(node)) { out.push(node); return; }
  // ItemList collection pages wrap postings in itemListElement[].item
  for (const v of Object.values(node)) harvest(v, out, depth + 1);
}

function fromJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let raw = m[1].trim().replace(/^﻿/, '');
    // Some CMSes emit JSON-LD wrapped in CDATA or with trailing semicolons.
    raw = raw.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').replace(/;\s*$/, '');
    try { harvest(JSON.parse(raw), out); } catch { /* malformed block: skip */ }
  }
  return out;
}

function fromHydration(html) {
  const out = [];
  for (const re of [/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
                    /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i]) {
    const m = re.exec(html);
    if (!m) continue;
    try { harvest(JSON.parse(m[1]), out); } catch { /* not JSON: skip */ }
  }
  return out;
}

function fromMicrodata(html, pageUrl) {
  const out = [];
  // The window was 6000 chars, which silently DROPPED any posting whose block
  // ran longer (job descriptions routinely do) — extraction then looked
  // complete while missing rows. 40k covers a verbose posting; the lazy
  // quantifier plus the lookahead still stops at the next block.
  const re = /itemtype=["']https?:\/\/schema\.org\/JobPosting["']([\s\S]{0,40000}?)(?=itemtype=["']https?:\/\/schema\.org\/JobPosting|$)/gi;
  let m;
  while ((m = re.exec(html))) {
    const block = m[1];
    const prop = (name) => {
      // `[^>]*?` must be LAZY: a greedy version consumes the whole tag
      // including ` content="..."`, then satisfies the alternation on the
      // closing `>` and returns the (empty) text node instead of the
      // attribute — which silently made every microdata posting undated.
      const p = new RegExp(`itemprop=["']${name}["'][^>]*?(?:content=["']([^"']*)["']|>([^<]{0,300}))`, 'i').exec(block);
      return p ? (p[1] || p[2] || '').trim() : '';
    };
    const title = prop('title');
    if (!title) continue;
    const href = /<a[^>]+href=["']([^"']+)["']/i.exec(block);
    out.push({
      '@type': 'JobPosting', title,
      datePosted: prop('datePosted'),
      jobLocation: prop('addressLocality') || prop('jobLocation'),
      hiringOrganization: prop('hiringOrganization'),
      url: href ? new URL(href[1], pageUrl).href : pageUrl,
    });
  }
  return out;
}

// ── normalization ───────────────────────────────────────────────────

function locationOf(p) {
  const parts = [];
  const walk = (l) => {
    if (!l) return;
    if (typeof l === 'string') { parts.push(l); return; }
    if (Array.isArray(l)) { l.forEach(walk); return; }
    const a = l.address || l;
    if (typeof a === 'string') { parts.push(a); return; }
    for (const k of ['addressLocality', 'addressRegion', 'addressCountry']) {
      const v = a?.[k];
      if (typeof v === 'string') parts.push(v);
      else if (v?.name) parts.push(v.name);
    }
  };
  walk(p.jobLocation);
  if (p.applicantLocationRequirements) walk(p.applicantLocationRequirements);
  if (p.jobLocationType === 'TELECOMMUTE') parts.push('Remote');
  return [...new Set(parts.filter(Boolean))].join(', ');
}

function normalize(p, pageUrl, company) {
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  if (!title) return null;
  let url = p.url || p.sameAs || pageUrl;
  try { url = new URL(url, pageUrl).href; } catch { url = pageUrl; }
  const posted = p.datePosted ? Date.parse(p.datePosted) : NaN;
  const org = p.hiringOrganization?.name || (typeof p.hiringOrganization === 'string' ? p.hiringOrganization : '') || company;
  return { title, url, location: locationOf(p), postedAt: Number.isNaN(posted) ? null : posted, company: org };
}

// ── main ────────────────────────────────────────────────────────────

(async () => {
  const urls = [];
  if (opt('--url', null)) urls.push(opt('--url'));
  const file = opt('--file', null);
  if (file && existsSync(file)) {
    urls.push(...readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
  }
  if (!urls.length) {
    console.error('usage: node scan-direct-sites.mjs --url <careers-url> | --file <list.txt> [--since 30] [--dry-run]');
    process.exit(1);
  }

  const sinceDays = Number(opt('--since', '30'));
  const cutoff = Date.now() - sinceDays * 86_400_000;
  const dry = flag('--dry-run');
  const keepUndated = flag('--include-undated');

  const limiter = new AdaptiveLimiter({ max: Number(opt('--concurrency', '4')) });
  const ctx = limitHttpCtx(makeHttpCtx(), limiter);

  console.log(`Direct careers-page scan — ${urls.length} site(s), last ${sinceDays}d${dry ? ' (DRY RUN)' : ''}`);
  console.log(`Filters from ${PORTALS_PATH}\n`);

  // loadSeenUrls() returns { seen, recheckEligible } — unwrap it. Taking the
  // object directly makes seen.has() a TypeError, and only on non-dry runs,
  // so a dry run cannot surface the break.
  const seen = dry ? new Set() : loadSeenUrls().seen;
  const out = [];
  const noStructured = [];
  const pageSeen = new Set();
  let fetchErrors = 0, undated = 0, stale = 0, filtered = 0, inspected = 0, badUrls = 0;

  for (const pageUrl of urls) {
    let host;
    try { host = new URL(pageUrl).hostname; } catch { badUrls++; console.error(`  skip (bad URL): ${pageUrl}`); continue; }
    const company = host.replace(/^(www|jobs|careers|apply)\./, '').split('.')[0];

    let html;
    try {
      html = await ctx.fetchText(pageUrl, { headers: { 'user-agent': BROWSER_LIKE_USER_AGENT }, timeoutMs: 20_000 });
    } catch (err) {
      fetchErrors++;
      console.error(`  ✗ ${host}: ${err.message}`);
      continue;
    }

    inspected++;
    const raw = [...fromJsonLd(html), ...fromMicrodata(html, pageUrl), ...fromHydration(html)];
    if (!raw.length) { noStructured.push(host); continue; }

    let kept = 0;
    for (const p of raw) {
      const job = normalize(p, pageUrl, company);
      if (!job) continue;
      // Dedup on url+title, not url alone. A posting with no per-job URL falls
      // back to the collection page URL, so URL-only dedup would collapse every
      // such posting on a listing page into the first one and silently drop the
      // rest. `seen` (the cross-run history) is still checked by URL, which is
      // correct there — it holds real per-job URLs.
      const key = `${job.url}::${job.title.toLowerCase()}`;
      if (seen.has(job.url) || pageSeen.has(key)) continue;
      pageSeen.add(key);
      if (job.postedAt === null) {
        undated++;
        if (!keepUndated) continue;
      } else if (job.postedAt < cutoff) { stale++; continue; }
      if (!titleOk(job.title) || !locationOk(job.location)) { filtered++; continue; }
      seen.add(job.url);
      out.push({ ...job, source: 'direct-site' });
      kept++;
    }
    console.log(`  ✓ ${host}: ${raw.length} postings found, ${kept} match`);
  }

  out.sort((a, b) => (b.postedAt || 0) - (a.postedAt || 0));

  console.log(`\n${'━'.repeat(45)}`);
  // Count what was actually INSPECTED, not what was listed — a headline that
  // counts unreachable sites as "scanned" overstates coverage.
  console.log(`Sites inspected:   ${inspected}/${urls.length}`);
  console.log(`Fetch errors:      ${fetchErrors}${badUrls ? `, bad URLs: ${badUrls}` : ''}`);
  console.log(`Filtered out:      ${filtered} (title/location)`);
  console.log(`Stale dropped:     ${stale}`);
  console.log(`Undated ${keepUndated ? 'kept' : 'dropped'}:    ${undated}${keepUndated ? '' : ' (use --include-undated)'}`);
  console.log(`New matches:       ${out.length}`);

  // Honest reporting: a site with no structured data isn't "no jobs" — it's
  // "this tool can't see it", which needs a local_parser or Playwright instead.
  if (noStructured.length) {
    console.log(`\n⚠️  No structured job data (needs a parser or Playwright): ${noStructured.join(', ')}`);
  }

  if (out.length) {
    console.log('\nMatches:');
    for (const o of out) {
      console.log(`  + ${o.postedAt ? new Date(o.postedAt).toISOString().slice(0, 10) : 'undated'} | ${o.company} | ${o.title} | ${o.location || 'N/A'}\n    ${o.url}`);
    }
  }

  if (!dry && out.length) {
    appendToPipeline(out);
    appendToScanHistory(out);
    console.log(`\n✅ ${out.length} added to data/pipeline.md`);
  } else if (dry) {
    console.log('\n(dry run — nothing written)');
  }
})();
