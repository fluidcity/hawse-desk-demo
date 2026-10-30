'use strict';
// Team / player stats data layer for rule conditions (rest days, back-to-backs, injuries, player form).
// No real stats provider is wired in this build. Two providers exist:
//   MockStatsProvider  deterministic SYNTHETIC numbers per team/day, labelled MOCK; any signal that relied on it is tagged simulated.
//   NullStatsProvider  returns nothing; stats conditions then report "unknown" and never match.
// A real provider only has to implement teamInfo(sport, team, atMs) → TeamInfo | null and set mode/simulated.
const { hash01 } = require('../util');

/** @typedef {{ name:string, role:number, status:'active'|'questionable'|'out', season:Object<string,number>, recent:Object<string,number>, games:number }} Player */
/** @typedef {{ team:string, restDays:number, backToBack:boolean, players:Player[], source:string, simulated:boolean }} TeamInfo */

const STATS = { basketball_nba: ['points', 'rebounds', 'assists'], americanfootball_nfl: ['passing_yards', 'rushing_yards', 'receiving_yards'], icehockey_nhl: ['goals', 'assists', 'shots'] };
const BASE = { points: 18, rebounds: 7, assists: 5, passing_yards: 235, rushing_yards: 62, receiving_yards: 58, goals: 0.4, shots: 2.8 };
const FIRST = ['Avery', 'Jordan', 'Casey', 'Riley', 'Quinn', 'Morgan', 'Rowan', 'Emerson'];

class NullStatsProvider {
  constructor() { this.mode = 'none'; this.simulated = false; this.label = 'no stats provider'; }
  teamInfo() { return null; }
}

class MockStatsProvider {
  constructor({ now = Date.now } = {}) { this.mode = 'mock'; this.simulated = true; this.label = 'MOCK stats (synthetic)'; this.now = now; }
  teamInfo(sport, team, atMs = this.now()) {
    if (!team) return null;
    const day = Math.floor(atMs / 86400e3), h = (k) => hash01(`${sport}|${team}|${day}|${k}`), stats = STATS[sport] || ['points'];
    const restDays = Math.floor(h('rest') * 4); // 0 = played yesterday
    const players = [0, 1, 2].map((i) => {
      const season = {}, recent = {}; for (const s of stats) { const b = BASE[s] * (1.4 - i * 0.3) * (0.8 + hash01(`${sport}|${team}|${i}|${s}`) * 0.4); season[s] = +b.toFixed(2); recent[s] = +(b * (0.7 + h(`r${i}${s}`) * 0.6)).toFixed(2); }
      const st = h(`st${i}`); return { name: `${FIRST[Math.floor(hash01(team + i) * FIRST.length)]} ${team.split(' ').pop()} #${i + 1}`, role: [34, 24, 16][i], status: st < 0.12 ? 'out' : st < 0.22 ? 'questionable' : 'active', season, recent, games: 5 };
    });
    return { team, restDays, backToBack: restDays === 0, players, source: this.label, simulated: true };
  }
}

module.exports = { MockStatsProvider, NullStatsProvider, STATS };
