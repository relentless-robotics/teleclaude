/**
 * LLM Reasoning Client
 *
 * Multi-provider LLM client for agent reasoning.
 * Supports: Claude CLI (uses existing subscription), Groq (FREE), Anthropic API, OpenAI, Kimi
 *
 * Priority: Claude CLI Haiku (cheap, no extra key) → Groq (free) → Anthropic API → OpenAI → Kimi
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// Provider configs
const PROVIDERS = {
  claude_cli: {
    name: 'Claude CLI (Haiku)',
    model: 'haiku',
    costPer1kIn: 0.001,   // Haiku pricing via subscription
    costPer1kOut: 0.005,
    isClaude_cli: true,
  },
  groq: {
    name: 'Groq',
    host: 'api.groq.com',
    path: '/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    envKey: 'GROQ_API_KEY',
    costPer1kIn: 0,      // Free tier
    costPer1kOut: 0,
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
  const model = options.model || 'haiku';
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
 * Find first available provider
 */
function findAvailableProvider() {
  const priority = ['claude_cli', 'groq', 'anthropic', 'openai', 'kimi'];
  for (const p of priority) {
    if (getApiKey(p)) return p;
  }
  return null;
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

// ============================================================================
// Trading Reasoning Engine
// ============================================================================

const TRADING_SYSTEM_PROMPT = `You are an expert intraday/short-term trader managing a $100K paper trading account with Level 3 options access. You trade options, equities, and ETFs.

YOUR JOB: Analyze the market data provided and make trading decisions. You reason like a professional trader - considering momentum, sentiment, catalysts, risk/reward, and market regime.

RULES:
- Max 5% of account per position
- Max 5 concurrent positions
- If down 3% on the day, stop trading
- Always have a thesis for every trade
- You CAN hold overnight if thesis supports it
- Prefer options for high-conviction directional bets
- Use equities/ETFs (SPY, QQQ) for broader market plays
- Close losers quickly, let winners run
- No forced EOD flatten - YOU decide what to hold

RESPOND IN JSON ONLY (no markdown code blocks, no explanation outside JSON) with this structure:
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
      "qty": 5,
      "reasoning": "Why this trade makes sense",
      "conviction": "HIGH" | "MEDIUM" | "LOW",
      "target": "$X or X%",
      "stop": "$X or X%",
      "timeframe": "intraday" | "1-3 days" | "1 week"
    }
  ],
  "needMoreData": ["TSLA options chain", "AMD earnings whisper"],
  "portfolioThoughts": "Overall portfolio assessment and risk"
}

If no good trades exist, return empty decisions array with explanation in marketAssessment. Quality over quantity - don't force trades.`;

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

  const userMessage = `Here is all available market data. Analyze and decide what trades to make (if any).

CURRENT TIME: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET

ACCOUNT STATE:
${JSON.stringify(dataPackage.account || {}, null, 2)}

CURRENT POSITIONS:
${JSON.stringify(dataPackage.positions || [], null, 2)}

TODAY'S P&L: $${dataPackage.todayPnL || 0}
TRADES TODAY: ${dataPackage.tradesCount || 0}

MARKET CONTEXT:
- Risk Sentiment: ${dataPackage.riskSentiment || 'UNKNOWN'}
- VIX: ${dataPackage.vix ? `$${dataPackage.vix.price} (${dataPackage.vix.changePct?.toFixed(1)}%)` : 'N/A'}

INDICES:
${JSON.stringify(dataPackage.indices || {}, null, 2)}

FUTURES (from overnight/pre-market):
${JSON.stringify(dataPackage.futures || {}, null, 2)}

PRE-MARKET GAPPERS:
${JSON.stringify(dataPackage.gappers || [], null, 2)}

SOCIAL SENTIMENT (StockTwits):
Trending: ${JSON.stringify(dataPackage.trending?.slice(0, 10) || [])}
Sentiment checks: ${JSON.stringify(dataPackage.sentimentChecks || {})}

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

Analyze everything and respond with your trading decisions in JSON only. No markdown.`;

  const messages = [
    { role: 'system', content: TRADING_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  const result = await callLLM(provider, messages, {
    temperature: 0.3,
    maxTokens: 2048,
    jsonMode: !PROVIDERS[provider]?.isAnthropic && !PROVIDERS[provider]?.isClaude_cli,
  });

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
 * Get list of available providers and their status
 */
function getProviderStatus() {
  const status = {};
  for (const [key, config] of Object.entries(PROVIDERS)) {
    const hasKey = !!getApiKey(key);
    status[key] = {
      name: config.name,
      available: hasKey,
      model: config.model,
      costPer1kIn: config.costPer1kIn,
      costPer1kOut: config.costPer1kOut,
    };
  }
  status.activeProvider = findAvailableProvider();
  return status;
}

module.exports = {
  callLLM,
  callClaudeCli,
  reasonAboutTrades,
  analyzeSpecificData,
  getProviderStatus,
  findAvailableProvider,
  isClaudeCliAvailable,
  PROVIDERS,
};
