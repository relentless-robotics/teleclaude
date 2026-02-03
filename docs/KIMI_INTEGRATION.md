# Kimi K2.5 Integration Guide

Complete guide for using Moonshot AI's Kimi K2.5 model alongside Claude in our workflow.

## Table of Contents

1. [Overview](#overview)
2. [Why Kimi K2.5?](#why-kimi-k25)
3. [Setup Instructions](#setup-instructions)
4. [Usage Examples](#usage-examples)
5. [Model Router](#model-router)
6. [Cost Optimization](#cost-optimization)
7. [Best Practices](#best-practices)

---

## Overview

Kimi K2.5 is Moonshot AI's open-source, trillion-parameter multimodal agentic model. It excels at:

- **Visual Coding**: Generate code from UI designs, mockups, and descriptions
- **Frontend Development**: Best open-source model for React, Vue, Angular
- **Agent Swarms**: Deploy up to 100 sub-agents simultaneously
- **Tool Calling**: Advanced function calling and API integration
- **Long Context**: 256K token context window

### Key Stats

| Feature | Kimi K2.5 | Claude Sonnet | Claude Opus |
|---------|-----------|---------------|-------------|
| **Pricing** | $0.60/$2.50 | $3.00/$15.00 | $15.00/$75.00 |
| **Context** | 256K | 200K | 200K |
| **Speed** | Medium | Medium | Slow |
| **Best For** | Coding, Frontend | Balanced | Complex Reasoning |

---

## Why Kimi K2.5?

### Cost Savings

For a typical coding task (5K input, 8K output):
- **Kimi**: $0.023
- **Sonnet**: $0.135 (5.8x more expensive)
- **Opus**: $0.675 (29.3x more expensive)

### Strengths vs Claude

**Kimi K2.5 is better for:**
- Frontend/UI code generation
- Visual coding (from designs to code)
- React/Vue/Angular components
- Multi-agent coordination
- Long-context coding tasks
- Cost-sensitive projects

**Claude is better for:**
- Complex reasoning and planning (Opus)
- Browser automation (Sonnet)
- Security analysis (Opus)
- Pure math/logic problems (Opus)
- General-purpose tasks (Sonnet)

### Benchmarks

- **HLE-Full**: 50.2 (beats GPT-5.2's 45.5)
- **Coding**: Strongest open-source model
- **Visual Coding**: Industry-leading
- **Agent Orchestration**: 100 sub-agents, 1,500 parallel tool calls

---

## Setup Instructions

### Step 1: Create Account

1. Visit [platform.moonshot.ai](https://platform.moonshot.ai/)
2. Sign up using your Google account (relentlessrobotics@gmail.com)
3. Verify your email if prompted

### Step 2: Add Balance

1. Go to [Console → Pay](https://platform.moonshot.ai/console/pay)
2. Add minimum $1 to test
3. **Tip**: Add $5 to receive $5 bonus ($10 total)

### Step 3: Generate API Key

1. In Console sidebar: **API Key Management**
2. Click **Create API Key**
3. Name it: `teleclaude-integration`
4. Copy the key immediately (shown only once!)

### Step 4: Configure API Key

**Option A - Environment Variable (Recommended):**
```bash
# Windows
set KIMI_API_KEY=your-api-key-here

# Linux/Mac
export KIMI_API_KEY=your-api-key-here
```

**Option B - API_KEYS.md:**
1. Open `API_KEYS.md`
2. Find the **Moonshot AI (Kimi K2.5)** section
3. Replace `PENDING` with your actual API key:
   ```markdown
   | API Key | `sk-your-actual-key-here` |
   ```

### Step 5: Test Installation

```bash
cd C:\Users\Footb\Documents\Github\teleclaude-main
node utils/test_kimi.js
```

If successful, you should see:
```
✅ Response received:
[Code output]

📊 Usage:
  Tokens: X in, Y out
  Cost: $0.00X
  Model: kimi-k2.5-preview
```

---

## Usage Examples

### Basic Chat

```javascript
const { chat } = require('./utils/kimi_client');

const result = await chat('Generate a React button component with hover effects');

console.log(result.content);
console.log(`Cost: $${result.cost.total}`);
```

### Code Generation

```javascript
const { generateCode } = require('./utils/kimi_client');

const result = await generateCode(`
  A TypeScript function that:
  - Validates email addresses
  - Returns detailed error messages
  - Includes unit tests
`);

console.log(result.content);
```

### Visual Coding (Kimi's Specialty)

```javascript
const { generateFromVisual } = require('./utils/kimi_client');

const result = await generateFromVisual(`
  A user profile card with:
  - Circular avatar on the left
  - Name and title on the right
  - Social media icons at the bottom
  - Smooth hover animations
  - Glassmorphism design style
`);

console.log(result.content);
```

### Multi-turn Conversation

```javascript
const { continueConversation } = require('./utils/kimi_client');

let history = [];

// Turn 1
let response = await continueConversation(history, 'Create a login form in React');
history = response.history;
console.log(response.result.content);

// Turn 2
response = await continueConversation(history, 'Now add password strength validation');
history = response.history;
console.log(response.result.content);
```

### Streaming (Long Responses)

```javascript
const { streamChatCompletion } = require('./utils/kimi_client');

await streamChatCompletion(
  [{ role: 'user', content: 'Build a complete todo app in React' }],
  (chunk) => {
    process.stdout.write(chunk);  // Print as it streams
  }
);
```

### Tool Calling

```javascript
const { chatCompletion } = require('./utils/kimi_client');

const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
        },
        required: ['location']
      }
    }
  }
];

const result = await chatCompletion([
  { role: 'user', content: 'What\'s the weather in San Francisco?' }
], { tools });

if (result.toolCalls) {
  console.log('Tool called:', result.toolCalls[0].function.name);
  console.log('Arguments:', result.toolCalls[0].function.arguments);
}
```

---

## Model Router

The model router automatically selects the best model (Claude or Kimi) based on task characteristics.

### Smart Routing

```javascript
const { route } = require('./utils/model_router');

// Automatically routes to Kimi (best for frontend)
const result = await route('Generate a React dashboard with charts');

// Automatically routes to Claude Opus (best for security)
const result2 = await route('Analyze security vulnerabilities in this auth system');

// Automatically routes to Claude Haiku (best for simple tasks)
const result3 = await route('List all JavaScript files in src/');
```

### Get Recommendations Without Executing

```javascript
const { suggest } = require('./utils/model_router');

const recommendation = suggest('Build a landing page with animations');

console.log(`Recommended: ${recommendation.recommended}`);
console.log(`Confidence: ${(recommendation.confidence * 100).toFixed(1)}%`);
console.log(`Reason: ${recommendation.reason}`);
console.log(`Alternatives: ${recommendation.alternatives.join(', ')}`);
```

### Force Specific Model

```javascript
const { route } = require('./utils/model_router');

// Force Kimi even if Sonnet would be recommended
const result = await route('Automate browser login', {
  forceModel: 'kimi'
});
```

### Routing Preferences

```javascript
const { suggest } = require('./utils/model_router');

// Prefer cheapest option
const rec1 = suggest('Generate a component', { preferCost: true });

// Prefer highest quality
const rec2 = suggest('Generate a component', { preferQuality: true });

// Prefer fastest response
const rec3 = suggest('Generate a component', { preferSpeed: true });

// Disable Kimi routing
const rec4 = suggest('Generate a component', { allowKimi: false });
```

### Batch Analysis

```javascript
const { batchSuggest } = require('./utils/model_router');

const tasks = [
  'Create a React form',
  'Analyze this algorithm',
  'Search for config files',
  'Build a REST API'
];

const suggestions = batchSuggest(tasks);

suggestions.forEach(({ task, suggestion }) => {
  console.log(`${task} → ${suggestion.recommended}`);
});
```

---

## Cost Optimization

### Estimate Before Executing

```javascript
const { estimateCosts } = require('./utils/model_router');

const task = 'Generate a complete e-commerce checkout flow';
const costs = estimateCosts(task, 10000, 15000);

console.log('Cost Comparison:');
costs.cheapestToMostExpensive.forEach(item => {
  console.log(`  ${item.model}: ${item.totalDollars}`);
});

console.log(`\nRecommended: ${costs.recommendation}`);
```

### Cost-Aware Routing

```javascript
const { route } = require('./utils/model_router');

// Let router pick cheapest viable option
const result = await route('Generate UI component', {
  preferCost: true
});
```

### Use Kimi for Bulk Coding Tasks

```javascript
const { generateCode } = require('./utils/kimi_client');

// Generate 10 components for ~$0.20 instead of ~$1.00 with Sonnet
const components = ['Header', 'Footer', 'Sidebar', 'Card', 'Button', ...];

for (const comp of components) {
  const result = await generateCode(`React ${comp} component with TypeScript`);
  // Save to files...
}
```

---

## Best Practices

### 1. Task-Model Matching

| Task Type | Best Model | Why |
|-----------|------------|-----|
| React/Vue/Angular code | **Kimi** | Strongest frontend model |
| Visual design → code | **Kimi** | Native visual understanding |
| Complex reasoning | **Claude Opus** | Superior logic |
| Browser automation | **Claude Sonnet** | Proven reliability |
| Simple file ops | **Claude Haiku** | Fast and cheap |
| Multi-agent tasks | **Kimi** | 100 sub-agent support |

### 2. Use Model Router by Default

Don't manually choose models - let the router decide:

```javascript
// ✅ GOOD - Let router decide
const result = await route(taskDescription);

// ❌ BAD - Hardcoded model
const result = await kimiClient.chat(taskDescription);
```

### 3. Fallback Strategy

Always enable fallback for critical tasks:

```javascript
const { routeWithFallback } = require('./utils/model_router');

// Tries Kimi, falls back to Sonnet/Haiku if it fails
const result = await routeWithFallback(taskDescription);
```

### 4. Monitor Costs

Track usage to optimize spending:

```javascript
const { chat, calculateCost } = require('./utils/kimi_client');

const result = await chat(prompt);

console.log(`Input: ${result.usage.prompt_tokens} tokens`);
console.log(`Output: ${result.usage.completion_tokens} tokens`);
console.log(`Cost: $${result.cost.total}`);

// Log to file for analysis
fs.appendFileSync('kimi_usage.log',
  `${new Date().toISOString()},${result.usage.prompt_tokens},${result.usage.completion_tokens},${result.cost.total}\n`
);
```

### 5. Leverage Context Caching

Kimi caches tokens at 75% discount ($0.15/M instead of $0.60/M):

```javascript
// For repeated tasks with similar context
const systemPrompt = `You are a React expert. Always use TypeScript...`;

// First call pays full price
const result1 = await chat(systemPrompt + '\n\nCreate a button');

// Subsequent calls with same system prompt are cached
const result2 = await chat(systemPrompt + '\n\nCreate a form');
const result3 = await chat(systemPrompt + '\n\nCreate a modal');
```

### 6. Use Streaming for Long Outputs

Improves perceived performance and allows early stopping:

```javascript
const { streamChatCompletion } = require('./utils/kimi_client');

let fullResponse = '';

await streamChatCompletion(
  [{ role: 'user', content: 'Build a full blog platform' }],
  (chunk) => {
    fullResponse += chunk;
    process.stdout.write(chunk);  // Show progress
  }
);
```

### 7. Combine with Claude for Hybrid Workflows

Use both models in sequence:

```javascript
// Step 1: Kimi generates code (cheap)
const code = await kimiClient.generateCode('React dashboard');

// Step 2: Claude Opus reviews for security (expensive but critical)
const review = await claudeOpus.analyze(code.content, 'security audit');

// Step 3: Kimi implements fixes (cheap)
const fixed = await kimiClient.chat(`Fix these issues: ${review}`);
```

---

## Troubleshooting

### "Invalid Authentication"

**Solution:**
- Check API key is set correctly
- Verify key hasn't been deleted in Console
- Ensure key is copied completely (no extra spaces)

### "Insufficient Balance"

**Solution:**
- Add funds at https://platform.moonshot.ai/console/pay
- Minimum $1 required

### "Rate Limit Reached"

**Solution:**
- Wait a few minutes
- Implement exponential backoff
- Consider upgrading plan if hitting limits often

### "Context Length Exceeded"

**Solution:**
- Reduce input size (max 256K tokens)
- Use recommended max of 200K for safety
- Chunk large inputs

### Fallback Not Working

**Solution:**
- Check `allowFallback` is not set to false
- Verify alternative models are available
- Check error logs for specific failure reasons

---

## API Reference

### kimi_client.js

**Functions:**
- `chat(prompt, options)` - Simple chat
- `chatCompletion(messages, options)` - Full conversation
- `streamChatCompletion(messages, onChunk, options)` - Streaming
- `generateCode(description, options)` - Code generation
- `generateFromVisual(visualDesc, options)` - Visual coding
- `continueConversation(history, newMessage, options)` - Multi-turn
- `isAvailable()` - Check if configured
- `getPricing()` - Get cost info
- `getContextLimits()` - Get limits
- `calculateCost(usage)` - Calculate cost

**Options:**
- `temperature` - 0.0-1.0 (default: 0.6)
- `top_p` - 0.0-1.0 (default: 0.95)
- `max_tokens` - Maximum output tokens
- `tools` - Function definitions for tool calling
- `tool_choice` - 'auto', 'none', or specific tool

### model_router.js

**Functions:**
- `route(taskDescription, options)` - Smart routing + execution
- `suggest(taskDescription, options)` - Get recommendation only
- `analyzeTask(taskDescription, options)` - Detailed analysis
- `estimateCosts(task, inputTokens, outputTokens)` - Cost estimate
- `batchSuggest(tasks, options)` - Batch analysis
- `routeWithFallback(task, options)` - With auto-fallback
- `isKimiAvailable()` - Check Kimi status
- `getModelSpecs(model)` - Get model info

**Options:**
- `preferCost` - Prefer cheapest option
- `preferQuality` - Prefer highest quality
- `preferSpeed` - Prefer fastest
- `allowKimi` - Allow Kimi routing (default: true)
- `forceModel` - Force specific model
- `allowFallback` - Enable fallback (default: true)

---

## Resources

- **Kimi Platform**: https://platform.moonshot.ai/
- **API Docs**: https://platform.moonshot.ai/docs
- **Pricing**: https://platform.moonshot.ai/docs/pricing/chat
- **GitHub**: https://github.com/MoonshotAI/Kimi-K2.5
- **HuggingFace**: https://huggingface.co/moonshotai/Kimi-K2.5
- **Technical Report**: https://www.kimi.com/blog/kimi-k2-5.html

---

## Summary

Kimi K2.5 is a powerful, cost-effective addition to our workflow. Use it for:

✅ Frontend/UI code generation (React, Vue, Angular)
✅ Visual coding (designs → code)
✅ Cost-sensitive projects
✅ Multi-agent coordination
✅ Long-context coding tasks

Continue using Claude for:

✅ Complex reasoning and planning
✅ Browser automation
✅ Security analysis
✅ General-purpose tasks

The model router automatically picks the right tool for each job, optimizing for cost, speed, and quality.
