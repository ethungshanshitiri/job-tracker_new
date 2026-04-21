#!/usr/bin/env node
/**
 * scrape.js  —  Faculty Job Tracker  —  v2
 *
 * Strategy
 * --------
 * For each institute, start at the homepage and crawl up to MAX_HOPS deep,
 * staying strictly within the institute's own domain. At every hop, links are
 * scored by how recruitment-relevant their anchor text and href text look, and
 * only the most promising ones are followed. When a page is fetched it is read
 * in full and run through a multi-step filter:
 *
 *   1. Link scoring  — should we even queue this link?
 *   2. Inclusion gate — does the full page text contain at least one rank term
 *      AND at least one target-department term AND at least one inclusion phrase?
 *   3. Exclusion check — is the page dominated by excluded categories with no
 *      rank signal?
 *   4. Closed signal — does the page say the posting is expired/closed?
 *   5. Sentence verification — read every sentence. Collect only sentences that
 *      contain a rank term. Then check that at least one sentence on the page
 *      also contains a department term. Both must appear on the page, though
 *      not necessarily in the same sentence (per your confirmed preference).
 *   6. Deadline and mode extraction.
 *   7. Confidence scoring.
 *
 * Run:  node scripts/scrape.js
 * Deps: none (pure Node.js built-ins only)
 */

import fs   from "fs";
import path from "path";
import http  from "http";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, "..");
const SOURCES   = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "sources.json"), "utf8"));
const OUT_PATH  = path.join(ROOT, "data", "jobs.json");

// ─── Config from sources.json ────────────────────────────────────────────────

const CFG             = SOURCES.crawler;
const MAX_HOPS        = CFG.max_hops;               // 3
const DELAY_MS        = CFG.request_delay_ms;       // 1200
const TIMEOUT_MS      = CFG.timeout_ms;             // 15000
const MAX_BODY_BYTES  = CFG.max_body_bytes;          // 2 MB
const MAX_PAGES       = CFG.max_pages_per_institute; // 40

const REC_PATTERNS  = CFG.recruitment_link_patterns.map(s => s.toLowerCase());
const SKIP_PATTERNS = CFG.skip_link_patterns.map(s => s.toLowerCase());

const RANKS      = SOURCES.target_ranks;                     // lowercase already
const DEPT_MAP   = buildDeptMap(SOURCES.target_departments); // phrase → familyKey
const INCL_KW    = SOURCES.inclusion_keywords.map(s => s.toLowerCase());
const EXCL_KW    = SOURCES.exclusion_keywords.map(s => s.toLowerCase());
const CLOSED_SIG = SOURCES.closed_signals.map(s => s.toLowerCase());

const DEPT_DISPLAY = {
  electrical_engineering:   "Electrical Engineering",
  electronics_communication:"Electronics & Communication Engineering",
  computer_science:         "Computer Science & Engineering",
};

function buildDeptMap(deptObj) {
  const map = {};
  for (const [family, synonyms] of Object.entries(deptObj)) {
    for (const syn of synonyms) map[syn.toLowerCase()] = family;
  }
  return map;
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; FacultyJobTracker/2.0; educational index bot)",
  "Accept":     "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.7",
  "Connection": "keep-alive",
};

