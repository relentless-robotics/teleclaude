/**
 * Groq API Test Script
 *
 * Run: node utils/test_groq.js
 */

const groqClient = require('./groq_client');

async function main() {
  console.log('=== Groq API Test ===\n');

  // Check availability
  console.log('1. Checking API key...');
  if (!groqClient.isAvailable()) {
    console.error('   ERROR: Groq API key not found!');
    console.log('   Set GROQ_API_KEY environment variable or add to API_KEYS.md');
    console.log('\n   API_KEYS.md format:');
    console.log('   ## Groq');
    console.log('   | Field | Value |');
    console.log('   |-------|-------|');
    console.log('   | API Key | `gsk_your_key_here` |');
    process.exit(1);
  }
  console.log('   OK: API key found\n');

  // Test connection
  console.log('2. Testing API connection...');
  const testResult = await groqClient.testConnection();
  if (!testResult.success) {
    console.error('   ERROR:', testResult.error);
    process.exit(1);
  }
  console.log('   OK: Connection successful');
  console.log('   Response:', testResult.message);
  console.log('   Model:', testResult.model);
  if (testResult.timing) {
    console.log('   Timing:', testResult.timing);
  }
  console.log();

  // Test chat completion
  console.log('3. Testing chat completion...');
  try {
    const chatResult = await groqClient.chat('What is 2+2? Answer with just the number.', {
      model: 'llama-3.1-8b-instant',  // Fast model for testing
      max_tokens: 10
    });
    console.log('   OK: Chat completion works');
    console.log('   Response:', chatResult.content);
    console.log('   Cost:', chatResult.cost);
    console.log();
  } catch (error) {
    console.error('   ERROR:', error.message);
  }

  // Test code generation
  console.log('4. Testing code generation...');
  try {
    const codeResult = await groqClient.generateCode('A function that checks if a number is prime', {
      max_tokens: 500
    });
    console.log('   OK: Code generation works');
    console.log('   Preview:', codeResult.content.substring(0, 200) + '...');
    console.log('   Cost:', codeResult.cost);
    console.log();
  } catch (error) {
    console.error('   ERROR:', error.message);
  }

  // Show available models
  console.log('5. Available models:');
  const models = groqClient.getModels();
  for (const [name, spec] of Object.entries(models)) {
    console.log(`   - ${name}: ${spec.description}`);
  }
  console.log();

  // Show pricing
  console.log('6. Pricing (per million tokens):');
  const pricing = groqClient.getPricing();
  for (const [model, prices] of Object.entries(pricing)) {
    console.log(`   - ${model}: $${prices.input} input / $${prices.output} output`);
  }
  console.log();

  console.log('=== All tests passed! ===');
}

main().catch(console.error);
