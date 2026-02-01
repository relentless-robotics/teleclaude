const { chromium } = require('playwright');
const fs = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function manualGetSecret() {
  console.log('Manual GitHub OAuth Client Secret retrieval...');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 500
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('https://github.com/settings/developers');
    await page.waitForTimeout(2000);

    const needsLogin = await page.locator('input[name="login"]').isVisible({ timeout: 5000 }).catch(() => false);

    if (needsLogin) {
      console.log('Logging in...');
      await page.fill('input[name="login"]', 'relentless-robotics');
      await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
      await page.click('input[type="submit"][value="Sign in"]');
      await page.waitForTimeout(3000);

      const has2FA = await page.locator('input[name="otp"]').isVisible({ timeout: 3000 }).catch(() => false);
      if (has2FA) {
        console.log('⚠️ 2FA required! Please complete in browser...');
        await page.waitForURL('**/settings/developers', { timeout: 60000 });
      }
    }

    console.log('Clicking on TeleClaude Dashboard...');
    await page.locator('a:has-text("TeleClaude Dashboard")').first().click();
    await page.waitForTimeout(2000);

    // Get Client ID
    const pageContent = await page.content();
    const clientIdMatch = pageContent.match(/Ov[a-zA-Z0-9]+/);
    const clientId = clientIdMatch ? clientIdMatch[0] : 'Ov23liOCE25GwuIKlMhO';

    console.log('\n===========================================');
    console.log('Client ID:', clientId);
    console.log('===========================================\n');

    console.log('Now I will click "Generate a new client secret" button...');
    console.log('WATCH THE BROWSER - the secret will appear ONLY ONCE!\n');

    // Try clicking with more lenient selector
    await page.waitForSelector('text=Generate a new client secret', { timeout: 10000 });
    await page.click('text=Generate a new client secret');

    console.log('\n⚠️⚠️⚠️ SECRET GENERATED! ⚠️⚠️⚠️');
    console.log('Look at the browser window NOW!');
    console.log('The client secret should be visible on the page.\n');

    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/github_secret_visible.png' });
    console.log('Screenshot saved to: screenshots/github_secret_visible.png\n');

    const clientSecret = await question('PASTE THE CLIENT SECRET HERE: ');

    if (!clientSecret || clientSecret.length < 20) {
      throw new Error('Invalid client secret provided');
    }

    const credentials = {
      client_id: clientId,
      client_secret: clientSecret.trim(),
      application_name: 'TeleClaude Dashboard',
      homepage_url: 'https://dashboard-app-black-kappa.vercel.app',
      callback_url: 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github',
      created_at: new Date().toISOString()
    };

    fs.writeFileSync('github_oauth_credentials.json', JSON.stringify(credentials, null, 2));

    console.log('\n✅ Credentials saved to github_oauth_credentials.json');
    console.log(JSON.stringify(credentials, null, 2));

    rl.close();
    await browser.close();

    return credentials;

  } catch (error) {
    console.error('❌ Error:', error.message);
    await page.screenshot({ path: 'screenshots/error.png' });
    rl.close();
    await browser.close();
    throw error;
  }
}

manualGetSecret()
  .then(() => {
    console.log('\n✅ Done!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Failed:', error.message);
    process.exit(1);
  });
