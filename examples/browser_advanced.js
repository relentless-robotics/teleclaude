/**
 * Advanced Browser Automation Example
 *
 * Demonstrates advanced features:
 * - Multiple selector fallbacks
 * - Conditional waiting
 * - Issue detection
 * - Complex interactions
 */

const browser = require('../utils/browser');

async function advancedExample() {
  console.log('Starting advanced browser automation example...\n');

  const session = await browser.launch({
    headless: false,
    stealth: true
  });

  try {
    // Navigate with retries
    console.log('Navigating with retry logic...');
    await session.goto('https://github.com', {
      retries: 3,
      timeout: 30000
    });

    // Find element with multiple fallback selectors
    console.log('Finding element with fallbacks...');
    const searchInput = await session.findElement([
      'input[name="q"]',
      'input[placeholder*="Search"]',
      '.header-search-input',
      '[aria-label*="search"]'
    ], {
      timeout: 10000,
      mustBeVisible: true,
      mustBeEnabled: true
    });

    if (searchInput) {
      console.log('✅ Found search input!');

      // Type with human-like behavior
      await session.type([
        'input[name="q"]',
        '.header-search-input'
      ], 'playwright automation', {
        humanLike: true,
        pressEnter: true
      });

      // Wait for search results
      const result = await session.waitForAny([
        { type: 'url', value: '/search' },
        { type: 'selector', value: '.codesearch-results' },
        { type: 'text', value: 'repository results' }
      ], { timeout: 10000 });

      if (result.matched) {
        console.log(`✅ Search completed: ${result.condition.type}`);
        await session.screenshot('github_search_results');
      }
    }

    // Detect issues on the page
    console.log('\nChecking for page issues...');
    const issues = await browser.detectIssues(session.page);
    console.log('Issues found:', issues);

    if (issues.captcha) {
      console.log('⚠️  CAPTCHA detected!');
    }
    if (issues.error) {
      console.log('⚠️  Error page detected!');
    }
    if (issues.rateLimit) {
      console.log('⚠️  Rate limit detected!');
    }

    // Get detailed page state
    console.log('\nGetting page state...');
    const state = await session.getState();
    console.log('URL:', state.url);
    console.log('Title:', state.title);
    console.log('Ready state:', state.ready);
    console.log('Issues:', state.issues);

    // Simulate human behavior
    console.log('\nSimulating human behavior...');
    await session.simulateHumanBehavior(5000);

    console.log('\n✅ Advanced example completed!');

  } catch (error) {
    console.error('Error:', error.message);
    await session.screenshot('advanced_error');
  } finally {
    await browser.humanDelay(2000);
    await session.close();
  }
}

advancedExample().catch(console.error);
