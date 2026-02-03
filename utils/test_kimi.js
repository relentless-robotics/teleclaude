/**
 * Test script for Kimi K2.5 integration
 *
 * Tests the kimi_client and model_router modules
 *
 * Usage:
 *   node utils/test_kimi.js
 */

const kimiClient = require('./kimi_client');
const modelRouter = require('./model_router');

async function testKimiAvailability() {
  console.log('\n=== Testing Kimi Availability ===');

  const available = kimiClient.isAvailable();
  console.log(`Kimi API configured: ${available}`);

  if (!available) {
    console.log('\n⚠️  To use Kimi K2.5:');
    console.log('1. Sign up at https://platform.moonshot.ai/');
    console.log('2. Add at least $1 balance to your account');
    console.log('3. Generate API key in Console → API Key Management');
    console.log('4. Add to API_KEYS.md or set KIMI_API_KEY environment variable');
    return false;
  }

  return true;
}

async function testPricingInfo() {
  console.log('\n=== Pricing Information ===');

  const pricing = kimiClient.getPricing();
  console.log('Per million tokens:');
  console.log(`  Input:  $${pricing.input}`);
  console.log(`  Output: $${pricing.output}`);
  console.log(`  Cached: $${pricing.cached} (75% savings)`);

  const limits = kimiClient.getContextLimits();
  console.log('\nContext Window:');
  console.log(`  Maximum: ${limits.maxTokens.toLocaleString()} tokens (256K)`);
  console.log(`  Recommended: ${limits.recommendedMax.toLocaleString()} tokens`);
}

async function testModelRouter() {
  console.log('\n=== Testing Model Router ===');

  const testTasks = [
    'Generate a React component for a user profile card',
    'Analyze the security implications of this authentication flow',
    'Search for all TypeScript files in the project',
    'Create a beautiful landing page with animations',
    'Design a scalable microservices architecture',
    'Automate browser login to GitHub'
  ];

  console.log('\nTask Routing Analysis:');

  for (const task of testTasks) {
    const suggestion = modelRouter.suggest(task);
    console.log(`\n"${task.substring(0, 50)}..."`);
    console.log(`  → Recommended: ${suggestion.recommended.toUpperCase()}`);
    console.log(`  → Confidence: ${(suggestion.confidence * 100).toFixed(1)}%`);
    console.log(`  → Reason: ${suggestion.reason}`);
    if (suggestion.alternatives.length > 0) {
      console.log(`  → Alternatives: ${suggestion.alternatives.join(', ')}`);
    }
  }
}

async function testCostEstimation() {
  console.log('\n=== Cost Estimation ===');

  const task = 'Generate a complete React dashboard with charts';
  const inputTokens = 5000;
  const outputTokens = 8000;

  console.log(`\nTask: "${task}"`);
  console.log(`Estimated: ${inputTokens} input tokens, ${outputTokens} output tokens\n`);

  const costs = modelRouter.estimateCosts(task, inputTokens, outputTokens);

  console.log('Cost Comparison (cheapest to most expensive):');
  for (const item of costs.cheapestToMostExpensive) {
    console.log(`  ${item.model.padEnd(8)} ${item.totalDollars.padStart(10)} (in: $${item.input}, out: $${item.output})`);
  }

  console.log(`\nRecommended model: ${costs.recommendation.toUpperCase()}`);
}

async function testKimiChat() {
  console.log('\n=== Testing Kimi Chat (if configured) ===');

  if (!kimiClient.isAvailable()) {
    console.log('⏭️  Skipping - API key not configured');
    return;
  }

  try {
    console.log('Sending test prompt to Kimi K2.5...');

    const result = await kimiClient.chat(
      'Write a simple "Hello World" function in JavaScript with a creative comment.',
      { max_tokens: 200 }
    );

    console.log('\n✅ Response received:');
    console.log(result.content);

    console.log('\n📊 Usage:');
    console.log(`  Tokens: ${result.usage.prompt_tokens} in, ${result.usage.completion_tokens} out`);
    console.log(`  Cost: $${result.cost.total}`);
    console.log(`  Model: ${result.model}`);

  } catch (error) {
    console.error('❌ Error:', error.message);

    if (error.message.includes('rate limit')) {
      console.log('\n⚠️  Rate limit reached. Wait a few minutes and try again.');
    } else if (error.message.includes('401') || error.message.includes('403')) {
      console.log('\n⚠️  Authentication failed. Check your API key.');
    } else if (error.message.includes('insufficient')) {
      console.log('\n⚠️  Insufficient balance. Add funds at https://platform.moonshot.ai/console/pay');
    }
  }
}

async function testCodeGeneration() {
  console.log('\n=== Testing Code Generation (if configured) ===');

  if (!kimiClient.isAvailable()) {
    console.log('⏭️  Skipping - API key not configured');
    return;
  }

  try {
    console.log('Generating code with Kimi K2.5...');

    const result = await kimiClient.generateCode(
      'A JavaScript function that validates an email address using regex',
      { max_tokens: 300 }
    );

    console.log('\n✅ Code generated:');
    console.log(result.content.substring(0, 500) + (result.content.length > 500 ? '...' : ''));

    console.log(`\n💰 Cost: $${result.cost.total}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

async function runAllTests() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Kimi K2.5 Integration Test Suite          ║');
  console.log('╚══════════════════════════════════════════════╝');

  await testKimiAvailability();
  await testPricingInfo();
  await testModelRouter();
  await testCostEstimation();

  // Only test actual API calls if configured
  await testKimiChat();
  await testCodeGeneration();

  console.log('\n✅ All tests complete!\n');
}

// Run tests
if (require.main === module) {
  runAllTests().catch(error => {
    console.error('\n❌ Test suite failed:', error);
    process.exit(1);
  });
}

module.exports = { runAllTests };