async function fetchPage(url, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const req   = proto.get(url, { headers: HEADERS, timeout: TIMEOUT_MS }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        if (redirectsLeft === 0) { reject(new Error("Too many redirects")); return; }
        const next = new URL(res.headers.location, url).href;
        res.resume();
        resolve(fetchPage(next, redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const ct = (res.headers["content-type"] || "").toLowerCase();
      if (!ct.includes("html") && !ct.includes("text")) {
        res.resume();
        reject(new Error(`Non-HTML content-type: ${ct}`));
        return;
      }
      res.setEncoding("utf8");
      let body  = "";
      let bytes = 0;
      res.on("data", chunk => {
        bytes += Buffer.byteLength(chunk, "utf8");
        body  += chunk;
        if (bytes >= MAX_BODY_BYTES) res.destroy();
      });
      res.on("end",   () => resolve(body));
      res.on("close", () => resolve(body));  // destroyed early → still return what we have
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
  });
}

// ─── HTML utilities ───────────────────────────────────────────────────────────

/** Decode HTML entities and strip tags, returning readable plain text. */
function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi,   " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|tr|td|th|h[1-6]|section|article|header|footer)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi,  "&")
    .replace(/&lt;/gi,   "<")
    .replace(/&gt;/gi,   ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Extract all href links from raw HTML. Returns array of { href, anchorText }.
 * Only keeps absolute or root-relative links; resolves relative ones against base.
 */
function extractLinks(html, baseUrl) {
  const links = [];
  const re    = /<a[^>]+href=["']([^"'#\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw    = m[1].trim();
    const anchor = toText(m[2]).trim().toLowerCase();
    try {
      const abs = new URL(raw, baseUrl).href;
      // Strip fragment
      const clean = abs.split("#")[0];
      links.push({ href: clean, anchorText: anchor });
    } catch { /* malformed URL — skip */ }
  }
  return links;
}

// ─── Link scoring ─────────────────────────────────────────────────────────────

/**
 * Returns a priority score for a link based on how recruitment-relevant it looks.
 * Higher is better. Returns -1 to suppress the link entirely.
 */
function scoreLinkRelevance(href, anchorText, domain) {
  const hLow = href.toLowerCase();
  const aLow = anchorText.toLowerCase();

  // Must stay on the same domain
  if (!hLow.includes(domain)) return -1;

  // Hard skip patterns — if any match, drop immediately
  for (const pat of SKIP_PATTERNS) {
    if (hLow.includes(pat) || aLow.includes(pat)) return -1;
  }

  let score = 0;

  // Bonus for recruitment patterns in href or anchor text
  for (const pat of REC_PATTERNS) {
    if (hLow.includes(pat)) score += 3;
    if (aLow.includes(pat)) score += 2;
  }

  // Strong bonus for explicit rank terms in anchor text
  for (const rank of RANKS) {
    if (aLow.includes(rank)) score += 5;
  }

  // Mild penalty for very long query strings (dynamic pages less likely to be useful)
  if ((href.match(/[&?]/g) || []).length > 4) score -= 2;

  return score;
}

// ─── Text analysis ────────────────────────────────────────────────────────────

/** Split text into sentences on common terminal punctuation or newlines. */
function toSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|[\n\r]+/)
    .map(s => s.trim())
    .filter(s => s.length > 10);
}

function textContains(text, phrase) {
  return text.toLowerCase().includes(phrase);
}

function anyContains(text, phrases) {
  const low = text.toLowerCase();
  return phrases.some(p => low.includes(p));
}

/** Returns true if rank terms appear on the page but only alongside excluded
 *  categories, with no genuine faculty opening signal. */
function isExclusionDominated(text) {
  const low = text.toLowerCase();
  const hasRank = RANKS.some(r => low.includes(r));
  if (!hasRank) return true;  // no rank term at all → suppress

  const exclCount = EXCL_KW.filter(k => low.includes(k)).length;
  const inclCount = INCL_KW.filter(k => low.includes(k)).length;
  // If exclusion terms are heavy and inclusion terms are absent, suppress
  if (exclCount >= 3 && inclCount === 0) return true;
  return false;
}

function isClosedPage(text) {
  const low = text.toLowerCase();
  return CLOSED_SIG.some(sig => low.includes(sig));
}

// ─── Department detection ─────────────────────────────────────────────────────

function detectDepartments(text) {
  const low   = text.toLowerCase();
  const found = new Set();
  for (const [phrase, family] of Object.entries(DEPT_MAP)) {
    if (low.includes(phrase)) found.add(family);
  }
  return [...found];
}

// ─── Rank detection ───────────────────────────────────────────────────────────

function detectRanks(text) {
  const low   = text.toLowerCase();
  const found = [];
  if (low.includes("assistant professor")) found.push("Assistant Professor");
  if (low.includes("associate professor")) found.push("Associate Professor");
  return found;
}

// ─── Deadline parsing ─────────────────────────────────────────────────────────

const MONTH_IDX = {
  january:0, february:1, march:2, april:3, may:4, june:5,
  july:6, august:7, september:8, october:9, november:10, december:11,
  jan:0, feb:1, mar:2, apr:3, jun:5, jul:6, aug:7,
  sep:8, oct:9, nov:10, dec:11,
};

