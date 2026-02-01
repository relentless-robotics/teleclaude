const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

async function completeVercelLogin() {
    const stateFile = path.join(__dirname, 'browser_state', 'google_auth.json');
    const projectDir = path.join(__dirname, 'period-tracker');

    console.log('[INFO] Starting Vercel login process...');

    // Start vercel login in background
    const vercelProcess = spawn('npx', ['vercel', 'login'], {
        cwd: projectDir,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    let authUrl = null;

    // Capture output to get auth URL
    vercelProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('[VERCEL]', output);

        const match = output.match(/https:\/\/vercel\.com\/oauth\/device\?user_code=[A-Z0-9-]+/);
        if (match) {
            authUrl = match[0];
            console.log('[INFO] Found auth URL:', authUrl);
        }
    });

    vercelProcess.stderr.on('data', (data) => {
        console.log('[VERCEL STDERR]', data.toString());
    });

    // Wait for auth URL to appear
    console.log('[INFO] Waiting for auth URL...');
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (authUrl) break;
    }

    if (!authUrl) {
        console.error('[ERROR] Could not get auth URL from Vercel CLI');
        vercelProcess.kill();
        return;
    }

    console.log('[INFO] Launching browser...');
    const browser = await chromium.launch({
        headless: false,
        channel: 'msedge'
    });

    let context;
    if (fs.existsSync(stateFile)) {
        console.log('[INFO] Loading saved Google auth state...');
        context = await browser.newContext({ storageState: stateFile });
    } else {
        context = await browser.newContext();
    }

    const page = await context.newPage();

    try {
        console.log('[INFO] Navigating to:', authUrl);
        await page.goto(authUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(2000);

        // Screenshot to see current state
        await page.screenshot({ path: 'vercel_login_step1.png' });

        // Check if we need to login or just authorize
        const pageContent = await page.content();

        if (pageContent.includes('Continue with Google') || pageContent.includes('Continue with Email')) {
            console.log('[INFO] Need to login first, clicking Continue with Google...');
            await page.click('text=Continue with Google');
            await page.waitForTimeout(3000);

            // Handle Google account selection if needed
            const currentUrl = page.url();
            if (currentUrl.includes('accounts.google.com')) {
                console.log('[INFO] On Google page...');
                try {
                    await page.click('text=relentlessrobotics@gmail.com');
                    await page.waitForTimeout(3000);
                } catch (e) {
                    console.log('[WARN] Could not click account:', e.message);
                }
            }

            await page.waitForTimeout(3000);
            await page.screenshot({ path: 'vercel_login_step2.png' });
        }

        // Now look for the Allow/Authorize button
        console.log('[INFO] Looking for Allow button...');
        await page.waitForTimeout(2000);

        try {
            const allowBtn = page.locator('button:has-text("Allow")');
            if (await allowBtn.isVisible()) {
                console.log('[INFO] Clicking Allow button...');
                await allowBtn.click();
                await page.waitForTimeout(5000);
            }
        } catch (e) {
            console.log('[INFO] Allow button not found or already authorized');
        }

        await page.screenshot({ path: 'vercel_login_final.png' });

        // Wait for verification to complete
        console.log('[INFO] Waiting for verification...');
        await page.waitForTimeout(10000);

        const finalContent = await page.content();
        if (finalContent.includes('Device Authorized') || finalContent.includes('success')) {
            console.log('[SUCCESS] Device authorized!');
        }

    } catch (error) {
        console.error('[ERROR]', error.message);
        await page.screenshot({ path: 'vercel_login_error.png' });
    }

    // Wait for vercel process to complete
    console.log('[INFO] Waiting for Vercel CLI to complete...');

    await new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.log('[INFO] Timeout reached, killing process...');
            vercelProcess.kill();
            resolve();
        }, 30000);

        vercelProcess.on('close', (code) => {
            clearTimeout(timeout);
            console.log('[INFO] Vercel process exited with code:', code);
            resolve();
        });
    });

    await browser.close();
    console.log('[INFO] Done!');
}

completeVercelLogin().catch(console.error);
