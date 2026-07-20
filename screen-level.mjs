#!/usr/bin/env node
/**
 * screen-level.mjs — zero-token pre-screen for the experience bar.
 *
 * Every rejection in this tracker has turned on one line of JD text:
 *   - Anthropic DE (2.7) and Boomi (3.4): "5+ years"
 *   - Palantir FDSE (3.3): "Must be graduating in December 2026 or Spring 2027"
 *   - Target FP&A (3.8): "3+ years AS A Data Analyst" (no degree path)
 *   - Target Sr DA  (4.4): "3+ years ... OR masters level education"  <-- the escape hatch
 *
 * Titles lie in both directions. "Sr" hid a req the candidate qualifies for;
 * "New Grad" hid a cohort gate he fails. Read the body, not the title.
 *
 * Prints the years-of-experience sentences and any degree-alternative clause so
 * a human can decide before an LLM evaluation is spent.
 *
 * Usage: node screen-level.mjs <url> [<url>...]
 */
import { resolveAtsApi, isAtsPosting } from './liveness-api.mjs';

const CONCURRENCY = 5;

// "5+ years", "3-5 years", "minimum of 2 years", "at least 4 years"
const YOE = /(?:\b(?:at least|minimum of|a minimum of)\s+)?\b\d+\s*(?:\+|-\s*\d+|\s+or\s+more)?\s*years?\b[^.;•]{0,120}/gi;

// The escape hatch that made Target #017 viable.
const DEGREE_ALT = /\b(?:or|and\/or)\b[^.;•]{0,40}\b(?:master'?s?|graduate degree|advanced degree|MS|M\.S\.|PhD|equivalent (?:experience|practical experience))\b[^.;•]{0,60}/gi;

const COHORT = /\b(?:must be graduating|graduating (?:in|by)|class of\s*20\d{2}|expected graduation|currently enrolled)\b[^.;•]{0,80}/gi;

function toText(raw) {
  let s = raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\"/g, '"');
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
    s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
    s = s.replace(/<\/(?:li|p|div|h[1-6])>|<br\s*\/?>/gi, ' • ').replace(/<[^>]+>/g, ' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

// Same board-scoping discipline as screen-sponsorship.mjs: Ashby returns the
// WHOLE board, so regexing the raw payload matches other people's postings.
function scoped(ats, raw, url) {
  let j;
  try { j = JSON.parse(raw); } catch { return toText(raw); }
  if (ats === 'greenhouse') return toText([j.title, j.content].filter(Boolean).join(' • '));
  if (ats === 'lever') return toText([j.text, j.descriptionPlain, ...(j.lists ?? []).map((l) => `${l.text}: ${l.content}`)].filter(Boolean).join(' • '));
  if (ats === 'ashby') {
    const id = url.match(/jobs\.ashbyhq\.com\/[^/?#]+\/([^/?#]+)/i)?.[1];
    const job = (Array.isArray(j.jobs) ? j.jobs : []).find((x) => x?.id === id);
    return job ? toText([job.title, job.descriptionHtml ?? job.descriptionPlain].filter(Boolean).join(' • ')) : null;
  }
  return toText(raw);
}

const uniq = (a) => [...new Set(a.map((s) => s.trim().replace(/\s+/g, ' ')))];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function one(url, attempt = 0) {
  // Own-domain careers pages (coinbase.com, stripe.com, instacart.careers) still
  // carry ?gh_jid=NNN and are backed by a Greenhouse board. Rebuild the API URL
  // from the host's second-level domain rather than giving up on them.
  const gh = url.match(/[?&]gh_jid=(\d+)/);
  if (gh && !isAtsPosting(url)) {
    const slug = url.match(/https?:\/\/(?:www\.)?([a-z0-9-]+)\./i)?.[1];
    if (slug) {
      try {
        const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${gh[1]}`, { headers: { accept: 'application/json' } });
        if (res.ok) {
          const j = JSON.parse(await res.text());
          if (j?.title) {
            const text = toText([j.title, j.content].filter(Boolean).join(' • '));
            return { url, title: j.title, yoe: uniq(text.match(YOE) ?? []).slice(0, 3), degreeAlt: uniq(text.match(DEGREE_ALT) ?? []).slice(0, 2), cohort: uniq(text.match(COHORT) ?? []).slice(0, 1) };
          }
        }
      } catch { /* fall through to the normal path */ }
    }
  }

  if (!isAtsPosting(url)) return { url, err: 'not an ATS posting' };
  const r = resolveAtsApi(url);
  if (!r) return { url, err: 'cannot resolve API' };
  let raw;
  try {
    const res = await fetch(r.apiUrl, { headers: { accept: 'application/json' } });
    if (!res.ok) return { url, err: `HTTP ${res.status}` };
    raw = await res.text();
  } catch (e) { return { url, err: e.message }; }

  const text = scoped(r.ats, raw, url);
  if (!text) {
    // Ashby serves the whole board (~2MB). Under concurrency it can answer 200
    // with an empty `jobs` array, which reads as "posting not in payload" — a
    // live req wrongly reported missing. Back off and retry once, serially.
    if (r.ats === 'ashby' && attempt === 0) {
      await sleep(1200);
      return one(url, 1);
    }
    return { url, err: 'posting not in payload' };
  }
  return {
    url,
    title: (text.match(/^(.{0,70}?)\s*•/) ?? [])[1] ?? '',
    yoe: uniq(text.match(YOE) ?? []).slice(0, 3),
    degreeAlt: uniq(text.match(DEGREE_ALT) ?? []).slice(0, 2),
    cohort: uniq(text.match(COHORT) ?? []).slice(0, 1),
  };
}

const urls = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!urls.length) { console.error('usage: node screen-level.mjs <url>...'); process.exit(1); }

const out = new Array(urls.length);
let i = 0;
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
  while (i < urls.length) { const k = i++; try { out[k] = await one(urls[k]); } catch (e) { out[k] = { url: urls[k], err: e.message }; } }
}));

for (const r of out) {
  console.log('\n' + (r.title || r.url.slice(0, 72)));
  if (r.err) { console.log('   ! ' + r.err); continue; }
  if (r.cohort.length) console.log('   ⛔ COHORT: ' + r.cohort[0].slice(0, 100));
  if (!r.yoe.length) console.log('   ✅ no years-of-experience requirement found');
  for (const y of r.yoe) console.log('   • ' + y.slice(0, 120));
  for (const d of r.degreeAlt) console.log('   🎓 ALT: ' + d.slice(0, 100));
}
