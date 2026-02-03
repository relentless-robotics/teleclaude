/**
 * Kimi K2.5 Workflow Examples
 *
 * Real-world examples of using Kimi alongside Claude in different scenarios
 */

const kimiClient = require('../utils/kimi_client');
const modelRouter = require('../utils/model_router');
const fs = require('fs');
const path = require('path');

// ============================================================================
// Example 1: Build a Complete React Component with Tests
// ============================================================================

async function example1_buildReactComponent() {
  console.log('\n=== Example 1: Build React Component ===\n');

  // Step 1: Generate component with Kimi (best for React)
  console.log('Step 1: Generating component with Kimi...');

  const componentCode = await kimiClient.generateCode(`
    A React TypeScript component for a user profile card:
    - Props: name, email, avatar, role
    - Card layout with avatar on left, info on right
    - Edit button that emits onEdit callback
    - Styled with Tailwind CSS
    - Responsive design
  `);

  console.log('✅ Component generated');
  console.log(`   Cost: $${componentCode.cost.total}`);

  // Step 2: Generate tests with Kimi (still cheap for this)
  console.log('\nStep 2: Generating tests...');

  const tests = await kimiClient.chat(`
    Generate Jest/React Testing Library tests for this component:

    ${componentCode.content}

    Include tests for:
    - Rendering with props
    - Edit button click
    - Responsive behavior
  `);

  console.log('✅ Tests generated');
  console.log(`   Cost: $${tests.cost.total}`);

  // Total cost with Kimi: ~$0.05
  // Total cost with Sonnet: ~$0.30 (6x more)
  const totalCost = parseFloat(componentCode.cost.total) + parseFloat(tests.cost.total);
  console.log(`\n💰 Total cost: $${totalCost.toFixed(4)}`);
  console.log(`   (Would be ~$${(totalCost * 6).toFixed(4)} with Claude Sonnet)`);

  return { componentCode: componentCode.content, tests: tests.content };
}

// ============================================================================
// Example 2: Smart Routing - Let Router Decide
// ============================================================================

async function example2_smartRouting() {
  console.log('\n=== Example 2: Smart Routing ===\n');

  const tasks = [
    'Generate a React login form with validation',
    'Analyze this authentication code for security vulnerabilities',
    'Search for all API endpoints in the codebase',
    'Create a landing page with hero section and pricing table'
  ];

  for (const task of tasks) {
    console.log(`Task: "${task.substring(0, 60)}..."`);

    // Get recommendation
    const suggestion = modelRouter.suggest(task);
    console.log(`  → Recommended: ${suggestion.recommended.toUpperCase()}`);
    console.log(`  → Confidence: ${(suggestion.confidence * 100).toFixed(1)}%`);
    console.log(`  → Estimated cost: $${suggestion.costEstimate.total}`);
    console.log();
  }
}

// ============================================================================
// Example 3: Hybrid Workflow - Kimi + Claude Together
// ============================================================================

