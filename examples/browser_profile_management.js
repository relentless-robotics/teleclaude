/**
 * Browser Profile Management Example
 *
 * Demonstrates how to manage multiple auth profiles,
 * check their validity, and use them in automation.
 */

const browser = require('../utils/browser');
const browserProfiles = require('../utils/browser_profiles');

async function manageProfiles() {
  console.log('Browser Profile Management Example\n');
  console.log('='.repeat(50));

  // List all saved profiles
  console.log('\n📋 Saved Auth Profiles:\n');
  const profiles = browserProfiles.listProfiles();

  if (profiles.length === 0) {
    console.log('  No saved profiles found.');
  } else {
    profiles.forEach(profile => {
      console.log(`  Profile: ${profile.name}`);
      console.log(`    Valid: ${profile.valid ? '✅' : '❌'}`);
      console.log(`    Age: ${profile.ageInDays} days`);
      console.log(`    Last used: ${profile.lastUsed || 'Never'}`);
      console.log('');
    });
  }

  // Check specific profile
  console.log('\n🔍 Checking Google Profile:\n');
  const hasGoogleAuth = browser.hasValidAuth('google');
  console.log(`  Google auth valid: ${hasGoogleAuth ? '✅' : '❌'}`);

  if (hasGoogleAuth) {
    console.log('\n  Loading Google auth and testing...');

    const session = await browser.withGoogleAuth({
      headless: false,
      stealth: true
    });

    try {
      // Test the auth by navigating to Google
      await session.goto('https://accounts.google.com');
      await session.waitForReady();

      // Check if we're logged in
      const authExpired = await browser.detectAuthExpired(session.page);
      if (authExpired) {
        console.log('  ❌ Auth has expired, deleting profile...');
        browserProfiles.deleteAuthState('google');
      } else {
        console.log('  ✅ Auth is still valid!');
        await session.screenshot('google_auth_test');
      }

    } catch (error) {
      console.error('  Error testing auth:', error.message);
    } finally {
      await session.close();
    }
  }

  // Show available credentials
  console.log('\n🔑 Available Credential Profiles:\n');
  const credentialProfiles = Object.keys(browserProfiles.CREDENTIALS);
  credentialProfiles.forEach(profile => {
    const creds = browserProfiles.getCredentials(profile);
    console.log(`  ${profile}:`);
    console.log(`    Email: ${creds.email}`);
    console.log(`    Uses OAuth: ${creds.useGoogleOAuth ? 'Yes (Google)' : 'No'}`);
    console.log(`    Domains: ${creds.domains ? creds.domains.join(', ') : 'N/A'}`);
    console.log('');
  });

  // Example: Get profile from URL
  console.log('\n🌐 Profile Detection from URLs:\n');
  const testUrls = [
    'https://github.com/login',
    'https://accounts.google.com',
    'https://vercel.com/login',
    'https://twitter.com/login'
  ];

  testUrls.forEach(url => {
    const profile = browserProfiles.getProfileFromUrl(url);
    console.log(`  ${url}`);
    console.log(`    → Profile: ${profile || 'Unknown'}`);
  });

  console.log('\n' + '='.repeat(50));
  console.log('✅ Profile management example completed!');
}

manageProfiles().catch(console.error);
