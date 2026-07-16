#!/usr/bin/env node
/*
 * fetch-kalshi.js — run by the hourly GitHub Action.
 *
 * Fetches Kalshi's World Cup "advances" markets (series KXWCADVANCE) directly
 * (GitHub's runners are server-side, so there is no CORS/proxy problem here),
 * normalizes each matchup to [homePct, awayPct] summing to 100, and writes
 * kalshi-odds.json next to the app. The app then reads that file same-origin.
 *
 * ALSO fetches the World Cup WINNER / champion market (a different Kalshi
 * series) so the Final matchup gets live odds too — the "advances" series has
 * no market for the Final (there is nothing to advance TO), which is why the
 * Final previously fell through to the app's model with no [K] tag.
 *
 * Output shape:
 *   {
 *     "updated": "2026-07-02T20:00:00Z",
 *     "odds": { "USA_Belgium": [54,46], "Portugal_Croatia": [72,28], ... }
 *   }
 *
 * No dependencies — uses Node 18+ global fetch.
 */

const fs = require('fs');

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const SERIES = 'KXWCADVANCE';

// Candidate series tickers for the "who wins the 2026 World Cup" market. Kalshi
// has used a few naming conventions; we try each and use the first that returns
// markets. If none match, run `node fetch-kalshi.js --discover` (see bottom) to
// print the real ticker, then add it here.
const WINNER_SERIES_CANDIDATES = [
  'KXWORLDCUP',
  'KXWORLDCUPWINNER',
  'KXWCWINNER',
  'KXWC',
];

// Kalshi 3-letter code -> canonical app team name. Keep in sync with the app's
// KALSHI.codeToName. Includes ISO and common sports variants (e.g. por/prt).
const CODE_TO_NAME = {
  usa:'USA', bel:'Belgium', bih:'Bosnia', sen:'Senegal', esp:'Spain',
  aut:'Austria', aus:'Australia', egy:'Egypt', bra:'Brazil', nor:'Norway',
  eng:'England', mex:'Mexico', can:'Canada', mar:'Morocco', par:'Paraguay',
  fra:'France', arg:'Argentina', cpv:'Cabo Verde', col:'Colombia', gha:'Ghana',
  prt:'Portugal', por:'Portugal', hrv:'Croatia', cro:'Croatia',
  sui:'Switzerland', swi:'Switzerland', alg:'Algeria', dza:'Algeria',
  ned:'Netherlands', nld:'Netherlands', jpn:'Japan', ger:'Germany', deu:'Germany',
  swe:'Sweden', civ:'Ivory Coast', rsa:'South Africa', ecu:'Ecuador',
};