async function example3_hybridWorkflow() {
  console.log('\n=== Example 3: Hybrid Workflow ===\n');

  // Scenario: Build a feature with code review

  // Step 1: Kimi generates the code (cheap)
  console.log('Step 1: Kimi generates authentication module...');

  let authCode;
  if (kimiClient.isAvailable()) {
    authCode = await kimiClient.generateCode(`
      A TypeScript authentication module with:
      - User registration with email validation
      - Login with JWT token generation
      - Password hashing with bcrypt
      - Token refresh endpoint
      - Logout functionality
    `);
    console.log(`✅ Code generated - Cost: $${authCode.cost.total}`);
  } else {
    console.log('   (Simulated - API key not configured)');
    authCode = { cost: { total: '0.018' }, content: '[Generated auth code would appear here]' };
    console.log(`✅ Code generated - Estimated cost: $${authCode.cost.total}`);
  }

  // Step 2: Claude Opus reviews for security (expensive but critical)
  console.log('\nStep 2: Claude Opus security review...');
  console.log('   (In real implementation, would call Claude API here)');

  // Simulated review result
  const securityReview = {
    issues: [
      'JWT secret should be environment variable, not hardcoded',
      'Add rate limiting to prevent brute force attacks',
      'Validate email format before database query'
    ],
    cost: 0.045  // Typical Opus review cost
  };

  console.log('✅ Security review complete - Issues found: 3');
  console.log(`   Cost: $${securityReview.cost.toFixed(4)}`);

  // Step 3: Kimi implements fixes (cheap again)
  console.log('\nStep 3: Kimi implements security fixes...');

  let fixedCode;
  if (kimiClient.isAvailable()) {
    fixedCode = await kimiClient.chat(`
      Fix these security issues in the code:
      ${securityReview.issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

      Original code:
      ${authCode.content.substring(0, 1000)}...
    `);
    console.log(`✅ Fixes implemented - Cost: $${fixedCode.cost.total}`);
  } else {
    console.log('   (Simulated - API key not configured)');
    fixedCode = { cost: { total: '0.015' } };
    console.log(`✅ Fixes implemented - Estimated cost: $${fixedCode.cost.total}`);
  }

  // Summary
  const totalCost = parseFloat(authCode.cost.total) +
                    securityReview.cost +
                    parseFloat(fixedCode.cost.total);

  console.log(`\n💰 Total hybrid workflow cost: $${totalCost.toFixed(4)}`);
  console.log(`   Kimi (generation + fixes): $${(parseFloat(authCode.cost.total) + parseFloat(fixedCode.cost.total)).toFixed(4)}`);
  console.log(`   Claude Opus (review): $${securityReview.cost.toFixed(4)}`);
  console.log(`\n   If all with Opus: ~$${(totalCost * 15).toFixed(4)}`);
  console.log(`   Savings: ${((1 - totalCost / (totalCost * 15)) * 100).toFixed(1)}%`);
}

// ============================================================================
// Example 4: Visual Coding - Design to Code
// ============================================================================

async function example4_visualCoding() {
  console.log('\n=== Example 4: Visual Coding (Kimi Specialty) ===\n');

  // Kimi excels at converting visual descriptions to code
  console.log('Converting design mockup to code...');

  const designDescription = `
    Create a modern pricing page with 3 tiers:

    LAYOUT:
    - Three cards side-by-side (responsive: stack on mobile)
    - Middle card slightly elevated with "Popular" badge

    CARD DESIGN:
    - Glassmorphism effect with subtle backdrop blur
    - Rounded corners (16px radius)
    - Soft shadow on hover
    - Smooth hover animation (scale 1.05, duration 300ms)

    EACH CARD CONTAINS:
    - Tier name (h3, bold)
    - Price (large text: $X/month)
    - Feature list (5-6 items with checkmark icons)
    - "Get Started" button (full width, gradient background)

    COLORS:
    - Background: dark gradient (from #1a1a2e to #0f0f1b)
    - Cards: semi-transparent white (rgba(255,255,255,0.1))
    - Text: white with varying opacity
    - Accent: blue-to-purple gradient (#4f46e5 to #7c3aed)

    TIERS:
    1. Starter - $9/month - Basic features
    2. Pro - $29/month - Advanced features (POPULAR)
    3. Enterprise - $99/month - All features
  `;

  const pricingPage = await kimiClient.generateFromVisual(designDescription);

  console.log('✅ Complete pricing page generated!');
  console.log(`   Cost: $${pricingPage.cost.total}`);
  console.log(`   Tokens: ${pricingPage.usage.completion_tokens} output`);

  // Save to file (in real usage)
  // fs.writeFileSync('pricing.html', pricingPage.content);

  console.log('\n💡 This is Kimi\'s strength - visual coding!');
  console.log('   Claude could do this but would cost ~6x more');
}

// ============================================================================
// Example 5: Cost-Aware Bulk Operations
// ============================================================================

async function example5_bulkOperations() {
  console.log('\n=== Example 5: Bulk Operations with Cost Tracking ===\n');

  const components = [
    'Button with variants (primary, secondary, danger)',
    'Input field with label and error message',
    'Card with image, title, description, and footer',
    'Navigation bar with logo and menu items',
    'Footer with social links and copyright'
  ];

  console.log(`Generating ${components.length} React components...\n`);

  let totalCost = 0;
  let totalTokens = 0;

  for (let i = 0; i < components.length; i++) {
    const component = components[i];

    // Use router to pick best model
    const suggestion = modelRouter.suggest(`React TypeScript ${component}`);

    console.log(`${i + 1}. ${component}`);
    console.log(`   → Using: ${suggestion.recommended}`);

    // For demo, we'll just estimate (in real code, would execute)
    const estimate = modelRouter.estimateCosts(component, 3000, 5000);
    const cost = parseFloat(estimate.breakdown[suggestion.recommended].total);

    console.log(`   → Estimated cost: $${cost.toFixed(5)}`);

    totalCost += cost;
    totalTokens += 8000;  // 3K in + 5K out
  }

  console.log(`\n💰 Total bulk operation:`);
  console.log(`   Components: ${components.length}`);
  console.log(`   Total cost: $${totalCost.toFixed(4)}`);
  console.log(`   Avg per component: $${(totalCost / components.length).toFixed(5)}`);
  console.log(`\n   If all with Sonnet: ~$${(totalCost * 6).toFixed(4)}`);
  console.log(`   Savings: $${((totalCost * 6) - totalCost).toFixed(4)}`);
}

