/**
 * Options Flow Deep Dive
 * Detects unusual options activity, large blocks, put/call skew.
 * Sources: Yahoo Finance options chains via data_layer (Alpaca for stock price)
 */

const dataLayer = require('./data_layer');

/**
 * Get options chain via unified data layer
 */
async function getOptionsChain(symbol) {
  return dataLayer.getOptionsChain(symbol);
}

/**
 * Analyze options flow for a symbol
 * Detects unusual activity, skew, and smart money signals
 */
async function analyzeOptionsFlow(symbol) {
  const chain = await getOptionsChain(symbol);
  if (!chain) return null;

  const stockPrice = chain.stockPrice;

  // Total volume and OI
  const totalCallVol = chain.calls.reduce((s, c) => s + c.volume, 0);
  const totalPutVol = chain.puts.reduce((s, p) => s + p.volume, 0);
  const totalCallOI = chain.calls.reduce((s, c) => s + c.openInterest, 0);
  const totalPutOI = chain.puts.reduce((s, p) => s + p.openInterest, 0);

  const putCallRatio = totalCallVol > 0 ? parseFloat((totalPutVol / totalCallVol).toFixed(2)) : null;
  const putCallOIRatio = totalCallOI > 0 ? parseFloat((totalPutOI / totalCallOI).toFixed(2)) : null;

  // Find unusual activity (volume >> open interest = new positions being opened)
  const unusualCalls = chain.calls
    .filter(c => c.volume > 100 && c.volumeToOI > 3 && !c.inTheMoney)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5);

  const unusualPuts = chain.puts
    .filter(p => p.volume > 100 && p.volumeToOI > 3 && !p.inTheMoney)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 5);

  // Highest volume strikes (where is the action?)
  const topCallStrikes = chain.calls
    .filter(c => c.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 3);

  const topPutStrikes = chain.puts
    .filter(p => p.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 3);

  // IV skew: compare OTM put IV to OTM call IV
  const otmCalls = chain.calls.filter(c => c.strike > stockPrice && c.impliedVol > 0);
  const otmPuts = chain.puts.filter(p => p.strike < stockPrice && p.impliedVol > 0);
  const avgCallIV = otmCalls.length > 0 ? otmCalls.reduce((s, c) => s + c.impliedVol, 0) / otmCalls.length : 0;
  const avgPutIV = otmPuts.length > 0 ? otmPuts.reduce((s, p) => s + p.impliedVol, 0) / otmPuts.length : 0;

  const ivSkew = avgPutIV > 0 && avgCallIV > 0 ?
    parseFloat(((avgPutIV - avgCallIV) / avgCallIV * 100).toFixed(1)) : null;

  // Max pain estimate (strike where most options expire worthless)
  const allStrikes = [...new Set([...chain.calls.map(c => c.strike), ...chain.puts.map(p => p.strike)])].sort((a, b) => a - b);
  let maxPain = null;
  let minPainValue = Infinity;

  for (const strike of allStrikes) {
    let painValue = 0;
    for (const c of chain.calls) {
      if (strike > c.strike) painValue += (strike - c.strike) * c.openInterest;
    }
    for (const p of chain.puts) {
      if (strike < p.strike) painValue += (p.strike - strike) * p.openInterest;
    }
    if (painValue < minPainValue) {
      minPainValue = painValue;
      maxPain = strike;
    }
  }

  // Expected move (from ATM straddle)
  const atmCall = chain.calls.reduce((best, c) =>
    Math.abs(c.strike - stockPrice) < Math.abs(best.strike - stockPrice) ? c : best,
    chain.calls[0] || { strike: 0, lastPrice: 0 }
  );
  const atmPut = chain.puts.reduce((best, p) =>
    Math.abs(p.strike - stockPrice) < Math.abs(best.strike - stockPrice) ? p : best,
    chain.puts[0] || { strike: 0, lastPrice: 0 }
  );
  const expectedMove = (atmCall.lastPrice || 0) + (atmPut.lastPrice || 0);
  const expectedMovePct = stockPrice > 0 ? parseFloat((expectedMove / stockPrice * 100).toFixed(1)) : null;

  // Sentiment signals
  const signals = [];
  if (putCallRatio !== null) {
    if (putCallRatio < 0.5) signals.push('VERY_BULLISH_FLOW');
    else if (putCallRatio < 0.8) signals.push('BULLISH_FLOW');
    else if (putCallRatio > 1.5) signals.push('VERY_BEARISH_FLOW');
    else if (putCallRatio > 1.0) signals.push('BEARISH_FLOW');
  }
  if (unusualCalls.length > 2) signals.push('UNUSUAL_CALL_ACTIVITY');
  if (unusualPuts.length > 2) signals.push('UNUSUAL_PUT_ACTIVITY');
  if (ivSkew !== null && ivSkew > 20) signals.push('HIGH_PUT_SKEW');  // Fear
  if (ivSkew !== null && ivSkew < -10) signals.push('HIGH_CALL_SKEW'); // Greed
  if (maxPain && Math.abs(stockPrice - maxPain) / stockPrice > 0.05) {
    signals.push(stockPrice > maxPain ? 'ABOVE_MAX_PAIN' : 'BELOW_MAX_PAIN');
  }

  return {
    symbol,
    stockPrice,
    expiration: chain.expirationDate,
    putCallRatio,
    putCallOIRatio,
    totalCallVol,
    totalPutVol,
    totalCallOI,
    totalPutOI,
    unusualCalls: unusualCalls.map(c => ({
      strike: c.strike, volume: c.volume, oi: c.openInterest,
      volOI: c.volumeToOI, iv: c.impliedVol ? (c.impliedVol * 100).toFixed(0) + '%' : null,
    })),
    unusualPuts: unusualPuts.map(p => ({
      strike: p.strike, volume: p.volume, oi: p.openInterest,
      volOI: p.volumeToOI, iv: p.impliedVol ? (p.impliedVol * 100).toFixed(0) + '%' : null,
    })),
    topCallStrikes: topCallStrikes.map(c => ({ strike: c.strike, volume: c.volume })),
    topPutStrikes: topPutStrikes.map(p => ({ strike: p.strike, volume: p.volume })),
    ivSkew,
    maxPain,
    expectedMove: expectedMove.toFixed(2),
    expectedMovePct: expectedMovePct ? expectedMovePct + '%' : null,
    avgCallIV: avgCallIV > 0 ? (avgCallIV * 100).toFixed(0) + '%' : null,
    avgPutIV: avgPutIV > 0 ? (avgPutIV * 100).toFixed(0) + '%' : null,
    signals,
  };
}

/**
 * Batch analyze options flow for multiple symbols
 */
async function analyzeMultiple(symbols) {
  const results = {};

  for (let i = 0; i < symbols.length; i++) {
    try {
      const result = await analyzeOptionsFlow(symbols[i]);
      if (result) results[symbols[i]] = result;
    } catch (e) {
      console.error(`[OptionsFlow] ${symbols[i]} failed:`, e.message);
    }
    // Small delay between requests
    if (i < symbols.length - 1) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return results;
}

async function run(symbols = []) {
  if (symbols.length === 0) return {};
  return analyzeMultiple(symbols);
}

module.exports = { run, analyzeOptionsFlow, analyzeMultiple, getOptionsChain };
