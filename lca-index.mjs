#!/usr/bin/env node
/**
 * lca-index.mjs — one-time compaction of DOL LCA disclosure xlsx files into a
 * greppable TSV index at data/lca/lca-rows.tsv.
 *
 * The quarterly disclosure workbooks are ~100MB each compressed (1-2GB of XML
 * inflated), which makes them unusable as a lookup source. This streams each
 * workbook's sheet XML through zlib without ever materializing it, keeps only
 * the columns that matter for sponsorship intelligence, and dedups filings by
 * CASE_NUMBER (files are processed newest-first; first occurrence wins, so a
 * refiled case keeps its most recent status).
 *
 * No dependencies: xlsx is a zip; entries are raw-deflate streams we can hand
 * to zlib.createInflateRaw. Shared strings fit comfortably in memory (~650k
 * unique strings per workbook); sheet XML never does, so it is scanned as a
 * rolling window cut at </row> boundaries.
 *
 * Usage:
 *   node lca-index.mjs                 # index every xlsx under data/FY____ into data/lca/
 *   node lca-index.mjs --file <path>   # index specific workbook(s)
 *
 * Output: data/lca/lca-rows.tsv (one line per unique case) + stats JSON on stdout.
 */
import { createReadStream, openSync, readSync, closeSync, fstatSync, mkdirSync, createWriteStream, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { createInflateRaw } from 'zlib';
import { StringDecoder } from 'string_decoder';

// ---------------------------------------------------------------- zip reader

function readCentralDirectory(fd, fileSize) {
  // EOCD is within the last 64KB + 22 bytes (comment can pad it).
  const tailLen = Math.min(fileSize, 65558);
  const tail = Buffer.alloc(tailLen);
  readSync(fd, tail, 0, tailLen, fileSize - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found — not a zip/xlsx?');
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff) throw new Error('zip64 archive — not supported');
  const cd = Buffer.alloc(cdSize);
  readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = new Map();
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50) {
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryStream(path, fd, entry) {
  // The local header's extra field length can differ from the central one, so
  // it must be read from the local header itself.
  const local = Buffer.alloc(30);
  readSync(fd, local, 0, 30, entry.localOffset);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header');
  const nameLen = local.readUInt16LE(26);
  const extraLen = local.readUInt16LE(28);
  const start = entry.localOffset + 30 + nameLen + extraLen;
  const raw = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
  if (entry.method === 0) return raw;
  if (entry.method === 8) return raw.pipe(createInflateRaw());
  throw new Error(`unsupported compression method ${entry.method}`);
}

// ---------------------------------------------------------------- xml helpers

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(amp|lt|gt|quot|apos);|&#x([0-9a-fA-F]+);|&#(\d+);/g,
    (_, name, hex, dec) => name ? ENT[name] : String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10)));
}

// Concatenate every <t> run inside an <si> or <is> block (rich text splits
// one logical string across runs).
function textRuns(xml) {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xml))) out += m[1];
  return decodeXml(out);
}

