/**
 * Thematic Scanner - Dick Capital Methodology Integration
 *
 * Adds to our existing scanner:
 * 1. Institutional ownership tracking
 * 2. Theme tagging (Kinetic, Orbital, Agentic, etc.)
 * 3. Micro-cap filters ($50M-$500M)
 * 4. Merger arb catalyst detection
 * 5. "Alpha Score" ranking system (0-100)
 *
 * This AUGMENTS our existing social/technical/macro scanning - doesn't replace it.
 */

const fs = require('fs');
const path = require('path');

// Theme definitions based on Dick Capital's framework
const THEMES = {
  KINETIC: {
    name: 'Kinetic',
    emoji: '🔫',
    description: 'Defense, manufacturing, things that move/shoot/explode',
    keywords: ['defense', 'military', 'aerospace', 'manufacturing', 'industrial', 'ammunition', 'weapons', 'missile', 'drone', 'contractor'],
    sectors: ['Industrials', 'Aerospace & Defense'],
    examples: ['LMT', 'RTX', 'NOC', 'GD', 'BA']
  },
  ORBITAL: {
    name: 'Orbital',
    emoji: '🛰️',
    description: 'Space economy, satellites, orbital infrastructure',
    keywords: ['space', 'satellite', 'orbital', 'launch', 'rocket', 'spacex', 'starlink', 'lunar', 'mars'],
    sectors: ['Aerospace & Defense', 'Communication Services'],
    examples: ['ASTS', 'RKLB', 'SPCE', 'LUNR', 'RDW']
  },
  AGENTIC: {
    name: 'Agentic AI',
    emoji: '🤖',
    description: 'AI agents, automation, digital employees',
    keywords: ['automation', 'rpa', 'ai agent', 'workflow', 'artificial intelligence', 'machine learning', 'robotic process'],
    sectors: ['Technology', 'Software'],
    examples: ['PATH', 'AI', 'PLTR', 'C3AI', 'BBAI']
  },
  AI_INFRA: {
    name: 'AI Infrastructure',
    emoji: '🖥️',
    description: 'AI compute, chips, data centers, networking',
    keywords: ['gpu', 'data center', 'hpc', 'high performance', 'compute', 'ai chip', 'semiconductor', 'networking', 'nvlink'],
    sectors: ['Technology', 'Semiconductors'],
    examples: ['NVDA', 'AMD', 'AVGO', 'MRVL', 'SMCI']
  },
  MINING: {
    name: 'Metals & Mining',
    emoji: '⛏️',
    description: 'Copper, gold, lithium, critical minerals',
    keywords: ['copper', 'gold', 'lithium', 'mining', 'mineral', 'ore', 'battery', 'rare earth'],
    sectors: ['Materials', 'Basic Materials'],
    examples: ['FCX', 'NEM', 'ALB', 'MP', 'LAC']
  },
  ENERGY_INFRA: {
    name: 'Energy Infrastructure',
    emoji: '⚡',
    description: 'Oil/gas, power generation, grid infrastructure',
    keywords: ['energy', 'oil', 'gas', 'pipeline', 'utility', 'power', 'grid', 'lng', 'refinery'],
    sectors: ['Energy', 'Utilities'],
    examples: ['XOM', 'CVX', 'OXY', 'SLB', 'HAL']
  }
};

// Market cap categories
const MARKET_CAP_RANGES = {
  MICRO: { min: 50_000_000, max: 300_000_000, label: 'Micro-cap' },
  SMALL: { min: 300_000_000, max: 2_000_000_000, label: 'Small-cap' },
  MID: { min: 2_000_000_000, max: 10_000_000_000, label: 'Mid-cap' },
  LARGE: { min: 10_000_000_000, max: Infinity, label: 'Large-cap' }
};

// Dick Capital's "sweet spot"
const DICK_CAPITAL_SWEET_SPOT = {
  marketCapMin: 50_000_000,
  marketCapMax: 500_000_000,
  instOwnershipMax: 0.10, // <10%
  avgVolumeMin: 50_000
};