function parseDeadline(text) {
  const now  = Date.now();
  const candidates = [];

  const addDate = (y, m, d) => {
    const dt = new Date(+y, +m, +d);
    if (!isNaN(dt) && dt.getTime() > now) candidates.push(dt);
  };

  // DD/MM/YYYY or DD-MM-YYYY
  for (const [, d, mo, y] of text.matchAll(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\b/g)) {
    addDate(y, +mo - 1, d);   // DD/MM/YYYY
    addDate(y, +d  - 1, mo);  // MM/DD/YYYY fallback
  }
  // YYYY-MM-DD
  for (const [, y, mo, d] of text.matchAll(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g)) {
    addDate(y, +mo - 1, d);
  }
  // DD Month YYYY  or  DD Mon YYYY
  for (const [, d, mon, y] of text.matchAll(
    /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(20\d{2})\b/gi
  )) {
    const mi = MONTH_IDX[mon.toLowerCase()];
    if (mi !== undefined) addDate(y, mi, d);
  }
  // Month DD, YYYY
  for (const [, mon, d, y] of text.matchAll(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})[,\s]+(20\d{2})\b/gi
  )) {
    const mi = MONTH_IDX[mon.toLowerCase()];
    if (mi !== undefined) addDate(y, mi, d);
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a - b);
  return candidates[0].toISOString().split("T")[0];
}

