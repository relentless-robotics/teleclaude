const { chromium } = require('playwright');
const fs = require('fs');

async function scrapeAllBounties() {
  console.log('Starting bounty scrape...');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://algora.io/bounties');
  console.log('Page loaded, waiting for content...');
  await page.waitForLoadState('networkidle');

  // Scroll to load all bounties
  let previousHeight = 0;
  let scrollCount = 0;

  while (scrollCount < 50) { // Max 50 scrolls
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);

    if (currentHeight === previousHeight) {
      console.log('Reached end of page');
      break;
    }

    previousHeight = currentHeight;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    scrollCount++;
    console.log(`Scroll ${scrollCount}, height: ${currentHeight}`);
  }

  // Scroll back to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // Extract all bounties
  const bounties = await page.evaluate(() => {
    const items = [];
    // Look for bounty cards/rows
    const allText = document.body.innerText;

    // Find patterns like "$100", "$150", etc followed by text
    const lines = allText.split('\n').filter(l => l.trim());

    let currentBounty = null;
    for (const line of lines) {
      const priceMatch = line.match(/\$[\d,]+/);
      if (priceMatch) {
        if (currentBounty) items.push(currentBounty);
        currentBounty = { amount: priceMatch[0], text: line };
      } else if (currentBounty && line.length > 5 && line.length < 200) {
        currentBounty.text += ' | ' + line;
      }
    }
    if (currentBounty) items.push(currentBounty);

    return items;
  });

  console.log(`Found ${bounties.length} potential bounties`);

  // Also get structured data if available
  const structuredBounties = await page.evaluate(() => {
    const results = [];
    // Try different selectors
    const cards = document.querySelectorAll('a[href*="/bounties"], div[class*="bounty"], tr, article');

    cards.forEach(card => {
      const text = card.innerText || '';
      const href = card.getAttribute('href') || '';
      const priceMatch = text.match(/\$[\d,]+/);

      if (priceMatch && text.length < 500) {
        results.push({
          amount: priceMatch[0],
          text: text.substring(0, 300).replace(/\n/g, ' | '),
          link: href
        });
      }
    });

    return results;
  });

  // Combine and dedupe
  const allBounties = [...bounties, ...structuredBounties];

  // Sort by amount
  allBounties.sort((a, b) => {
    const amountA = parseInt(a.amount.replace(/[$,]/g, '')) || 0;
    const amountB = parseInt(b.amount.replace(/[$,]/g, '')) || 0;
    return amountA - amountB;
  });

  // Format output
  let output = '# All Algora Bounties (Scraped)\n\n';
  output += `Total found: ${allBounties.length}\n\n`;
  output += '## Bounties Under $300 (Our Targets)\n\n';

  const smallBounties = allBounties.filter(b => {
    const amount = parseInt(b.amount.replace(/[$,]/g, '')) || 0;
    return amount > 0 && amount <= 300;
  });

  smallBounties.forEach(b => {
    output += `- **${b.amount}** - ${b.text.substring(0, 150)}\n`;
  });

  output += '\n\n## All Bounties\n\n';
  allBounties.forEach(b => {
    output += `- **${b.amount}** - ${b.text.substring(0, 150)}\n`;
  });

  // Save to file
  fs.writeFileSync('BOUNTY_INDEX.md', output);
  console.log('Saved to BOUNTY_INDEX.md');

  // Take screenshot
  await page.screenshot({ path: 'screenshots/all_bounties.png', fullPage: true });

  await browser.close();

  return { total: allBounties.length, small: smallBounties.length, bounties: smallBounties };
}

scrapeAllBounties()
  .then(result => {
    console.log('Done!');
    console.log(`Total bounties: ${result.total}`);
    console.log(`Small bounties (under $300): ${result.small}`);
    console.log('\nSmall bounties found:');
    result.bounties.forEach(b => console.log(`  ${b.amount}: ${b.text.substring(0, 80)}`));
  })
  .catch(err => console.error('Error:', err));
