/**
 * Deep inspection of Turnstile challenge iframe contents
 */

const { chromium } = require('playwright');

const TEST_URL = 'https://nowsecure.nl/';

async function deepInspect() {
  console.log('Deep inspection of Turnstile challenge iframes...\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    await page.goto(TEST_URL, { waitUntil: 'domcontentloaded' });
    console.log('[+] Page loaded, waiting 3 seconds for Turnstile to fully render...');
    await page.waitForTimeout(3000);

    const frames = page.frames();
    console.log(`[+] Total frames: ${frames.length}\n`);

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const url = frame.url();

      if (!url.includes('challenges.cloudflare.com')) {
        continue;
      }

      console.log('='.repeat(60));
      console.log(`FRAME ${i}: Cloudflare Challenge`);
      console.log('='.repeat(60));
      console.log(`URL: ${url}`);

      try {
        // Get all HTML content
        const html = await frame.evaluate(() => document.documentElement.outerHTML);
        console.log(`\nFull HTML (first 1000 chars):\n${html.substring(0, 1000)}\n`);

        // Count all elements
        const allElements = await frame.$$('*');
        console.log(`Total elements in iframe: ${allElements.length}`);

        // Look for inputs
        const inputs = await frame.$$('input');
        console.log(`\n=== INPUTS (${inputs.length}) ===`);
        for (let j = 0; j < inputs.length; j++) {
          const input = inputs[j];
          const type = await input.getAttribute('type');
          const id = await input.getAttribute('id');
          const className = await input.getAttribute('class');
          const name = await input.getAttribute('name');
          const role = await input.getAttribute('role');
          const html = await input.evaluate(el => el.outerHTML);
          console.log(`Input ${j}:`);
          console.log(`  type: ${type}`);
          console.log(`  id: ${id}`);
          console.log(`  class: ${className}`);
          console.log(`  name: ${name}`);
          console.log(`  role: ${role}`);
          console.log(`  html: ${html}`);
        }

        // Look for buttons
        const buttons = await frame.$$('button');
        console.log(`\n=== BUTTONS (${buttons.length}) ===`);
        for (const button of buttons) {
          const html = await button.evaluate(el => el.outerHTML);
          console.log(html);
        }

        // Look for divs with role
        const clickableDivs = await frame.$$('div[role], span[role], label[role]');
        console.log(`\n=== ELEMENTS WITH ROLE (${clickableDivs.length}) ===`);
        for (const div of clickableDivs) {
          const role = await div.getAttribute('role');
          const id = await div.getAttribute('id');
          const className = await div.getAttribute('class');
          const html = await div.evaluate(el => el.outerHTML.substring(0, 200));
          console.log(`Role: ${role}, ID: ${id}, Class: ${className}`);
          console.log(`  HTML: ${html}`);
        }

        // Look for shadow DOMs
        const elementsWithShadow = await frame.evaluate(() => {
          const elements = document.querySelectorAll('*');
          const withShadow = [];
          elements.forEach((el, idx) => {
            if (el.shadowRoot) {
              withShadow.push({
                index: idx,
                tagName: el.tagName,
                id: el.id,
                className: el.className,
                shadowHTML: el.shadowRoot.innerHTML.substring(0, 500)
              });
            }
          });
          return withShadow;
        });

        console.log(`\n=== SHADOW DOMS (${elementsWithShadow.length}) ===`);
        for (const shadow of elementsWithShadow) {
          console.log(`Element: <${shadow.tagName}> id="${shadow.id}" class="${shadow.className}"`);
          console.log(`Shadow content: ${shadow.shadowHTML}`);
        }

        // Get computed styles of body
        const bodyStyle = await frame.evaluate(() => {
          const body = document.body;
          const style = window.getComputedStyle(body);
          return {
            width: style.width,
            height: style.height,
            overflow: style.overflow
          };
        });
        console.log(`\n=== BODY STYLES ===`);
        console.log(JSON.stringify(bodyStyle, null, 2));

      } catch (e) {
        console.log(`Error inspecting frame: ${e.message}`);
      }

      console.log('');
    }

    console.log('\n[*] Keeping browser open for 60 seconds...');
    console.log('[*] You can manually interact with the checkbox to see what happens');
    await page.waitForTimeout(60000);

  } finally {
    await browser.close();
  }
}

deepInspect().catch(console.error);
