const { chromium } = require('playwright');
const fs = require('fs');

async function findSecretElement() {
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

    console.log('\nSearching for "Generate" elements...\n');

    // Check all element types
    const allElements = await page.$$('a, button, input[type="submit"], span.btn, div[role="button"]');

    console.log(`Checking ${allElements.length} clickable elements...`);

    for (const el of allElements) {
      const text = await el.textContent().catch(() => '');
      const tagName = await el.evaluate(node => node.tagName);

      if (text.toLowerCase().includes('generate') || text.toLowerCase().includes('client secret')) {
        console.log(`\n✅ Found matching element:`);
        console.log(`Tag: ${tagName}`);
        console.log(`Text: ${text}`);

        const classes = await el.getAttribute('class');
        const role = await el.getAttribute('role');
        console.log(`Classes: ${classes}`);
        console.log(`Role: ${role}`);

        console.log('\nTrying to click this element...');
        await el.click();

        console.log('Waiting for response...');
        await page.waitForTimeout(3000);

        await page.screenshot({ path: 'screenshots/after_element_click.png', fullPage: true });

        const bodyText = await page.textContent('body');
        fs.writeFileSync('screenshots/body_text.txt', bodyText);

        // Look for secret
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
            break;
          }
        }

        if (secret) {
          console.log('\n✅✅✅ SECRET FOUND! ✅✅✅');
          console.log('Secret:', secret.substring(0, 15) + '...');

          const credentials = {
            client_id: clientId,
            client_secret: secret,
            application_name: 'TeleClaude Dashboard',
            homepage_url: 'https://dashboard-app-black-kappa.vercel.app',
            callback_url: 'https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github',
            created_at: new Date().toISOString()
          };

          fs.writeFileSync('github_oauth_credentials.json', JSON.stringify(credentials, null, 2));
          console.log('\n✅ Credentials saved to github_oauth_credentials.json');

          await page.waitForTimeout(3000);
          await browser.close();
          return credentials;
        }

        break; // Found and clicked the element
      }
    }

    console.log('\nKeeping browser open for inspection...');
    await page.waitForTimeout(20000);
    await browser.close();

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: 'screenshots/error_find.png', fullPage: true });
    await browser.close();
    throw error;
  }
}

findSecretElement()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
