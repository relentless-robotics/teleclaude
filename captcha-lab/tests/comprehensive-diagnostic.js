const { launchStealthBrowser, simulateHumanBehavior } = require('../solver/stealth-browser');

async function comprehensiveDiagnostic() {
  console.log('🔬 Comprehensive Turnstile Diagnostic\n');

  const { browser, page } = await launchStealthBrowser({ headless: false });

  await page.goto('https://nowsecure.nl/');
  console.log('✅ Page loaded\n');

  // Simulate behavior first
  console.log('🎭 Simulating human behavior...');
  await simulateHumanBehavior(page, 5000);
  console.log('✅ Behavior simulation complete\n');

  // Wait for widgets to fully render
  console.log('⏳ Waiting 10 seconds for widgets to render...');
  await page.waitForTimeout(10000);

  // Comprehensive analysis
  console.log('\n📊 === COMPREHENSIVE ANALYSIS ===\n');

  const analysis = await page.evaluate(() => {
    const results = {};

    // 1. Find all Turnstile widgets
    const widgets = Array.from(document.querySelectorAll('.cf-turnstile'));
    results.widgets = widgets.map((w, i) => {
      const info = {
        index: i,
        id: w.id,
        className: w.className,
        innerHTML: w.innerHTML.substring(0, 300),
        childNodes: w.childNodes.length,
        children: Array.from(w.children).map(child => ({
          tag: child.tagName,
          id: child.id,
          className: child.className
        })),
        hasShadow: !!w.shadowRoot,
        style: w.getAttribute('style'),
        position: {
          x: w.getBoundingClientRect().x,
          y: w.getBoundingClientRect().y,
          width: w.getBoundingClientRect().width,
          height: w.getBoundingClientRect().height
        }
      };

      // Check if widget has data attributes
      const attrs = {};
      for (let attr of w.attributes) {
        if (attr.name.startsWith('data-')) {
          attrs[attr.name] = attr.value;
        }
      }
      info.dataAttributes = attrs;

      // Try to find iframes inside widget
      const iframesInside = Array.from(w.querySelectorAll('iframe'));
      info.iframesInside = iframesInside.map(iframe => ({
        src: iframe.src,
        width: iframe.width,
        height: iframe.height,
        position: {
          x: iframe.getBoundingClientRect().x,
          y: iframe.getBoundingClientRect().y,
          width: iframe.getBoundingClientRect().width,
          height: iframe.getBoundingClientRect().height
        }
      }));

      return info;
    });

    // 2. Find ALL iframes on page
    const allIframes = Array.from(document.querySelectorAll('iframe'));
    results.allIframes = allIframes.map(iframe => ({
      src: iframe.src,
      id: iframe.id,
      className: iframe.className,
      title: iframe.title,
      name: iframe.name,
      width: iframe.width,
      height: iframe.height,
      sandbox: iframe.getAttribute('sandbox'),
      allow: iframe.getAttribute('allow'),
      position: {
        x: iframe.getBoundingClientRect().x,
        y: iframe.getBoundingClientRect().y,
        width: iframe.getBoundingClientRect().width,
        height: iframe.getBoundingClientRect().height
      },
      visible: iframe.offsetParent !== null
    }));

    // 3. Look for clickable elements with "verify" or "human" text
    const clickableElements = [];
    const allElements = document.querySelectorAll('*');

    allElements.forEach(el => {
      const text = el.textContent.toLowerCase();
      if ((text.includes('verify') || text.includes('human')) && el.getBoundingClientRect().width > 100) {
        clickableElements.push({
          tag: el.tagName,
          id: el.id,
          className: el.className,
          text: el.textContent.substring(0, 100),
          position: {
            x: el.getBoundingClientRect().x,
            y: el.getBoundingClientRect().y,
            width: el.getBoundingClientRect().width,
            height: el.getBoundingClientRect().height
          }
        });
      }
    });

    results.clickableElements = clickableElements;

    return results;
  });

  console.log('=== WIDGET INFORMATION ===');
  console.log(JSON.stringify(analysis.widgets, null, 2));

  console.log('\n=== ALL IFRAMES ===');
  console.log(JSON.stringify(analysis.allIframes, null, 2));

  console.log('\n=== CLICKABLE ELEMENTS (with "verify"/"human") ===');
  console.log(JSON.stringify(analysis.clickableElements, null, 2));

  // Take full page screenshot
  await page.screenshot({
    path: '../screenshots/comprehensive-diagnostic.png',
    fullPage: true
  });

  console.log('\n📸 Screenshot saved to: ../screenshots/comprehensive-diagnostic.png');

  console.log('\n⏸️  Keeping browser open for 60 seconds...');
  console.log('Try manually clicking the checkbox to observe behavior!\n');

  await page.waitForTimeout(60000);

  await browser.close();
}

comprehensiveDiagnostic().catch(console.error);
