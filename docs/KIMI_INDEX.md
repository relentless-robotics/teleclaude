# Kimi K2.5 Integration - Master Index

Central navigation hub for all Kimi K2.5 documentation and resources.

---

## 🚀 Quick Start

**New to Kimi?** Start here:

1. [Setup Checklist](KIMI_SETUP_CHECKLIST.md) - Step-by-step setup guide (5 min)
2. [Quick Reference](KIMI_QUICK_REFERENCE.md) - One-page cheat sheet
3. Run: `node utils/test_kimi.js` - Verify installation

**Already set up?** Jump to:
- [Usage Examples](#usage-examples)
- [Cost Optimization](#cost-optimization)
- [API Reference](#api-reference)

---

## 📚 Documentation

### Getting Started
- **[Setup Checklist](KIMI_SETUP_CHECKLIST.md)** - Complete setup walkthrough with troubleshooting
- **[Quick Reference](KIMI_QUICK_REFERENCE.md)** - One-page cheat sheet for daily use
- **[Full Integration Guide](KIMI_INTEGRATION.md)** - Comprehensive 550+ line guide

### Advanced Topics
- **[CLAUDE.md](../CLAUDE.md#kimi-k25-integration-cost-optimization)** - Project-wide integration instructions
- **[Workflow Examples](../examples/kimi_workflow_example.js)** - 7 real-world implementation patterns

---

## 🔧 Code Modules

### Core Libraries
Located in `utils/`:

| Module | Purpose | Lines | Key Functions |
|--------|---------|-------|---------------|
| **kimi_client.js** | API client | 380 | chat, generateCode, stream |
| **model_router.js** | Smart routing | 450 | route, suggest, estimateCosts |
| **test_kimi.js** | Test suite | 230 | runAllTests |

### Usage
```javascript
// Smart routing
const { route } = require('./utils/model_router');
const result = await route('Task description');

// Direct usage
const { chat } = require('./utils/kimi_client');
const result = await chat('Generate code');
```

---

## 💡 Usage Examples

### Basic Examples

**1. Simple Chat**
```javascript
const { chat } = require('./utils/kimi_client');
const result = await chat('Create a React button component');
console.log(result.content);
console.log(`Cost: $${result.cost.total}`);
```

**2. Smart Routing (Recommended)**
```javascript
const { route } = require('./utils/model_router');
const result = await route('Generate a dashboard with charts');
// Automatically picks Kimi for frontend tasks
```

**3. Cost Estimation**
```javascript
const { estimateCosts } = require('./utils/model_router');
const costs = estimateCosts('Build login form', 5000, 8000);
console.log(costs.cheapestToMostExpensive);
```

### Advanced Examples

**4. Visual Coding**
```javascript
const { generateFromVisual } = require('./utils/kimi_client');
const ui = await generateFromVisual(`
  A pricing card with:
  - Header with plan name
  - Large price display
  - Feature list with checkmarks
  - Call-to-action button
  - Glassmorphism style
`);
```

**5. Multi-turn Conversation**
```javascript
const { continueConversation } = require('./utils/kimi_client');

let history = [];

// Turn 1
let res = await continueConversation(history, 'Create signup form');
history = res.history;

// Turn 2
res = await continueConversation(history, 'Add validation');
history = res.history;
```

**6. Hybrid Workflow**
```javascript
// Kimi generates code (cheap)
const code = await kimiClient.generateCode('Auth module');

// Claude reviews security (critical)
const review = await claudeOpus.securityReview(code);

// Kimi implements fixes (cheap)
const fixed = await kimiClient.chat(`Fix: ${review}`);
```

**7. Tool Calling**
```javascript
const { chatCompletion } = require('./utils/kimi_client');

const tools = [{
  type: 'function',
  function: {
    name: 'get_user',
    description: 'Get user by ID',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string' }
      }
    }
  }
}];

const result = await chatCompletion([
  { role: 'user', content: 'Get user 123' }
], { tools });
```

**Full examples:** See `examples/kimi_workflow_example.js`

---

## 💰 Cost Optimization

### Price Comparison

| Model | Input/M | Output/M | Typical Task | Best For |
|-------|---------|----------|--------------|----------|
| Kimi | $0.60 | $2.50 | **$0.023** | Coding, frontend |
| Haiku | $0.25 | $1.25 | $0.011 | Simple tasks |
| Sonnet | $3.00 | $15.00 | $0.135 | Balanced tasks |
| Opus | $15.00 | $75.00 | $0.675 | Complex reasoning |

*Typical task = 5K input, 8K output tokens*

### Cost-Saving Strategies

1. **Use Router** - Automatically picks cheapest viable option
2. **Kimi for Coding** - 80% cheaper than Sonnet
3. **Cache Context** - 75% discount on cached tokens
4. **Hybrid Workflows** - Combine models strategically
5. **Batch Operations** - Process multiple items together
6. **Estimate First** - Check costs before executing

### ROI Calculator

**Current (no Kimi):**
- 10 components/week × $0.135 = $1.35/week
- Annual: $70.20

**With Kimi:**
- 10 components/week × $0.023 = $0.23/week
- Annual: $11.96

**Savings: $58.24/year per 10 components**

---

## 🎯 Model Selection Guide

### Decision Tree

```
Is it FRONTEND/UI code?
├─ Yes → Use KIMI (best + cheapest)
└─ No ↓

Is it SECURITY/ARCHITECTURE?
├─ Yes → Use OPUS (critical decisions)
└─ No ↓

Is it BROWSER AUTOMATION?
├─ Yes → Use SONNET (reliable)
└─ No ↓

Is it SIMPLE FILE OPERATION?
├─ Yes → Use HAIKU (fast + cheap)
└─ No → Use ROUTER (decides)
```

### Task-to-Model Mapping

| Task Type | Kimi | Haiku | Sonnet | Opus |
|-----------|------|-------|--------|------|
| React/Vue/Angular | ✅✅✅ | ❌ | ⚠️ | ❌ |
| UI from design | ✅✅✅ | ❌ | ❌ | ❌ |
| Landing pages | ✅✅✅ | ❌ | ⚠️ | ❌ |
| Backend API | ✅✅ | ❌ | ✅ | ⚠️ |
| Security analysis | ❌ | ❌ | ⚠️ | ✅✅✅ |
| Architecture | ❌ | ❌ | ⚠️ | ✅✅✅ |
| Browser automation | ⚠️ | ❌ | ✅✅✅ | ❌ |
| File search | ❌ | ✅✅✅ | ❌ | ❌ |
| Code review | ✅ | ❌ | ✅✅ | ✅✅✅ |

Legend: ✅✅✅ = Best choice, ✅✅ = Good choice, ✅ = Acceptable, ⚠️ = Possible but suboptimal, ❌ = Not recommended

---

## 📖 API Reference

### kimi_client.js

**Main Functions:**

| Function | Purpose | Parameters | Returns |
|----------|---------|------------|---------|
| `chat(prompt, opts)` | Simple chat | prompt, options | result object |
| `chatCompletion(msgs, opts)` | Multi-turn | messages[], options | result object |
| `generateCode(desc, opts)` | Code gen | description, options | result object |
| `generateFromVisual(desc, opts)` | Visual code | visual description, options | result object |
| `streamChatCompletion(msgs, callback, opts)` | Streaming | messages[], onChunk, options | full content |
| `continueConversation(history, msg, opts)` | Multi-turn helper | history[], new message, options | { result, history } |

**Utility Functions:**

| Function | Purpose | Returns |
|----------|---------|---------|
| `isAvailable()` | Check if configured | boolean |
| `getPricing()` | Get cost info | pricing object |
| `getContextLimits()` | Get limits | limits object |
| `calculateCost(usage)` | Calculate cost | cost breakdown |

**Options:**
- `temperature`: 0.0-1.0 (default: 0.6)
- `top_p`: 0.0-1.0 (default: 0.95)
- `max_tokens`: Max output length
- `tools`: Function definitions
- `tool_choice`: Tool selection strategy

### model_router.js

**Main Functions:**

| Function | Purpose | Parameters | Returns |
|----------|---------|------------|---------|
| `route(task, opts)` | Route & execute | task description, options | result object |
| `suggest(task, opts)` | Recommend only | task description, options | recommendation |
| `analyzeTask(task, opts)` | Detailed analysis | task description, options | analysis object |
| `estimateCosts(task, inTokens, outTokens)` | Cost estimate | task, input size, output size | cost comparison |
| `batchSuggest(tasks, opts)` | Batch analysis | task array, options | suggestions array |
| `routeWithFallback(task, opts)` | Route with retry | task description, options | result object |

**Utility Functions:**

| Function | Purpose | Returns |
|----------|---------|---------|
| `isKimiAvailable()` | Check Kimi status | boolean |
| `getModelSpecs(model)` | Get specs | specs object |

**Options:**
- `preferCost`: Prefer cheapest option
- `preferQuality`: Prefer highest quality
- `preferSpeed`: Prefer fastest
- `allowKimi`: Allow Kimi routing (default: true)
- `forceModel`: Force specific model
- `allowFallback`: Enable fallback (default: true)

---

## 🧪 Testing

### Run Tests

```bash
# Full test suite
node utils/test_kimi.js

# Specific examples
node examples/kimi_workflow_example.js

# Quick availability check
node -e "console.log(require('./utils/kimi_client').isAvailable())"
```

### Test Coverage

- ✅ Availability checks
- ✅ Pricing information
- ✅ Routing analysis
- ✅ Cost estimation
- ✅ Live API tests (if configured)
- ✅ Code generation
- ✅ Streaming responses
- ✅ Multi-turn conversations

---

## 🔧 Configuration

### API Key Setup

**Method 1: Environment Variable**
```bash
# Windows
set KIMI_API_KEY=your-key

# Linux/Mac
export KIMI_API_KEY=your-key
```

**Method 2: API_KEYS.md**
Edit `API_KEYS.md` → Moonshot AI section → Replace `PENDING`

### Verification

```bash
# Check configuration
node -p "require('./utils/kimi_client').isAvailable()"
# Should output: true
```

---

## 🐛 Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Invalid Authentication" | API key incorrect | Check env var or API_KEYS.md |
| "Kimi API configured: false" | Key not detected | Set env var or update file |
| "Insufficient Balance" | Account balance $0 | Add funds at platform.moonshot.ai |
| "Rate Limit Reached" | Too many requests | Wait a few minutes |
| "Context Length Exceeded" | Input too large | Reduce input size (<256K) |

**Detailed troubleshooting:** See [KIMI_SETUP_CHECKLIST.md](KIMI_SETUP_CHECKLIST.md#troubleshooting)

---

## 🌐 External Resources

### Official Resources
- **Platform:** https://platform.moonshot.ai/
- **Console:** https://platform.moonshot.ai/console
- **API Docs:** https://platform.moonshot.ai/docs
- **Pricing:** https://platform.moonshot.ai/docs/pricing/chat

### Code Repositories
- **GitHub:** https://github.com/MoonshotAI/Kimi-K2.5
- **HuggingFace:** https://huggingface.co/moonshotai/Kimi-K2.5

### Research & Analysis
- **Technical Report:** https://www.kimi.com/blog/kimi-k2-5.html
- **Model Comparison:** https://composio.dev/blog/kimi-k2-thinking-vs-claude-4-5-sonnet-vs-gpt-5-codex-tested-the-best-models-for-agentic-coding
- **OpenRouter:** https://openrouter.ai/moonshotai/kimi-k2.5

---

## 📊 Performance Benchmarks

### Quality Benchmarks
- **HLE-Full:** 50.2 (beats GPT-5.2's 45.5)
- **Coding:** Strongest open-source model
- **Visual Coding:** Industry-leading
- **Frontend:** Best for React/Vue/Angular

### Speed & Efficiency
- **Agent Orchestration:** 100 sub-agents, 1,500 tool calls
- **Execution Time:** 4.5x faster with agent swarms
- **Context Window:** 256K tokens (vs Claude's 200K)

### Cost Efficiency
- **vs Sonnet:** 5-6x cheaper
- **vs Opus:** 25-30x cheaper
- **ROI:** 80% cost reduction on coding tasks

---

## 🎓 Best Practices

### Do's ✅
- Use model router for automatic selection
- Leverage Kimi for frontend/UI tasks
- Estimate costs before bulk operations
- Use hybrid workflows for critical features
- Monitor and track usage
- Cache system prompts for 75% discount

### Don'ts ❌
- Hardcode model choices (use router)
- Use Kimi for pure reasoning (use Claude)
- Skip cost estimation on large tasks
- Ignore rate limits
- Forget to track savings

---

## 📈 Success Metrics

Track these metrics to measure success:

| Metric | Target | How to Track |
|--------|--------|--------------|
| Cost per task | <$0.05 | Log after each task |
| Weekly AI spend | <$3 | Sum daily costs |
| Cost reduction % | >70% | Compare to pre-Kimi |
| Kimi usage % | >60% | Tasks using Kimi vs Claude |
| Router accuracy | >80% | Good recommendations % |

---

## 🚀 Getting Help

### Documentation Priority

1. **Quick answer?** → [Quick Reference](KIMI_QUICK_REFERENCE.md)
2. **Setup issue?** → [Setup Checklist](KIMI_SETUP_CHECKLIST.md)
3. **Usage examples?** → [Examples](../examples/kimi_workflow_example.js)
4. **Deep dive?** → [Full Guide](KIMI_INTEGRATION.md)

### Support Channels

- **Project Issues:** Check TROUBLESHOOTING sections in docs
- **API Issues:** https://platform.moonshot.ai/ support
- **GitHub Issues:** https://github.com/MoonshotAI/Kimi-K2.5/issues

---

## 📅 Version History

| Date | Version | Changes |
|------|---------|---------|
| 2026-02-01 | 1.0.0 | Initial integration complete |

---

## 🎯 Quick Command Reference

```bash
# Setup
set KIMI_API_KEY=your-key
node utils/test_kimi.js

# Test
node -e "console.log(require('./utils/kimi_client').isAvailable())"

# Examples
node examples/kimi_workflow_example.js

# Documentation
start docs/KIMI_INTEGRATION.md
start docs/KIMI_QUICK_REFERENCE.md
```

---

**Everything you need for Kimi K2.5 integration in one place!** 🚀
