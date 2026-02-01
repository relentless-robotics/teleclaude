const { chromium } = require('playwright');
const fs = require('fs');

async function getSecretWithPause() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    console.log('Navigating to GitHub...');
    await page.goto('https://github.com/login');

    await page.fill('input[name="login"]', 'relentless-robotics');
    await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
    await page.click('input[type="submit"]');

    console.log('Waiting for login...');
    await page.waitForTimeout(5000);

    await page.goto('https://github.com/settings/developers');
    await page.waitForTimeout(2000);

    console.log('Clicking on TeleClaude Dashboard...');
    await page.click('text=TeleClaude Dashboard');
    await page.waitForTimeout(2000);

    // Get Client ID
    const pageText = await page.textContent('body');
    const clientId = pageText.match(/Ov[a-zA-Z0-9]+/)[0];
    console.log('Client ID:', clientId);

    await page.screenshot({ path: 'screenshots/ready_to_generate.png', fullPage: true });

    console.log('\n================================================');
    console.log('BROWSER IS READY!');
    console.log('================================================');
    console.log('\nI will now click "Generate a new client secret"');
    console.log('WATCH THE BROWSER WINDOW CAREFULLY!');
    console.log('\nWaiting 5 seconds...\n');

    await page.waitForTimeout(5000);

    console.log('Clicking "Generate a new client secret" NOW...');
    await page.click('button:has-text("Generate")');

    console.log('\n⚠️⚠️⚠️ BUTTON CLICKED! ⚠️⚠️⚠️');
    console.log('Taking screenshot in 2 seconds...\n');

    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'screenshots/secret_revealed.png', fullPage: true });

    console.log('Screenshot saved to: screenshots/secret_revealed.png');
    console.log('\nI will now try to extract the secret from the page...');

    const fullText = await page.textContent('body');

    // Save full page text for inspection
    fs.writeFileSync('screenshots/page_text.txt', fullText);

    // Try to find secret (40-char hex or GitHub personal access token format)
    const secretPatterns = [
      /ghp_[a-zA-Z0-9]{36}/,  // GitHub PAT format
      /\b[a-f0-9]{40}\b/,      // 40-char hex
      /gho_[a-zA-Z0-9]{36}/,   // GitHub OAuth format
      /ghs_[a-zA-Z0-9]{36}/    // GitHub secret format
    ];

    let clientSecret = null;
    for (const pattern of secretPatterns) {
      const match = fullText.match(pattern);
      if (match) {
        clientSecret = match[0];
        console.log('Found potential secret with pattern:', pattern);
        break;
      }
    }

    if (clientSecret) {
      console.log('\n✅ Client Secret found:', clientSecret.substring(0, 15) + '...');

      const credentials = {
        client_id: clientId,
        client_secret: clientSecret,
        application_name: 'TeleClaude Dashboard',
        homepage_url: 'https://dashboard-app-black-kappa.vercel.app',
        callback_url: 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github',
        created_at: new Date().toISOString()
      };

      fs.writeFileSync('github_oauth_credentials.json', JSON.stringify(credentials, null, 2));
      console.log('\n✅ Credentials saved to github_oauth_credentials.json');
      console.log(JSON.stringify(credentials, null, 2));

    } else {
      console.log('\n⚠️ Could not auto-extract secret.');
      console.log('Please check screenshots/secret_revealed.png');
      console.log('And screenshots/page_text.txt');
    }

    console.log('\nKeeping browser open for 10 seconds for verification...');
    await page.waitForTimeout(10000);

    await browser.close();
    return { clientId, clientSecret };

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: 'screenshots/error_pause.png', fullPage: true });
    await browser.close();
    throw error;
  }
}

getSecretWithPause()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
