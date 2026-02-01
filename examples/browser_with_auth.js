/**
 * Browser Automation with Google Auth Example
 *
 * Demonstrates how to use saved authentication states
 * to avoid repeated logins.
 */

const browser = require('../utils/browser');

async function main() {
  console.log('Starting browser automation with Google auth...\n');

  // Check if we have valid Google auth
  const hasAuth = browser.hasValidAuth('google');
  console.log(`Google auth available: ${hasAuth}`);

  // Launch with Google auth pre-loaded
  const session = await browser.withGoogleAuth({
    headless: false,
    stealth: true
  });

  try {
    // Navigate to a Google service
    console.log('Navigating to Google Cloud Console...');
    await session.goto('https://console.cloud.google.com');

    // Wait for page to load
    await session.waitForReady({ waitForNetwork: true });

    // Check if we're logged in
    const state = await session.getState();
    console.log('Current URL:', state.url);

    // Check for auth expiry
    const authExpired = await browser.detectAuthExpired(session.page);
    if (authExpired) {
      console.log('⚠️  Auth has expired, need to re-login');
    } else {
      console.log('✅ Successfully authenticated!');

      // Do something with the authenticated session
      // For example, navigate to a project
      console.log('Navigating to projects...');
      await session.click('[aria-label="Select a project"]', {
        humanLike: true
      });

      await browser.humanDelay(1000);

      // Take screenshot
      await session.screenshot('google_cloud_authenticated');

      // If this is a new login, save the auth state
      if (!hasAuth) {
        console.log('Saving Google auth state for future use...');
        await session.saveAuthState('google');
      }
    }

  } catch (error) {
    console.error('Error:', error.message);
    await session.screenshot('error_state');
  } finally {
    await session.close();
  }
}

main().catch(console.error);