// Stream an entry, invoking onWindow(text) with growing text and letting it
// return the number of chars consumed. Cuts on utf8 boundaries via StringDecoder.
function scanEntry(path, fd, entry, onChunkText) {
  return new Promise((resolvePromise, reject) => {
    const decoder = new StringDecoder('utf8');
    const stream = entryStream(path, fd, entry);
    let pending = '';
    stream.on('data', (chunk) => {
      pending += decoder.write(chunk);
      if (pending.length > 1_000_000) pending = onChunkText(pending);
    });
    stream.on('end', () => { onChunkText(decoder.end() ? pending + decoder.end() : pending, true); resolvePromise(); });
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------- sheet parse

function colToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

function parseRow(rowXml, sst) {
  const cells = [];
  CELL_RE.lastIndex = 0;
  let m;
  while ((m = CELL_RE.exec(rowXml))) {
    const attrs = m[1];
    const body = m[2] ?? '';
    const ref = /r="([A-Z]+)\d+"/.exec(attrs);
    if (!ref) continue;
    const type = /t="([^"]+)"/.exec(attrs)?.[1];
    let value = '';
    if (type === 'inlineStr') {
      value = textRuns(body);
    } else {
      const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      if (type === 's') value = sst[parseInt(v, 10)] ?? '';
      else value = decodeXml(v);
    }
    cells[colToIndex(ref[1])] = value;
  }
  return cells;
}

// ---------------------------------------------------------------- field logic

const WANTED = [
  'CASE_NUMBER', 'CASE_STATUS', 'VISA_CLASS', 'RECEIVED_DATE', 'DECISION_DATE',
  'EMPLOYER_NAME', 'TRADE_NAME_DBA', 'NAICS_CODE',
  'SOC_CODE', 'SOC_TITLE', 'JOB_TITLE', 'FULL_TIME_POSITION',
  'TOTAL_WORKER_POSITIONS', 'NEW_EMPLOYMENT', 'CONTINUED_EMPLOYMENT', 'CHANGE_EMPLOYER',
  'PW_WAGE_LEVEL', 'PREVAILING_WAGE', 'PW_UNIT_OF_PAY',
  'WAGE_RATE_OF_PAY_FROM', 'WAGE_RATE_OF_PAY_TO', 'WAGE_UNIT_OF_PAY',
  'WORKSITE_CITY', 'WORKSITE_STATE',
  'EMPLOYER_POC_JOB_TITLE', 'EMPLOYER_POC_EMAIL',
  'H_1B_DEPENDENT', 'WILLFUL_VIOLATOR',
];

const DATE_FIELDS = new Set(['RECEIVED_DATE', 'DECISION_DATE']);

function excelSerialToISO(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1000 || n > 80000) return v; // already a string date or junk
  const d = new Date(Math.round((n - 25569) * 86400000));
  return d.toISOString().slice(0, 10);
}

