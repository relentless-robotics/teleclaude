/**
 * LLM Reasoning Client v2
 *
 * Multi-provider LLM client with circuit breaker failover.
 * Supports: Claude CLI, Groq (FREE), Anthropic API, OpenAI, Kimi
 *
 * Default priority: Claude CLI → Groq → Anthropic → OpenAI → Kimi
 * Override via config/llm_config.json or forceProvider('groq')
 *
 * Circuit breaker: auto-switches away from failing providers and recovers.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// Load API keys from config file if env vars not set
const API_KEYS_FILE = path.join(__dirname, '..', 'config', 'api_keys.json');
try {
  if (fs.existsSync(API_KEYS_FILE)) {
    const keys = JSON.parse(fs.readFileSync(API_KEYS_FILE, 'utf8'));
    for (const [envVar, value] of Object.entries(keys)) {
      if (!process.env[envVar] && value) {
        process.env[envVar] = value;
      }
    }
  }
} catch (e) { /* ignore */ }

// Load LLM config (provider priority, circuit breaker settings, model overrides)
const LLM_CONFIG_FILE = path.join(__dirname, '..', 'config', 'llm_config.json');
let _llmConfig = null;
function getLlmConfig() {
  if (_llmConfig) return _llmConfig;
  try {
    if (fs.existsSync(LLM_CONFIG_FILE)) {
      _llmConfig = JSON.parse(fs.readFileSync(LLM_CONFIG_FILE, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  if (!_llmConfig) _llmConfig = {};
  return _llmConfig;
}

// ============================================================================
// Circuit Breaker: tracks failures per provider and auto-switches
// ============================================================================
const _circuitState = {};  // { provider: { failures, lastFailure, state } }
// States: 'closed' (healthy), 'open' (broken, skip), 'half-open' (testing recovery)

function getCircuitState(provider) {
  if (!_circuitState[provider]) {
    _circuitState[provider] = { failures: 0, lastFailure: 0, state: 'closed' };
  }
  return _circuitState[provider];
}

function recordFailure(provider) {
  const config = getLlmConfig();
  const cb = config.circuitBreaker || { failureThreshold: 3, recoveryTimeMs: 300000 };
  const state = getCircuitState(provider);
  state.failures++;
  state.lastFailure = Date.now();
  if (state.failures >= cb.failureThreshold) {
    state.state = 'open';
    console.warn(`[LLM] Circuit OPEN for ${provider} after ${state.failures} failures. Will retry in ${cb.recoveryTimeMs / 1000}s.`);
  }
}

function recordSuccess(provider) {
  const state = getCircuitState(provider);
  state.failures = 0;
  state.state = 'closed';
}

function isCircuitOpen(provider) {
  const config = getLlmConfig();
  const cb = config.circuitBreaker || { recoveryTimeMs: 300000 };
  const state = getCircuitState(provider);
  if (state.state === 'closed') return false;
  if (state.state === 'open') {
    // Check if recovery time has passed
    if (Date.now() - state.lastFailure > cb.recoveryTimeMs) {
      state.state = 'half-open';
      return false;  // Allow one test attempt
    }
    return true;  // Still broken
  }
  return false;  // half-open allows through
}

// Runtime override (persists until process restart or config reload)
let _runtimeForceProvider = null;

/**
 * Force all LLM calls to use a specific provider.
 * Call with null to reset to config/default behavior.
 * @param {string|null} provider - 'groq', 'claude_cli', 'anthropic', 'openai', 'kimi', or null
 */
function forceProvider(provider) {
  _runtimeForceProvider = provider;
  console.log(`[LLM] Provider forced to: ${provider || 'auto'}`);
}

/**
 * Reload config from disk (call after editing llm_config.json)
 */
function reloadConfig() {
  _llmConfig = null;
  getLlmConfig();
  console.log('[LLM] Config reloaded from disk.');
}

// Provider configs
const PROVIDERS = {
  claude_cli: {
    name: 'Claude CLI (Sonnet)',
    model: 'sonnet',
    costPer1kIn: 0.003,   // Sonnet pricing via subscription
    costPer1kOut: 0.015,
    isClaude_cli: true,
  },
  groq: {
    name: 'Groq (Llama 3.3 70B)',
    host: 'api.groq.com',
    path: '/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    envKey: 'GROQ_API_KEY',
    costPer1kIn: 0.00059,  // $0.59/M
    costPer1kOut: 0.00079,  // $0.79/M
    altModels: ['moonshotai/kimi-k2-instruct-0905', 'llama-3.1-8b-instant'],
  },
  anthropic: {
    name: 'Anthropic Haiku',
    host: 'api.anthropic.com',
    path: '/v1/messages',
    model: 'claude-haiku-4-5-20251001',
    envKey: 'ANTHROPIC_API_KEY',
    costPer1kIn: 0.001,
    costPer1kOut: 0.005,
    isAnthropic: true,
  },
  openai: {
    name: 'OpenAI GPT-4o-mini',
    host: 'api.openai.com',
    path: '/v1/chat/completions',
    model: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
    costPer1kIn: 0.00015,
    costPer1kOut: 0.0006,
  },
  kimi: {
    name: 'Kimi K2.5',
    host: 'api.moonshot.ai',
    path: '/v1/chat/completions',
    model: 'kimi-k2.5-preview',
    envKey: 'KIMI_API_KEY',
    costPer1kIn: 0.0006,
    costPer1kOut: 0.0025,
  },
};

// Cache Claude CLI availability check
let _claudeCliAvailable = null;

/**
 * Check if Claude CLI is installed and working
 */
function isClaudeCliAvailable() {
  if (_claudeCliAvailable !== null) return _claudeCliAvailable;
  try {
    const { execSync } = require('child_process');
    const result = execSync('claude --version', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    _claudeCliAvailable = result.includes('.');
    return _claudeCliAvailable;
  } catch {
    _claudeCliAvailable = false;
    return false;
  }
}

/**
 * Call Claude CLI in print mode (runs from temp dir to avoid CLAUDE.md interference)
 * @param {string} prompt - Combined system + user prompt
 * @param {object} options - { model, timeout }
 * @returns {Promise<string>} Response text
 */
function callClaudeCli(prompt, options = {}) {
  const model = options.model || 'sonnet';
  const timeout = options.timeout || 90000;

  return new Promise((resolve, reject) => {
    // Write prompt to temp file to avoid shell argument limits
    const tmpFile = path.join(os.tmpdir(), `llm_reason_${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, prompt);

    // Run from temp dir so project CLAUDE.md doesn't override the prompt
    const cmd = `powershell -Command "Get-Content '${tmpFile}' | claude -p --model ${model} --output-format text --tools '' --no-session-persistence"`;

    exec(cmd, {
      encoding: 'utf-8',
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      cwd: os.tmpdir(),
    }, (err, stdout, stderr) => {
      // Cleanup temp file
      try { fs.unlinkSync(tmpFile); } catch (e) {}

      if (err && !stdout) {
        reject(new Error(`Claude CLI error: ${err.message}`));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

// Try to load keys from vault
function loadKeyFromVault(secretName) {
  try {
    const vl = require('../security/vault_loader');
    if (!vl.isInitialized()) vl.initVaultFromSecure();
    return vl.getSecret(secretName);
  } catch (e) {
    return null;
  }
}

/**
 * Get API key for a provider (env → vault → null)
 */
function getApiKey(provider) {
  const config = PROVIDERS[provider];
  if (!config) return null;

  // Claude CLI doesn't need an API key - it uses its own auth
  if (config.isClaude_cli) return isClaudeCliAvailable() ? 'claude-cli' : null;

  // Check env first
  const envVal = process.env[config.envKey];
  if (envVal) return envVal;

  // Check vault
  const vaultVal = loadKeyFromVault(config.envKey);
  if (vaultVal) return vaultVal;

  return null;
}

/**
 * Get provider priority list (respects config overrides + runtime force)
 */
function getProviderPriority() {
  // Runtime force takes highest precedence
  if (_runtimeForceProvider) return [_runtimeForceProvider];
  // Config force next
  const config = getLlmConfig();
  if (config.forceProvider) return [config.forceProvider];
  // Config priority order, or default
  return config.providerPriority || ['claude_cli', 'groq', 'anthropic', 'openai', 'kimi'];
}

/**
 * Find first available provider (respects circuit breaker + config)
 */
function findAvailableProvider() {
  const priority = getProviderPriority();
  for (const p of priority) {
    if (getApiKey(p) && !isCircuitOpen(p)) return p;
  }
  // If all circuit-healthy providers are unavailable, try any with a key (ignore circuit)
  for (const p of priority) {
    if (getApiKey(p)) return p;
  }
  return null;
}

/**
 * Get all available providers in priority order (respects circuit breaker)
 */
function getAllAvailableProviders() {
  const priority = getProviderPriority();
  // Available and circuit-healthy first, then circuit-open as last resort
  const healthy = priority.filter(p => getApiKey(p) && !isCircuitOpen(p));
  const broken = priority.filter(p => getApiKey(p) && isCircuitOpen(p));
  return [...healthy, ...broken];
}

/**
 * Make API call to LLM provider
 */
function callLLM(provider, messages, options = {}) {
  const config = PROVIDERS[provider];

  if (!config) {
    return Promise.reject(new Error(`Provider ${provider} not available`));
  }

  // Claude CLI path - combine messages into a single prompt
  if (config.isClaude_cli) {
    const systemMsg = messages.find(m => m.role === 'system')?.content || '';
    const userMsg = messages.find(m => m.role === 'user')?.content || '';
    const combinedPrompt = `${systemMsg}\n\n${userMsg}`;

    return callClaudeCli(combinedPrompt, {
      model: options.model || config.model,
      timeout: options.timeout || 90000,
    }).then(content => ({
      content,
      provider: config.name,
      model: options.model || config.model,
      usage: null, // CLI doesn't report usage
    }));
  }

  // API-based providers need an API key
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    return Promise.reject(new Error(`Provider ${provider} not available`));
  }

  return new Promise((resolve, reject) => {
    let body;
    const headers = { 'Content-Type': 'application/json' };

    if (config.isAnthropic) {
      // Anthropic Messages API format
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = JSON.stringify({
        model: options.model || config.model,
        max_tokens: options.maxTokens || 4096,
        messages: messages.map(m => ({
          role: m.role === 'system' ? 'user' : m.role,
          content: m.content,
        })),
        system: messages.find(m => m.role === 'system')?.content,
      });
    } else {
      // OpenAI-compatible format (Groq, OpenAI, Kimi)
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = JSON.stringify({
        model: options.model || config.model,
        messages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature ?? 0.3,
        response_format: options.jsonMode ? { type: 'json_object' } : undefined,
      });
    }

    const req = https.request({
      hostname: config.host,
      path: config.path,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data);
            let content;
            if (config.isAnthropic) {
              content = json.content?.[0]?.text || '';
            } else {
              content = json.choices?.[0]?.message?.content || '';
            }
            resolve({
              content,
              provider: config.name,
              model: options.model || config.model,
              usage: json.usage,
            });
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`${config.name} API ${res.statusCode}: ${data.substring(0, 500)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Call LLM with automatic fallback to next provider on failure (503, timeout, etc.)
 * Uses circuit breaker pattern: tracks failures and auto-switches away from broken providers.
 */
async function callLLMWithFallback(messages, options = {}) {
  const providers = getAllAvailableProviders();
  if (providers.length === 0) {
    throw new Error('No LLM provider available. Install Claude CLI, or set GROQ_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or KIMI_API_KEY');
  }

  let lastError;
  for (const provider of providers) {
    try {
      const result = await callLLM(provider, messages, options);
      recordSuccess(provider);
      return result;
    } catch (e) {
      lastError = e;
      recordFailure(provider);
      const isRateLimit = e.message.includes('429') || e.message.includes('rate limit');
      console.warn(`[LLM] ${PROVIDERS[provider]?.name || provider} failed${isRateLimit ? ' (RATE LIMITED)' : ''}: ${e.message.substring(0, 100)}, trying next...`);
    }
  }
  throw lastError;
}

// ============================================================================
// Trading Reasoning Engine
// ============================================================================

/**
 * Build trading system prompt dynamically with actual account data
 */
function buildTradingSystemPrompt(accountData) {
  const equity = accountData?.equity || 100000;
  const maxPosition = Math.round(equity * 0.05);
  const dailyLossLimit = Math.round(equity * 0.03);

  return `You are an expert intraday/short-term trader. You trade options, equities, and ETFs.

ACCOUNT CONSTRAINTS (CRITICAL - DO NOT EXCEED):
- Account equity: $${equity.toLocaleString()}
- Max position size: $${maxPosition.toLocaleString()} (5% of equity - for both stocks and options)
- Max 5 concurrent positions
- If down 3% on the day ($${dailyLossLimit.toLocaleString()}), stop trading

POSITION SIZING RULES:
- For EQUITIES: qty = floor($${maxPosition.toLocaleString()} / stock_price). Example: $500 stock → ${Math.floor(maxPosition / 500)} shares max.
- For OPTIONS: qty = floor($${maxPosition.toLocaleString()} / (premium_per_contract * 100)). Example: $5.00 premium → ${Math.floor(maxPosition / 500)} contracts max.
- CRITICAL: "estimatedCost" = qty * premium * 100. This is the TOTAL DOLLAR COST of the trade. You MUST include this.
- The premium is NOT the strike price. A $200 strike call might have a $3.50 premium. estimatedCost = qty * 3.50 * 100.
- Keep estimatedCost under $${maxPosition.toLocaleString()}. If you're unsure, size SMALLER.
- The qty you specify is the EXACT number to trade.

FUNDAMENTAL THESIS REQUIREMENT (MANDATORY):
For EVERY trade decision, you MUST explain WHY the stock is at its current price level:
- What catalyst moved it here? (earnings beat/miss, guidance, FDA, analyst action, sector rotation, macro event)
- Is the current price justified or an overreaction?
- What is the THESIS for your trade? Not just "RSI oversold" but "Earnings beat by 12% but stock dropped 8% on slightly lowered guidance — likely overreaction given strong fundamentals"

Your thesis must include:
1. THE CATALYST: What event/news drove the stock to this price
2. THE MISPRICING: Why you think the market got it wrong (or right)
3. THE EDGE: What specific information or analysis gives you conviction

BAD thesis: "AMD oversold, RSI 28, buying calls"
GOOD thesis: "AMD dropped 8% after earnings beat (+12% EPS) on slightly lowered Q2 guidance. Market overreacted — strong AI/datacenter demand intact, peer NVDA guiding up. Buying oversold bounce with defined risk."

This applies to BOTH day trades AND swing trades. No trade without a fundamental thesis.

BEFORE EVERY TRADE, YOU MUST ANSWER:
1. WHAT is the specific catalyst? (not "volume" or "momentum" - an actual event or data point)
2. WHY now? What happened in the last 30 minutes that makes this actionable?
3. WHERE is your entry? (specific price, not "around here")
4. WHERE is your stop? (specific price, max 3% below entry for longs)
5. WHERE is your target? (specific price, must be at least 2:1 reward/risk)
6. WHAT is the market doing? (don't fight the trend - if SPY is red, reduce size)

If you cannot answer ALL 6 questions with specific numbers, the answer is HOLD/WAIT.

CONVICTION REQUIREMENTS:
- LOW conviction: DO NOT TRADE. Wait.
- MEDIUM conviction: Half size only.
- HIGH conviction: Full size.
- You should be HIGH conviction on fewer than 3 trades per day.

HARD ENTRY RULES (NEVER VIOLATE):
1. DO NOT buy any stock already up more than 15% today - the move has happened, you missed it
2. DO NOT buy any stock within 2% of its daily high - wait for a pullback
3. DO NOT enter if the stock has already reversed 5%+ from its high today - momentum is broken
4. REQUIRE at least one of: RSI < 60, price below VWAP, or a fresh catalyst within 30 minutes
5. If you lost on this symbol today, you CANNOT re-enter it (hard blocked by system)

POSITION MANAGEMENT - THESIS-BASED EXITS:

For EVERY trade entry, you MUST declare:
- TRADE_TYPE: SCALP (1-2 cycles), SWING (full day), or CATALYST (until event resolves)
- THESIS: The specific reason you're entering (e.g., "Bounce off $148 support with volume")
- INVALIDATION: What would BREAK the thesis (e.g., "Closes below $145" or "SPY breaks 590")
- STOP_LEVEL: Based on your invalidation point, NOT an arbitrary percentage
- MAX_HOLD: Maximum time before reviewing (SCALP: 30min, SWING: end of day, CATALYST: 2 days)

EXIT RULES:
1. THESIS INVALIDATED → Exit immediately. The reason you entered no longer holds.
2. MAX_HOLD REACHED with no progress (<1% move) → Exit. Setup didn't work.
3. TRAILING STOP HIT → Exit. Only trail stops UP, never down.
4. DO NOT exit just because price dipped in the first 15-30 minutes. Ask: "Is my thesis still valid?"
5. Options will show large % swings on small stock moves - focus on the UNDERLYING price vs your invalidation level, not the option P&L.

STOP LEVEL GUIDELINES BY TRADE TYPE:
- SCALP: Stop at a nearby technical level (support/resistance), typically 1-3% on stock
- SWING: Stop below key support or below today's low, typically 3-7% on stock
- CATALYST: Stop at thesis-breaking level (e.g., below pre-announcement price), can be wider

IMPORTANT: A -5% unrealized loss with a VALID thesis is better than a -3% realized loss where the stock recovers 10 minutes later. Be patient with valid setups.

WHEN TO ACTUALLY PANIC EXIT (regardless of thesis):
- Position is down 10%+ on the UNDERLYING (not options premium)
- Breaking news fundamentally changes the story
- Market-wide crash (SPY down 2%+ intraday)

TRADING RULES:
- Always have a thesis for every trade
- You CAN hold overnight if thesis supports it
- Prefer options for high-conviction directional bets
- Use equities/ETFs (SPY, QQQ) for broader market plays
- Close losers quickly, let winners run
- No forced EOD flatten - YOU decide what to hold
- Quality over quantity - don't force trades

RESPOND IN JSON ONLY (no markdown code blocks, no explanation outside JSON):
{
  "marketAssessment": "1-2 sentence market read",
  "decisions": [
    {
      "action": "BUY" | "SELL" | "HOLD" | "CLOSE",
      "symbol": "AAPL",
      "vehicle": "OPTION" | "EQUITY",
      "direction": "CALL" | "PUT" | "LONG" | "SHORT",
      "strike": 230,
      "expiry": "2026-02-07",
      "qty": 2,
      "premiumPerContract": 3.50,
      "estimatedCost": "$700",
      "reasoning": "Why this trade makes sense",
      "conviction": "HIGH" | "MEDIUM" | "LOW",
      "target": "$X or X%",
      "stop": "$X or X%",
      "timeframe": "intraday" | "1-3 days" | "1 week",
      "tradeType": "SCALP" | "SWING" | "CATALYST",
      "thesis": "Specific reason for entry (e.g., bounce off $148 support with volume)",
      "invalidation": "What would break the thesis (e.g., closes below $145)",
      "stopLevel": 145.00,
      "maxHoldCycles": 2
    }
  ],
  "needMoreData": ["TSLA options chain", "AMD earnings whisper"],
  "portfolioThoughts": "Overall portfolio assessment and risk"

NOTE on estimatedCost for OPTIONS:
- premiumPerContract = the price per share of the option (e.g., $3.50)
- estimatedCost = qty × premiumPerContract × 100 (e.g., 2 × $3.50 × 100 = $700)
- This is the TOTAL CASH OUTLAY. Keep it under $${maxPosition.toLocaleString()}.

NOTE on new thesis-based fields (REQUIRED for BUY actions):
- tradeType: SCALP (1-2 cycles/30min), SWING (full day), CATALYST (until event)
- thesis: WHY you're entering this specific trade right now
- invalidation: What price/event would prove your thesis WRONG
- stopLevel: The exact price level that invalidates your thesis
- maxHoldCycles: How many 10-min cycles to hold max (SCALP: 3, SWING: 39, CATALYST: 288)
}

If no good trades exist, return empty decisions array with explanation in marketAssessment.`;
}

/**
 * Run trading reasoning with LLM
 * @param {object} dataPackage - All market data for the agent
 * @param {string} preferredProvider - Optional provider override
 * @returns {object} Parsed trading decisions
 */
async function reasonAboutTrades(dataPackage, preferredProvider = null) {
  const provider = preferredProvider || findAvailableProvider();
  if (!provider) {
    throw new Error('No LLM provider available. Install Claude CLI, or set GROQ_API_KEY (free), ANTHROPIC_API_KEY, OPENAI_API_KEY, or KIMI_API_KEY');
  }

  // Build dynamic system prompt with actual account constraints
  const systemPrompt = buildTradingSystemPrompt(dataPackage.account);

  const userMessage = `Here is all available market data. Analyze and decide what trades to make (if any).

CURRENT TIME: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET

ACCOUNT STATE:
${JSON.stringify(dataPackage.account || {}, null, 2)}

CURRENT VERIFIED POSITIONS (from Alpaca API):
${(dataPackage.positions || []).length > 0 ? (dataPackage.positions || []).map(p =>
  `- ${p.symbol}: ${p.qty}x @ $${p.avgEntry?.toFixed(2) || '?'} avg cost, current $${p.currentPrice?.toFixed(2) || '?'}, P&L ${p.unrealizedPL >= 0 ? '+' : ''}$${p.unrealizedPL?.toFixed(2) || '?'} (${p.unrealizedPLPct >= 0 ? '+' : ''}${p.unrealizedPLPct?.toFixed(1) || '?'}%)`
).join('\n') : '[No open positions]'}

CRITICAL: These positions are REAL current holdings from Alpaca. Do NOT recommend entries that conflict with existing positions without acknowledging them.

TODAY'S P&L: $${dataPackage.todayPnL || 0}
TRADES TODAY: ${dataPackage.tradesCount || 0}

${dataPackage.todayStats ? `
YOUR PERFORMANCE TODAY (FIX 8 - Real-Time Scorecard):
Trades: ${dataPackage.todayStats.trades_today}/${dataPackage.todayStats.remaining_trades + dataPackage.todayStats.trades_today} max | Wins: ${dataPackage.todayStats.wins_today} | Losses: ${dataPackage.todayStats.losses_today} | Win Rate: ${dataPackage.todayStats.win_rate_today}
P&L Today: $${dataPackage.todayStats.pnl_today} | Remaining Trades: ${dataPackage.todayStats.remaining_trades}
Blocked Symbols (2+ consecutive losses): ${dataPackage.todayStats.blocked_symbols.length > 0 ? dataPackage.todayStats.blocked_symbols.join(', ') : 'None'}
` : ''}

MARKET CONTEXT:
- Risk Sentiment: ${dataPackage.riskSentiment || 'UNKNOWN'}
- VIX: ${dataPackage.vix ? `$${dataPackage.vix.price} (${dataPackage.vix.changePct?.toFixed(1)}%)` : 'N/A'}

INDICES:
${JSON.stringify(dataPackage.indices || {}, null, 2)}

FUTURES (from overnight/pre-market):
${JSON.stringify(dataPackage.futures || {}, null, 2)}

PRE-MARKET GAPPERS:
${JSON.stringify(dataPackage.gappers || [], null, 2)}

BREAKING NEWS:
${(dataPackage.breakingNews || []).slice(0, 10).map(n => `[${n.sentiment || '?'}] ${n.headline} ${n.symbols?.length ? '(' + n.symbols.join(', ') + ')' : ''}`).join('\n') || 'None available'}

SOCIAL SENTIMENT (StockTwits):
Trending: ${JSON.stringify(dataPackage.trending?.slice(0, 10) || [])}
Sentiment checks: ${JSON.stringify(dataPackage.sentimentChecks || {})}

DATA SOURCE HIERARCHY (most reliable → least):
1. Price action + volume (MOST RELIABLE)
2. Options flow (unusual activity, P/C ratio)
3. Earnings/analyst data (Finnhub)
4. Technical levels (support/resistance, RSI, MACD)
5. Sector relative strength
6. Social sentiment (LEAST RELIABLE - use as CONFIRMATION ONLY, never as primary signal)

NEVER enter a trade SOLELY because a stock is trending on Reddit or StockTwits.
Social buzz AFTER a 50%+ move = retail FOMO = you're the exit liquidity.

EARNINGS TODAY:
${JSON.stringify(dataPackage.earningsToday || [], null, 2)}

ECONOMIC EVENTS:
${JSON.stringify(dataPackage.economicEvents || [], null, 2)}

TECHNICAL SIGNALS:
- Breakouts: ${JSON.stringify(dataPackage.technicals?.breakouts || [])}
- Volume Spikes: ${JSON.stringify(dataPackage.technicals?.volumeSpikes || [])}
- Oversold: ${JSON.stringify(dataPackage.technicals?.oversold || [])}

OPTIONS FLOW:
${JSON.stringify(dataPackage.optionsFlow || [], null, 2)}

TOP QUOTES (price action today):
${JSON.stringify(dataPackage.topQuotes || {}, null, 2)}

DAY WATCHLIST:
${JSON.stringify(dataPackage.dayWatchlist || [], null, 2)}

PREVIOUS REASONING (what you decided last scan):
${JSON.stringify(dataPackage.previousReasoning || [], null, 2)}

TODAY'S EXECUTED TRADES (what you already opened/closed today):
${(dataPackage.todayTrades || []).length > 0 ? dataPackage.todayTrades.map(t => `- ${t.time ? new Date(t.time).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true }) : '?'}: ${t.action} ${t.symbol}${t.underlying && t.underlying !== t.symbol ? ' (' + t.underlying + ')' : ''} ${t.vehicle || ''} ${t.direction || ''} x${t.qty || '?'} — ${t.reason || 'no reason logged'}`).join('\n') : 'No trades executed yet today.'}

CRITICAL THESIS CONTINUITY RULE:
Review your executed trades above. If you JUST opened a position on a symbol (or its underlying), you MUST acknowledge it before taking a contradictory position. For example:
- If you bought AMD CALLS 30 minutes ago, you cannot buy AMD PUTS now without explaining why your thesis REVERSED (e.g., "Played the rebound, now shorting into resistance").
- If you closed a position at a loss, explain what changed before re-entering the same symbol.
- You CAN be bullish then bearish — but the reasoning must show awareness of the prior trade and a clear thesis evolution, not a fresh analysis that ignores what you just did.
- Think of your trades as a NARRATIVE, not isolated events.

FAILED SETUPS TODAY (DO NOT REPEAT):
${(dataPackage.failedSetups || []).length > 0 ? (dataPackage.failedSetups || []).map(f =>
  `- ${f.symbol} ${f.setupType}: Failed ${f.count}x today. ${f.lastReason || f.reason}${f.count >= 2 ? ' — STRONGLY AVOID THIS SETUP' : ''}`
).join('\n') : 'No failed setups today - clean slate'}

PAST TRADE LESSONS (learn from these - pay close attention to patterns):
${(dataPackage.pastLessons || []).slice(-10).map(l => {
  const rule = l.rule?.actionableRule ? ` → RULE: ${l.rule.actionableRule}` : '';
  return `- ${l.symbol} ${l.outcome} (${l.plPct || '?'}): ${l.lesson}${rule}`;
}).join('\n') || 'No past lessons yet.'}

INTRADAY SCORECARD (YOUR performance TODAY - study this before trading):
${dataPackage.intradayScorecard ? `
- Trades opened: ${dataPackage.intradayScorecard.totalOpens || 0}
- Trades closed: ${dataPackage.intradayScorecard.totalCloses || 0}
- Wins today: ${dataPackage.intradayScorecard.winsToday || 0}
- Losses today: ${dataPackage.intradayScorecard.lossesToday || 0}
- Win rate: ${dataPackage.intradayScorecard.winRate || 'N/A'}
- Current streak: ${dataPackage.intradayScorecard.currentStreak?.count || 0} ${dataPackage.intradayScorecard.currentStreak?.type || 'N/A'}
${(dataPackage.intradayScorecard.activeWarnings || []).length > 0 ? '\n⚠️ ACTIVE WARNINGS:\n' + dataPackage.intradayScorecard.activeWarnings.join('\n') : ''}
${(dataPackage.intradayScorecard.troubleSymbols || []).length > 0 ? '\nTROUBLE SYMBOLS (multiple losses today):\n' + dataPackage.intradayScorecard.troubleSymbols.map(t => `- ${t.symbol}: ${t.losses} LOSSES in ${t.totalEntries} entries - STRONGLY RECONSIDER before re-entering`).join('\n') : ''}
` : 'No scorecard available.'}

PER-SYMBOL TRADE HISTORY TODAY:
${dataPackage.intradayScorecard?.symbolHistory ? Object.entries(dataPackage.intradayScorecard.symbolHistory).map(([sym, h]) => `- ${sym}: ${h.opens} entries, ${h.closes} exits`).join('\n') : 'No trades yet.'}

RECENT DAILY PERFORMANCE (green/red day history):
${(dataPackage.recentDailyHistory || []).length > 0 ? dataPackage.recentDailyHistory.map(d => `- ${d.date}: ${d.greenDay ? '🟢 GREEN' : '🔴 RED'} P&L: $${d.dayPnL?.toFixed?.(2) || d.dayPnL || 0} | ${d.dayTrades || 0} trades | Regime: ${d.marketRegime || '?'} | VIX: ${d.vix || '?'}`).join('\n') : 'No history yet (first day).'}
${dataPackage.performanceHistory ? `
CUMULATIVE STATS: $${dataPackage.performanceHistory.cumulativePnL?.toFixed(2) || 0} total | ${dataPackage.performanceHistory.totalTrades || 0} trades | ${dataPackage.performanceHistory.winRate || 'N/A'} win rate
CURRENT STREAK: ${dataPackage.performanceHistory.currentStreak?.count || 0} ${dataPackage.performanceHistory.currentStreak?.type || ''} days
` : ''}

MARKET REGIME: ${dataPackage.marketRegime || 'UNKNOWN'}
VIX LEVEL: ${dataPackage.marketVix || 'N/A'}

MARKET OVERVIEW (sector leaders/laggards, yield curve):
${dataPackage.marketOverview ? `
- VIX (FRED): ${dataPackage.marketOverview.vixFRED || 'N/A'} (${dataPackage.marketOverview.vixLevel || '?'})
- Yield Curve Spread: ${dataPackage.marketOverview.yieldCurve?.spread?.toFixed(2) || 'N/A'}% (${dataPackage.marketOverview.yieldCurve?.signal || '?'})
- Top Gainers: ${(dataPackage.marketOverview.topGainers || []).map(g => `${g.symbol} +${g.changesPercentage?.toFixed(1)}%`).join(', ') || 'N/A'}
- Top Losers: ${(dataPackage.marketOverview.topLosers || []).map(l => `${l.symbol} ${l.changesPercentage?.toFixed(1)}%`).join(', ') || 'N/A'}
- Most Active: ${(dataPackage.marketOverview.mostActive || []).map(a => a.symbol).join(', ') || 'N/A'}
` : 'Not available'}

EARNINGS CALENDAR (next 7 days - CRITICAL for catalyst timing):
${(dataPackage.earningsCalendar || []).length > 0 ? dataPackage.earningsCalendar.map(e => `- ${e.symbol}: ${e.date} ${e.hour || ''} | EPS Est: ${e.epsEstimate || 'N/A'}`).join('\n') : 'No upcoming earnings data available.'}

OPTIONS IV ENVIRONMENT (IV, put/call ratio, expected move - CRITICAL for vehicle selection):
${Object.keys(dataPackage.optionsEnvironment || {}).length > 0 ? Object.entries(dataPackage.optionsEnvironment).map(([sym, d]) =>
  `- ${sym}: IV=${d.avgIV} | P/C Ratio=${d.putCallRatio || 'N/A'} | Expected Move=${d.expectedMove} | Call Vol=${d.callVolume || 0} Put Vol=${d.putVolume || 0}`
).join('\n') : 'No options data available.'}

Use IV data to decide vehicle: HIGH IV → use spreads or sell premium or trade equities (don't overpay for options). LOW IV → good for buying calls/puts.
Put/Call Ratio > 1 = bearish skew (more puts being bought), < 0.7 = bullish skew.

SHORT INTEREST & RSI (from Finviz):
${Object.keys(dataPackage.shortInterest || {}).length > 0 ? Object.entries(dataPackage.shortInterest).map(([sym, d]) =>
  `- ${sym}: Short Float=${d.shortFloat} | Short Ratio=${d.shortRatio || 'N/A'} | RSI(14)=${d.rsi || 'N/A'} | Target=$${d.targetPrice || 'N/A'} | Analyst Rec=${d.analystRec || 'N/A'} (1=Strong Buy, 5=Strong Sell)`
).join('\n') : 'No short interest data available.'}

RSI INTERPRETATION (MANDATORY):
- RSI < 30: OVERSOLD (potential bounce, but confirm with volume + catalyst)
- RSI 30-40: Approaching oversold (watch for reversal signals)
- RSI 40-60: NEUTRAL (no directional RSI signal - do NOT cite RSI as bullish or bearish)
- RSI 60-70: Approaching overbought (consider trimming)
- RSI > 70: OVERBOUGHT (potential pullback risk)
NEVER call RSI 40-60 "oversold" or "overbought". It means NOTHING in that range.

High short interest (>15%) = potential squeeze if bullish catalyst.

ANALYST RATINGS & PRICE TARGETS:
${Object.keys(dataPackage.analystRatings || {}).length > 0 ? Object.entries(dataPackage.analystRatings).map(([sym, d]) =>
  `- ${sym}: Buy=${d.buy || 0} Hold=${d.hold || 0} Sell=${d.sell || 0} StrongBuy=${d.strongBuy || 0} | Target: Low=$${d.targetLow || '?'} Mean=$${d.targetMean || '?'} High=$${d.targetHigh || '?'}`
).join('\n') : 'No analyst data available.'}

INTRADAY PRICE ACTION (5-min bars - recent trend/momentum):
${Object.keys(dataPackage.intradayBars || {}).length > 0 ? Object.entries(dataPackage.intradayBars).map(([sym, bars]) => {
  if (!bars || bars.length === 0) return `- ${sym}: No bars`;
  const first = bars[0];
  const last = bars[bars.length - 1];
  const trend = last.c > first.o ? 'UPTREND' : last.c < first.o ? 'DOWNTREND' : 'FLAT';
  const range = Math.max(...bars.map(b => b.h)) - Math.min(...bars.map(b => b.l));
  const avgVol = Math.round(bars.reduce((s, b) => s + (b.v || 0), 0) / bars.length);
  return `- ${sym}: ${trend} | Last hour range: $${range.toFixed(2)} | Last: $${last.c.toFixed(2)} | Avg 5m vol: ${avgVol}`;
}).join('\n') : 'No intraday bar data available.'}

Use intraday bars to understand SHORT-TERM momentum and trend. Uptrend = strength, potential continuation. Downtrend = weakness, wait for reversal signal. Range-bound = choppy, avoid.

VWAP & INTRADAY RANGE (where price is relative to today's action):
${Object.keys(dataPackage.vwapData || {}).length > 0 ? Object.entries(dataPackage.vwapData).map(([sym, d]) =>
  `- ${sym}: VWAP=$${d.vwap} (${d.priceVsVwap}, ${d.distFromVwap} away) | Today: Open=$${d.todayOpen} Low=$${d.todayLow} High=$${d.todayHigh} Now=$${d.currentPrice} | Position in range: ${d.positionInRange}`
).join('\n') : 'No VWAP data available.'}

VWAP is the institutional benchmark. Above VWAP = bullish, below = bearish. Stocks at 90-100% of range = near HOD (don't chase longs). Stocks at 0-10% of range = near LOD (don't chase shorts).

TODAY'S MOVE CONTEXT (how far stocks have ALREADY moved - CRITICAL for entry timing):
${Object.keys(dataPackage.todayMoveContext || {}).length > 0 ? Object.entries(dataPackage.todayMoveContext).map(([sym, d]) =>
  `- ${sym}: ${d.direction} ${d.changePct} (${d.moveLabel}) | Near HOD: ${d.nearHOD} | Near LOD: ${d.nearLOD} | Market Cap: ${d.marketCap}`
).join('\n') : 'No move context available.'}

ENTRY TIMING RULES (NON-NEGOTIABLE):
- If a stock is UP >10% today AND near HOD → DO NOT BUY. Wait for pullback to VWAP or consolidation.
- If a stock is DOWN >10% today AND near LOD → DO NOT SHORT. Wait for bounce to fail.
- Stocks that moved >20% today are EXTREME moves. Position size should be HALF of normal.
- If entering a momentum play that's already extended, use a TIGHT stop. You are LATE.
- The best entries are pullbacks within trends, NOT chasing vertical moves.
- "Already moved 100% today" means you're buying someone else's exit. Size accordingly (1-2% max).

ENTRY QUALITY FILTERS:
1. Do NOT enter "oversold bounce" plays unless RSI is actually < 35 AND there's a volume surge or catalyst
2. Do NOT enter the same direction on a stock that's already failed you today (check failed setups below)
3. Do NOT cite a single indicator as your thesis — you need at least 2 confirming signals
4. If a stock has dropped 20%+ in a week, it's probably dropping for a reason — don't catch the knife without a clear catalyst for reversal

MARKET CAP & POSITION SIZING AWARENESS:
${Object.keys(dataPackage.marketCapData || {}).length > 0 ? Object.entries(dataPackage.marketCapData).map(([sym, mc]) =>
  `- ${sym}: Market Cap ${mc}`
).join('\n') : 'No market cap data available.'}

Position sizing by market cap:
- Mega/Large-cap (>$10B): Normal size (up to 5% of account)
- Mid-cap ($2B-$10B): Moderate size (up to 4% of account)
- Small-cap ($500M-$2B): Reduced size (up to 3% of account)
- Micro-cap (<$500M): MINIMUM size (up to 2% of account) - these are HIGH RISK, LOW LIQUIDITY
- Penny stocks or <$100M market cap: AVOID or absolute minimum size

PHASE OF TRADING DAY:
${(() => {
  const etNow = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false });
  const [h, m] = etNow.split(':').map(Number);
  const mins = h * 60 + m;
  if (mins < 585) return 'PRE-MARKET (before 9:30). Planning phase only. Set watchlist.';
  if (mins < 595) return '⚠️ OPENING RANGE (9:30-9:55 AM). DANGEROUS - wide spreads, false breakouts, gap fills. Use SMALLER size. Wait for 10 AM for cleaner action.';
  if (mins < 690) return '✅ MORNING TREND (10:00-11:30 AM). BEST time for momentum plays. Trends established, volume strong. Go for it.';
  if (mins < 840) return '😴 MIDDAY LULL (11:30 AM-2:00 PM). Low volume, choppy, false signals. REDUCE activity. Only take A+ setups.';
  if (mins < 930) return '⚡ POWER HOUR SETUP (2:00-3:30 PM). Volume picking up. Watch for trend continuation or reversal setups.';
  if (mins < 960) return '🔥 POWER HOUR (3:30-4:00 PM). Strong moves, follow-through or EOD reversals. Good time to act.';
  return 'AFTER HOURS. Market closed. Assess and plan for tomorrow.';
})()}

MULTI-DAY PRICE ACTION (5d and 20d trends - CRITICAL for understanding the bigger picture):
${Object.keys(dataPackage.multiDayHistory || {}).length > 0 ? Object.entries(dataPackage.multiDayHistory).map(([sym, d]) =>
  `- ${sym}: Now $${d.current} | 5d: ${d.change5d} (${d.trend5d}) | 20d: ${d.change20d} (${d.trend20d}) | 30d Range: $${d.low30d}-$${d.high30d} | Position in range: ${d.rangePosition}`
).join('\n') : 'No multi-day data available.'}

Use multi-day trends to understand WHERE in the trend you are:
- Near 30d lows (range 0-20%) = potential bounce/reversal or breakdown. Look for support.
- Near 30d highs (range 80-100%) = extended, potential pullback or breakout. Watch for resistance.
- 5d UP + 20d DOWN = short-term bounce in downtrend (potential short/fade). 5d DOWN + 20d UP = pullback in uptrend (potential buy the dip).

DATA SOURCE STATUS (what successfully pulled this tick):
${Object.keys(dataPackage.dataStatus || {}).length > 0 ? Object.entries(dataPackage.dataStatus).map(([source, status]) =>
  `- ${source}: ${status}`
).join('\n') : 'No status available.'}

${dataPackage.macroAlpha ? `
---- V9 MACROSTRATEGY MONTHLY ALPHA SCORES (LEGACY) ----
These are ML predictions for MONTHLY-horizon returns. Use as a directional TILT, NOT a timing signal.
V9 Q1 (top quintile) = model expects outperformance this month. V9 Q5 (bottom) = expects underperformance.
Combine with your intraday thesis: V9 Q1 stock + your bullish setup = STRONGER conviction. V9 Q5 + bullish setup = LOWER conviction (trade against the model at your own risk).
${typeof dataPackage.macroAlpha === 'string' ? dataPackage.macroAlpha : JSON.stringify(dataPackage.macroAlpha, null, 2)}
` : ''}

${dataPackage.v9Predictions ? `
---- V9 MACROSTRATEGY PREDICTIONS (WALK-FORWARD ML ENSEMBLE) ----
Model: XGBoost + Weekly_Momentum_Kelly execution
Backtest (2023-2025): ${dataPackage.v9Predictions.model_metrics?.backtest_return || '73.80%'} return, ${dataPackage.v9Predictions.model_metrics?.backtest_sharpe || 3.98} Sharpe, ${dataPackage.v9Predictions.model_metrics?.backtest_max_dd || '-8.64%'} max DD (vs SPY 14.29%)
Prediction horizon: 10-day forward returns (primary), blended 5d/21d/63d
Rebalance: Weekly (Mondays)
Freshness: ${dataPackage.v9Predictions.freshness?.ageDays || '?'}d old ${dataPackage.v9Predictions.freshness?.isStale ? '(STALE - treat with caution)' : '(current)'}

QUINTILE INTERPRETATION:
- Q1 (top 20%): STRONG LONG bias for swing trades. Best expected returns. In backtest, Q1 delivered ~71.73% annualized.
- Q2 (60-80th pct): Above-average. Good secondary candidates.
- Q3 (40-60th pct): NEUTRAL. No strong alpha signal.
- Q4-Q5 (bottom 40%): Weak/negative expected returns. AVOID for longs, consider for shorts.

${dataPackage.v9Predictions.relevantPredictions?.length > 0 ? `PREDICTIONS FOR YOUR WATCHLIST SYMBOLS:
${dataPackage.v9Predictions.relevantPredictions.map(p => `- ${p.symbol}: Q${p.quintile} score=${p.score.toFixed(4)} (${p.signal}) rank #${p.rank}/${dataPackage.v9Predictions.universe_size || '?'}`).join('\n')}` : 'No V9 predictions for current watchlist symbols.'}

TOP 15 LONG CANDIDATES (Q1-Q2 with momentum filter):
${dataPackage.v9Predictions.topLongs?.slice(0, 15).map(p => `- ${p.symbol}: Q${p.quintile} score=${p.score.toFixed(4)} (${p.signal}) rank #${p.rank}`).join('\n') || 'N/A'}

BOTTOM 10 (Q5 - AVOID for longs):
${dataPackage.v9Predictions.bottomPicks?.slice(0, 10).map(p => `- ${p.symbol}: Q${p.quintile} score=${p.score.toFixed(4)} (${p.signal}) rank #${p.rank}`).join('\n') || 'N/A'}

Next rebalance due: ${dataPackage.v9Predictions.portfolio_action?.rebalance_due || 'N/A'}

HOW TO USE V9 FOR TRADING:
- **Swing trades (multi-day holds):** V9 is STRONGEST signal. Q1 = highest conviction longs. Align swing entries with V9 top quintile.
- **Day trades:** V9 provides directional TILT. Q1 + bullish intraday setup = stronger conviction. Q5 + bullish setup = lower conviction (model disagrees).
- **ULTIMATE SETUPS:** V9 Q1 + IASM ALL_LONG = highest conviction long (monthly + intraday models agree). V9 Q5 + IASM ALL_SHORT = highest conviction fade.
- **Risk sizing:** Q1 longs can take FULL position size. Q4-Q5 longs should be HALF size (trading against the model) or avoided entirely.
- V9 rebalances weekly, so use for longer-term directional bias, not minute-to-minute timing.

CAUTION: Backtest performance includes execution configs tuned on same holdout period. Treat as in-sample estimates. Real performance will be lower.
` : ''}

${dataPackage.iasmSignals ? `
---- IASM MULTI-HORIZON INTRADAY ALPHA SIGNALS ----
ML predictions from IASM (XGBoost+LightGBM on 5-min bars). Predicts returns across multiple horizons (15m/30m/1h/4h).
${dataPackage.iasmSignals.horizonsAvailable?.length > 0 ? `Active horizons: ${dataPackage.iasmSignals.horizonsAvailable.join(', ')}` : ''}
${dataPackage.iasmSignals.freshness ? `Signal freshness: ${dataPackage.iasmSignals.freshness.ageMinutes}m old ${dataPackage.iasmSignals.freshness.isFresh ? '(FRESH)' : dataPackage.iasmSignals.freshness.isStale ? '(STALE - use with caution)' : '(aging)'}` : ''}

MULTI-HORIZON CONSENSUS (KEY CONCEPT):
- consensus=ALL_LONG: ALL horizons agree bullish = HIGHEST CONVICTION long signal
- consensus=ALL_SHORT: ALL horizons agree bearish = HIGHEST CONVICTION fade
- consensus=MIXED: Horizons disagree = LOWER conviction, short-term vs long-term conflict
- IASM ALL_LONG + V9 Q1 = ULTIMATE long setup (multi-horizon + monthly model agree)
- IASM ALL_SHORT + V9 Q5 = ULTIMATE fade setup
- MIXED signals: Use the timeframe matching your trade (15m for scalps, 4h for swings)

CONFIDENCE LEVELS:
- > 0.7 = STRONG. Trust for entry timing.
- 0.6-0.7 = MODERATE. Confirmation signal.
- < 0.6 = WEAK. Ignore.

${dataPackage.iasmSignals.relevantSignals?.length > 0 ? `SIGNALS FOR YOUR WATCHLIST SYMBOLS:
${dataPackage.iasmSignals.relevantSignals.map(s => `- ${s.symbol}: ${s.direction} (conf=${(s.confidence * 100).toFixed(0)}%, exp=${s.expected_return_pct > 0 ? '+' : ''}${s.expected_return_pct?.toFixed(2)}%)${s.consensus ? ' [' + s.consensus + ']' : ''}${s.context ? ' | ' + s.context : ''}`).join('\n')}` : 'No signals match your current watchlist symbols.'}

${dataPackage.iasmSignals.topLongs?.length > 0 ? `TOP LONG OPPORTUNITIES (IASM):
${dataPackage.iasmSignals.topLongs.map(s => `- ${s.symbol}: conf=${(s.confidence * 100).toFixed(0)}%, exp=${s.expected_return_pct > 0 ? '+' : ''}${s.expected_return_pct?.toFixed(2)}%${s.consensus ? ' [' + s.consensus + ']' : ''}${s.context ? ' | ' + s.context : ''}`).join('\n')}` : ''}

${dataPackage.iasmSignals.topShorts?.length > 0 ? `TOP FADE CANDIDATES (IASM SHORT):
${dataPackage.iasmSignals.topShorts.map(s => `- ${s.symbol}: conf=${(s.confidence * 100).toFixed(0)}%, exp=${s.expected_return_pct > 0 ? '+' : ''}${s.expected_return_pct?.toFixed(2)}%${s.consensus ? ' [' + s.consensus + ']' : ''}${s.context ? ' | ' + s.context : ''}`).join('\n')}` : ''}
` : ''}

OPPORTUNITY MINDSET:
- There are UNLIMITED opportunities in the market at any time. If nothing looks good in tech, look at energy. If not energy, look at financials, commodities, or ETFs.
- You should ALWAYS be scanning for the best risk/reward setup across ALL sectors and asset types, not just a narrow watchlist.
- If your current positions aren't working, don't stubbornly hold - rotate to where the action IS.
- The top gainers, losers, most active, and trending lists are your opportunity pool. Something is ALWAYS moving.
- Don't sit out unless the market is genuinely dangerous (VIX spike, flash crash, circuit breakers). Normal choppy action is fine - just size appropriately.
- If you see 0 opportunities, you're not looking hard enough. Re-examine the data.

RISK MANAGEMENT (applied AFTER finding opportunities):
- If your win rate today is below 40%, reduce position sizes but KEEP TRADING opportunities you find.
- If you have 2+ losses on the same underlying today, move on to a DIFFERENT symbol - don't keep hitting the same wall.
- Consider time of day: first 15 minutes can be trappy, power hour (3-4 PM) often has clean moves. But opportunities exist ALL day.
- If you're on a losing streak, REDUCE SIZE but don't stop. Smaller positions on better setups.
- Capital preservation matters, but so does capital deployment. Cash sitting idle earns nothing.

Analyze everything and respond with your trading decisions in JSON only. No markdown. REMEMBER: size positions within the account limits. Find the BEST opportunity in the data - something is always moving.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  // Try preferred provider first, then fall back through all available
  const providers = preferredProvider ? [preferredProvider, ...getAllAvailableProviders().filter(p => p !== preferredProvider)] : getAllAvailableProviders();
  let result;
  let lastError;
  for (const p of providers) {
    try {
      result = await callLLM(p, messages, {
        temperature: 0.3,
        maxTokens: 2048,
        jsonMode: !PROVIDERS[p]?.isAnthropic && !PROVIDERS[p]?.isClaude_cli,
      });
      break;
    } catch (e) {
      lastError = e;
      console.warn(`[LLM] ${PROVIDERS[p]?.name || p} failed for trading reasoning: ${e.message.substring(0, 100)}, trying next...`);
    }
  }
  if (!result) throw lastError || new Error('All LLM providers failed');

  // Parse JSON from response
  let parsed;
  try {
    // Try direct parse
    parsed = JSON.parse(result.content);
  } catch (e) {
    // Try extracting JSON from markdown code block
    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1]);
    } else {
      // Try finding JSON object in text
      const braceMatch = result.content.match(/\{[\s\S]*\}/);
      if (braceMatch) {
        parsed = JSON.parse(braceMatch[0]);
      } else {
        throw new Error(`Could not parse LLM response as JSON: ${result.content.substring(0, 200)}`);
      }
    }
  }

  return {
    ...parsed,
    _meta: {
      provider: result.provider,
      model: result.model,
      usage: result.usage,
    },
  };
}

/**
 * Ask LLM for more data analysis on specific items
 */
async function analyzeSpecificData(question, data, preferredProvider = null) {
  const provider = preferredProvider || findAvailableProvider();
  if (!provider) throw new Error('No LLM provider available');

  const messages = [
    { role: 'system', content: 'You are a professional trader. Analyze the data and give a brief, actionable assessment. Be specific about entries, exits, and risk.' },
    { role: 'user', content: `${question}\n\nData:\n${JSON.stringify(data, null, 2)}` },
  ];

  return callLLM(provider, messages, { temperature: 0.3, maxTokens: 1024 });
}

/**
 * Get list of available providers and their status (including circuit breaker state)
 */
function getProviderStatus() {
  const status = {};
  for (const [key, config] of Object.entries(PROVIDERS)) {
    const hasKey = !!getApiKey(key);
    const circuit = getCircuitState(key);
    status[key] = {
      name: config.name,
      available: hasKey,
      model: config.model,
      costPer1kIn: config.costPer1kIn,
      costPer1kOut: config.costPer1kOut,
      circuit: circuit.state,
      failures: circuit.failures,
    };
  }
  status.activeProvider = findAvailableProvider();
  status.priority = getProviderPriority();
  status.forcedProvider = _runtimeForceProvider || getLlmConfig().forceProvider || null;
  return status;
}

/**
 * Run a health check against all providers. Returns which are working.
 */
async function healthCheck() {
  const results = {};
  const testMsg = [{ role: 'user', content: 'Reply with exactly: OK' }];

  for (const [key] of Object.entries(PROVIDERS)) {
    if (!getApiKey(key)) {
      results[key] = { status: 'no_key' };
      continue;
    }
    const start = Date.now();
    try {
      const resp = await callLLM(key, testMsg, { maxTokens: 10, timeout: 15000 });
      results[key] = { status: 'ok', latencyMs: Date.now() - start, response: resp.content?.substring(0, 20) };
      recordSuccess(key);
    } catch (e) {
      results[key] = { status: 'error', latencyMs: Date.now() - start, error: e.message.substring(0, 100) };
    }
  }
  return results;
}

/**
 * Quick shortcut: force Groq as the only provider (for when Claude is down)
 */
function useGroqOnly() {
  forceProvider('groq');
}

/**
 * Quick shortcut: reset to auto-detection (normal mode)
 */
function useAuto() {
  forceProvider(null);
}

module.exports = {
  // Core API
  callLLM,
  callLLMWithFallback,
  callClaudeCli,

  // Trading
  reasonAboutTrades,
  analyzeSpecificData,

  // Provider management
  getProviderStatus,
  findAvailableProvider,
  getAllAvailableProviders,
  isClaudeCliAvailable,
  getProviderPriority,

  // Failover control
  forceProvider,
  useGroqOnly,
  useAuto,
  reloadConfig,
  healthCheck,

  // Circuit breaker (for external monitoring)
  getCircuitState,
  recordSuccess,
  recordFailure,
  isCircuitOpen,

  PROVIDERS,
};
