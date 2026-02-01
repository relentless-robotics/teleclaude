const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function quickSetup() {
    console.log('Quick Google Ads setup...');

    let context;
    let page;

    try {
        console.log('Launching Edge...');
        context = await chromium.launchPersistentContext(
            path.join(__dirname, 'browser_profile_edge'),
            {
                channel: 'msedge',
                headless: false,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-extensions'
                ],
                viewport: { width: 1920, height: 1080 }
            }
        );

        page = await context.newPage();

        // Navigate with domcontentloaded instead of networkidle
        console.log('Navigating...');
        await page.goto('https://ads.google.com/aw/signup/aboutyourbusiness?ocid=7987879904&euid=1615163210&__u=3072615290&uscid=7987879904&__c=6128758496&authuser=0', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        // Wait for page to settle
        await sleep(8000);

        console.log(`URL: ${page.url()}`);
        await page.screenshot({ path: 'quick_start.png', fullPage: true });

        // Get page content
        const bodyText = await page.evaluate(() => document.body.innerText);
        console.log('Page content:', bodyText.substring(0, 1000));

        // Check what step we're on
        const stepMatch = page.url().match(/currentStep=([^&]+)/);
        if (stepMatch) {
            console.log(`Current step: ${stepMatch[1]}`);
        }

        // Fill textarea if present
        const textareaFilled = await page.evaluate(() => {
            const textarea = document.querySelector('textarea');
            if (textarea) {
                textarea.value = 'Relentless Robotics provides innovative automation solutions and robotics technology for businesses.';
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            }
            return false;
        });
        console.log(`Textarea filled: ${textareaFilled}`);

        await sleep(2000);

        // Click Next button
        console.log('Clicking Next...');
        const clicked = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                if (btn.textContent.includes('Next')) {
                    btn.click();
                    return true;
                }
            }
            return false;
        });
        console.log(`Next clicked: ${clicked}`);

        await sleep(5000);
        console.log(`URL after Next: ${page.url()}`);
        await page.screenshot({ path: 'quick_after_next.png', fullPage: true });

        // Keep going
        for (let i = 0; i < 10; i++) {
            console.log(`\n--- Iteration ${i + 1} ---`);
            const url = page.url();
            console.log(`URL: ${url}`);

            // Check if at dashboard
            if (url.includes('/aw/overview') || url.includes('/aw/campaigns') || url.includes('/aw/home')) {
                console.log('SUCCESS: At dashboard!');
                break;
            }

            // Try clicking Next/Skip
            await page.evaluate(() => {
                const targets = ['Next', 'Continue', 'Skip', 'Done'];
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    for (const t of targets) {
                        if (btn.textContent.trim() === t) {
                            btn.click();
                            return t;
                        }
                    }
                }
            });

            await sleep(5000);
        }

        // Final state
        console.log(`\nFinal URL: ${page.url()}`);
        await page.screenshot({ path: 'quick_final.png', fullPage: true });

        console.log('Keeping browser open for 300 seconds...');
        await sleep(300000);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        if (page) {
            await page.screenshot({ path: 'quick_error.png', fullPage: true });
        }
    } finally {
        if (context) {
            await context.close();
        }
    }
}

quickSetup().catch(console.error);
