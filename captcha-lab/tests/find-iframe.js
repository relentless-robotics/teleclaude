const { launchStealthBrowser } = require('../solver/stealth-browser');

async function findIframe() {
  const { browser, page } = await launchStealthBrowser({ headless: false });

  await page.goto('https://nowsecure.nl/');
  await page.waitForTimeout(5000);

  const iframes = await page.evaluate(() => {
    const frames = Array.from(document.querySelectorAll('iframe'));
    return frames.map(iframe => ({
      src: iframe.src,
      id: iframe.id,
      className: iframe.className,
      width: iframe.width,
      height: iframe.height,
      style: iframe.getAttribute('style'),
      visible: iframe.offsetParent !== null,
      box: {
        x: iframe.getBoundingClientRect().x,
        y: iframe.getBoundingClientRect().y,
        width: iframe.getBoundingClientRect().width,
        height: iframe.getBoundingClientRect().height
      }
    }));
  });

  console.log('Found iframes:', JSON.stringify(iframes, null, 2));

  await page.waitForTimeout(30000);
  await browser.close();
}

findIframe().catch(console.error);