// ============================================================================
// Example 6: Streaming for Long Outputs
// ============================================================================

async function example6_streaming() {
  console.log('\n=== Example 6: Streaming Long Outputs ===\n');

  if (!kimiClient.isAvailable()) {
    console.log('⏭️  Skipping - Kimi API not configured');
    return;
  }

  console.log('Generating complete blog platform (streaming)...\n');

  let chunkCount = 0;
  let fullContent = '';

  try {
    await kimiClient.streamChatCompletion([
      {
        role: 'user',
        content: 'Build a simple blog platform with user authentication (just outline the structure and key files)'
      }
    ],
    (chunk) => {
      chunkCount++;
      fullContent += chunk;

      // Show progress every 10 chunks
      if (chunkCount % 10 === 0) {
        process.stdout.write('.');
      }
    },
    { max_tokens: 1000 });

    console.log(`\n\n✅ Streaming complete!`);
    console.log(`   Chunks received: ${chunkCount}`);
    console.log(`   Total length: ${fullContent.length} characters`);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// ============================================================================
// Example 7: Multi-turn Conversation
// ============================================================================

async function example7_multiTurn() {
  console.log('\n=== Example 7: Multi-turn Conversation ===\n');

  if (!kimiClient.isAvailable()) {
    console.log('⏭️  Skipping - Kimi API not configured');
    return;
  }

  let history = [];
  let totalCost = 0;

  try {
    // Turn 1: Initial request
    console.log('Turn 1: Create a signup form...');
    let response = await kimiClient.continueConversation(
      history,
      'Create a React signup form with name, email, and password fields'
    );
    history = response.history;
    totalCost += parseFloat(response.result.cost.total);
    console.log(`✅ Cost: $${response.result.cost.total}`);

    // Turn 2: Add feature
    console.log('\nTurn 2: Add validation...');
    response = await kimiClient.continueConversation(
      history,
      'Add validation - email must be valid format, password must be 8+ characters'
    );
    history = response.history;
    totalCost += parseFloat(response.result.cost.total);
    console.log(`✅ Cost: $${response.result.cost.total}`);

    // Turn 3: Add styling
    console.log('\nTurn 3: Add styling...');
    response = await kimiClient.continueConversation(
      history,
      'Style it with Tailwind CSS and add a gradient background'
    );
    history = response.history;
    totalCost += parseFloat(response.result.cost.total);
    console.log(`✅ Cost: $${response.result.cost.total}`);

    console.log(`\n💰 Total conversation cost: $${totalCost.toFixed(4)}`);
    console.log(`   (Benefits from context caching - 75% discount on cached tokens)`);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// ============================================================================
// Run Examples
// ============================================================================

async function runAllExamples() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        Kimi K2.5 Workflow Examples                       ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  try {
    // Examples that don't require API key
    await example2_smartRouting();
    await example3_hybridWorkflow();
    await example5_bulkOperations();

    // Examples that require API key (will skip if not configured)
    await example6_streaming();
    await example7_multiTurn();

    // Uncomment when you have API key:
    // await example1_buildReactComponent();
    // await example4_visualCoding();

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  Examples complete! See docs/KIMI_INTEGRATION.md        ║');
    console.log('║  for full documentation.                                 ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

  } catch (error) {
    console.error('\n❌ Example failed:', error.message);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  runAllExamples().catch(error => {
    console.error('Examples failed:', error);
    process.exit(1);
  });
}

module.exports = {
  example1_buildReactComponent,
  example2_smartRouting,
  example3_hybridWorkflow,
  example4_visualCoding,
  example5_bulkOperations,
  example6_streaming,
  example7_multiTurn
};
