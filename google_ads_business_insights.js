const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleBusinessInsights() {
    console.log('Handling Google Ads business-insights step...');

    let context;
    let page;

    try {
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

        // Navigate to the business-insights step
        console.log('Navigating to business-insights step...');
        await page.goto('https://ads.google.com/aw/signup/aboutyourbusiness?ocid=7987879904&euid=1615163210&__u=3072615290&uscid=7987879904&__c=6128758496&authuser=0&currentStep=business-insights', {
            waitUntil: 'networkidle',
            timeout: 60000
        });
        await sleep(5000);

        console.log(`Starting URL: ${page.url()}`);
        await page.screenshot({ path: 'insights_start.png', fullPage: true });

        // Find and fill the business description textarea
        console.log('\nLooking for business description textarea...');

        // Get all textareas
        const textareas = await page.$$('textarea');
        console.log(`Found ${textareas.length} textareas`);

        if (textareas.length > 0) {
            // Fill the first textarea with a business description
            const description = 'Relentless Robotics provides innovative automation solutions and robotics technology for businesses. We specialize in custom robotic systems, industrial automation, and AI-powered solutions to increase efficiency and productivity.';

            await textareas[0].click();
            await sleep(300);
            await textareas[0].fill(description);
            console.log('Filled business description');
        }

        await sleep(1000);
        await page.screenshot({ path: 'insights_filled.png', fullPage: true });

        // Now try to click Next
        console.log('\nClicking Next button...');

        // Method 1: Find all buttons and click the one with "Next"
        const nextClicked = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                if (btn.textContent.trim() === 'Next') {
                    console.log('Found Next button');
                    btn.scrollIntoView({ block: 'center' });
                    btn.click();
                    return true;
                }
            }
            return false;
        });
        console.log(`Next button clicked via JS: ${nextClicked}`);

        await sleep(3000);

        // If that didn't work, try force click with Playwright
        if (page.url().includes('business-insights')) {
            console.log('Still on same page, trying force click...');
            try {
                await page.locator('button:has-text("Next")').click({ force: true, timeout: 10000 });
                console.log('Force clicked Next');
            } catch (e) {
                console.log('Force click failed:', e.message);
            }
        }

        await sleep(3000);
        console.log(`URL after Next: ${page.url()}`);
        await page.screenshot({ path: 'insights_after_next.png', fullPage: true });

        // Continue through remaining steps
        let stepNum = 0;
        while (stepNum < 20) {
            stepNum++;
            const currentUrl = page.url();
            console.log(`\n=== Step ${stepNum}: ${currentUrl.match(/currentStep=([^&]+)/)?.[1] || 'unknown'} ===`);

            // Check if we reached dashboard
            if (currentUrl.includes('/aw/overview') || currentUrl.includes('/aw/campaigns') || currentUrl.includes('/aw/home')) {
                console.log('\n*** SUCCESS: Reached Google Ads dashboard! ***');
                break;
            }

            // Get page text
            const bodyText = await page.evaluate(() => document.body.innerText);
            console.log('Page preview:', bodyText.substring(0, 500));

            // Handle linking step (skip YouTube/Analytics linking)
            if (currentUrl.includes('linking')) {
                console.log('At linking step - looking for skip...');
                const skipResult = await page.evaluate(() => {
                    const skipTexts = ['Skip', 'Not now', 'No thanks'];
                    for (const text of skipTexts) {
                        const els = document.querySelectorAll('button, a, span');
                        for (const el of els) {
                            if (el.textContent.includes(text)) {
                                el.click();
                                return text;
                            }
                        }
                    }
                    return null;
                });
                if (skipResult) {
                    console.log(`Clicked: ${skipResult}`);
                    await sleep(3000);
                    continue;
                }
            }

            // Try clicking Next/Continue
            const buttonClicked = await page.evaluate(() => {
                const targets = ['Next', 'Continue', 'Submit', 'Skip', 'Done'];
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    const text = btn.textContent.trim();
                    for (const target of targets) {
                        if (text === target) {
                            btn.scrollIntoView({ block: 'center' });
                            btn.click();
                            return text;
                        }
                    }
                }
                return null;
            });

            if (buttonClicked) {
                console.log(`Clicked: ${buttonClicked}`);
            } else {
                console.log('No target button found');
                // Try with playwright force click
                try {
                    const nextBtn = await page.locator('button:has-text("Next"), button:has-text("Continue")').first();
                    if (await nextBtn.isVisible()) {
                        await nextBtn.click({ force: true });
                        console.log('Force clicked via Playwright');
                    }
                } catch (e) {
                    console.log('Playwright click also failed');
                }
            }

            await sleep(5000);
            await page.screenshot({ path: `insights_step_${stepNum}.png`, fullPage: true });

            // Check if URL changed
            if (page.url() === currentUrl) {
                console.log('URL unchanged, might need different approach...');

                // Try pressing Tab+Enter
                await page.keyboard.press('Tab');
                await page.keyboard.press('Tab');
                await page.keyboard.press('Enter');
                await sleep(3000);
            }
        }

        // Final state
        console.log('\n=== FINAL STATE ===');
        console.log(`URL: ${page.url()}`);
        await page.screenshot({ path: 'insights_final.png', fullPage: true });

        const finalText = await page.evaluate(() => document.body.innerText);
        console.log('Final page:', finalText.substring(0, 1500));

        // Check for account ID
        const accountMatch = page.url().match(/(\d{3}-\d{3}-\d{4})/);
        if (accountMatch) {
            console.log(`Account ID: ${accountMatch[1]}`);
        }

        console.log('\nKeeping browser open for 300 seconds...');
        await sleep(300000);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        if (page) {
            await page.screenshot({ path: 'insights_error.png', fullPage: true });
        }
    } finally {
        if (context) {
            await context.close();
        }
    }
}

handleBusinessInsights().catch(console.error);
