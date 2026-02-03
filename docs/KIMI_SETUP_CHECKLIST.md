# Kimi K2.5 Setup Checklist

Quick setup checklist to get Kimi K2.5 running in your workflow.

---

## Pre-Setup Verification

- [ ] Node.js installed (v16+)
- [ ] Project at: `C:\Users\Footb\Documents\Github\teleclaude-main`
- [ ] Internet connection active

---

## Setup Steps

### ✅ Step 1: Create Account (2 minutes)

1. [ ] Visit https://platform.moonshot.ai/
2. [ ] Click "Sign Up" or "Get Started"
3. [ ] Use relentlessrobotics@gmail.com (or your email)
4. [ ] Can sign up with Google account for faster access
5. [ ] Verify email if prompted
6. [ ] Log into Console

**Status:** Account created ✓

---

### ✅ Step 2: Add Balance (1 minute)

1. [ ] In Console, click "Pay" or "Recharge"
2. [ ] Select payment method
3. [ ] Add minimum $1 (recommended: $5 to get $5 bonus)
4. [ ] Complete payment
5. [ ] Verify balance shows in account

**Recommended:** Add $5 → Get $10 total with bonus

**Status:** Balance added ✓

---

### ✅ Step 3: Generate API Key (1 minute)

1. [ ] In Console sidebar: "API Key Management"
2. [ ] Click "Create API Key"
3. [ ] Name: `teleclaude-integration`
4. [ ] (Optional) Assign to project
5. [ ] **IMPORTANT:** Copy key immediately (shown only once!)
6. [ ] Save key to secure location

**Key format:** Starts with letters/numbers (OpenAI-compatible format)

**Status:** API key generated ✓

---

### ✅ Step 4: Configure API Key (1 minute)

**Choose ONE method:**

#### Method A: Environment Variable (Recommended)

**Windows:**
```bash
# Temporary (current session)
set KIMI_API_KEY=your-actual-key-here

# Permanent (system-wide)
setx KIMI_API_KEY "your-actual-key-here"
```

**Linux/Mac:**
```bash
# Add to ~/.bashrc or ~/.zshrc
export KIMI_API_KEY=your-actual-key-here

# Then reload
source ~/.bashrc
```

#### Method B: API_KEYS.md File

1. [ ] Open `C:\Users\Footb\Documents\Github\teleclaude-main\API_KEYS.md`
2. [ ] Find section: `## Moonshot AI (Kimi K2.5)`
3. [ ] Replace `PENDING` with your actual key:
   ```markdown
   | API Key | `sk-your-actual-key-here` |
   ```
4. [ ] Save file

**Status:** API key configured ✓

---

### ✅ Step 5: Test Integration (30 seconds)

Run test suite:

```bash
cd C:\Users\Footb\Documents\Github\teleclaude-main
node utils/test_kimi.js
```

**Expected output:**
```
╔══════════════════════════════════════════════╗
║   Kimi K2.5 Integration Test Suite          ║
╚══════════════════════════════════════════════╝

=== Testing Kimi Availability ===
Kimi API configured: true

=== Pricing Information ===
Per million tokens:
  Input:  $0.6
  Output: $2.5
  Cached: $0.15 (75% savings)

...

=== Testing Kimi Chat (if configured) ===
Sending test prompt to Kimi K2.5...

✅ Response received:
[Code output]

📊 Usage:
  Tokens: X in, Y out
  Cost: $0.00X
  Model: kimi-k2.5-preview

✅ All tests complete!
```

