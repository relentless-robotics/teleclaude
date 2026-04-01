## KIMI K2.5 INTEGRATION (Cost Optimization)

**You now have access to Kimi K2.5 - the strongest open-source coding model - at 80% lower cost than Claude Sonnet!**

### Why Use Kimi?

**Cost Savings:**
- Kimi: $0.60/$2.50 per million tokens
- Sonnet: $3.00/$15.00 (5-6x more expensive)
- Typical coding task: $0.023 vs $0.135 (83% savings!)

**Kimi Strengths:**
- Best open-source model for coding
- Excels at frontend/UI generation (React, Vue, Angular)
- Visual coding (designs → code)
- 256K context window (larger than Claude's 200K)
- Can deploy 100 sub-agents simultaneously

### Smart Model Router

**ALWAYS use the model router instead of hardcoding model choice:**

```javascript
const { route } = require('./utils/model_router');

// Router automatically picks best model for task
const result = await route('Generate a React dashboard with charts');

// With preferences
const result = await route('Task description', {
  preferCost: true,      // Pick cheapest viable option
  preferQuality: true,   // Pick highest quality
  preferSpeed: true,     // Pick fastest
  forceModel: 'kimi'     // Force specific model
});
```

### When to Use Each Model

| Task Type | Best Model | Why |
|-----------|------------|-----|
| **React/Vue/Angular** | **Kimi** | Strongest frontend model |
| **UI from design** | **Kimi** | Visual coding specialty |
| **Landing pages** | **Kimi** | UI + animations |
| **Bulk coding** | **Kimi** | 80% cheaper than Sonnet |
| **Security analysis** | **Opus** | Deep reasoning required |
| **Browser automation** | **Sonnet** | Proven reliability |
| **File searches** | **Haiku** | Fast & cheap |

### Quick Usage Examples

**Smart Routing (Recommended):**
```javascript
const { route } = require('./utils/model_router');
const result = await route('Generate a React component for user profile');
```

**Direct Kimi Usage:**
```javascript
const { chat, generateCode } = require('./utils/kimi_client');

// Simple chat
const result = await chat('Build a login form with validation');

// Code generation
const code = await generateCode('A TypeScript CSV parser');

// Visual coding
const { generateFromVisual } = require('./utils/kimi_client');
const ui = await generateFromVisual('A card with image, title, description, and hover animation');
```

**Cost Estimation:**
```javascript
const { estimateCosts } = require('./utils/model_router');
const costs = estimateCosts('Task description', 5000, 8000);
console.log(costs.cheapestToMostExpensive);
```

**Get Recommendation:**
```javascript
const { suggest } = require('./utils/model_router');
const rec = suggest('Generate React dashboard');
console.log(`Use: ${rec.recommended} (${rec.reason})`);
```

### Hybrid Workflows

Combine Kimi + Claude for maximum efficiency:

```javascript
// 1. Kimi generates code (cheap: $0.02)
const code = await kimiClient.generateCode('Auth module');

// 2. Opus reviews security (expensive but critical: $0.05)
const review = await claudeOpus.analyze(code.content);

// 3. Kimi implements fixes (cheap: $0.02)
const fixed = await kimiClient.chat(`Fix: ${review}`);

// Total: $0.09 vs $1.50 all-Opus (94% savings!)
```

### Setup

1. Sign up: https://platform.moonshot.ai/
2. Add $5 balance (get $10 with bonus)
3. Generate API key in Console
4. Set environment variable:
   ```bash
   set KIMI_API_KEY=your-key-here
   ```
5. Or add to API_KEYS.md (Moonshot AI section)

### Documentation

- Full guide: `docs/KIMI_INTEGRATION.md`
- Quick reference: `docs/KIMI_QUICK_REFERENCE.md`
- Examples: `examples/kimi_workflow_example.js`
- Test: `node utils/test_kimi.js`

### Cost Comparison Examples

**Generate React Component (5K in, 8K out):**
- Kimi: **$0.023** ✅
- Sonnet: $0.135 (5.8x more)
- Opus: $0.675 (29x more)

**10 Components:**
- Kimi: **$0.23** ✅
- Sonnet: $1.35 (5.8x more)
- Opus: $6.75 (29x more)

**Expected ROI:** 70-80% reduction in AI API costs for coding tasks.

---

## CURSOR CLI (Parallel AI Assistant)

**You have access to Cursor CLI for parallel AI coding tasks - it's FREE with the Pro subscription!**

### ⚠️ ALWAYS USE AUTO MODEL

The `auto` model is **FREE** with Cursor Pro. Never use other models unless absolutely necessary.

### When to Use Cursor CLI

Use Cursor CLI when:
- You need parallel AI work while doing something else
- Complex refactoring that benefits from Cursor's codebase awareness
- Code review or explanation tasks
- Tasks that can run independently

### Quick Commands

```bash
# Ask a question (FREE - uses auto model)
node utils/cursor_cli.js ask "Explain this code"

# Run agent task (FREE - uses auto model)
node utils/cursor_cli.js agent "Refactor the auth module"

# Plan approach (FREE - uses auto model)
node utils/cursor_cli.js plan "Add user authentication"
```

### Node.js Integration

```javascript
const { cursorAsk, cursorAgent, cursorPlan } = require('./utils/cursor_cli');

// All use auto model by default (FREE!)
const explanation = await cursorAsk('What does this function do?');
const result = await cursorAgent('Fix the bug in user.js');
```

### Key Points

- **Location:** `utils/cursor_cli.js`
- **Model:** Always uses `auto` (FREE with Pro)
- **Modes:** ask, plan, agent
- **Cloud Handoff:** Prefix with `&` to run in cloud

---

## CURSOR FALLBACK MODE

**Module:** `utils/cursor_fallback.js`

Automatically routes tasks to Cursor CLI when Claude rate limits hit or for simple tasks to save tokens.

### How It Works

```
Normal: User → Discord → Claude → Work → Discord
Fallback: User → Discord → Claude (thin) → Cursor CLI → Result file → Claude → Discord
```

### Automatic Task Routing

Tasks are automatically routed based on type:

**Always use Cursor (FREE):**
- File search, glob, grep
- Read files, list files
- Explain code, code review
- Refactor, format, lint
- Simple edits, rename variables

**Always use Claude (needs MCP):**
- Send Discord/Telegram messages
- Memory operations
- Browser automation
- Authentication
- Complex multi-system tasks

### Usage

```javascript
const {
  smartRoute,
  runWithCursor,
  activateRateLimitFallback,
  getStatus,
  getPendingResults
} = require('./utils/cursor_fallback');

// Smart routing (auto-decides Cursor vs Claude)
const result = await smartRoute('Find all TypeScript files with errors');
if (result.routed) {
  // Was handled by Cursor
  send_to_discord(formatResultForDiscord(result));
} else {
  // Handle with Claude
}

// Force Cursor mode
const result = await smartRoute('Refactor auth module', { forceCursor: true });

// Activate rate limit fallback
activateRateLimitFallback('2026-01-31T15:00:00Z');

// Check status
const status = getStatus();
// { cursorAvailable: true, fallbackEnabled: true, rateLimitUntil: '...' }

// Get pending results to report
const pending = getPendingResults();
for (const result of pending) {
  send_to_discord(formatResultForDiscord(result));
  markResultReported(result.id);
}
```

### Rate Limit Handling

When Claude rate limit is detected:

```javascript
// Activate fallback mode
const { activateRateLimitFallback } = require('./utils/cursor_fallback');

// When you detect "rate limit" error:
activateRateLimitFallback(resetTime);
// Now simple tasks auto-route to Cursor

// When limit resets:
deactivateFallback();
```

### Benefits

| Aspect | Claude Only | With Cursor Fallback |
|--------|-------------|---------------------|
| Cost | $$$ | $ (Cursor is FREE) |
| Rate Limits | Blocking | Graceful degradation |
| Simple Tasks | Expensive | Free via Cursor |
| Availability | Single point | Redundant |

### Task Routing Customization

Edit `TASK_ROUTING` in `cursor_fallback.js`:

```javascript
const TASK_ROUTING = {
  cursorPreferred: ['file search', 'grep', 'refactor', ...],
  claudeRequired: ['discord', 'memory', 'browser', ...]
};
```

### Results Storage

- Results saved to: `cursor_results/task_*.json`
- Status file: `cursor_results/current_status.json`
- Log file: `logs/cursor_fallback.log`

### Cleanup

```javascript
cleanupResults(7); // Remove results older than 7 days
```

---

