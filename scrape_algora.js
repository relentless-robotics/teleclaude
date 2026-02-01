const { chromium } = require('playwright');
const fs = require('fs');

async function scrapeAlgoraBounties() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Navigating to Algora bounties...');
  await page.goto('https://algora.io/bounties', { waitUntil: 'networkidle' });

  console.log('Waiting for page to load...');
  await page.waitForTimeout(5000);

  console.log('Taking initial screenshot...');
  await page.screenshot({ path: 'algora_initial.png', fullPage: true });

  console.log('Scrolling to load all content...');
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if(totalHeight >= scrollHeight){
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });

  await page.waitForTimeout(3000);

  console.log('Extracting bounty data from page...');

  const bountyData = await page.evaluate(() => {
    const data = {
      projects: [],
      rawText: document.body.innerText,
      links: []
    };

    // Get all links that might be project/bounty links
    const allLinks = Array.from(document.querySelectorAll('a'));
    allLinks.forEach(link => {
      const href = link.href;
      const text = link.innerText.trim();
      if (href && text) {
        data.links.push({ href, text });
      }
    });

    // Try to find bounty amounts
    const bodyText = document.body.innerText;
    const dollarMatches = bodyText.match(/\$\d+/g);
    data.dollarAmounts = dollarMatches || [];

    return data;
  });

  console.log('Bounty data extracted:');
  console.log('Dollar amounts found:', bountyData.dollarAmounts);
  console.log('Links found:', bountyData.links.length);
  console.log('\nSample links:');
  bountyData.links.slice(0, 20).forEach(link => {
    console.log(`  ${link.text} -> ${link.href}`);
  });

  // Save full data to file
  fs.writeFileSync('algora_data.json', JSON.stringify(bountyData, null, 2));
  console.log('\nFull data saved to algora_data.json');

  await page.screenshot({ path: 'algora_final.png', fullPage: true });

  await browser.close();
  console.log('Browser closed!');

  return bountyData;
}

scrapeAlgoraBounties().catch(console.error);
