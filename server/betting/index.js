'use strict';
// Sports-betting module entry point. Everything betting lives under server/betting/ (+ public/betting/ for the UI).
// HOST CONTRACT (all the module needs from HAWSE; another host can provide the same to run it standalone):
//   host.cfg.betting            config from ./config.fromEnv(env)
//   host.addFeed(name, obj)     register an object with optional start()/stop()/snapshot()
//   host.addStrategy(s)         register a paper strategy (only for the paper bet_ev/bet_spread/bet_arb strategies)
//   host.health                 { register, ok, fail } for provider health badges
//   host.tape                   { push({kind,msg,...}) } event tape
//   host.ledger                 paper ledger { close(...) } (BetBook settlement only)
//   opts.Strategy               the host's Strategy base class (injected, not imported)
// It ADDS: host.routes[] ({prefix, handle}) and host.importers[] (lab import delegation), host.placeLiveBet (always throws).
const { OddsFeed } = require('./data/odds');
const { BetBook } = require('./book');
const { LiveBetPlacer } = require('./live');
const defineStrategies = require('./strategies');
const { RuleDesk } = require('./desk');
const { routes } = require('./routes');

function mount(host, { Strategy, cfg = host.cfg.betting } = {}) {
  const feed = host.addFeed('odds', new OddsFeed({ health: host.health, cfg }));
  const book = host.bets = host.addFeed('bets', new BetBook(host, feed, cfg));
  host.liveBets = new LiveBetPlacer(); host.placeLiveBet = () => host.liveBets.placeBet(); // always throws
  if (Strategy) { const D = defineStrategies(Strategy); for (const S of [D.BetEV, D.BetSpread, D.BetArb]) host.addStrategy(new S(host, feed, book)); }
  const desk = host.addFeed('betdesk', new RuleDesk({ cfg, feed, now: host.now ? () => host.now() : Date.now,
    onSignal: (s) => host.tape && host.tape.push({ kind: 'signal', msg: `${s.simulated ? '[SIM] ' : ''}SIGNAL ${s.ruleName}: ${s.event} · ${s.label} @ ${s.book} (review → slip)`, simulated: s.simulated }) }));
  (host.routes = host.routes || []).push({ prefix: '/api/betting', handle: routes(desk) });
  (host.importers = host.importers || []).push(desk.importer());
  return { feed, book, desk };
}
module.exports = { mount, RuleDesk, defineStrategies, config: require('./config') };
