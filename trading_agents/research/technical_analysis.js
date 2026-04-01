/**
 * Technical Analysis Module
 * Calculates RSI, MACD, SMAs, support/resistance, volume profile
 * Source: Alpaca (primary) via data_layer, Yahoo Finance (fallback)
 */

const dataLayer = require('./data_layer');

/**
 * Fetch historical daily data via unified data layer
 */
async function getHistoricalData(symbol, range = '6mo') {
  return dataLayer.getHistoricalBars(symbol, range);
}

/**
 * Calculate RSI (Relative Strength Index)
 */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate EMA (Exponential Moving Average)
 */
function calcEMA(data, period) {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const ema = [data.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < data.length; i++) {
    ema.push(data[i] * k + ema[ema.length - 1] * (1 - k));
  }
  return ema;
}

/**
 * Calculate SMA (Simple Moving Average)
 */
function calcSMA(data, period) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * Calculate MACD (12, 26, 9)
 */
function calcMACD(closes) {
  if (closes.length < 26) return null;

  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);

  // Align: ema12 starts at index 12, ema26 at index 26
  // MACD line = ema12 - ema26 (aligned from index 26)
  const offset = 26 - 12; // 14
  const macdLine = [];
  for (let i = 0; i < ema26.length; i++) {
    macdLine.push(ema12[i + offset] - ema26[i]);
  }

  if (macdLine.length < 9) return null;

  const signalLine = calcEMA(macdLine, 9);
  const histOffset = 9 - 1;

  const currentMACD = macdLine[macdLine.length - 1];
  const currentSignal = signalLine[signalLine.length - 1];
  const currentHist = currentMACD - currentSignal;
  const prevHist = macdLine.length >= 2 && signalLine.length >= 2 ?
    macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2] : 0;

  return {
    macd: parseFloat(currentMACD.toFixed(3)),
    signal: parseFloat(currentSignal.toFixed(3)),
    histogram: parseFloat(currentHist.toFixed(3)),
    crossover: (prevHist <= 0 && currentHist > 0) ? 'BULLISH' :
               (prevHist >= 0 && currentHist < 0) ? 'BEARISH' : 'NONE',
    trend: currentMACD > currentSignal ? 'BULLISH' : 'BEARISH',
  };
}

/**
 * Find support and resistance levels from recent price action
 */
function findSupportResistance(bars, numLevels = 3) {
  if (bars.length < 20) return { support: [], resistance: [] };

  const currentPrice = bars[bars.length - 1].close;
  const recentBars = bars.slice(-60); // Last ~3 months

  // Find swing highs and lows
  const swingHighs = [];
  const swingLows = [];

  for (let i = 2; i < recentBars.length - 2; i++) {
    const h = recentBars[i].high;
    const l = recentBars[i].low;

    if (h > recentBars[i - 1].high && h > recentBars[i - 2].high &&
        h > recentBars[i + 1].high && h > recentBars[i + 2].high) {
      swingHighs.push({ price: h, date: recentBars[i].date });
    }
    if (l < recentBars[i - 1].low && l < recentBars[i - 2].low &&
        l < recentBars[i + 1].low && l < recentBars[i + 2].low) {
      swingLows.push({ price: l, date: recentBars[i].date });
    }
  }

  // Cluster nearby levels
  const clusterLevels = (levels) => {
    if (levels.length === 0) return [];
    const sorted = levels.sort((a, b) => a.price - b.price);
    const clusters = [];
    let cluster = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].price - cluster[0].price) / cluster[0].price < 0.02) {
        cluster.push(sorted[i]);
      } else {
        clusters.push({
          price: parseFloat((cluster.reduce((s, c) => s + c.price, 0) / cluster.length).toFixed(2)),
          touches: cluster.length,
          lastDate: cluster[cluster.length - 1].date,
        });
        cluster = [sorted[i]];
      }
    }
    clusters.push({
      price: parseFloat((cluster.reduce((s, c) => s + c.price, 0) / cluster.length).toFixed(2)),
      touches: cluster.length,
      lastDate: cluster[cluster.length - 1].date,
    });

    return clusters.sort((a, b) => b.touches - a.touches).slice(0, numLevels);
  };

  const support = clusterLevels(swingLows).filter(l => l.price < currentPrice);
  const resistance = clusterLevels(swingHighs).filter(l => l.price > currentPrice);

  return { support, resistance };
}

/**
 * Calculate volume profile (average volume, recent vs average)
 */
