/**
 * Basic Browser Automation Example
 *
 * Demonstrates the fundamental features of the unified browser module.
 */

const browser = require('../utils/browser');

async function main() {
  console.log('Starting basic browser automation example...\n');

  // Launch browser with stealth mode
  const session = await browser.launch({
    headless: false,
    stealth: true
  });

  try {
    // Navigate to a website
    console.log('Navigating to example.com...');
    await session.goto('https://example.com');

    // Wait for page to be ready
    await session.waitForReady();

    // Get page state
    const state = await session.getState();
    console.log('Page state:', state);

    // Take a screenshot
    console.log('Taking screenshot...');
    await session.screenshot('basic_example');

    // Find an element
    console.log('Finding elements...');
    const heading = await session.findElement(['h1', 'header h1']);
    if (heading) {
      console.log('Found heading element!');
    }

    // Simulate human behavior
    console.log('Simulating human behavior...');
    await session.simulateHumanBehavior(3000);

    console.log('\n✅ Basic example completed successfully!');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    // Always close the browser
    await session.close();
  }
}

// Run the example
main().catch(console.error);