class ThematicScanner {
  constructor() {
    this.dataDir = path.join(__dirname, 'data', 'thematic');
    this.watchlistFile = path.join(this.dataDir, 'watchlist.json');
    this.mergerArbFile = path.join(this.dataDir, 'merger_arb.json');

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Tag a stock with relevant themes
   */
  tagThemes(stock) {
    const themes = [];
    const { sector, industry, description, name } = stock;

    const searchText = `${sector} ${industry} ${description} ${name}`.toLowerCase();

    for (const [key, theme] of Object.entries(THEMES)) {
      // Check keywords
      const keywordMatch = theme.keywords.some(kw => searchText.includes(kw.toLowerCase()));
      // Check sector
      const sectorMatch = theme.sectors.some(s => sector?.includes(s) || industry?.includes(s));
      // Check if it's a known example
      const exampleMatch = theme.examples.includes(stock.symbol);

      if (keywordMatch || sectorMatch || exampleMatch) {
        themes.push({
          code: key,
          name: theme.name,
          emoji: theme.emoji,
          confidence: exampleMatch ? 'HIGH' : (keywordMatch && sectorMatch ? 'MEDIUM' : 'LOW')
        });
      }
    }

    return themes;
  }

  /**
   * Classify market cap
   */
  classifyMarketCap(marketCap) {
    for (const [key, range] of Object.entries(MARKET_CAP_RANGES)) {
      if (marketCap >= range.min && marketCap < range.max) {
        return { code: key, label: range.label };
      }
    }
    return { code: 'UNKNOWN', label: 'Unknown' };
  }

  /**
   * Check if stock fits Dick Capital's micro-cap criteria
   */
  fitsDickCapitalProfile(stock) {
    const { marketCap, institutionalOwnership, avgVolume } = stock;

    return {
      fits: (
        marketCap >= DICK_CAPITAL_SWEET_SPOT.marketCapMin &&
        marketCap <= DICK_CAPITAL_SWEET_SPOT.marketCapMax &&
        (institutionalOwnership === undefined || institutionalOwnership < DICK_CAPITAL_SWEET_SPOT.instOwnershipMax) &&
        (avgVolume === undefined || avgVolume >= DICK_CAPITAL_SWEET_SPOT.avgVolumeMin)
      ),
      details: {
        marketCapOk: marketCap >= DICK_CAPITAL_SWEET_SPOT.marketCapMin && marketCap <= DICK_CAPITAL_SWEET_SPOT.marketCapMax,
        instOwnershipOk: institutionalOwnership === undefined || institutionalOwnership < DICK_CAPITAL_SWEET_SPOT.instOwnershipMax,
        volumeOk: avgVolume === undefined || avgVolume >= DICK_CAPITAL_SWEET_SPOT.avgVolumeMin
      }
    };
  }

  /**
   * Calculate Dick Capital "Alpha Score" (0-100)
   */
  calculateAlphaScore(stock) {
    let score = 0;
    const breakdown = {};

    // Undiscovered Factor (30 points max)
    const instOwn = stock.institutionalOwnership || 0.5; // Default to 50% if unknown
    if (instOwn < 0.05) {
      score += 30;
      breakdown.undiscovered = 30;
    } else if (instOwn < 0.10) {
      score += 20;
      breakdown.undiscovered = 20;
    } else if (instOwn < 0.20) {
      score += 10;
      breakdown.undiscovered = 10;
    } else {
      breakdown.undiscovered = 0;
    }

    // Theme Alignment (25 points max)
    const themes = stock.themes || this.tagThemes(stock);
    if (themes.length >= 3) {
      score += 25;
      breakdown.themeAlignment = 25;
    } else if (themes.length === 2) {
      score += 15;
      breakdown.themeAlignment = 15;
    } else if (themes.length === 1) {
      score += 5;
      breakdown.themeAlignment = 5;
    } else {
      breakdown.themeAlignment = 0;
    }

    // Catalyst Score (20 points max)
    if (stock.recentCatalyst && stock.catalystDaysAgo <= 30) {
      score += 20;
      breakdown.catalyst = 20;
    } else if (stock.recentCatalyst && stock.catalystDaysAgo <= 90) {
      score += 10;
      breakdown.catalyst = 10;
    } else {
      breakdown.catalyst = 0;
    }

    // Fundamentals - Revenue Growth (15 points max)
    const revGrowth = stock.revenueGrowth || 0;
    if (revGrowth > 0.50) {
      score += 15;
      breakdown.fundamentals = 15;
    } else if (revGrowth > 0.30) {
      score += 10;
      breakdown.fundamentals = 10;
    } else if (revGrowth > 0.10) {
      score += 5;
      breakdown.fundamentals = 5;
    } else {
      breakdown.fundamentals = 0;
    }

    // Liquidity (10 points max)
    const avgVol = stock.avgVolume || 0;
    if (avgVol > 500_000) {
      score += 10;
      breakdown.liquidity = 10;
    } else if (avgVol > 100_000) {
      score += 7;
      breakdown.liquidity = 7;
    } else if (avgVol > 50_000) {
      score += 4;
      breakdown.liquidity = 4;
    } else {
      breakdown.liquidity = 0;
    }

    return {
      total: score,
      breakdown,
      priority: score >= 80 ? 'HIGH' : score >= 60 ? 'MEDIUM' : score >= 40 ? 'LOW' : 'PASS'
    };
  }

  /**
   * Add a merger arb opportunity
   */
  addMergerArb(deal) {
    let deals = [];
    if (fs.existsSync(this.mergerArbFile)) {
      deals = JSON.parse(fs.readFileSync(this.mergerArbFile, 'utf8'));
    }

    const existing = deals.find(d => d.target === deal.target);
    if (existing) {
      Object.assign(existing, deal, { updatedAt: new Date().toISOString() });
    } else {
      deals.push({
        ...deal,
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    fs.writeFileSync(this.mergerArbFile, JSON.stringify(deals, null, 2));
    return deals;
  }

  /**
   * Get active merger arb opportunities
   */
  getMergerArbs() {
    if (!fs.existsSync(this.mergerArbFile)) return [];
    const deals = JSON.parse(fs.readFileSync(this.mergerArbFile, 'utf8'));
    return deals.filter(d => d.status !== 'CLOSED');
  }

  /**
   * Calculate merger arb spread
   */
  calculateSpread(currentPrice, dealPrice) {
    if (!dealPrice || !currentPrice) return null;
    return ((dealPrice - currentPrice) / currentPrice) * 100;
  }

  /**
   * Add to thematic watchlist
   */
  addToWatchlist(stock) {
    let watchlist = [];
    if (fs.existsSync(this.watchlistFile)) {
      watchlist = JSON.parse(fs.readFileSync(this.watchlistFile, 'utf8'));
    }

    const existing = watchlist.find(w => w.symbol === stock.symbol);
    if (existing) {
      Object.assign(existing, stock, { updatedAt: new Date().toISOString() });
    } else {
      watchlist.push({
        ...stock,
        addedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    fs.writeFileSync(this.watchlistFile, JSON.stringify(watchlist, null, 2));
    return watchlist;
  }

  /**
   * Get thematic watchlist
   */
  getWatchlist(filters = {}) {
    if (!fs.existsSync(this.watchlistFile)) return [];
    let watchlist = JSON.parse(fs.readFileSync(this.watchlistFile, 'utf8'));

    if (filters.theme) {
      watchlist = watchlist.filter(w =>
        w.themes?.some(t => t.code === filters.theme || t.name === filters.theme)
      );
    }

    if (filters.minAlphaScore) {
      watchlist = watchlist.filter(w =>
        (w.alphaScore?.total || 0) >= filters.minAlphaScore
      );
    }

    if (filters.marketCapRange) {
      const range = MARKET_CAP_RANGES[filters.marketCapRange];
      if (range) {
        watchlist = watchlist.filter(w =>
          w.marketCap >= range.min && w.marketCap < range.max
        );
      }
    }

    return watchlist;
  }

  /**
   * Scan for micro-cap opportunities (Dick Capital style)
   */
  async scanMicroCaps(stocks) {
    const results = [];

    for (const stock of stocks) {
      const themes = this.tagThemes(stock);
      const marketCapClass = this.classifyMarketCap(stock.marketCap || 0);
      const dickProfile = this.fitsDickCapitalProfile(stock);

      stock.themes = themes;
      stock.marketCapClass = marketCapClass;
      stock.dickCapitalProfile = dickProfile;

      const alphaScore = this.calculateAlphaScore(stock);
      stock.alphaScore = alphaScore;

      if (dickProfile.fits || alphaScore.total >= 60) {
        results.push(stock);
      }
    }

    // Sort by alpha score
    results.sort((a, b) => b.alphaScore.total - a.alphaScore.total);

    return results;
  }

  /**
   * Format results for Discord
   */
  formatForDiscord(results, title = 'Thematic Scan Results') {
    if (!results.length) return `**${title}**\n\nNo opportunities found.`;

    let msg = `**${title}**\n\n`;

    results.slice(0, 10).forEach((stock, i) => {
      const themeEmojis = (stock.themes || []).map(t => t.emoji).join('');
      const score = stock.alphaScore?.total || 0;
      const priority = stock.alphaScore?.priority || 'N/A';

      msg += `**${i + 1}. ${stock.symbol}** ${themeEmojis}\n`;
      msg += `   Alpha Score: ${score}/100 (${priority})\n`;
      msg += `   Market Cap: ${stock.marketCapClass?.label || 'N/A'}\n`;

      if (stock.dickCapitalProfile?.fits) {
        msg += `   ✅ Fits Dick Capital Profile\n`;
      }

      msg += '\n';
    });

    return msg;
  }

  /**
   * Get theme summary
   */
  getThemeSummary() {
    const watchlist = this.getWatchlist();
    const summary = {};

    for (const [key, theme] of Object.entries(THEMES)) {
      const matching = watchlist.filter(w =>
        w.themes?.some(t => t.code === key)
      );
      summary[key] = {
        name: theme.name,
        emoji: theme.emoji,
        count: matching.length,
        topPicks: matching.slice(0, 3).map(m => m.symbol)
      };
    }

    return summary;
  }
}

// Export
module.exports = {
  ThematicScanner,
  THEMES,
  MARKET_CAP_RANGES,
  DICK_CAPITAL_SWEET_SPOT
};

// CLI
if (require.main === module) {
  const scanner = new ThematicScanner();

  // Example usage
  const testStocks = [
    { symbol: 'ASTS', name: 'AST SpaceMobile', sector: 'Communication Services', marketCap: 400_000_000 },
    { symbol: 'PATH', name: 'UiPath', sector: 'Technology', industry: 'Software', marketCap: 8_000_000_000 },
    { symbol: 'NBIS', name: 'Nebius Group', sector: 'Technology', marketCap: 200_000_000, institutionalOwnership: 0.05 }
  ];

  console.log('Testing thematic scanner...\n');

  testStocks.forEach(stock => {
    const themes = scanner.tagThemes(stock);
    const alphaScore = scanner.calculateAlphaScore(stock);
    const dickProfile = scanner.fitsDickCapitalProfile(stock);

    console.log(`${stock.symbol}:`);
    console.log(`  Themes: ${themes.map(t => t.name).join(', ') || 'None'}`);
    console.log(`  Alpha Score: ${alphaScore.total}/100 (${alphaScore.priority})`);
    console.log(`  Dick Capital Profile: ${dickProfile.fits ? 'YES' : 'NO'}`);
    console.log('');
  });
}
