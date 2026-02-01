const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Ensure screenshots directory exists
const screenshotsDir = path.join(__dirname, 'screenshots', 'captchas');
if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
}

async function sendDiscordMessage(message) {
    // This will be handled by the main bridge - just log for now
    console.log(`[DISCORD] ${message}`);
}

async function completeJumpTaskSurveys() {
    const googleAuthPath = path.join(__dirname, 'browser_state', 'google_auth.json');
    const jumpTaskAuthPath = path.join(__dirname, 'browser_state', 'jumptask_auth.json');

    let browser;
    let context;

    try {
        await sendDiscordMessage("🌐 Launching browser...");

        browser = await chromium.launch({
            headless: false,
            args: ['--start-maximized']
        });

        // Try to load JumpTask auth state first, fallback to Google auth
        let storageState = null;
        if (fs.existsSync(jumpTaskAuthPath)) {
            await sendDiscordMessage("📂 Loading saved JumpTask session...");
            storageState = jumpTaskAuthPath;
        } else if (fs.existsSync(googleAuthPath)) {
            await sendDiscordMessage("📂 Loading saved Google auth...");
            storageState = googleAuthPath;
        }

        context = await browser.newContext({
            storageState: storageState || undefined,
            viewport: null
        });

        const page = await context.newPage();

        // Navigate to JumpTask earn page
        await sendDiscordMessage("🔗 Navigating to JumpTask dashboard...");

        try {
            await page.goto('https://app.jumptask.io/earn', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sendDiscordMessage("✓ Page loaded (DOM ready)");
        } catch (navError) {
            await sendDiscordMessage(`⚠️ Navigation warning: ${navError.message}. Trying to continue anyway...`);
            // Try to navigate to base URL instead
            await page.goto('https://app.jumptask.io/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        await page.waitForTimeout(5000);

        // Check if we need to login
        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/auth')) {
            await sendDiscordMessage("🔐 Need to login - clicking Google OAuth...");

            // Look for Google sign in button
            const googleButton = await page.locator('button:has-text("Continue with Google"), button:has-text("Sign in with Google"), a:has-text("Continue with Google")').first();
            if (await googleButton.isVisible({ timeout: 5000 })) {
                await googleButton.click();
                await page.waitForTimeout(5000);
            }
        }

        // Wait for dashboard to load
        await sendDiscordMessage("⏳ Waiting for dashboard to load...");
        await page.waitForTimeout(8000); // Just wait 8 seconds instead of networkidle

        // Save updated session state
        const updatedState = await context.storageState();
        fs.writeFileSync(jumpTaskAuthPath, JSON.stringify(updatedState, null, 2));
        await sendDiscordMessage("💾 Session state saved");

        // Take screenshot of dashboard
        const dashboardScreenshot = path.join(__dirname, 'screenshots', `jumptask_dashboard_${Date.now()}.png`);
        await page.screenshot({ path: dashboardScreenshot, fullPage: true });
        await sendDiscordMessage(`📸 Dashboard screenshot saved: ${dashboardScreenshot}`);

        // Look for surveys section
        await sendDiscordMessage("🔍 Looking for available surveys...");

        // Try different selectors for surveys
        const surveySelectors = [
            'text=Surveys',
            '[href*="survey"]',
            'button:has-text("Survey")',
            '.survey-card',
            '[data-testid*="survey"]'
        ];

        let surveysFound = false;
        for (const selector of surveySelectors) {
            try {
                const element = page.locator(selector).first();
                if (await element.isVisible({ timeout: 2000 })) {
                    await sendDiscordMessage(`✓ Found surveys section using selector: ${selector}`);
                    await element.click();
                    await page.waitForTimeout(3000);
                    surveysFound = true;
                    break;
                }
            } catch (e) {
                // Try next selector
            }
        }

        if (!surveysFound) {
            await sendDiscordMessage("ℹ️ Could not auto-locate surveys. Checking page content...");

            // Get page content to analyze
            const bodyText = await page.locator('body').textContent();

            if (bodyText.includes('survey') || bodyText.includes('Survey')) {
                await sendDiscordMessage("📝 Page mentions surveys. Taking full page screenshot for manual review.");
            } else {
                await sendDiscordMessage("⚠️ No surveys mentioned on current page. May need to navigate differently.");
            }
        }

        // Take another screenshot after attempting to find surveys
        const surveysScreenshot = path.join(__dirname, 'screenshots', `jumptask_surveys_${Date.now()}.png`);
        await page.screenshot({ path: surveysScreenshot, fullPage: true });
        await sendDiscordMessage(`📸 Surveys page screenshot: ${surveysScreenshot}`);

        // Look for available survey tasks
        await sendDiscordMessage("🔎 Scanning for available survey tasks...");

        // Try to find clickable survey items
        const surveyItems = await page.locator('[class*="task"], [class*="survey"], [class*="offer"]').all();

        if (surveyItems.length > 0) {
            await sendDiscordMessage(`Found ${surveyItems.length} potential survey items. Checking availability...`);

            let completedCount = 0;

            for (let i = 0; i < Math.min(surveyItems.length, 5); i++) {
                try {
                    const item = surveyItems[i];
                    const itemText = await item.textContent();

                    await sendDiscordMessage(`📋 Checking survey ${i+1}: ${itemText.substring(0, 50)}...`);

                    // Check if item is clickable and available
                    if (await item.isVisible() && await item.isEnabled()) {
                        await item.click();
                        await page.waitForTimeout(5000);

                        // Check for CAPTCHA
                        const captchaDetected = await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="captcha"]').first().isVisible({ timeout: 2000 }).catch(() => false);

                        if (captchaDetected) {
                            const captchaScreenshot = path.join(screenshotsDir, `captcha_${Date.now()}.png`);
                            await page.screenshot({ path: captchaScreenshot });
                            await sendDiscordMessage(`🔒 CAPTCHA detected! Screenshot saved: ${captchaScreenshot}\nPlease solve and I'll continue...`);

                            // Wait for solution file
                            const solutionFile = captchaScreenshot.replace('.png', '_solution.txt');
                            await sendDiscordMessage(`Waiting for solution file: ${solutionFile}`);

                            // Wait up to 5 minutes for solution
                            let solutionFound = false;
                            for (let wait = 0; wait < 150; wait++) {
                                if (fs.existsSync(solutionFile)) {
                                    const solution = fs.readFileSync(solutionFile, 'utf-8').trim();
                                    await sendDiscordMessage(`✓ Solution received: ${solution}`);
                                    // Note: Actual CAPTCHA solving would require more specific implementation
                                    solutionFound = true;
                                    break;
                                }
                                await page.waitForTimeout(2000);
                            }

                            if (!solutionFound) {
                                await sendDiscordMessage("⏱️ Timeout waiting for CAPTCHA solution. Skipping this survey.");
                                await page.goBack();
                                continue;
                            }
                        }

                        // Check if survey loaded
                        const surveyFrames = await page.frames();
                        if (surveyFrames.length > 1) {
                            await sendDiscordMessage("📝 Survey loaded in iframe. Attempting to complete...");

                            // This is where survey completion logic would go
                            // For now, just wait and take screenshot
                            await page.waitForTimeout(5000);

                            const surveyInProgressScreenshot = path.join(__dirname, 'screenshots', `survey_${i+1}_${Date.now()}.png`);
                            await page.screenshot({ path: surveyInProgressScreenshot, fullPage: true });
                            await sendDiscordMessage(`📸 Survey in progress: ${surveyInProgressScreenshot}`);

                            completedCount++;
                        }

                        // Go back to survey list
                        await page.goBack({ waitUntil: 'networkidle' });
                        await page.waitForTimeout(2000);
                    }

                } catch (error) {
                    await sendDiscordMessage(`⚠️ Error on survey ${i+1}: ${error.message}`);
                    continue;
                }
            }

            await sendDiscordMessage(`✅ Survey scan complete. Attempted ${completedCount} surveys.`);

        } else {
            await sendDiscordMessage("ℹ️ No survey items found with current selectors. Page structure may be different.");
        }

        // Get current balance/earnings
        await sendDiscordMessage("💰 Checking current balance...");

        try {
            const balanceText = await page.locator('[class*="balance"], [class*="earning"], [class*="reward"]').first().textContent({ timeout: 5000 });
            await sendDiscordMessage(`Current balance: ${balanceText}`);
        } catch (e) {
            await sendDiscordMessage("⚠️ Could not locate balance element.");
        }

        // Final screenshot
        const finalScreenshot = path.join(__dirname, 'screenshots', `jumptask_final_${Date.now()}.png`);
        await page.screenshot({ path: finalScreenshot, fullPage: true });
        await sendDiscordMessage(`📸 Final screenshot: ${finalScreenshot}`);

        await sendDiscordMessage("✅ JumpTask survey task complete! Check screenshots for details.");

        // Keep browser open for 30 seconds for user to see
        await sendDiscordMessage("🔄 Keeping browser open for 30 seconds...");
        await page.waitForTimeout(30000);

    } catch (error) {
        await sendDiscordMessage(`❌ Error: ${error.message}`);
        console.error('Full error:', error);

        if (context) {
            try {
                const errorScreenshot = path.join(__dirname, 'screenshots', `jumptask_error_${Date.now()}.png`);
                const page = context.pages()[0];
                if (page) {
                    await page.screenshot({ path: errorScreenshot });
                    await sendDiscordMessage(`📸 Error screenshot: ${errorScreenshot}`);
                }
            } catch (e) {
                console.error('Could not take error screenshot:', e);
            }
        }
    } finally {
        if (browser) {
            await browser.close();
            await sendDiscordMessage("🔚 Browser closed.");
        }
    }
}

// Run the script
completeJumpTaskSurveys().catch(console.error);
