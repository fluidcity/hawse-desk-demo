'use strict';
// Preloaded template library. Descriptions are plain-language; risk notes are honest. No template carries any
// performance claim. Every template starts 'unverified' until you backtest it on this desk.
const base = (o) => ({ schemaVersion: 1, status: 'unverified', source: { type: 'template' }, entry: { allowShort: false }, exit: {}, risk: { capitalUsd: 10000, positionPct: 50, maxDrawdownPct: 25 }, costs: { feeRate: 0.0005, slippageBps: 2 }, ...o });

const TEMPLATES = [
  base({ id: 'tpl-funding-arb', name: 'Funding-rate arbitrage', kind: 'funding_arb', market: { symbol: 'BTC', venue: 'okx', instrument: 'swap', bar: '1H' },
    params: { minNetBps: 2, venues: ['binance', 'bybit', 'okx', 'hyperliquid'] }, costs: { feeRate: 0.0005, slippageBps: 2 },
    description: 'Short the perp on the venue paying the highest funding and long the same coin on the venue paying the lowest, so price moves cancel and you collect the funding difference. Runs live on the desk as the "Funding Arb" strategy.',
    riskNotes: ['Funding rates flip sign; a spread that looked positive can vanish before the next settlement.', 'Four taker fees usually exceed one funding period of spread; edges need multiple settlements to pay.', 'Capital sits on two venues: exchange/withdrawal risk and liquidation risk on the losing leg if margin is thin.', 'Historical replay is not supported here (no single public source of multi-venue funding history); evaluate it as a live paper run.'] }),
  base({ id: 'tpl-basis', name: 'Cash-and-carry basis', kind: 'basis_carry', market: { symbol: 'BTC', venue: 'okx', instrument: 'swap', bar: '1H' },
    params: { minNetBps: 5, exitBps: 2, holdHours: 72 }, costs: { feeRate: 0.0008, slippageBps: 2 }, exit: { maxHoldBars: 336 },
    description: 'Buy spot and short the perpetual of the same coin when the perp trades above spot by more than costs, then unwind when the gap closes. You earn the premium (and positive funding) while staying roughly price-neutral.',
    riskNotes: ['On most days the basis on majors is a few basis points, far below four taker fees, so this mostly sits flat.', 'Backtest uses candle closes for both legs, not bid/ask; real spreads make results worse than the replay.', 'Negative funding is paid by the short leg; prolonged negative funding turns carry into a loss.', 'Exchange counterparty risk on both legs.'] }),
  base({ id: 'tpl-ma-cross', name: 'Trend following · MA crossover', kind: 'ma_cross', market: { symbol: 'BTC', venue: 'okx', instrument: 'swap', bar: '4H' },
    params: { fast: 20, slow: 50, maType: 'ema' }, exit: { stopPct: 6 },
    description: 'Go long when a fast moving average crosses above a slow one and exit when it crosses back. Tries to catch long trends and accepts many small losses in between.',
    riskNotes: ['Whipsaws in sideways markets produce strings of small losses; win rate is typically below 50%.', 'Signals lag: entries come after part of the move and exits give back part of the gain.', 'Results are very sensitive to the chosen periods; tuning on one period of history overfits.'] }),
  base({ id: 'tpl-bollinger', name: 'Mean reversion · Bollinger bands', kind: 'bollinger_revert', market: { symbol: 'ETH', venue: 'okx', instrument: 'swap', bar: '1H' },
    params: { period: 20, mult: 2 }, exit: { stopPct: 4, maxHoldBars: 48 },
    description: 'Buy when price closes below the lower Bollinger band (2 standard deviations under a 20-bar average) and sell when it returns to the average.',
    riskNotes: ['Works in ranges and fails in trends: "cheap" can keep getting cheaper.', 'Many small wins and occasional large losses; the stop matters more than the entry.', 'Frequent trading makes fees and slippage a large share of the edge.'] }),
  base({ id: 'tpl-orb', name: 'Opening-range breakout', kind: 'orb', market: { symbol: 'BTC', venue: 'okx', instrument: 'swap', bar: '5m' },
    params: { sessionStartUtc: '13:30', rangeMinutes: 30, sessionMinutes: 390 }, entry: { allowShort: true },
    description: 'Mark the high and low of the first 30 minutes after a session open (13:30 UTC = US equities open), then trade a break of that range with the stop at the opposite side and exit by session end.',
    riskNotes: ['Crypto trades 24/7, so the "open" is a convention; the edge, if any, comes from US-session flow.', 'False breakouts are common; wide ranges mean wide stops.', 'The desk\'s CME MES/MNQ ORB uses a SIMULATED feed unless Tradovate credentials are configured.'] }),
  base({ id: 'tpl-dca-grid', name: 'DCA / grid', kind: 'dca_grid', market: { symbol: 'BTC', venue: 'okx', instrument: 'spot', bar: '1H' },
    params: { spacingPct: 1.5, levels: 8 }, costs: { feeRate: 0.001, slippageBps: 1 }, risk: { capitalUsd: 10000, positionPct: 80, maxDrawdownPct: 40 },
    description: 'Place buy orders at evenly spaced levels below the current price and sell each filled lot one step higher. Accumulates on dips and takes small profits on bounces.',
    riskNotes: ['In a sustained down-trend every level fills and you hold a full, losing inventory (large drawdown).', 'Caps upside: in a strong rally the grid sells early.', 'Profit per round trip is the spacing minus two fees; tight spacing can be eaten by costs.'] }),
  base({ id: 'tpl-vol-breakout', name: 'Volatility breakout', kind: 'volatility_breakout', market: { symbol: 'SOL', venue: 'okx', instrument: 'swap', bar: '1H' },
    params: { lookback: 20, atrPeriod: 14, atrMult: 1, expansion: 1.2 }, exit: { stopPct: 3, takePct: 6, maxHoldBars: 24 }, entry: { allowShort: true },
    description: 'Enter when a bar closes beyond the prior 20-bar high/low with a move larger than 1×ATR while volatility is expanding, betting that the burst continues.',
    riskNotes: ['Breakouts often fail and reverse; expect a low win rate offset (hopefully) by larger winners.', 'Entries happen after big candles, so slippage in real fast markets is worse than modeled.', 'Funding on perps can be expensive exactly when momentum is crowded.'] }),
];
const get = (id) => TEMPLATES.find((t) => t.id === id || t.kind === id);
module.exports = { TEMPLATES, get };
