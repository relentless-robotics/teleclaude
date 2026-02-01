const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function createGitHubPAT() {
  console.log('Starting GitHub PAT creation...');

  const browser = await chromium.launch({
    headless: false,
    channel: 'msedge'
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Step 1: Navigate to GitHub login
    console.log('Step 1: Navigating to GitHub login...');
    await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Step 2: Login with credentials
    console.log('Step 2: Logging in...');
    await page.fill('input[name="login"]', 'relentless-robotics');
    await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
    await page.click('input[type="submit"][value="Sign in"]');

    // Wait a bit for navigation
    await page.waitForTimeout(5000);

    // Check if 2FA is required
    const requires2FA = await page.locator('text=Two-factor authentication').isVisible().catch(() => false);

    if (requires2FA) {
      console.log('2FA detected - waiting for manual completion...');
      console.log('Please complete 2FA on your device...');
      await page.waitForURL('https://github.com/**', { timeout: 120000 });
      await page.waitForTimeout(3000);
    }

    // Step 3: Navigate to tokens page
    console.log('Step 3: Navigating to Personal Access Tokens page...');
    await page.goto('https://github.com/settings/tokens', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Step 4: Click "Generate new token" -> "Generate new token (classic)"
    console.log('Step 4: Initiating new token creation...');

    // Click the dropdown button
    await page.click('summary:has-text("Generate new token")');
    await page.waitForTimeout(1000);

    // Click "Generate new token (classic)"
    await page.click('a:has-text("Generate new token (classic)")');
    await page.waitForTimeout(5000);

    // Take screenshot to debug
    await page.screenshot({ path: 'screenshots/github_token_form.png' });
    console.log('Screenshot saved for debugging');

    // Step 5: Fill in token details
    console.log('Step 5: Configuring token settings...');

    // Note field - try multiple possible selectors
    const noteField = await page.locator('input#oauth_access_description, input[name="oauth_access_description"], input[placeholder*="note" i]').first();
    await noteField.waitFor({ timeout: 10000 });

    // Use timestamp to make it unique
    const tokenName = 'dev-automation-' + Date.now();
    await noteField.fill(tokenName);
    console.log('Token name:', tokenName);

    // Expiration - need to click the dropdown button then select option
    console.log('Setting expiration...');

    // Look for the expiration dropdown/button
    const expirationButton = await page.locator('button:has-text("30 days"), summary:has-text("days")').first();

    if (await expirationButton.isVisible().catch(() => false)) {
      await expirationButton.click();
      await page.waitForTimeout(1000);

      // Click "No expiration" or "Custom" option
      const noExpirationOption = await page.locator('text="No expiration", text="Never", text="Custom"').first();
      await noExpirationOption.click({ timeout: 5000 }).catch(async () => {
        console.log('Could not find no expiration option, using default 30 days');
      });
      await page.waitForTimeout(500);

      // Close the dropdown by clicking elsewhere or pressing Escape
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
    } else {
      console.log('Expiration dropdown not found, using default...');
    }

    // Step 6: Select ALL scopes
    console.log('Step 6: Selecting all scopes...');

    // Get all checkboxes for scopes - try different selectors
    let scopeCheckboxes = await page.locator('input[type="checkbox"]').all();

    console.log(`Found ${scopeCheckboxes.length} checkboxes total`);

    // Filter to only scope-related checkboxes (not the first few which might be other things)
    for (const checkbox of scopeCheckboxes) {
      const isChecked = await checkbox.isChecked().catch(() => false);
      const isVisible = await checkbox.isVisible().catch(() => false);

      if (isVisible && !isChecked) {
        await checkbox.check().catch(e => console.log('Could not check:', e.message));
        await page.waitForTimeout(100);
      }
    }

    // Step 7: Generate token
    console.log('Step 7: Generating token...');
    await page.click('button:has-text("Generate token")');
    await page.waitForTimeout(5000);

    // Step 8: Copy the token
    console.log('Step 8: Extracting token...');

    // Wait for token page to load
    await page.waitForTimeout(2000);

    // Take another screenshot
    await page.screenshot({ path: 'screenshots/github_token_generated.png' });
    console.log('Token page screenshot saved');

    // The token is displayed in a specific element after generation
    // It's in a green success box with a checkmark
    let token = '';

    // Try to get from text content (it's displayed as text with checkmark)
    const tokenText = page.locator('text=/ghp_[a-zA-Z0-9]+/, text=/github_pat_[a-zA-Z0-9_]+/').first();
    if (await tokenText.isVisible({ timeout: 5000 }).catch(() => false)) {
      const fullText = await tokenText.textContent();
      // Extract just the token part (starts with ghp_ or github_pat_)
      const match = fullText.match(/(ghp_[a-zA-Z0-9]+|github_pat_[a-zA-Z0-9_]+)/);
      if (match) {
        token = match[1];
      }
    }

    // Try getting from clipboard button's data attribute
    if (!token) {
      const clipboardButton = page.locator('[data-clipboard-text^="ghp_"], [data-clipboard-text^="github_pat_"]').first();
      if (await clipboardButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        token = await clipboardButton.getAttribute('data-clipboard-text');
      }
    }

    // Try to find any element containing the token
    if (!token) {
      const allText = await page.textContent('body');
      const match = allText.match(/(ghp_[a-zA-Z0-9]+|github_pat_[a-zA-Z0-9_]+)/);
      if (match) {
        token = match[1];
      }
    }

    if (!token) {
      throw new Error('Could not find generated token on the page');
    }

    console.log('Token generated successfully!');
    console.log('Token:', token);

    // Step 9: Save to API_KEYS.md
    console.log('Step 9: Saving to API_KEYS.md...');

    const apiKeysPath = path.join(__dirname, 'API_KEYS.md');
    const today = new Date().toISOString().split('T')[0];

    const entry = `
---

## GitHub (relentless-robotics) - ${tokenName}

| Field | Value |
|-------|-------|
| Service | GitHub |
| Account | relentless-robotics |
| Key Name | ${tokenName} |
| PAT | \`${token}\` |
| Scopes | Full access (all) |
| Created | ${today} |
| Console URL | https://github.com/settings/tokens |

---
`;

    // Check if API_KEYS.md exists
    if (!fs.existsSync(apiKeysPath)) {
      // Create new file
      const header = `# API_KEYS.md - Stored API Keys

This file contains API keys that have been manually obtained (via browser login, etc.) and need to be stored for later use.

**Security Note:** This file contains sensitive credentials. Do not share or commit to public repositories.

---

*Add new keys below using the standard format.*
`;
      fs.writeFileSync(apiKeysPath, header + entry, 'utf-8');
      console.log('Created new API_KEYS.md file');
    } else {
      // Append to existing file
      fs.appendFileSync(apiKeysPath, entry, 'utf-8');
      console.log('Appended to existing API_KEYS.md file');
    }

    console.log('\n=================================');
    console.log('SUCCESS! GitHub PAT created and saved.');
    console.log('=================================\n');
    console.log('Token:', token);
    console.log('\nTo configure gh CLI, run:');
    console.log(`echo "${token}" | gh auth login --with-token`);

    // Keep browser open for 10 seconds so user can see the result
    await page.waitForTimeout(10000);

  } catch (error) {
    console.error('Error creating GitHub PAT:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Run the script
createGitHubPAT().catch(console.error);