function volumeProfile(bars) {
  if (bars.length < 20) return null;

  const volumes = bars.map(b => b.volume).filter(v => v > 0);
  const avg20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const avg5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const latest = volumes[volumes.length - 1];

  return {
    avgVolume20d: Math.round(avg20),
    avgVolume5d: Math.round(avg5),
    latestVolume: latest,
    volumeRatio: parseFloat((latest / avg20).toFixed(2)),
    volumeTrend: avg5 > avg20 * 1.3 ? 'INCREASING' : avg5 < avg20 * 0.7 ? 'DECREASING' : 'NORMAL',
  };
}

/**
 * Full technical analysis for a symbol
 */
async function analyzeSymbol(symbol) {
  const hist = await getHistoricalData(symbol, '6mo');
  if (!hist || hist.bars.length < 30) return null;

  const closes = hist.bars.map(b => b.close);
  const currentPrice = closes[closes.length - 1];

  // Moving averages
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);
  const sma200 = closes.length >= 200 ? calcSMA(closes, 200) : null;

  // RSI
  const rsi = calcRSI(closes, 14);

  // MACD
  const macd = calcMACD(closes);

  // Support/Resistance
  const levels = findSupportResistance(hist.bars);

  // Volume
  const volume = volumeProfile(hist.bars);

  // Price vs MAs
  const priceVsSMA20 = sma20 ? ((currentPrice - sma20) / sma20 * 100).toFixed(2) : null;
  const priceVsSMA50 = sma50 ? ((currentPrice - sma50) / sma50 * 100).toFixed(2) : null;
  const priceVsSMA200 = sma200 ? ((currentPrice - sma200) / sma200 * 100).toFixed(2) : null;

  // Trend determination
  let trend = 'NEUTRAL';
  if (sma20 && sma50) {
    if (currentPrice > sma20 && sma20 > sma50) trend = 'STRONG_UPTREND';
    else if (currentPrice > sma20) trend = 'UPTREND';
    else if (currentPrice < sma20 && sma20 < sma50) trend = 'STRONG_DOWNTREND';
    else if (currentPrice < sma20) trend = 'DOWNTREND';
  }

  // Signal summary
  const signals = [];
  if (rsi !== null) {
    if (rsi < 30) signals.push('RSI_OVERSOLD');
    else if (rsi > 70) signals.push('RSI_OVERBOUGHT');
  }
  if (macd?.crossover === 'BULLISH') signals.push('MACD_BULLISH_CROSS');
  if (macd?.crossover === 'BEARISH') signals.push('MACD_BEARISH_CROSS');
  if (sma20 && sma50 && sma20 > sma50 && priceVsSMA20 > 0) signals.push('GOLDEN_CROSS_ZONE');
  if (sma20 && sma50 && sma20 < sma50 && priceVsSMA20 < 0) signals.push('DEATH_CROSS_ZONE');
  if (volume?.volumeRatio > 2) signals.push('VOLUME_SPIKE');

  return {
    symbol,
    price: currentPrice,
    trend,
    rsi: rsi ? parseFloat(rsi.toFixed(1)) : null,
    macd,
    sma: {
      sma20: sma20 ? parseFloat(sma20.toFixed(2)) : null,
      sma50: sma50 ? parseFloat(sma50.toFixed(2)) : null,
      sma200: sma200 ? parseFloat(sma200.toFixed(2)) : null,
      priceVsSMA20: priceVsSMA20 ? priceVsSMA20 + '%' : null,
      priceVsSMA50: priceVsSMA50 ? priceVsSMA50 + '%' : null,
      priceVsSMA200: priceVsSMA200 ? priceVsSMA200 + '%' : null,
    },
    supportResistance: levels,
    volume,
    signals,
    high52: hist.meta.high52,
    low52: hist.meta.low52,
  };
}

/**
 * Batch analyze multiple symbols
 */
async function analyzeMultiple(symbols) {
  const results = {};
  const batches = [];

  // Process in batches of 5 to avoid rate limiting
  for (let i = 0; i < symbols.length; i += 5) {
    batches.push(symbols.slice(i, i + 5));
  }

  for (const batch of batches) {
    const batchResults = await Promise.all(
      batch.map(sym => analyzeSymbol(sym).catch(() => null))
    );
    for (let j = 0; j < batch.length; j++) {
      if (batchResults[j]) results[batch[j]] = batchResults[j];
    }
    if (batches.indexOf(batch) < batches.length - 1) {
      await new Promise(r => setTimeout(r, 500)); // Brief pause between batches
    }
  }

  return results;
}

async function run(symbols = []) {
  if (symbols.length === 0) return {};
  return analyzeMultiple(symbols);
}

module.exports = { run, analyzeSymbol, analyzeMultiple, calcRSI, calcMACD, calcSMA, findSupportResistance };
