/**
 * Diagnostic script to inspect Turnstile widget structure
 */

const { chromium } = require('playwright');

const TEST_URL = 'https://nowsecure.nl/';

async function inspectTurnstile() {
  console.log('Inspecting Turnstile widget structure...\n');

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
    await page.waitForTimeout(2000);

    console.log('=== IFRAMES ===');
    const frames = page.frames();
    console.log(`Total frames: ${frames.length}`);
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const url = frame.url();
      const name = frame.name();
      console.log(`Frame ${i}: ${name || '(no name)'}`);
      console.log(`  URL: ${url}`);
    }

    console.log('\n=== TURNSTILE WIDGET ===');
    const widget = await page.$('.cf-turnstile');
    if (widget) {
      console.log('✓ Found .cf-turnstile widget');

      // Get widget properties
      const widgetHTML = await widget.evaluate(el => el.outerHTML);
      console.log('Widget HTML:', widgetHTML.substring(0, 500));

      // Check for iframe inside widget
      const iframeInWidget = await widget.$('iframe');
      if (iframeInWidget) {
        const src = await iframeInWidget.getAttribute('src');
        const title = await iframeInWidget.getAttribute('title');
        console.log('\n✓ Found iframe inside widget');
        console.log(`  src: ${src}`);
        console.log(`  title: ${title}`);

        // Try to access iframe content
        const frame = await iframeInWidget.contentFrame();
        if (frame) {
          console.log('  ✓ Accessed iframe content');

          // Look for checkbox in iframe
          const checkbox = await frame.$('input[type="checkbox"]');
          if (checkbox) {
            console.log('  ✓ Found checkbox in iframe!');
            const checkboxHTML = await checkbox.evaluate(el => el.outerHTML);
            console.log(`  Checkbox HTML: ${checkboxHTML}`);
          } else {
            console.log('  ✗ No checkbox found in iframe');

            // List all elements in iframe
            const bodyHTML = await frame.evaluate(() => document.body.innerHTML);
            console.log('  Iframe body HTML:', bodyHTML.substring(0, 500));
          }
        } else {
          console.log('  ✗ Could not access iframe content (may be cross-origin)');
        }
      }

      // Check for shadow DOM
      const hasShadow = await widget.evaluate(el => !!el.shadowRoot);
      if (hasShadow) {
        console.log('\n✓ Widget has shadow DOM');
        const shadowHTML = await widget.evaluate(el => el.shadowRoot.innerHTML);
        console.log('Shadow DOM:', shadowHTML.substring(0, 500));
      }
    }

    console.log('\n=== CLOUDFLARE CHALLENGE IFRAME ===');
    const cfIframe = await page.$('iframe[src*="challenges.cloudflare.com"]');
    if (cfIframe) {
      console.log('✓ Found Cloudflare challenge iframe');
      const src = await cfIframe.getAttribute('src');
      console.log(`  src: ${src}`);

      const frame = await cfIframe.contentFrame();
      if (frame) {
        console.log('  ✓ Accessed iframe content');

        // Look for interactive elements
        const inputs = await frame.$$('input');
        const buttons = await frame.$$('button');
        const divs = await frame.$$('div[role="button"]');

        console.log(`  Found ${inputs.length} inputs, ${buttons.length} buttons, ${divs.length} clickable divs`);

        for (let i = 0; i < inputs.length; i++) {
          const input = inputs[i];
          const type = await input.getAttribute('type');
          const id = await input.getAttribute('id');
          const className = await input.getAttribute('class');
          console.log(`  Input ${i}: type=${type}, id=${id}, class=${className}`);
        }
      }
    }

    console.log('\n=== ALL IFRAMES WITH CLOUDFLARE ===');
    const allCfIframes = await page.$$('iframe[src*="cloudflare"]');
    console.log(`Found ${allCfIframes.length} Cloudflare iframes`);
    for (let i = 0; i < allCfIframes.length; i++) {
      const iframe = allCfIframes[i];
      const src = await iframe.getAttribute('src');
      console.log(`  ${i}: ${src}`);
    }

    console.log('\n[*] Keeping browser open for 30 seconds for manual inspection...');
    console.log('[*] You can now manually inspect the page in DevTools');
    await page.waitForTimeout(30000);

  } finally {
    await browser.close();
  }
}

inspectTurnstile().catch(console.error);
