/**
 * Diagnostic Test for Turnstile
 *
 * Analyzes the page structure and iframes to understand
 * how to properly interact with the Turnstile widget.
 */

const { launchStealthBrowser } = require('../solver/stealth-browser');

async function diagnoseTurnstile() {
  console.log('🔍 Turnstile Diagnostic Test\n');

  let browser, context, page;

  try {
    // Launch stealth browser
    console.log('🚀 Launching stealth browser...');
    const result = await launchStealthBrowser({
      headless: false,
      persistent: false
    });

    browser = result.browser;
    context = result.context;
    page = result.page;

    console.log('✅ Browser launched\n');

    // Navigate to test page
    const testUrl = 'https://nowsecure.nl/';
    console.log(`🌐 Navigating to ${testUrl}...`);

    await page.goto(testUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    console.log('✅ Page loaded\n');

    // Wait for page to settle
    await page.waitForTimeout(3000);

    // Analyze main page
    console.log('📄 Main Page Analysis:');
    const mainPageInfo = await page.evaluate(() => {
      const info = {
        title: document.title,
        iframes: document.querySelectorAll('iframe').length,
        turnstileWidgets: document.querySelectorAll('.cf-turnstile').length,
        turnstileDivs: document.querySelectorAll('[class*="turnstile"]').length
      };

      // Get iframe sources
      const iframes = Array.from(document.querySelectorAll('iframe'));
      info.iframeSources = iframes.map(iframe => ({
        src: iframe.src,
        id: iframe.id,
        className: iframe.className
      }));

      return info;
    });

    console.log(JSON.stringify(mainPageInfo, null, 2));
    console.log('');

    // Analyze all frames
    console.log('🖼️  Frame Analysis:');
    const frames = page.frames();
    console.log(`Total frames: ${frames.length}\n`);

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const url = frame.url();

      console.log(`Frame ${i}:`);
      console.log(`  URL: ${url}`);

      if (url.includes('challenges.cloudflare.com')) {
        console.log(`  ⭐ This is a Cloudflare challenge frame!`);

        try {
          // Analyze frame content
          const frameContent = await frame.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input'));
            const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));

            return {
              inputCount: inputs.length,
              checkboxCount: checkboxes.length,
              inputs: inputs.map(input => ({
                type: input.type,
                id: input.id,
                name: input.name,
                className: input.className,
                visible: input.offsetParent !== null
              })),
              bodyHTML: document.body ? document.body.innerHTML.substring(0, 500) : 'NO BODY',
              allElements: document.querySelectorAll('*').length
            };
          });

          console.log('  Frame content:', JSON.stringify(frameContent, null, 4));

          // Try to take screenshot of frame
          const frameElement = await page.$(`iframe[src*="challenges.cloudflare.com"]`);
          if (frameElement) {
            const box = await frameElement.boundingBox();
            if (box) {
              console.log(`  Frame position: x=${box.x}, y=${box.y}, w=${box.width}, h=${box.height}`);
            }
          }

        } catch (e) {
          console.log(`  ❌ Error analyzing frame: ${e.message}`);
        }
      }

      console.log('');
    }

    // Keep browser open for manual inspection
    console.log('\n⏸️  Browser will remain open for 60 seconds for manual inspection...');
    console.log('You can manually interact with the page to see what happens.');
    await page.waitForTimeout(60000);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    if (browser) {
      console.log('\n🔚 Closing browser...');
      await browser.close();
    }
  }
}

// Run diagnostic
diagnoseTurnstile().catch(console.error);
