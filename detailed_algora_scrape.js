const { chromium } = require('playwright');
const fs = require('fs');

async function scrapeDetailedBounties() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const detailedBounties = [];

  // List of bounty URLs to visit
  const bountyUrls = [
    { url: 'https://github.com/rafael-fuente/diffractsim/issues/69', org: 'Rafael de la Fuente', amount: '$1,000' },
    { url: 'https://github.com/archestra-ai/archestra/issues/1301', org: 'Archestra', amount: '$900' },
    { url: 'https://github.com/Mudlet/Mudlet/issues/8030', org: 'Mudlet', amount: '$1,000' },
    { url: 'https://algora.io/twentyhq/bounties/g6i2c8YSNV9nHogT', org: 'Twenty (YC S23)', amount: '$2,500' },
    { url: 'https://github.com/golemcloud/golem-cli/issues/275', org: 'Golem Cloud', amount: '$3,500' },
    { url: 'https://github.com/omnigres/omnigres/issues/823', org: 'Omnigres', amount: '$1,000' },
    { url: 'https://github.com/deskflow/deskflow/issues/8032', org: 'Deskflow', amount: '$2,500' },
    { url: 'https://github.com/deskflow/deskflow/issues/8031', org: 'Deskflow', amount: '$5,000' },
    { url: 'https://github.com/getkyo/kyo/issues/390', org: 'Kyo', amount: '$500' },
    { url: 'https://algora.io/isaac/bounties/clq18zr98000ejs0gt0nv7gwu', org: 'Isaac', amount: '$850' },
    { url: 'https://github.com/zio/zio-blocks/issues/899', org: 'ZIO', amount: '$500' },
    { url: 'https://github.com/zio/zio-schema/issues/754', org: 'ZIO', amount: '$500' }
  ];

  for (const bounty of bountyUrls) {
    console.log(`\nVisiting: ${bounty.org} - ${bounty.amount}`);
    console.log(`URL: ${bounty.url}`);

    try {
      await page.goto(bounty.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Extract page content
      const pageData = await page.evaluate(() => {
        return {
          title: document.title,
          bodyText: document.body.innerText.substring(0, 3000),
          languages: Array.from(document.querySelectorAll('[aria-label*="language"], .BorderGrid-cell, .color-fg-muted'))
            .map(el => el.innerText)
            .filter(text => text && text.length < 30)
        };
      });

      detailedBounties.push({
        organization: bounty.org,
        amount: bounty.amount,
        url: bounty.url,
        title: pageData.title,
        snippet: pageData.bodyText.substring(0, 500),
        languages: pageData.languages
      });

      console.log(`  Title: ${pageData.title}`);
      console.log(`  Languages found: ${pageData.languages.slice(0, 5).join(', ')}`);

    } catch (error) {
      console.log(`  Error scraping ${bounty.url}: ${error.message}`);
      detailedBounties.push({
        organization: bounty.org,
        amount: bounty.amount,
        url: bounty.url,
        error: error.message
      });
    }

    await page.waitForTimeout(1000);
  }

  // Save detailed results
  fs.writeFileSync('detailed_bounties.json', JSON.stringify(detailedBounties, null, 2));
  console.log('\n\nDetailed bounty data saved to detailed_bounties.json');

  await browser.close();
  return detailedBounties;
}

scrapeDetailedBounties().catch(console.error);
