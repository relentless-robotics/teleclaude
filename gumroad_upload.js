const { chromium } = require('playwright');

const GUMROAD_EMAIL = 'relentlessrobotics@gmail.com';
const GUMROAD_PASSWORD = 'GumRd#2026$Secure!';
const ZIP_PATH = 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gumroad_product\\Python_Quant_Trading_Bot_Starter_Kit.zip';

const PRODUCT_NAME = 'Python Quant Trading Bot Starter Kit';
const PRODUCT_PRICE = '24';
const PRODUCT_DESCRIPTION = `Stop Writing Trading Bots From Scratch

Every developer who wants to trade algorithmically faces the same problem: piecing together data feeds, strategy logic, risk management, backtesting, and execution from scattered tutorials and half-baked libraries.

This kit gives you everything you need in one professional package.

What You Get:

3 Complete Strategy Types
- Momentum strategies (MA crossover, breakouts, time-series momentum)
- Mean reversion strategies (Bollinger Bands, RSI, pairs trading)
- Machine learning strategies (XGBoost, LightGBM, ensemble methods)

Professional Risk Management
- Position sizing: Kelly Criterion, Fixed Fractional, Volatility Targeting
- Stop losses: Fixed, Trailing, ATR-based
- Portfolio controls: Drawdown limits, sector exposure, correlation monitoring

High-Performance Backtesting
- Vectorized engine (1M+ bars/second)
- Realistic slippage and commission modeling
- Walk-forward optimization
- Monte Carlo simulation
- 20+ performance metrics (Sharpe, Sortino, Calmar, etc.)

Live Trading Ready
- Alpaca integration (commission-free stocks)
- Interactive Brokers template (stocks, options, futures)
- Paper trading mode for safe testing
- Strategy runner with real-time execution

Production Features
- Data fetching with automatic caching
- Technical indicator library
- Comprehensive logging
- Clean, documented code

Who This Is For:
- Developers who want to trade algorithmically but don't want to build infrastructure from scratch
- Quant-curious programmers looking for a professional starting point
- Hobbyist traders who want to automate their strategies
- Finance students learning quantitative methods

Requirements:
- Python 3.8+
- Basic Python knowledge
- Understanding of financial markets

30-Day Money Back Guarantee - If the kit doesn't meet your expectations, email for a full refund. No questions asked.`;

(async () => {
    console.log('Starting browser...');
    const browser = await chromium.launch({
        headless: false,
        slowMo: 300
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // Navigate to Gumroad
        console.log('Navigating to Gumroad...');
        await page.goto('https://gumroad.com/login');
        await page.waitForLoadState('networkidle');

        // Login
        console.log('Logging in...');
        await page.fill('input[name="email"], input[type="email"]', GUMROAD_EMAIL);
        await page.fill('input[name="password"], input[type="password"]', GUMROAD_PASSWORD);
        await page.click('button[type="submit"]');

        // Wait for login to complete
        await page.waitForURL('**/dashboard**', { timeout: 30000 });
        console.log('Logged in successfully!');

        // Navigate to new product
        console.log('Creating new product...');
        await page.goto('https://app.gumroad.com/products/new');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2000);

        // Fill in product name
        console.log('Filling product name...');
        const nameInput = page.locator('input[placeholder="Name of product"]');
        await nameInput.fill(PRODUCT_NAME);
        await page.waitForTimeout(500);

        // Click on "Digital product" card to ensure it's selected
        console.log('Selecting Digital Product type...');
        await page.click('text=Digital product');
        await page.waitForTimeout(1000);

        // Scroll down to see price field
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1000);

        // Fill in price
        console.log('Filling price...');
        const priceInput = page.locator('input[placeholder="Price your product"]');
        await priceInput.fill(PRODUCT_PRICE);
        await page.waitForTimeout(500);

        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gumroad_step1.png' });
        console.log('Step 1: Name and price filled');

        // Click "Next: Customize" button
        console.log('Clicking Next: Customize...');
        const nextButton = page.locator('button:has-text("Next: Customize"), a:has-text("Next: Customize")');
        await nextButton.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(3000);

        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gumroad_step2.png' });
        console.log('Step 2: On customize page');
        console.log('Current URL: ' + page.url());

        // Now look for file upload
        console.log('Looking for file upload area...');

        // Wait for the page to fully load
        await page.waitForTimeout(2000);

        // Try to find file input (may be hidden)
        let fileInput = page.locator('input[type="file"]');
        let count = await fileInput.count();
        console.log('Found ' + count + ' file inputs');

        if (count > 0) {
            // Upload the file
            await fileInput.first().setInputFiles(ZIP_PATH);
            console.log('File uploaded!');
            await page.waitForTimeout(5000);
        } else {
            // Look for "Add content" or upload button
            const addContentBtn = page.locator('button:has-text("Add content"), button:has-text("Add file"), button:has-text("Upload")').first();
            if (await addContentBtn.isVisible()) {
                await addContentBtn.click();
                await page.waitForTimeout(2000);

                // Now try to find file input again
                fileInput = page.locator('input[type="file"]');
                count = await fileInput.count();
                if (count > 0) {
                    await fileInput.first().setInputFiles(ZIP_PATH);
                    console.log('File uploaded after clicking add content!');
                    await page.waitForTimeout(5000);
                }
            }
        }

        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gumroad_step3.png' });
        console.log('Step 3: After file upload attempt');

        // Look for description field
        console.log('Looking for description field...');
        const descriptionArea = page.locator('textarea, [contenteditable="true"], .ProseMirror').first();
        if (await descriptionArea.isVisible()) {
            await descriptionArea.click();
            await descriptionArea.fill(PRODUCT_DESCRIPTION);
            console.log('Description filled');
        }

        await page.waitForTimeout(2000);
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gumroad_step4.png' });

        // Look for Publish/Save button
        console.log('Looking for Publish button...');
        const publishButton = page.locator('button:has-text("Publish"), button:has-text("Save")').first();
        if (await publishButton.isVisible()) {
            await publishButton.click();
            console.log('Clicked Publish/Save');
            await page.waitForTimeout(5000);
        }

        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gumroad_step5.png' });

        // Get final URL
        const finalUrl = page.url();
        console.log('Final URL: ' + finalUrl);

        // Try to find product link
        const productLink = await page.locator('a[href*="/l/"]').first();
        if (await productLink.isVisible()) {
            const href = await productLink.getAttribute('href');
            console.log('Product Link: ' + href);
        }

        console.log('Process complete. Browser staying open for 30 seconds...');
        await page.waitForTimeout(30000);

    } catch (error) {
        console.error('Error:', error.message);
        await page.screenshot({ path: 'C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\gumroad_error.png' });
        console.log('Error screenshot saved');
        await page.waitForTimeout(30000);
    } finally {
        await browser.close();
    }
})();
