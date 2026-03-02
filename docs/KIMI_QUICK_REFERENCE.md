# Kimi K2.5 Quick Reference

One-page cheat sheet for Kimi integration.

## Setup (One-Time)

```bash
# 1. Sign up: https://platform.moonshot.ai/
# 2. Add $5 balance (get $10 with bonus)
# 3. Generate API key in Console
# 4. Set environment variable:
set KIMI_API_KEY=your-key-here
# 5. Test:
node utils/test_kimi.js
```

---

## Basic Usage

### Smart Routing (Recommended)

```javascript
const { route } = require('./utils/model_router');

// Auto-picks best model
const result = await route('Generate a React component for user profile');
console.log(result.content);
```

### Direct Kimi Usage

```javascript
const { chat } = require('./utils/kimi_client');

const result = await chat('Build a login form with validation');
console.log(result.content);
console.log(`Cost: $${result.cost.total}`);
```

### Code Generation

```javascript
const { generateCode } = require('./utils/kimi_client');

const result = await generateCode('A TypeScript function to parse CSV files');
```

### Visual Coding

```javascript
const { generateFromVisual } = require('./utils/kimi_client');

const result = await generateFromVisual(`
  A card component with:
  - Image at top
  - Title and description
  - Button at bottom
  - Hover animation
`);
```

---

## Model Selection Guide

| Task | Model | Why |
|------|-------|-----|
| React/Vue components | **Kimi** | Best frontend model |
| UI from design | **Kimi** | Visual coding |
| Landing pages | **Kimi** | UI + animations |
| Security analysis | **Opus** | Deep reasoning |
| Browser automation | **Sonnet** | Proven tool |
| File search | **Haiku** | Fast & cheap |

---

## Cost Reference

| Model | Input | Output | Typical Task |
|-------|-------|--------|--------------|
| **Kimi** | $0.60/M | $2.50/M | **$0.023** |
| Haiku | $0.25/M | $1.25/M | $0.011 |
| Sonnet | $3.00/M | $15.00/M | $0.135 |
| Opus | $15.00/M | $75.00/M | $0.675 |

*Typical task = 5K input, 8K output tokens*

---

## Router Functions

### Get Recommendation

```javascript
const { suggest } = require('./utils/model_router');

const rec = suggest('Task description');
console.log(rec.recommended);  // 'kimi', 'sonnet', etc.
console.log(rec.reason);
```

### Estimate Costs

```javascript
const { estimateCosts } = require('./utils/model_router');

const costs = estimateCosts('Task', 5000, 8000);
console.log(costs.cheapestToMostExpensive);
```

### With Preferences

```javascript
const { route } = require('./utils/model_router');

// Prefer cheapest
await route('Task', { preferCost: true });

// Prefer quality
await route('Task', { preferQuality: true });

// Prefer speed
await route('Task', { preferSpeed: true });

// Force model
await route('Task', { forceModel: 'kimi' });
```

---

## Common Patterns

### Multi-turn Conversation

```javascript
const { continueConversation } = require('./utils/kimi_client');

let history = [];

// Turn 1
let res = await continueConversation(history, 'Create login form');
history = res.history;

// Turn 2
res = await continueConversation(history, 'Add password reset');
history = res.history;
```

### Streaming

```javascript
const { streamChatCompletion } = require('./utils/kimi_client');

await streamChatCompletion(
  [{ role: 'user', content: 'Build a todo app' }],
  (chunk) => process.stdout.write(chunk)
);
```

### Tool Calling

```javascript
const { chatCompletion } = require('./utils/kimi_client');

const tools = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string' }
      }
    }
  }
}];

const result = await chatCompletion([
  { role: 'user', content: 'Weather in NYC?' }
], { tools });
```

---

## Error Handling

```javascript
try {
  const result = await chat('Generate code');
} catch (error) {
  if (error.message.includes('rate limit')) {
    // Wait and retry
  } else if (error.message.includes('401')) {
    // Check API key
  } else if (error.message.includes('insufficient')) {
    // Add balance
  }
}
```

---

## Batch Processing

```javascript
const { batchSuggest } = require('./utils/model_router');

const tasks = [
  'Generate React form',
  'Analyze security',
  'Search files'
];

const suggestions = batchSuggest(tasks);
suggestions.forEach(({ task, suggestion }) => {
  console.log(`${task} → ${suggestion.recommended}`);
});
```

---

## Cost Optimization Tips

1. **Use router** - Picks cheapest viable option
2. **Kimi for code** - 80% cheaper than Sonnet
3. **Cache prompts** - 75% discount ($0.15/M)
4. **Estimate first** - Check costs before running
5. **Batch similar tasks** - Reuse context

---

## Troubleshooting

| Error | Solution |
|-------|----------|
| Invalid Authentication | Check API key in env or API_KEYS.md |
| Insufficient Balance | Add funds at platform.moonshot.ai/console/pay |
| Rate Limit | Wait a few minutes, implement backoff |
| Context Length | Reduce input (max 256K tokens) |

---

## Key Files

- **Client**: `utils/kimi_client.js`
- **Router**: `utils/model_router.js`
- **Tests**: `utils/test_kimi.js`
- **Full Guide**: `docs/KIMI_INTEGRATION.md`
- **API Keys**: `API_KEYS.md`

---

## Resources

- Platform: https://platform.moonshot.ai/
- Docs: https://platform.moonshot.ai/docs
- Pricing: https://platform.moonshot.ai/docs/pricing/chat
- GitHub: https://github.com/MoonshotAI/Kimi-K2.5

---

**TL;DR**: Kimi K2.5 is the best open-source coding model. Use it for frontend work and save 80% on costs compared to Claude Sonnet.
