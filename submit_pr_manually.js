const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'msedge'
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 }
  });

  const page = await context.newPage();

  try {
    console.log('Step 1: Logging into GitHub...');
    await page.goto('https://github.com/login');
    await page.waitForTimeout(2000);

    await page.locator('input#login_field').fill('relentless-robotics');
    await page.locator('input#password').fill('Relentless@Robotics2026!');
    await page.locator('input[type="submit"]').click();
    await page.waitForTimeout(5000);

    console.log('Step 2: Navigating to our fork...');
    await page.goto('https://github.com/relentless-robotics/nuclei-templates');
    await page.waitForTimeout(3000);

    console.log('Step 3: Checking if add-cve-2024-3408 branch exists...');
    await page.locator('button[data-testid="branch-menu-toggle"], button:has-text("main")').first().click();
    await page.waitForTimeout(2000);

    // Search for our branch
    const branchInput = page.locator('input[placeholder*="branch"], input[aria-label*="branch"]').first();
    await branchInput.fill('add-cve-2024-3408');
    await page.waitForTimeout(2000);

    const branchExists = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-filterable-for="branch-filter-field"] a, .SelectMenu-item'));
      return items.some(item => item.textContent.includes('add-cve-2024-3408'));
    });

    if (!branchExists) {
      console.log('Branch does not exist in fork. Creating it...');

      // Close branch menu
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);

      // Navigate to creating new file
      await page.goto('https://github.com/relentless-robotics/nuclei-templates/new/main/http/cves/2024');
      await page.waitForTimeout(3000);

      // Enter filename
      console.log('Creating CVE-2024-3408.yaml file...');
      await page.locator('input[name="filename"]').fill('CVE-2024-3408.yaml');

      // Read file content
      const fileContent = fs.readFileSync('C:\\Users\\Footb\\Documents\\Github\\nuclei-templates\\http\\cves\\2024\\CVE-2024-3408.yaml', 'utf-8');

      // Enter content into editor
      console.log('Filling file content...');
      await page.locator('div[role="textbox"]').first().click();
      await page.keyboard.type(fileContent, { delay: 10 });

      await page.waitForTimeout(2000);

      // Scroll down to commit section
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);

      // Select "Create a new branch"
      const newBranchRadio = page.locator('input[value="new-branch"]');
      await newBranchRadio.check();
      await page.waitForTimeout(500);

      // Enter branch name
      const branchNameInput = page.locator('input[name="new_branch"]');
      await branchNameInput.fill('add-cve-2024-3408');

      await page.waitForTimeout(1000);

      // Click "Propose new file"
      await page.locator('button:has-text("Propose new file"), button[type="submit"]:has-text("Commit")').first().click();
      await page.waitForTimeout(5000);

      console.log('File committed and branch created!');
    } else {
      console.log('Branch exists. Switching to it...');
      const branchLink = page.locator('a:has-text("add-cve-2024-3408")').first();
      await branchLink.click();
      await page.waitForTimeout(3000);
    }

    console.log('Step 4: Creating Pull Request...');

    // Navigate to PR creation page
    await page.goto('https://github.com/projectdiscovery/nuclei-templates/compare/main...relentless-robotics:nuclei-templates:add-cve-2024-3408');
    await page.waitForTimeout(5000);

    // Click "Create pull request" if available
    const createPRButton = page.locator('button:has-text("Create pull request"), a.btn:has-text("Create pull request")').first();
    const isVisible = await createPRButton.isVisible({ timeout: 5000 }).catch(() => false);

    if (isVisible) {
      await createPRButton.click();
      await page.waitForTimeout(3000);
    }

    // Fill PR title
    console.log('Filling PR details...');
    const titleInput = page.locator('input#pull_request_title');
    await titleInput.fill('Add Nuclei template for CVE-2024-3408 (dtale RCE)');

    // Fill PR body
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

    const bodyTextarea = page.locator('textarea#pull_request_body');
    await bodyTextarea.fill(prBody);

    await page.waitForTimeout(2000);

    // Submit PR
    console.log('Submitting Pull Request...');
    const submitButton = page.locator('button.btn-primary:has-text("Create pull request")').first();
    await submitButton.click();
    await page.waitForTimeout(5000);

    // Get PR URL
    const prUrl = page.url();
    console.log('PR_CREATED:' + prUrl);

    await page.waitForTimeout(3000);

  } catch (error) {
    console.log('ERROR:' + error.message);
    await page.screenshot({ path: 'pr_submit_error.png' }).catch(() => {});
  }

  await browser.close();
})();