**If errors occur:** See [Troubleshooting](#troubleshooting) section below

**Status:** Tests passing ✓

---

### ✅ Step 6: Try First Request (30 seconds)

Create test file: `test_kimi_hello.js`

```javascript
const { chat } = require('./utils/kimi_client');

async function test() {
  const result = await chat('Write a "Hello World" function in JavaScript');

  console.log('Response:', result.content);
  console.log(`Cost: $${result.cost.total}`);
  console.log(`Tokens: ${result.usage.completion_tokens}`);
}

test().catch(console.error);
```

Run:
```bash
node test_kimi_hello.js
```

**Expected:** Should generate code and show cost

**Status:** First request successful ✓

---

### ✅ Step 7: Test Model Router (30 seconds)

Create test file: `test_router.js`

```javascript
const { suggest } = require('./utils/model_router');

const tasks = [
  'Generate a React login form',
  'Analyze security vulnerabilities',
  'Search for TypeScript files'
];

tasks.forEach(task => {
  const rec = suggest(task);
  console.log(`${task} → ${rec.recommended.toUpperCase()}`);
});
```

Run:
```bash
node test_router.js
```

**Expected:** Should show model recommendations for each task

**Status:** Router working ✓

---

## Verification Checklist

After setup, verify all components:

- [ ] `node utils/test_kimi.js` runs without errors
- [ ] Test requests return valid responses
- [ ] Cost tracking shows actual costs (not $0.00)
- [ ] Model router suggests appropriate models
- [ ] Documentation accessible at `docs/KIMI_INTEGRATION.md`

---

## Integration Checklist

Integrate into your workflow:

- [ ] Update any hardcoded model choices to use router
- [ ] Add cost logging to track savings
- [ ] Use Kimi for frontend/UI tasks
- [ ] Use Claude Opus for security/reasoning
- [ ] Use hybrid workflows for critical features
- [ ] Monitor daily costs to track ROI

---

## Troubleshooting

### ❌ "Invalid Authentication" Error

**Cause:** API key not found or incorrect

**Solutions:**
1. Check environment variable:
   ```bash
   echo %KIMI_API_KEY%    # Windows
   echo $KIMI_API_KEY     # Linux/Mac
   ```
2. Verify API_KEYS.md has correct key (no extra spaces)
3. Regenerate key in Console if necessary
4. Restart terminal/IDE after setting env var

---

### ❌ "Kimi API configured: false"

**Cause:** API key not detected

**Solutions:**
1. Check key location (env var OR API_KEYS.md)
2. Ensure key is not "PENDING"
3. Check file path is correct
4. Try Method B (API_KEYS.md) if Method A (env var) doesn't work

---

### ❌ "Insufficient Balance" Error

**Cause:** Account balance too low

**Solutions:**
1. Add funds at https://platform.moonshot.ai/console/pay
2. Minimum $1 required
3. Check balance in Console dashboard

---

### ❌ "Rate Limit Reached"

**Cause:** Too many requests in short time

**Solutions:**
1. Wait a few minutes
2. Check rate limits in Console
3. Consider upgrading plan if hitting limits often
4. Implement exponential backoff in code

---

### ❌ Test Suite Passes But No Response

**Cause:** API key valid but balance is $0

**Solutions:**
1. Check balance in Console
2. Add minimum $1 to account
3. Retry test after balance added

---

### ❌ "Context Length Exceeded"

**Cause:** Input too large (>256K tokens)

**Solutions:**
1. Reduce input size
2. Use recommended max of 200K tokens
3. Chunk large inputs into smaller pieces

---

## Quick Reference

**Platform:** https://platform.moonshot.ai/
**Docs:** https://platform.moonshot.ai/docs
**Pricing:** https://platform.moonshot.ai/docs/pricing/chat
**Console:** https://platform.moonshot.ai/console

**Local Docs:**
- Full guide: `docs/KIMI_INTEGRATION.md`
- Quick ref: `docs/KIMI_QUICK_REFERENCE.md`
- Examples: `examples/kimi_workflow_example.js`

**Support:**
- GitHub: https://github.com/MoonshotAI/Kimi-K2.5
- Technical Report: https://www.kimi.com/blog/kimi-k2-5.html

---

## Next Steps

After successful setup:

1. [ ] Read full guide: `docs/KIMI_INTEGRATION.md`
2. [ ] Review examples: `examples/kimi_workflow_example.js`
3. [ ] Integrate router into existing workflows
4. [ ] Start tracking cost savings
5. [ ] Update project tasks to use optimal models

---

## Success Criteria

Setup is complete when:

✅ Test suite passes all checks
✅ Sample requests return valid responses
✅ Cost tracking shows actual usage
✅ Model router provides recommendations
✅ You can generate code with Kimi
✅ Documentation is accessible

**Estimated setup time:** 5-10 minutes total
**Expected payback:** 3 days (from cost savings)

---

## Cost Tracking Template

Track your savings over time:

```
Date       | Task Type        | Model | Cost   | Would-be Sonnet | Savings
-----------|------------------|-------|--------|-----------------|--------
2026-02-01 | React component  | Kimi  | $0.023 | $0.135          | $0.112
2026-02-01 | Add tests        | Kimi  | $0.015 | $0.080          | $0.065
2026-02-01 | Security review  | Opus  | $0.450 | $0.450          | $0.000
2026-02-01 | Implement fixes  | Kimi  | $0.018 | $0.120          | $0.102
-----------|------------------|-------|--------|-----------------|--------
           |                  | TOTAL | $0.506 | $0.785          | $0.279 (36%)
```

After 1 week of typical usage:
- Traditional (all Sonnet): ~$10-15
- With Kimi + Router: ~$2-3
- **Savings: $8-12/week** ($32-48/month!)

---

**Ready to start saving?** Complete the checklist above and you're good to go! 🚀
