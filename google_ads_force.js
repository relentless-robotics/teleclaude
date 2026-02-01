const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function forceSetup() {
    console.log('Google Ads setup with force click...');

    let context;
    let page;

    try {
        // Use Edge with persistent context
        console.log('Launching Edge with persistent profile...');
        context = await chromium.launchPersistentContext(
            path.join(__dirname, 'browser_profile_edge'),
            {
                channel: 'msedge',
                headless: false,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-extensions',
                    '--start-maximized'
                ],
                viewport: { width: 1920, height: 1080 }
            }
        );

        page = await context.newPage();

        // Navigate to the setup page
        console.log('Navigating to setup page...');
        await page.goto('https://ads.google.com/aw/signup/aboutyourbusiness?ocid=7987879904&euid=1615163210&__u=3072615290&uscid=7987879904&__c=6128758496&authuser=0', {
            waitUntil: 'networkidle',
            timeout: 60000
        });
        await sleep(5000);

        console.log(`Current URL: ${page.url()}`);

        // Use JavaScript to remove any overlays/modals
        console.log('\nRemoving any overlay elements...');
        await page.evaluate(() => {
            // Remove any modal overlays
            document.querySelectorAll('[role="dialog"], [role="alertdialog"], .modal, .overlay, .dialog').forEach(el => {
                el.style.display = 'none';
            });

            // Remove any fixed position elements that might be overlays
            document.querySelectorAll('*').forEach(el => {
                const style = window.getComputedStyle(el);
                if (style.position === 'fixed' && style.zIndex > 100) {
                    // Check if it looks like an overlay
                    if (el.textContent.includes('blocker') || el.textContent.includes('Turn off')) {
                        el.style.display = 'none';
                        console.log('Removed overlay:', el.className);
                    }
                }
            });
        });

        await sleep(1000);

        // Fill the form fields
        console.log('\nFilling form fields...');

        // Business name - first input
        await page.evaluate(() => {
            const inputs = document.querySelectorAll('input');
            if (inputs[0]) {
                inputs[0].value = 'Relentless Robotics';
                inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
                inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        console.log('Set business name via JS');

        // Website URL - second input
        await page.evaluate(() => {
            const inputs = document.querySelectorAll('input');
            if (inputs[1]) {
                inputs[1].value = 'https://www.example.com';
                inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
                inputs[1].dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        console.log('Set website URL via JS');

        await sleep(1000);
        await page.screenshot({ path: 'force_step1.png', fullPage: true });

        // Try to find and click the Next button using various methods
        console.log('\nTrying to click Next button...');

        // Method 1: Find button by text and click with JS
        const clicked1 = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Next')) {
                    console.log('Found Next button:', btn.className);
                    btn.click();
                    return true;
                }
            }
            return false;
        });
        console.log('Method 1 (JS click):', clicked1 ? 'Success' : 'Failed');

        await sleep(2000);

        // Method 2: Find by aria-label or role
        const clicked2 = await page.evaluate(() => {
            const btn = document.querySelector('[aria-label*="Next"], [aria-label*="next"], button[type="submit"]');
            if (btn) {
                btn.click();
                return true;
            }
            return false;
        });
        console.log('Method 2 (aria-label):', clicked2 ? 'Success' : 'Failed');

        await sleep(2000);

        // Method 3: Scroll to bottom and try clicking
        console.log('\nScrolling page...');
        await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
        });
        await sleep(1000);

        // Method 4: Try with force click on any visible Next text
        try {
            await page.locator('text=Next').first().click({ force: true, timeout: 5000 });
            console.log('Method 4 (force click): Success');
        } catch (e) {
            console.log('Method 4 (force click): Failed -', e.message);
        }

        await sleep(3000);
        console.log(`URL after click attempts: ${page.url()}`);
        await page.screenshot({ path: 'force_step2.png', fullPage: true });

        // If still on same page, try alternative approach
        if (page.url().includes('aboutyourbusiness')) {
            console.log('\nStill on same page, trying alternative approach...');

            // Try selecting phone number option instead of website
            console.log('Trying phone number option...');
            await page.evaluate(() => {
                const phoneOption = document.querySelector('[data-value="PHONE"], input[value="PHONE"], text*="phone number"');
                if (phoneOption) {
                    phoneOption.click();
                }

                // Also try radio buttons
                const radios = document.querySelectorAll('input[type="radio"]');
                if (radios.length > 1) {
                    radios[1].click(); // Click second radio (phone)
                }
            });

            await sleep(2000);

            // Try clicking Next again
            await page.evaluate(() => {
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent.includes('Next')) {
                        btn.scrollIntoView();
                        btn.focus();
                        btn.click();
                    }
                }
            });

            await sleep(3000);
        }

        // Check if we progressed
        console.log(`URL after alternative: ${page.url()}`);
        await page.screenshot({ path: 'force_step3.png', fullPage: true });

        // Try using keyboard navigation
        console.log('\nTrying keyboard navigation...');
        await page.keyboard.press('Tab');
        await sleep(200);
        await page.keyboard.press('Tab');
        await sleep(200);
        await page.keyboard.press('Tab');
        await sleep(200);
        await page.keyboard.press('Enter');
        await sleep(3000);

        console.log(`URL after keyboard: ${page.url()}`);

        // Final attempt - dispatch click event directly
        console.log('\nFinal attempt - dispatching events...');
        await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Next')) {
                    const rect = btn.getBoundingClientRect();
                    console.log('Button rect:', rect);

                    // Create and dispatch events
                    const mousedown = new MouseEvent('mousedown', {
                        view: window,
                        bubbles: true,
                        cancelable: true,
                        clientX: rect.left + rect.width / 2,
                        clientY: rect.top + rect.height / 2
                    });
                    const mouseup = new MouseEvent('mouseup', {
                        view: window,
                        bubbles: true,
                        cancelable: true,
                        clientX: rect.left + rect.width / 2,
                        clientY: rect.top + rect.height / 2
                    });
                    const click = new MouseEvent('click', {
                        view: window,
                        bubbles: true,
                        cancelable: true,
                        clientX: rect.left + rect.width / 2,
                        clientY: rect.top + rect.height / 2
                    });

                    btn.dispatchEvent(mousedown);
                    btn.dispatchEvent(mouseup);
                    btn.dispatchEvent(click);

                    return true;
                }
            }
            return false;
        });

        await sleep(5000);
        console.log(`URL after events: ${page.url()}`);
        await page.screenshot({ path: 'force_step4.png', fullPage: true });

        // Get page content
        const bodyText = await page.evaluate(() => document.body.innerText);
        console.log('\nCurrent page content:', bodyText.substring(0, 1500));

        console.log('\nKeeping browser open for 300 seconds for manual intervention...');
        await sleep(300000);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        if (page) {
            await page.screenshot({ path: 'force_error.png', fullPage: true });
        }
    } finally {
        if (context) {
            await context.close();
        }
    }
}

forceSetup().catch(console.error);
