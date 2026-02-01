const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function setupWithKeyboard() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');

    console.log('Google Ads setup with keyboard navigation...');

    let browser;
    let context;
    let page;

    try {
        browser = await chromium.launch({
            headless: false,
            args: ['--disable-blink-features=AutomationControlled', '--start-maximized']
        });
        context = await browser.newContext({
            storageState: stateFile,
            viewport: { width: 1920, height: 1080 }
        });
        page = await context.newPage();

        // Go directly to the setup page
        console.log('Navigating to account setup...');
        await page.goto('https://ads.google.com/aw/signup/aboutyourbusiness?ocid=7987879904&euid=1615163210&__u=3072615290&uscid=7987879904&__c=6128758496&authuser=0', {
            waitUntil: 'networkidle',
            timeout: 60000
        });
        await sleep(5000);

        console.log(`Current URL: ${page.url()}`);

        // Close any ad blocker warning if present
        try {
            const closeWarning = await page.locator('[aria-label="Close"], button:has-text("Close"), .mdc-icon-button').first();
            if (await closeWarning.isVisible()) {
                await closeWarning.click();
                await sleep(1000);
            }
        } catch (e) {
            // No warning
        }

        // Click on the page to ensure focus
        await page.click('body');
        await sleep(500);

        // Tab to navigate to fields
        console.log('Navigating to business name field...');
        await page.keyboard.press('Tab');
        await sleep(500);
        await page.keyboard.press('Tab');
        await sleep(500);
        await page.keyboard.press('Tab');
        await sleep(500);

        // Type business name
        console.log('Typing business name...');
        await page.keyboard.type('Relentless Robotics', { delay: 50 });
        await sleep(1000);

        // Tab to URL field
        console.log('Tabbing to URL field...');
        await page.keyboard.press('Tab');
        await sleep(500);
        await page.keyboard.press('Tab');
        await sleep(500);
        await page.keyboard.press('Tab');
        await sleep(500);

        // Type URL
        console.log('Typing URL...');
        await page.keyboard.type('https://www.example.com', { delay: 50 });
        await sleep(1000);

        await page.screenshot({ path: 'keyboard_step1.png', fullPage: true });

        // Tab to Next button and press Enter
        console.log('Tabbing to Next button...');
        for (let i = 0; i < 10; i++) {
            await page.keyboard.press('Tab');
            await sleep(200);
        }

        // Try pressing Enter to submit
        await page.keyboard.press('Enter');
        await sleep(5000);

        console.log(`URL after submit: ${page.url()}`);
        await page.screenshot({ path: 'keyboard_step2.png', fullPage: true });

        // Alternative: Try clicking directly on input fields using coordinates
        console.log('\nTrying direct click approach...');

        // Reload the page
        await page.goto('https://ads.google.com/aw/signup/aboutyourbusiness?ocid=7987879904&euid=1615163210&__u=3072615290&uscid=7987879904&__c=6128758496&authuser=0', {
            waitUntil: 'networkidle',
            timeout: 60000
        });
        await sleep(5000);

        // Find all elements that might be input containers
        const inputDivs = await page.locator('[role="textbox"], div.mdc-text-field, mat-form-field, .text-field').all();
        console.log(`Found ${inputDivs.length} potential input containers`);

        // Try clicking on any element with "Enter" in placeholder text
        const enterElements = await page.locator('*:has-text("Enter")').all();
        console.log(`Found ${enterElements.length} elements with "Enter" text`);

        // Look for the URL input by finding the link icon and clicking near it
        try {
            const linkIcon = await page.locator('text=link').first();
            if (await linkIcon.isVisible()) {
                const box = await linkIcon.boundingBox();
                if (box) {
                    console.log(`Link icon at: ${box.x}, ${box.y}`);
                    // Click to the right of the icon (where input should be)
                    await page.mouse.click(box.x + 200, box.y);
                    await sleep(500);
                    await page.keyboard.type('https://www.example.com', { delay: 50 });
                    console.log('Typed URL near link icon');
                }
            }
        } catch (e) {
            console.log('Could not find link icon');
        }

        await page.screenshot({ path: 'keyboard_step3.png', fullPage: true });

        // Try finding input by evaluating page
        console.log('\nTrying JavaScript approach...');
        await page.evaluate(() => {
            // Find all inputs
            const inputs = document.querySelectorAll('input');
            console.log('Inputs found:', inputs.length);

            // Try to find the URL input
            inputs.forEach((input, i) => {
                const parent = input.parentElement;
                const grandparent = parent ? parent.parentElement : null;
                const text = (parent?.innerText || '') + (grandparent?.innerText || '');
                console.log(`Input ${i}:`, input.type, text.substring(0, 50));
            });
        });

        // Get all input elements and their parents
        const allInputs = await page.$$('input');
        console.log(`Total inputs on page: ${allInputs.length}`);

        for (let i = 0; i < allInputs.length; i++) {
            const input = allInputs[i];
            const box = await input.boundingBox();
            if (box) {
                console.log(`Input ${i} at: x=${box.x}, y=${box.y}, width=${box.width}, height=${box.height}`);

                // The second visible input should be the URL field
                if (i === 1 && box.width > 100) {
                    console.log(`Clicking and filling input ${i}...`);
                    await input.click();
                    await sleep(300);
                    await input.selectText();
                    await sleep(100);
                    await page.keyboard.type('https://www.example.com', { delay: 30 });
                    console.log('Filled via direct click');
                }
            }
        }

        await sleep(2000);
        await page.screenshot({ path: 'keyboard_step4.png', fullPage: true });

        // Now try clicking Next
        console.log('\nClicking Next button...');
        try {
            await page.click('button:has-text("Next")');
            await sleep(5000);
        } catch (e) {
            console.log('Failed to click Next:', e.message);
        }

        console.log(`URL after Next: ${page.url()}`);
        await page.screenshot({ path: 'keyboard_step5.png', fullPage: true });

        // Print current page state
        const bodyText = await page.evaluate(() => document.body.innerText);
        console.log('\nCurrent page state:');
        console.log(bodyText.substring(0, 2000));

        console.log('\nKeeping browser open for 120 seconds...');
        await sleep(120000);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        if (page) {
            await page.screenshot({ path: 'keyboard_error.png', fullPage: true });
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

setupWithKeyboard().catch(console.error);
