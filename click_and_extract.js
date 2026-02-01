const { chromium } = require('playwright');
const fs = require('fs');

async function clickAndExtract() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  try {
    await page.goto('https://github.com/login');
    await page.fill('input[name="login"]', 'relentless-robotics');
    await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
    await page.click('input[type="submit"]');
    await page.waitForTimeout(6000);

    await page.goto('https://github.com/settings/developers');
    await page.waitForTimeout(2000);

    await page.click('text=TeleClaude Dashboard');
    await page.waitForTimeout(2000);

    const clientId = (await page.textContent('body')).match(/Ov[a-zA-Z0-9]+/)[0];
    console.log('Client ID:', clientId);

    console.log('\nLooking for the button...');

    // Wait for the button to be visible
    await page.waitForSelector('button', { state: 'visible' });

    // Get all buttons and find the right one
    const buttons = await page.$$('button');
    console.log(`Found ${buttons.length} buttons on page`);

    let generateButton = null;
    for (const button of buttons) {
      const text = await button.textContent();
      console.log('Button text:', text);
      if (text && text.includes('Generate')) {
        generateButton = button;
        console.log('✅ Found Generate button!');
        break;
      }
    }

    if (!generateButton) {
      throw new Error('Could not find Generate button');
    }

    console.log('\nClicking Generate button...');
    await generateButton.click();

    console.log('Waiting 3 seconds for secret to appear...');
    await page.waitForTimeout(3000);

    await page.screenshot({ path: 'screenshots/after_click.png', fullPage: true });

    // Extract secret
    const bodyText = await page.textContent('body');
    fs.writeFileSync('screenshots/body_after_click.txt', bodyText);

    const patterns = [
      /ghs_[a-zA-Z0-9]{36}/,
      /ghp_[a-zA-Z0-9]{36}/,
      /gho_[a-zA-Z0-9]{36}/,
      /\b[a-f0-9]{40}\b/
    ];

    let secret = null;
    for (const pattern of patterns) {
      const match = bodyText.match(pattern);
      if (match) {
        secret = match[0];
        console.log('\n✅ Found secret:', secret.substring(0, 15) + '...');
        break;
      }
    }

    if (secret) {
      const credentials = {
        client_id: clientId,
        client_secret: secret,
        application_name: 'TeleClaude Dashboard',
        homepage_url: 'https://dashboard-app-black-kappa.vercel.app',
        callback_url: 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github',
        created_at: new Date().toISOString()
      };

      fs.writeFileSync('github_oauth_credentials.json', JSON.stringify(credentials, null, 2));
      console.log('\n✅ SUCCESS! Credentials saved!');
      console.log(JSON.stringify(credentials, null, 2));
    } else {
      console.log('\n⚠️ Could not find secret automatically');
      console.log('Check screenshots/after_click.png and screenshots/body_after_click.txt');
    }

    await page.waitForTimeout(5000);
    await browser.close();

    if (secret) {
      return { clientId, secret };
    } else {
      throw new Error('Secret not found');
    }

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: 'screenshots/error_extract.png', fullPage: true });
    await browser.close();
    throw error;
  }
}

clickAndExtract()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