const UNIT_FACTOR = { 'Year': 1, 'Hour': 2080, 'Week': 52, 'Bi-Weekly': 26, 'Month': 12, 'Semi-Monthly': 24 };
function annualize(amount, unit) {
  const n = parseFloat(String(amount).replace(/[$,]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return '';
  const f = UNIT_FACTOR[unit] ?? (n < 500 ? 2080 : 1); // fallback: hourly-looking numbers get annualized
  return String(Math.round(n * f));
}

const clean = (s) => (s ?? '').replace(/[\t\n\r]+/g, ' ').trim();

// Output columns (wage fields collapsed to annualized numbers).
const OUT_COLS = [
  'src', 'CASE_NUMBER', 'CASE_STATUS', 'VISA_CLASS', 'RECEIVED_DATE', 'DECISION_DATE',
  'EMPLOYER_NAME', 'TRADE_NAME_DBA', 'NAICS_CODE',
  'SOC_CODE', 'SOC_TITLE', 'JOB_TITLE', 'FULL_TIME_POSITION',
  'TOTAL_WORKER_POSITIONS', 'NEW_EMPLOYMENT', 'CONTINUED_EMPLOYMENT', 'CHANGE_EMPLOYER',
  'PW_WAGE_LEVEL', 'PREVAILING_ANNUAL', 'WAGE_FROM_ANNUAL', 'WAGE_TO_ANNUAL',
  'WORKSITE_CITY', 'WORKSITE_STATE',
  'EMPLOYER_POC_JOB_TITLE', 'EMPLOYER_POC_EMAIL',
  'H_1B_DEPENDENT', 'WILLFUL_VIOLATOR',
];

// ---------------------------------------------------------------- workbook

async function indexWorkbook(path, seen, out, stats) {
  const fd = openSync(path, 'r');
  const src = basename(path).replace(/^LCA_Dis(?:l)?closure_Data_|\.xlsx$/g, '');
  try {
    const fileSize = fstatSync(fd).size;
    const entries = readCentralDirectory(fd, fileSize);

    // Shared strings: whole table in memory (needed for random access).
    const sst = [];
    const sstEntry = entries.get('xl/sharedStrings.xml');
    if (sstEntry) {
      await scanEntry(path, fd, sstEntry, (text, final) => {
        let last = 0;
        const re = /<si>([\s\S]*?)<\/si>/g;
        let m;
        while ((m = re.exec(text))) { sst.push(textRuns(m[1])); last = re.lastIndex; }
        return text.slice(last);
      });
    }

    // Pick the largest worksheet (the data sheet).
    let sheetName = null, sheetEntry = null;
    for (const [name, e] of entries) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name) &&
          (!sheetEntry || e.compressedSize > sheetEntry.compressedSize)) {
        sheetName = name; sheetEntry = e;
      }
    }
    if (!sheetEntry) throw new Error('no worksheet found');

    let headerMap = null;   // column index -> wanted field name
    let rows = 0, kept = 0;
    const ROW_RE = /<row\b[^>]*>([\s\S]*?)<\/row>/g;

    await scanEntry(path, fd, sheetEntry, (text) => {
      let last = 0;
      ROW_RE.lastIndex = 0;
      let m;
      while ((m = ROW_RE.exec(text))) {
        last = ROW_RE.lastIndex;
        const cells = parseRow(m[1], sst);
        if (!headerMap) {
          headerMap = {};
          cells.forEach((h, i) => { if (WANTED.includes(h)) headerMap[i] = h; });
          continue;
        }
        rows++;
        const rec = {};
        for (const [i, field] of Object.entries(headerMap)) {
          let v = clean(cells[i] ?? '');
          if (DATE_FIELDS.has(field) && v) v = excelSerialToISO(v);
          rec[field] = v;
        }
        const cn = rec.CASE_NUMBER;
        if (!cn || seen.has(cn)) { if (cn) stats.dupes++; continue; }
        seen.add(cn);
        kept++;
        const line = [
          src, cn, rec.CASE_STATUS, rec.VISA_CLASS, rec.RECEIVED_DATE, rec.DECISION_DATE,
          rec.EMPLOYER_NAME, rec.TRADE_NAME_DBA, rec.NAICS_CODE,
          rec.SOC_CODE, rec.SOC_TITLE, rec.JOB_TITLE, rec.FULL_TIME_POSITION,
          rec.TOTAL_WORKER_POSITIONS, rec.NEW_EMPLOYMENT, rec.CONTINUED_EMPLOYMENT, rec.CHANGE_EMPLOYER,
          rec.PW_WAGE_LEVEL,
          annualize(rec.PREVAILING_WAGE, rec.PW_UNIT_OF_PAY),
          annualize(rec.WAGE_RATE_OF_PAY_FROM, rec.WAGE_UNIT_OF_PAY),
          annualize(rec.WAGE_RATE_OF_PAY_TO, rec.WAGE_UNIT_OF_PAY),
          rec.WORKSITE_CITY, rec.WORKSITE_STATE,
          rec.EMPLOYER_POC_JOB_TITLE, rec.EMPLOYER_POC_EMAIL,
          rec.H_1B_DEPENDENT, rec.WILLFUL_VIOLATOR,
        ].join('\t');
        out.write(line + '\n');
      }
      return text.slice(last);
    });

    stats.files.push({ file: basename(path), rows, kept });
    process.stderr.write(`  ${basename(path)}: ${rows} rows, ${kept} kept\n`);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
let files = [];
if (args.includes('--file')) {
  files = args.filter((a) => a.endsWith('.xlsx'));
} else {
  for (const dir of readdirSync('data')) {
    if (!/^FY\d{4}$/.test(dir)) continue;
    for (const f of readdirSync(join('data', dir))) {
      if (f.endsWith('.xlsx') && !f.startsWith('~$')) files.push(join('data', dir, f));
    }
  }
}
if (!files.length) {
  console.error('no xlsx files found under data/FY*/');
  process.exit(1);
}
// Newest first: FY desc, then quarter desc. First occurrence of a case wins.
files.sort((a, b) => b.localeCompare(a));

mkdirSync('data/lca', { recursive: true });
const out = createWriteStream('data/lca/lca-rows.tsv');
out.write(OUT_COLS.join('\t') + '\n');

const seen = new Set();
const stats = { files: [], dupes: 0 };
const t0 = Date.now();
for (const f of files) {
  process.stderr.write(`indexing ${f} ...\n`);
  await indexWorkbook(f, seen, out, stats);
}
await new Promise((res) => out.end(res));

const sizeMB = (statSync('data/lca/lca-rows.tsv').size / 1048576).toFixed(1);
console.log(JSON.stringify({
  ok: true,
  uniqueCases: seen.size,
  duplicatesSkipped: stats.dupes,
  outputFile: 'data/lca/lca-rows.tsv',
  outputSizeMB: Number(sizeMB),
  seconds: Math.round((Date.now() - t0) / 1000),
  files: stats.files,
}, null, 2));
