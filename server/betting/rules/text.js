'use strict';
// Deterministic plain-text → rule mapper (for notes / transcripts, e.g. ReelRipper). No LLM, no guessing beyond the
// phrase table below: every recognised phrase is listed in `mapped`, everything else in `unmapped`; the result is a
// DRAFT rule (enabled:false) that the user reviews before turning on.
const SPORTS = { nba: 'basketball_nba', basketball: 'basketball_nba', nfl: 'americanfootball_nfl', football: 'americanfootball_nfl', nhl: 'icehockey_nhl', hockey: 'icehockey_nhl', mlb: 'baseball_mlb', baseball: 'baseball_mlb', ncaaf: 'americanfootball_ncaaf', ncaab: 'basketball_ncaab' };
const UNSUPPORTED = [[/\bparlays?\b|\bsame[- ]game\b|\bsgp\b/i, 'parlays / same-game parlays'], [/\bteasers?\b/i, 'teasers'], [/\b(live|in[- ]game|in[- ]play)\b/i, 'live / in-play betting (scanner watches pre-game lines)'], [/\bplayer props?\b|\bprops?\b/i, 'player prop markets (not fetched; stats conditions only)'], [/\bfutures?\b/i, 'futures'], [/\b(auto[- ]?(bet|place)|place (the )?bets? automatically|bot places)\b/i, 'automatic bet placement (never supported; signals are for manual review)']];
const CLAIMS = /\b(\d{2,3}\s?%\s*(win|hit)|lock|guaranteed|can'?t lose|never lose|units? (up|profit)|record of)\b/i;
const num = (s) => parseFloat(s);

function textToRule(text) {
  const t = String(text || '').slice(0, 8000), lc = t.toLowerCase(), C = [], mapped = [], warnings = [], unmapped = [];
  const add = (type, params, why) => { C.push({ type, params }); mapped.push(`${why} → ${type} ${JSON.stringify(params)}`); };
  if (!t.trim()) return { ok: false, error: 'empty text', mapped, unmapped };
  const sports = [...new Set(Object.entries(SPORTS).filter(([k]) => new RegExp(`\\b${k}\\b`, 'i').test(t)).map(([, v]) => v))];
  if (sports.length) add('sport_in', { sports }, 'sport mention');
  const mk = []; if (/\b(money ?lines?|ml|straight up|to win outright)\b/i.test(t)) mk.push('h2h'); if (/\b(spreads?|ats|against the spread|points?\s+(spread|line))\b/i.test(t) || /\bgetting\s+\+?\d/i.test(t)) mk.push('spreads'); if (/\b(totals?|overs?|unders?|o\/u)\b/i.test(t)) mk.push('totals');
  if (mk.length) add('market_is', { markets: [...new Set(mk)] }, 'market mention');
  const fade = /\b(fade|against|bet the other side|opponents? of)\b/i.test(t);
  // With "fade/against", side words describe the team being FADED, so the selection we signal is the opposite side.
  const FLIP = { home: 'away', away: 'home', favorite: 'underdog', underdog: 'favorite', over: 'under', under: 'over' };
  const side = (v, why) => add('side_is', { side: fade ? FLIP[v] : v }, fade ? `${why} (faded → ${FLIP[v]})` : why);
  if (/\bhome\b/i.test(t) && !/\b(road|away)\b/i.test(t)) side('home', '"home"');
  else if (/\b(road|away)\b/i.test(t) && !/\bhome\b/i.test(t)) side('away', '"road/away"');
  if (/\b(under ?dogs?|dogs?)\b/i.test(t)) side('underdog', '"underdog"'); else if (/\b(favou?rites?|favs?|chalk)\b/i.test(t)) side('favorite', '"favorite"');
  if (/\bovers?\b/i.test(t) && !/\bunders?\b/i.test(t)) side('over', '"over"'); else if (/\bunders?\b/i.test(t) && !/\bovers?\b/i.test(t) && !/\bunder ?dogs?\b/i.test(t)) side('under', '"under"');
  let m;
  if ((m = lc.match(/(?:getting|\+)\s*(\d+(?:\.\d)?)\s*(?:points?|pts)?\s*(?:or more|\+|and up|or better)/))) add('line_between', { min: num(m[1]), max: 40 }, `"+${m[1]} or more"`);
  if ((m = lc.match(/(?:between|from)\s*([+-]\d{3,4})\s*(?:and|to|-)\s*([+-]\d{3,4})/))) add('odds_between', { minAmerican: num(m[1]), maxAmerican: num(m[2]) }, `odds ${m[1]}..${m[2]}`);
  if (/\b(back[- ]to[- ]backs?|b2b|second night|no rest)\b/i.test(t)) add('back_to_back', { team: fade || /\bopponents?\b/i.test(t) ? 'opponent' : 'selection' }, '"back-to-back"');
  if (/\b(rest advantage|more rest|well[- ]rested)\b/i.test(t)) add('rest_advantage', { minDays: (m = lc.match(/(\d)\s*(?:\+\s*)?(?:more )?days? (?:of )?rest/)) ? +m[1] : 1 }, '"rest advantage"');
  if (/\b(star|key|best|top)\s+(player|guy|scorer|qb|quarterback)\b.*\b(out|injured|ruled out|sitting|missing)\b|\b(missing|without)\s+(their|its)\s+(star|best|top|key)/i.test(t)) add('key_player_out', { team: fade || /\b(opponent|other team)\b/i.test(t) ? 'opponent' : /\bbet (on )?(teams|the team) (missing|without)\b/i.test(t) ? 'selection' : 'opponent', minRole: 25, includeQuestionable: /\bquestionable\b/i.test(t) }, '"key player out"');
  if ((m = lc.match(/\b(hot|cold)\b|\bon a (heater|streak)\b|\bslump/))) { const st = (lc.match(/\b(points|rebounds|assists|goals|shots|passing yards|rushing yards|receiving yards)\b/) || [])[1] || 'points'; add('player_form', { team: fade ? 'opponent' : 'selection', stat: st.replace(' ', '_'), minDeltaPct: (m = lc.match(/(\d{1,3})\s*%\s*(?:above|over|more|below|under|less)/)) ? +m[1] : 20, direction: /\b(cold|slump)\b/.test(lc) ? 'cold' : 'hot' }, '"hot/cold player"'); }
  if ((m = lc.match(/(?:line|spread|total)\s+(?:has\s+)?(?:moved|moves|jumped|dropped)\s+(?:by\s+)?(\d+(?:\.\d)?)\s*(?:points?|pts)/)) || /\b(steam|sharp money|reverse line movement|rlm|line movement)\b/i.test(t)) {
    const dir = /\b(reverse line movement|rlm|buy low|against the move|fade the move)\b/i.test(t) ? 'against' : /\b(steam|follow|sharp money|with the move)\b/i.test(t) ? 'toward' : 'any';
    add('line_moved', { minPoints: m ? num(m[1]) : 1, minProbPp: 3, direction: dir }, '"line moved"');
  }
  if (/\bkey numbers?\b/i.test(t)) add('key_number', { numbers: ['3', '7'] }, '"key number"');
  if ((m = lc.match(/(?:edge|ev)\s*(?:of|is|must be|at least|>=|≥|over)?\s*(?:at least\s*)?(\d+(?:\.\d+)?)\s*%/)) || /\+ev\b|positive ev|line shop/i.test(t)) add('ev_at_least', { minPct: m ? num(m[1]) : 2, minBooks: 3 }, '"edge/+EV"');
  if ((m = lc.match(/(?:better|best) (?:number|line) (?:by )?(\d+(?:\.\d)?)/)) || /\bbetter number\b|\bbest number\b/i.test(t)) add('off_consensus_line', { minPoints: m ? num(m[1]) : 1 }, '"better number"');
  if ((m = lc.match(/within\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?)\s+(?:of|before)/))) add('starts_within', { minMinutes: 0, maxMinutes: Math.round(num(m[1]) * (/^h/.test(m[2]) ? 60 : 1)) }, `"within ${m[1]} ${m[2]}"`);
  if (/\barb(itrage)?s?\b/i.test(t)) add('arb_available', { minPct: (m = lc.match(/arb\w*\s*(?:of|>=|≥|at least)?\s*(\d+(?:\.\d+)?)\s*%/)) ? num(m[1]) : 0.5 }, '"arbitrage"');
  for (const [re, what] of UNSUPPORTED) if (re.test(t)) unmapped.push(what);
  if (CLAIMS.test(t)) warnings.push('performance claims in the text were ignored; nothing here is verified');
  if (!C.length) return { ok: false, error: 'no recognisable rule conditions in the text', mapped, unmapped, warnings };
  const first = t.split(/[.!?:](?:\s|$)|\n/).map((x) => x.trim()).find(Boolean) || 'Imported rule';
  return { ok: true, rule: { schema: 'hawse.betRule/1', name: first.slice(0, 80), description: t.trim().slice(0, 600), enabled: false, match: 'all', cooldownMin: 30, conditions: C, source: { type: 'text-import', note: t.trim().slice(0, 400) } }, mapped, unmapped, warnings };
}
module.exports = { textToRule };