function isRolling(text) {
  const low = text.toLowerCase();
  return (
    low.includes("rolling basis") ||
    low.includes("open until filled") ||
    low.includes("until the position is filled") ||
    low.includes("applications are reviewed on a rolling")
  );
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

function scoreConfidence({ hasRank, deptCount, hasDeadline, rolling, inclCount }) {
  let s = 0;
  if (hasRank)      s += 3;
  if (deptCount > 0) s += 2;
  if (hasDeadline || rolling) s += 2;
  if (inclCount >= 2) s += 1;
  if (s >= 7) return "high";
  if (s >= 4) return "medium";
  return "low";
}

// ─── Per-institute crawler ────────────────────────────────────────────────────

/**
 * BFS crawl from homepage up to MAX_HOPS.
 *
 * Queue entries: { url, depth }
 * On each page:
 *   - Extract all links, score them, add promising ones to the queue
 *   - Run analysis on the page itself
 *
 * Returns the best matching page (highest score) or null.
 */
async function crawlInstitute(institute) {
  const { id, name, homepage, domain } = institute;
  const checkedAt = new Date().toISOString();

  const visited = new Set();
  // { url, depth, score } — scored during link extraction so BFS is priority-aware
  const queue   = [{ url: homepage, depth: 0, linkScore: 100 }];
  let   pagesVisited = 0;

  // Accumulate all confirmed findings across pages
  const allRanks  = new Set();
  const allDepts  = new Set();
  let   bestUrl   = null;
  let   bestDeadline = null;
  let   rolling   = false;
  let   inclCount = 0;
  let   anyConfirmed = false;

  while (queue.length > 0 && pagesVisited < MAX_PAGES) {
    // Sort queue by score descending so best candidates are visited first
    queue.sort((a, b) => b.linkScore - a.linkScore);
    const { url, depth } = queue.shift();

    if (visited.has(url)) continue;
    visited.add(url);
    pagesVisited++;

    // Polite delay
    await sleep(DELAY_MS);

    let html;
    try {
      html = await fetchPage(url);
    } catch (err) {
      console.log(`    [fetch-err] ${url} — ${err.message}`);
      continue;
    }

    const text = toText(html);

    // ── Gate 1: quick inclusion check on this page ──
    const pageHasRank  = RANKS.some(r => textContains(text, r));
    const pageHasIncl  = anyContains(text, INCL_KW);
    const pageHasDept  = detectDepartments(text).length > 0;

    // Only proceed with full analysis if page has at least rank+inclusion or rank+dept
    const worthAnalysing = pageHasRank && (pageHasIncl || pageHasDept);

    if (worthAnalysing) {
      // ── Gate 2: exclusion dominance ──
      if (!isExclusionDominated(text)) {
        // ── Gate 3: closed signal ──
        if (!isClosedPage(text)) {
          const ranksFound = detectRanks(text);
          const deptsFound = detectDepartments(text);

          if (ranksFound.length > 0 && deptsFound.length > 0) {
            // ── Confirmed match on this page ──
            anyConfirmed = true;
            ranksFound.forEach(r => allRanks.add(r));
            deptsFound.forEach(d => allDepts.add(d));

            const pd = parseDeadline(text);
            const pr = isRolling(text);
            const ic = INCL_KW.filter(k => textContains(text, k)).length;

            // Keep the page URL that is most specific (deepest / most keyword-rich)
            if (!bestUrl || ic > inclCount) {
              bestUrl      = url;
              inclCount    = ic;
            }
            if (pd && !bestDeadline) bestDeadline = pd;
            if (pr) rolling = true;

            console.log(`    [match] ${url.replace(homepage, "")||"/"} — ranks: ${ranksFound.join(",")} depts: ${deptsFound.join(",")}`);
          }
        } else {
          console.log(`    [closed] ${url.replace(homepage, "")||"/"}`);
        }
      }
    }

    // ── Extract and enqueue child links (if not at max depth) ──
    if (depth < MAX_HOPS) {
      const links = extractLinks(html, url);
      for (const { href, anchorText } of links) {
        if (visited.has(href)) continue;
        const s = scoreLinkRelevance(href, anchorText, domain);
        if (s < 0) continue;        // suppressed
        if (s === 0 && depth >= 2)  continue;  // at hop 3 only follow positive-score links
        queue.push({ url: href, depth: depth + 1, linkScore: s });
      }
    }
  }

  if (!anyConfirmed) return null;

  const ranksArr = [...allRanks];
  const deptsArr = [...allDepts];
  const confidence = scoreConfidence({
    hasRank:     ranksArr.length > 0,
    deptCount:   deptsArr.length,
    hasDeadline: !!bestDeadline,
    rolling,
    inclCount,
  });

  // Build flat job entries: one per rank × department
  const jobs = [];
  for (const rank of ranksArr) {
    for (const deptFamily of deptsArr) {
      jobs.push({
        rank,
        department:       DEPT_DISPLAY[deptFamily] || deptFamily,
        departmentFamily: deptFamily,
        deadline:         bestDeadline || null,
        rolling,
        applicationMode:  rolling    ? "Rolling basis"
                          : bestDeadline ? "Fixed deadline"
                          : "See official page",
        confidence,
        notes: confidence === "low" ? "Low confidence — verify manually on official page" : null,
      });
    }
  }

  return {
    id,
    name,
    type: institute.instType,
    url:  bestUrl || homepage,
    status:    "active",
    checkedAt,
    pagesScanned: pagesVisited,
    jobs,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log(" Faculty Job Tracker — Scraper v2");
  console.log(` Started: ${new Date().toISOString()}`);
  console.log(`═══════════════════════════════════════════════\n`);

  const allInstitutes = [
    ...SOURCES.iits.map(i => ({ ...i, instType: "IIT" })),
    ...SOURCES.nits.map(i => ({ ...i, instType: "NIT" })),
  ];

  // Deduplicate by id (safety net)
  const seen    = new Set();
  const unique  = allInstitutes.filter(i => {
    if (seen.has(i.id)) return false;
    seen.add(i.id);
    return true;
  });

  console.log(`Institutes to crawl: ${unique.length}\n`);

  const results = [];

  for (const institute of unique) {
    console.log(`\n→ ${institute.name}  (${institute.homepage})`);
    let result;
    try {
      result = await crawlInstitute(institute);
    } catch (err) {
      console.warn(`  [FATAL] ${institute.name}: ${err.message}`);
      result = null;
    }

    if (result && result.jobs.length > 0) {
      console.log(`  ✓ ${result.jobs.length} job(s) confirmed | confidence: ${result.jobs[0]?.confidence} | pages scanned: ${result.pagesScanned}`);
      results.push(result);
    } else {
      console.log(`  — No confirmed openings found`);
    }
  }

  const output = {
    generatedAt:  new Date().toISOString(),
    totalActive:  results.length,
    scraper:      "v2 — homepage crawl, 3-hop depth",
    results,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\n${"═".repeat(47)}`);
  console.log(` Done. ${results.length} institute(s) with confirmed openings.`);
  console.log(` Output → ${OUT_PATH}`);
  console.log(`${"═".repeat(47)}\n`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