// Reverse map: canonical name (lowercased) -> code, for winner-market parsing
// where we match by team NAME in the market title rather than a ticker code.
const NAME_TO_CANON = {};
for (const code in CODE_TO_NAME) {
  NAME_TO_CANON[CODE_TO_NAME[code].toLowerCase()] = CODE_TO_NAME[code];
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// yes price (0..1) from a market: mid of bid/ask, else last price. null if none.
function yesPriceOf(m) {
  const yb = parseFloat(m.yes_bid_dollars), ya = parseFloat(m.yes_ask_dollars);
  let yes = (Number.isFinite(yb) && Number.isFinite(ya) && (yb > 0 || ya > 0))
            ? (yb + ya) / 2 : parseFloat(m.last_price_dollars);
  return (Number.isFinite(yes) && yes > 0) ? yes : null;
}

// Which canonical team name does this market's Yes side refer to? Looks in the
// yes_sub_title / title / yes_sub_title fields for a known team name.
function teamInText() {
  for (let i = 0; i < arguments.length; i++) {
    const txt = String(arguments[i] || '').toLowerCase();
    for (const nameLc in NAME_TO_CANON) {
      // word-ish boundary so "iran" doesn't match inside another token
      if (new RegExp('(^|[^a-z])' + nameLc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(txt)) {
        return NAME_TO_CANON[nameLc];
      }
    }
  }
  return null;
}

// ── Advances-market parser (unchanged) ──────────────────────────────────────
function parseMarket(m) {
  if (!m) return null;
  const src = String(m.event_ticker || m.ticker || '').toLowerCase();
  let codes = null;
  for (const seg of src.split('-')) {
    const mm = seg.match(/^26[a-z]{3}\d{2}([a-z]{6})$/);   // 26jul06usabel
    if (mm) { codes = mm[1]; break; }
  }
  if (!codes) return null;
  const cA = codes.slice(0, 3), cB = codes.slice(3, 6);
  const nameA = CODE_TO_NAME[cA], nameB = CODE_TO_NAME[cB];
  if (!nameA || !nameB) { console.warn('  unmapped codes:', cA, cB, 'from', src); return null; }

  const yes = yesPriceOf(m);
  if (yes == null) return null;

  let yesPct = clamp(Math.round(yes * 100), 3, 97);
  const sub = (m.yes_sub_title || '').toLowerCase();
  const yesForName = sub.includes(nameA.toLowerCase()) ? nameA
                   : sub.includes(nameB.toLowerCase()) ? nameB : nameA;
  const homePct = (yesForName === nameA) ? yesPct : (100 - yesPct);
  return { key: nameA + '_' + nameB, pair: [homePct, 100 - homePct] };
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('Kalshi HTTP ' + r.status + ' for ' + url);
  return r.json();
}

// Fetch all markets for a series (paginating through cursors, just in case).
async function fetchSeriesMarkets(series, statusFilter) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    let url = `${BASE}/markets?series_ticker=${series}&limit=200`;
    if (statusFilter) url += `&status=${statusFilter}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const j = await getJSON(url);
    const ms = (j && j.markets) || [];
    out.push(...ms);
    cursor = (j && j.cursor) || '';
    if (!cursor || !ms.length) break;
  }
  return out;
}

// ── Winner-market pass ──────────────────────────────────────────────────────
// The champion market is an OUTRIGHT: one "Yes" market per team ("Will <team>
// win the 2026 World Cup?"). With only two teams left in the Final, the two
// finalists' Yes prices already sum to ~100, so we can treat them as a
// head-to-head pair. We take the two HIGHEST-priced team markets as the
// finalists — everyone else has been eliminated and sits near 0.
async function buildFinalPair() {
  let markets = [];
  let usedSeries = '';
  for (const s of WINNER_SERIES_CANDIDATES) {
    try {
      const ms = await fetchSeriesMarkets(s, 'open');
      if (ms.length) { markets = ms; usedSeries = s; break; }
    } catch (e) {
      console.warn('  winner series', s, 'failed:', e.message);
    }
  }
  if (!markets.length) {
    console.warn('No winner-series markets found (tried: ' +
      WINNER_SERIES_CANDIDATES.join(', ') + '). Skipping Final odds.');
    return null;
  }
  console.log('Winner market series:', usedSeries, '(' + markets.length + ' markets)');

  // Collect (team, yesPct) for every market we can attribute to a team.
  const teamProbs = [];
  for (const m of markets) {
    const yes = yesPriceOf(m);
    if (yes == null) continue;
    const team = teamInText(m.yes_sub_title, m.title, m.subtitle, m.ticker);
    if (!team) continue;
    teamProbs.push({ team, pct: clamp(Math.round(yes * 100), 1, 99) });
  }
  if (teamProbs.length < 2) {
    console.warn('Winner market: fewer than 2 attributable teams; skipping.');
    return null;
  }

  // Two highest = the finalists.
  teamProbs.sort((a, b) => b.pct - a.pct);
  const [A, B] = teamProbs;
  if (A.team === B.team) { console.warn('Winner market: top two same team; skipping.'); return null; }

  // Renormalize the two legs to sum to 100 (they're ~equal already but not exact).
  const total = A.pct + B.pct;
  const aPct = clamp(Math.round(A.pct / total * 100), 3, 97);
  const pair = [aPct, 100 - aPct];
  const key = A.team + '_' + B.team;
  console.log('Final pair:', key, '=', JSON.stringify(pair),
              `(raw ${A.team} ${A.pct} / ${B.team} ${B.pct})`);
  return { key, pair };
}

async function main() {
  // 1) Advances markets (existing behavior).
  const advUrl = `${BASE}/markets?series_ticker=${SERIES}&limit=200`;
  console.log('Fetching', advUrl);
  const j = await getJSON(advUrl);
  const markets = (j && j.markets) || [];
  console.log('Got', markets.length, 'advances markets');

  const odds = {};
  let n = 0;
  for (const m of markets) {
    const p = parseMarket(m);
    if (p) { odds[p.key] = p.pair; n++; }
  }
  console.log('Parsed', n, 'advances matchups');

  // 2) Final / champion market (new). Non-fatal: if it fails we still write
  //    the advances odds.
  try {
    const fin = await buildFinalPair();
    if (fin) { odds[fin.key] = fin.pair; n++; }
  } catch (e) {
    console.warn('Final-market pass failed (non-fatal):', e.message);
  }

  // Safety: if we parsed nothing at all, do NOT overwrite a good file.
  if (n === 0) {
    console.error('No matchups parsed — leaving existing kalshi-odds.json untouched.');
    process.exit(1);
  }

  const out = { updated: new Date().toISOString(), odds };
  fs.writeFileSync('kalshi-odds.json', JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote kalshi-odds.json with', n, 'matchups');
}

// ── Discovery helper ────────────────────────────────────────────────────────
// `node fetch-kalshi.js --discover` lists series whose title mentions the World
// Cup, so you can read off the real winner-series ticker if the candidates above
// don't match. Uses the /series endpoint.
async function discover() {
  try {
    const j = await getJSON(`${BASE}/series?limit=1000`);
    const list = (j && (j.series || j.series_list)) || [];
    const hits = list.filter(s => /world\s*cup/i.test(
      (s.title || '') + ' ' + (s.ticker || '') + ' ' + (s.category || '')));
    if (!hits.length) { console.log('No World Cup series found via /series.'); return; }
    console.log('World Cup series:');
    for (const s of hits) console.log('  ', s.ticker, '—', s.title || '(no title)');
  } catch (e) {
    console.error('discover failed:', e.message);
  }
}

if (process.argv.includes('--discover')) {
  discover();
} else {
  main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
}
