# New Discord Channels Usage Guide

## Channels Created

### 1. macrostrategy-v9
- **ID:** 1471437662480109620
- **Topic:** MacroStrategy v9 genetic algorithm trading signals
- **Emoji:** 🧬
- **Purpose:** Post signals and updates from the MacroStrategy V9 genetic algorithm

### 2. iasm-signals
- **ID:** 1471437663742722143
- **Topic:** IASM (Intraday Adaptive Strategy Manager) trading signals
- **Emoji:** ⚡
- **Purpose:** Post real-time signals from the IASM trading system

---

## How to Send Messages

### Method 1: Using the Discord Channels Module

```javascript
const discordChannels = require('./discord_channels');

// Send to MacroStrategy V9 channel
await discordChannels.macrostrategyV9(
  '🧬 **New Signal from MacroStrategy V9**\n\n' +
  '**Symbol:** AAPL\n' +
  '**Action:** BUY\n' +
  '**Confidence:** 85%\n' +
  '**Target:** $180'
);

// Send to IASM Signals channel
await discordChannels.iasmSignals(
  '⚡ **IASM Alert**\n\n' +
  '**Symbol:** SPY\n' +
  '**Signal:** Strong momentum detected\n' +
  '**Timeframe:** 5min\n' +
  '**Action:** Monitor for entry'
);
```

### Method 2: Using the Generic Send Method

```javascript
const discordChannels = require('./discord_channels');

// Using channel key
await discordChannels.send('macrostrategyV9', 'Your message here');
await discordChannels.send('iasmSignals', 'Your message here');
```

---

## Integration Examples

### MacroStrategy V9 Integration

```javascript
// In your MacroStrategy V9 script
const discordChannels = require('./trading_agents/discord_channels');

async function postMacroSignal(signal) {
  const message = `
🧬 **MacroStrategy V9 Signal**

**Symbol:** ${signal.symbol}
**Action:** ${signal.action}
**Confidence:** ${signal.confidence}%
**Entry:** $${signal.entry}
**Target:** $${signal.target}
**Stop Loss:** $${signal.stopLoss}

**Strategy:** ${signal.strategy}
**Timeframe:** ${signal.timeframe}
**Generated:** ${new Date().toLocaleString()}
  `.trim();

  await discordChannels.macrostrategyV9(message);
}

// Usage
await postMacroSignal({
  symbol: 'TSLA',
  action: 'BUY',
  confidence: 82,
  entry: 245.50,
  target: 265.00,
  stopLoss: 238.00,
  strategy: 'Genetic Algorithm - Population Best',
  timeframe: 'Daily'
});
```

### IASM Integration

```javascript
// In your IASM script
const discordChannels = require('./trading_agents/discord_channels');

async function postIasmSignal(signal) {
  const message = `
⚡ **IASM Signal**

**Symbol:** ${signal.symbol}
**Type:** ${signal.type}
**Timeframe:** ${signal.timeframe}
**Strength:** ${signal.strength}/10

**Current Price:** $${signal.price}
**Volume:** ${signal.volume}
**RSI:** ${signal.rsi}

**Action:** ${signal.recommendation}
**Timestamp:** ${new Date().toLocaleString()}
  `.trim();

  await discordChannels.iasmSignals(message);
}

// Usage
await postIasmSignal({
  symbol: 'SPY',
  type: 'Momentum Breakout',
  timeframe: '5min',
  strength: 8,
  price: 485.23,
  volume: '2.5M',
  rsi: 68,
  recommendation: 'Watch for pullback entry'
});
```

---

## Channel Configuration

All channel configurations are stored in:

**File:** `trading_agents/data/discord_channels.json`

```json
{
  "guildId": "1469178833541402864",
  "channels": {
    "general": "1469178834313019414",
    "preMarket": "1469187605256994826",
    "swingScanner": "1469187605953515663",
    "afterHours": "1469187606582530254",
    "overnight": "1469187607299883110",
    "tradeExecution": "1469187607975034890",
    "alerts": "1469187608700518602",
    "pnl": "1469187609392713819",
    "systemStatus": "1469187609837174989",
    "macrostrategyV9": "1471437662480109620",
    "iasmSignals": "1471437663742722143"
  }
}
```

---

## Testing

To test the channels:

```bash
node trading_agents/test_new_channels.js
```

This will send test messages to both channels and verify they're working correctly.

---

## Troubleshooting

### Messages Not Appearing

1. **Check bot token is loaded:**
   ```javascript
   const status = discordChannels.getStatus();
   console.log(status.hasToken); // Should be true
   ```

2. **Verify channel IDs are loaded:**
   ```javascript
   const status = discordChannels.getStatus();
   console.log(status.channels); // Should include macrostrategyV9 and iasmSignals
   ```

3. **Reload configuration:**
   ```javascript
   discordChannels.reload();
   ```

### Permission Issues

- Ensure the Discord bot has "Send Messages" permission in the channels
- Check that the bot is a member of the Trading Agents category
- Verify the bot token in `config.json` is valid

---

## Created: 2026-02-12

Channels were created and configured by the teleclaude Discord channel setup script.
