/**
 * Find Checkbox Test
 *
 * Specifically designed to locate where the Turnstile checkbox actually is
 */

const { launchStealthBrowser } = require('../solver/stealth-browser');

async function findCheckbox() {
  console.log('🔍 Finding Turnstile Checkbox Location\n');

  let browser, context, page;

  try {
    const result = await launchStealthBrowser({ headless: false });
    browser = result.browser;
    context = result.context;
    page = result.page;

    await page.goto('https://nowsecure.nl/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    console.log('📍 Searching for checkbox in main page...\n');

    // Search main page
    const mainPageCheckbox = await page.evaluate(() => {
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      const labels = Array.from(document.querySelectorAll('label'));

      return {
        checkboxCount: checkboxes.length,
        checkboxes: checkboxes.map(cb => ({
          id: cb.id,
          name: cb.name,
          className: cb.className,
          visible: cb.offsetParent !== null,
          parentTagName: cb.parentElement?.tagName,
          parentClassName: cb.parentElement?.className
        })),
        labelCount: labels.length,
        labels: labels.map(l => ({
          text: l.textContent,
          htmlFor: l.htmlFor,
          className: l.className
        }))
      };
    });

    console.log('Main Page:', JSON.stringify(mainPageCheckbox, null, 2));

    // Check inside widget shadow DOM
    console.log('\n📍 Checking for shadow DOM...\n');

    const shadowInfo = await page.evaluate(() => {
      const widgets = document.querySelectorAll('.cf-turnstile');
      const results = [];

      widgets.forEach((widget, index) => {
        const result = {
          index,
          hasShadowRoot: !!widget.shadowRoot,
          innerHTML: widget.innerHTML.substring(0, 200),
          childCount: widget.children.length,
          children: Array.from(widget.children).map(child => ({
            tagName: child.tagName,
            id: child.id,
            className: child.className
          }))
        };

        if (widget.shadowRoot) {
          const shadowCheckboxes = widget.shadowRoot.querySelectorAll('input[type="checkbox"]');
          result.shadowCheckboxes = shadowCheckboxes.length;
        }

        results.push(result);
      });

      return results;
    });

    console.log('Shadow DOM:', JSON.stringify(shadowInfo, null, 2));

    // Check all frames again
    console.log('\n📍 Checking frames with detailed selectors...\n');

    const frames = page.frames();
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      const url = frame.url();

      if (url.includes('cloudflare')) {
        console.log(`\nFrame ${i}: ${url.substring(0, 100)}`);

        try {
          const frameInfo = await frame.evaluate(() => {
            return {
              checkboxes: document.querySelectorAll('input[type="checkbox"]').length,
              inputs: document.querySelectorAll('input').length,
              labels: document.querySelectorAll('label').length,
              divs: document.querySelectorAll('div').length,
              bodyText: document.body?.textContent || 'NO BODY',
              allHTML: document.documentElement.innerHTML.substring(0, 500)
            };
          });

          console.log(JSON.stringify(frameInfo, null, 2));
        } catch (e) {
          console.log('Error:', e.message);
        }
      }
    }

    console.log('\n\n⏸️  Browser open for 60 seconds - manually click checkbox to see what happens...');
    await page.waitForTimeout(60000);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

findCheckbox().catch(console.error);
