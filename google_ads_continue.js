const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function continueSetup() {
    console.log('Continuing Google Ads setup...');

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

        // Navigate to where we left off
        console.log('Navigating to setup page...');
        await page.goto('https://ads.google.com/aw/signup/aboutyourbusiness?ocid=7987879904&euid=1615163210&__u=3072615290&uscid=7987879904&__c=6128758496&authuser=0&currentStep=business-insights', {
            waitUntil: 'networkidle',
            timeout: 60000
        });
        await sleep(5000);

        console.log(`Starting URL: ${page.url()}`);
        await page.screenshot({ path: 'continue_start.png', fullPage: true });

        // Main loop to progress through setup
        let stepNum = 0;
        const maxSteps = 30;

        while (stepNum < maxSteps) {
            stepNum++;
            const currentUrl = page.url();
            console.log(`\n=== Step ${stepNum} ===`);
            console.log(`URL: ${currentUrl}`);

            // Get page content
            const bodyText = await page.evaluate(() => document.body.innerText);
            console.log('Page preview:', bodyText.substring(0, 800));

            // Check if we've reached the dashboard
            if (currentUrl.includes('/aw/overview') || currentUrl.includes('/aw/campaigns') || currentUrl.includes('/home')) {
                console.log('\n*** SUCCESS: Reached Google Ads dashboard! ***');
                break;
            }

            // Check for specific step types and handle them
            const stepType = currentUrl.match(/currentStep=([^&]+)/);
            if (stepType) {
                console.log(`Current step type: ${stepType[1]}`);
            }

            // Try to remove any overlays first
            await page.evaluate(() => {
                document.querySelectorAll('*').forEach(el => {
                    const style = window.getComputedStyle(el);
                    if (style.position === 'fixed' && style.zIndex > 100) {
                        if (el.textContent.includes('blocker') || el.textContent.includes('Turn off')) {
                            el.style.display = 'none';
                        }
                    }
                });
            });

            // Handle different step types
            if (bodyText.includes('keyword') || bodyText.includes('Keyword')) {
                console.log('At keywords step - adding sample keywords...');
                // Try to find keyword input and add some
                const keywordInput = await page.evaluate(() => {
                    const inputs = document.querySelectorAll('input, textarea');
                    for (const input of inputs) {
                        if (input.placeholder && input.placeholder.toLowerCase().includes('keyword')) {
                            return true;
                        }
                    }
                    return false;
                });

                if (keywordInput) {
                    // Add sample keywords
                    await page.keyboard.type('robotics, automation, robots');
                    await sleep(500);
                }
            }

            if (bodyText.includes('headline') || bodyText.includes('Headline') || bodyText.includes('Write your ad')) {
                console.log('At ad creation step - filling sample ad...');
                // Fill ad fields
                await page.evaluate(() => {
                    const inputs = document.querySelectorAll('input, textarea');
                    let filled = 0;
                    for (const input of inputs) {
                        if (!input.value && input.type !== 'hidden') {
                            if (filled === 0) {
                                input.value = 'Relentless Robotics';
                                input.dispatchEvent(new Event('input', { bubbles: true }));
                                filled++;
                            } else if (filled === 1) {
                                input.value = 'Quality Robotics Solutions';
                                input.dispatchEvent(new Event('input', { bubbles: true }));
                                filled++;
                            } else if (filled === 2) {
                                input.value = 'Innovative automation for your business';
                                input.dispatchEvent(new Event('input', { bubbles: true }));
                                filled++;
                            }
                        }
                    }
                });
            }

            if (bodyText.includes('budget') || bodyText.includes('Budget')) {
                console.log('At budget step...');
                // Try to enter a minimal budget if needed
            }

            if (bodyText.includes('billing') || bodyText.includes('payment') || bodyText.includes('Billing')) {
                console.log('At billing step - looking for skip option...');
                // Try to skip billing
                const skipClicked = await page.evaluate(() => {
                    const skipTexts = ['Skip', 'Set up later', 'Not now', 'Later', "I'll do this later"];
                    const elements = document.querySelectorAll('button, a, span, div');
                    for (const el of elements) {
                        for (const text of skipTexts) {
                            if (el.textContent.trim() === text || el.textContent.includes(text)) {
                                el.click();
                                return text;
                            }
                        }
                    }
                    return null;
                });
                if (skipClicked) {
                    console.log(`Clicked skip: ${skipClicked}`);
                    await sleep(3000);
                    continue;
                }
            }

            // Look for "Skip" anywhere on page
            if (bodyText.includes('Skip')) {
                console.log('Found Skip option...');
                const skipClicked = await page.evaluate(() => {
                    const skipBtn = Array.from(document.querySelectorAll('button, a')).find(el =>
                        el.textContent.trim() === 'Skip' || el.textContent.includes('Skip for now')
                    );
                    if (skipBtn) {
                        skipBtn.click();
                        return true;
                    }
                    return false;
                });
                if (skipClicked) {
                    console.log('Clicked Skip');
                    await sleep(3000);
                    continue;
                }
            }

            // Try to click Next/Continue/Submit
            console.log('Looking for navigation buttons...');
            const buttonClicked = await page.evaluate(() => {
                const buttonTexts = ['Next', 'Continue', 'Submit', 'Create campaign', 'Publish', 'Done', 'Finish', 'Save'];
                const buttons = document.querySelectorAll('button');

                for (const btn of buttons) {
                    const text = btn.textContent.trim();
                    for (const targetText of buttonTexts) {
                        if (text === targetText || text.includes(targetText)) {
                            console.log('Found button:', text);
                            btn.scrollIntoView();
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
                console.log('No navigation button found');

                // Try force clicking with locator
                try {
                    const nextBtn = await page.locator('button:has-text("Next"), button:has-text("Continue")').first();
                    if (await nextBtn.isVisible()) {
                        await nextBtn.click({ force: true });
                        console.log('Force clicked Next/Continue');
                    }
                } catch (e) {
                    // Continue
                }
            }

            await sleep(5000);
            await page.screenshot({ path: `continue_step_${stepNum}.png`, fullPage: true });

            // Check if URL changed
            const newUrl = page.url();
            if (newUrl === currentUrl) {
                console.log('URL did not change, might be stuck...');

                // Try keyboard navigation
                console.log('Trying keyboard...');
                await page.keyboard.press('Tab');
                await page.keyboard.press('Tab');
                await page.keyboard.press('Tab');
                await page.keyboard.press('Enter');
                await sleep(3000);
            }
        }

        // Final state
        console.log('\n=== FINAL STATE ===');
        const finalUrl = page.url();
        console.log(`URL: ${finalUrl}`);

        // Try to get account ID
        const accountMatch = finalUrl.match(/(\d{3}-\d{3}-\d{4})/);
        if (accountMatch) {
            console.log(`Account ID: ${accountMatch[1]}`);
        }

        await page.screenshot({ path: 'continue_final.png', fullPage: true });

        const finalText = await page.evaluate(() => document.body.innerText);
        console.log('\nFinal page content:', finalText.substring(0, 2000));

        // Determine success
        if (finalUrl.includes('/aw/overview') || finalUrl.includes('/aw/campaigns') || finalUrl.includes('/home')) {
            console.log('\n*** GOOGLE ADS ACCOUNT SETUP COMPLETE! ***');
        } else {
            console.log('\nSetup may need manual completion. Keeping browser open...');
        }

        console.log('\nKeeping browser open for 300 seconds...');
        await sleep(300000);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        if (page) {
            await page.screenshot({ path: 'continue_error.png', fullPage: true });
        }
    } finally {
        if (context) {
            await context.close();
        }
    }
}

continueSetup().catch(console.error);
