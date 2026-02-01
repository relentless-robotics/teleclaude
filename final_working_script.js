const { chromium } = require('playwright');
const fs = require('fs');

async function getFinalSecret() {
  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const page = await browser.newPage();

  try {
    console.log('Logging in to GitHub...');
    await page.goto('https://github.com/login');
    await page.fill('input[name="login"]', 'relentless-robotics');
    await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
    await page.click('input[type="submit"]');
    await page.waitForTimeout(6000);

    console.log('Navigating to OAuth apps...');
    await page.goto('https://github.com/settings/developers');
    await page.waitForTimeout(2000);

    console.log('Clicking on TeleClaude Dashboard...');
    await page.click('text=TeleClaude Dashboard');
    await page.waitForTimeout(2000);

    const clientId = (await page.textContent('body')).match(/Ov[a-zA-Z0-9]+/)[0];
    console.log('✅ Client ID:', clientId);

    console.log('\nClicking "Generate a new client secret" submit button...');
    // It's an input[type="submit"] with value="Generate a new client secret"
    await page.click('input[type="submit"][value="Generate a new client secret"]');

    console.log('⏳ Waiting for secret to appear...');
    await page.waitForTimeout(3000);

    await page.screenshot({ path: 'screenshots/secret_displayed.png', fullPage: true });
    console.log('📸 Screenshot saved');

    const bodyText = await page.textContent('body');
    fs.writeFileSync('screenshots/page_with_secret.txt', bodyText);

    // GitHub OAuth secrets typically start with "ghs_" or are 40-char hex
    const patterns = [
      /ghs_[a-zA-Z0-9]{36}/,       // GitHub OAuth secret format
      /gho_[a-zA-Z0-9]{36}/,       // Alternative format
      /ghp_[a-zA-Z0-9]{36}/,       // Personal access token format
      /\b[a-f0-9]{40}\b/           // 40-character hex string
    ];

    let clientSecret = null;
    for (const pattern of patterns) {
      const match = bodyText.match(pattern);
      if (match) {
        clientSecret = match[0];
        console.log(`✅ Found secret with pattern: ${pattern}`);
        break;
      }
    }

    if (!clientSecret) {
      console.log('⚠️ Could not auto-extract secret from page text');
      console.log('Checking screenshots/page_with_secret.txt for manual extraction...');

      // Also try looking in flash messages
      try {
        const flashText = await page.locator('.flash-success, .flash-full, .flash').first().textContent({ timeout: 2000 });
        console.log('Flash message:', flashText);

        for (const pattern of patterns) {
          const match = flashText.match(pattern);
          if (match) {
            clientSecret = match[0];
            console.log('✅ Found secret in flash message!');
            break;
          }
        }
      } catch (e) {
        console.log('No flash message found');
      }
    }

    if (clientSecret) {
      console.log(`\n🎉 CLIENT SECRET OBTAINED: ${clientSecret.substring(0, 15)}...`);

      const credentials = {
        client_id: clientId,
        client_secret: clientSecret,
        application_name: 'TeleClaude Dashboard',
        homepage_url: 'https://dashboard-app-black-kappa.vercel.app',
        callback_url: 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github',
        created_at: new Date().toISOString()
      };

      fs.writeFileSync('github_oauth_credentials.json', JSON.stringify(credentials, null, 2));

      console.log('\n✅✅✅ SUCCESS! ✅✅✅');
      console.log('Credentials saved to: github_oauth_credentials.json');
      console.log('\nCredentials:');
      console.log(JSON.stringify(credentials, null, 2));

      await page.waitForTimeout(3000);
      await browser.close();

      return credentials;
    } else {
      console.log('\n❌ Could not extract secret automatically');
      console.log('Please check:');
      console.log('- screenshots/secret_displayed.png');
      console.log('- screenshots/page_with_secret.txt');
      console.log('\nKeeping browser open for 15 seconds...');

      await page.waitForTimeout(15000);
      await browser.close();

      throw new Error('Secret extraction failed');
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    await page.screenshot({ path: 'screenshots/error_final.png', fullPage: true });
    console.log('Error screenshot saved');

    await page.waitForTimeout(5000);
    await browser.close();
    throw error;
  }
}

getFinalSecret()
  .then(creds => {
    console.log('\n🚀 Ready for next step: Configuring Vercel environment variables');
    process.exit(0);
  })
  .catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
