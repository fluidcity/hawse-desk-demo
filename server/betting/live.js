'use strict';
// Real-money bet placement is NOT implemented and must stay that way without a separate legal + security review.
// This stub exists so any accidental call fails loudly. The betting module is ALERTS ONLY outside the paper ledger.
class LiveBettingDisabledError extends Error {
  constructor() { super('Real-money bet placement is disabled in this build (paper bets + alerts only).'); this.code = 'LIVE_BETTING_DISABLED'; }
}
class LiveBetPlacer {
  placeBet() { throw new LiveBettingDisabledError(); }
  cancelBet() { throw new LiveBettingDisabledError(); }
  login() { throw new LiveBettingDisabledError(); }
}
module.exports = { LiveBetPlacer, LiveBettingDisabledError };
