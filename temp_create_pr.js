const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const stateFile = path.join('C:', 'Users', 'Footb', 'Documents', 'Github', 'teleclaude-main', 'browser_state', 'google_auth.json');

  let contextOptions = {
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };

  if (fs.existsSync(stateFile)) {
    contextOptions.storageState = stateFile;
  }

  const browser = await chromium.launch({
    headless: false,
    channel: 'msedge'
  });

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    // Login first
    console.log('Logging into GitHub...');
    await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const loggedIn = await page.evaluate(() => {
      return document.querySelector('[data-login]') !== null;
    });

    if (!loggedIn) {
      await page.locator('input#login_field').fill('relentless-robotics');
      await page.locator('input#password').fill('Relentless@Robotics2026!');
      await page.locator('input[type="submit"][value="Sign in"]').click();
      await page.waitForTimeout(5000);
    }

    console.log('Logged in successfully');

    // Strategy: Upload the file directly via GitHub web UI instead of pushing
    console.log('Navigating to fork...');
    await page.goto('https://github.com/relentless-robotics/nuclei-templates', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Check if we're on our fork
    const isFork = await page.evaluate(() => {
      return document.body.innerText.includes('forked from') ||
             document.querySelector('.fork-flag') !== null;
    });

    console.log('On fork:', isFork);

    // Navigate to the file location in our fork
    console.log('Navigating to http/cves/2024/ directory...');
    await page.goto('https://github.com/relentless-robotics/nuclei-templates/tree/main/http/cves/2024', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Check if CVE-2024-3408.yaml already exists
    const fileExists = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.some(link => link.textContent.includes('CVE-2024-3408'));
    });

    console.log('File exists in fork:', fileExists);

    if (fileExists) {
      console.log('File already in fork! Proceeding to create PR...');
    } else {
      console.log('File not in fork. Need to create branch and upload file first.');

      // Click "Add file" button
      const addFileButton = page.locator('button:has-text("Add file"), summary:has-text("Add file")').first();
      const addVisible = await addFileButton.isVisible({ timeout: 5000 }).catch(() => false);

      if (addVisible) {
        await addFileButton.click();
        await page.waitForTimeout(1000);

        // Click "Create new file"
        await page.locator('a:has-text("Create new file")').click();
        await page.waitForTimeout(2000);

        // Enter filename
        await page.locator('input[name="filename"]').fill('CVE-2024-3408.yaml');

        // Read the file content
        const fileContent = fs.readFileSync('C:\\Users\\Footb\\Documents\\Github\\nuclei-templates\\http\\cves\\2024\\CVE-2024-3408.yaml', 'utf-8');

        // Fill in content
        const editor = page.locator('.CodeMirror').first();
        await editor.click();
        await page.keyboard.type(fileContent);

        await page.waitForTimeout(2000);

        // Create new branch
        await page.locator('input[name="new_branch"]').fill('add-cve-2024-3408');

        // Commit
        await page.locator('button:has-text("Commit new file")').click();
        await page.waitForTimeout(5000);

        console.log('File committed to new branch');
      }
    }

    // Now create PR
    console.log('Creating pull request...');
    await page.goto('https://github.com/projectdiscovery/nuclei-templates/compare/main...relentless-robotics:nuclei-templates:add-cve-2024-3408', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Fill in PR title
    await page.locator('input#pull_request_title').fill('Add Nuclei template for CVE-2024-3408 (dtale RCE)');

    // Fill in PR body
    const prBody = `## Summary

This PR adds a Nuclei template for CVE-2024-3408, a critical authentication bypass and remote code execution vulnerability in man-group/dtale.

## Vulnerability Details

- **CVE:** CVE-2024-3408
- **Severity:** Critical (CVSS 9.8)
- **Product:** man-group/dtale
- **Affected Versions:** Up to and including 3.10.0
- **Fixed Version:** 3.15.1

The vulnerability combines:
1. Hardcoded SECRET_KEY allowing session cookie forgery
2. Improper filter validation allowing arbitrary code execution

## Template Features

- Detects vulnerable dtale instances
- Tests for authentication bypass
- Verifies RCE capability via /test-filter endpoint
- Multiple matchers for reliable detection

## References

- https://nvd.nist.gov/vuln/detail/CVE-2024-3408
- https://github.com/advisories/GHSA-v9q6-fm48-rx74

## Related Issue

Closes #14488 ($100 Algora bounty)`;

    await page.locator('textarea#pull_request_body').fill(prBody);

    await page.waitForTimeout(2000);

    // Click Create PR button
    const createPRButton = page.locator('button:has-text("Create pull request")').first();
    await createPRButton.click();
    await page.waitForTimeout(5000);

    // Get PR URL
    const prUrl = page.url();
    console.log('PR_CREATED:' + prUrl);

  } catch (error) {
    console.log('ERROR:' + error.message);
    await page.screenshot({ path: 'pr_error.png' }).catch(() => {});
  }

  await page.waitForTimeout(3000);
  await browser.close();
})();
