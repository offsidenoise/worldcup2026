#!/usr/bin/env node
/*
 * fetch-kalshi.js — run by the hourly GitHub Action.
 *
 * Fetches Kalshi's World Cup "advances" markets (series KXWCADVANCE) directly
 * (GitHub's runners are server-side, so there is no CORS/proxy problem here),
 * normalizes each matchup to [homePct, awayPct] summing to 100, and writes
 * kalshi-odds.json next to the app. The app then reads that file same-origin.
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

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Parse one market into { key, pair } or null.
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

  const yb = parseFloat(m.yes_bid_dollars), ya = parseFloat(m.yes_ask_dollars);
  let yes = (Number.isFinite(yb) && Number.isFinite(ya) && (yb > 0 || ya > 0))
            ? (yb + ya) / 2 : parseFloat(m.last_price_dollars);
  if (!Number.isFinite(yes) || yes <= 0) return null;

  let yesPct = clamp(Math.round(yes * 100), 3, 97);
  const sub = (m.yes_sub_title || '').toLowerCase();
  const yesForName = sub.includes(nameA.toLowerCase()) ? nameA
                   : sub.includes(nameB.toLowerCase()) ? nameB : nameA;
  const homePct = (yesForName === nameA) ? yesPct : (100 - yesPct);
  return { key: nameA + '_' + nameB, pair: [homePct, 100 - homePct] };
}

async function main() {
  const url = `${BASE}/markets?series_ticker=${SERIES}&limit=200`;
  console.log('Fetching', url);
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('Kalshi HTTP ' + r.status);
  const j = await r.json();
  const markets = (j && j.markets) || [];
  console.log('Got', markets.length, 'markets');

  const odds = {};
  let n = 0;
  for (const m of markets) {
    const p = parseMarket(m);
    if (p) { odds[p.key] = p.pair; n++; }
  }
  console.log('Parsed', n, 'matchups');

  // Safety: if we parsed nothing, do NOT overwrite a good file with an empty one.
  if (n === 0) {
    console.error('No matchups parsed — leaving existing kalshi-odds.json untouched.');
    process.exit(1);
  }

  const out = { updated: new Date().toISOString(), odds };
  fs.writeFileSync('kalshi-odds.json', JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote kalshi-odds.json with', n, 'matchups');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
