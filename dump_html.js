const { chromium } = require('playwright');
const fs = require('fs');

async function dumpHTML() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  await page.goto('https://github.com/login');
  await page.fill('input[name="login"]', 'relentless-robotics');
  await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
  await page.click('input[type="submit"]');
  await page.waitForTimeout(6000);

  await page.goto('https://github.com/settings/developers');
  await page.waitForTimeout(2000);

  await page.click('text=TeleClaude Dashboard');
  await page.waitForTimeout(2000);

  const html = await page.content();
  fs.writeFileSync('screenshots/page.html', html);
  console.log('✅ HTML saved to screenshots/page.html');

  // Also search for the text "Generate" in the HTML
  const matches = html.match(/.{0,200}[Gg]enerate.{0,200}/g);
  if (matches) {
    console.log('\nFound "Generate" in HTML:');
    matches.forEach((m, i) => {
      console.log(`\n--- Match ${i + 1} ---`);
      console.log(m);
    });
  }

  await page.waitForTimeout(3000);
  await browser.close();
}

dumpHTML().then(() => process.exit(0)).catch(() => process.exit(1));
