const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    channel: 'msedge',
    slowMo: 500  // Slow down to see what's happening
  });

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  try {
    // Step 1: Login
    console.log('Step 1: Logging into GitHub...');
    await page.goto('https://github.com/login');
    await page.waitForLoadState('domcontentloaded');

    await page.fill('input#login_field', 'relentless-robotics');
    await page.fill('input#password', 'Relentless@Robotics2026!');
    await page.click('input[type="submit"]');
    await page.waitForTimeout(5000);

    console.log('Logged in!');

    // Step 2: Go directly to compare page to create PR
    console.log('Step 2: Navigating to compare page...');
    await page.goto('https://github.com/projectdiscovery/nuclei-templates/compare/main...relentless-robotics:nuclei-templates:add-cve-2024-3408');
    await page.waitForTimeout(5000);

    // Check what we see
    const pageText = await page.textContent('body');

    if (pageText.includes('There isn\'t anything to compare') || pageText.includes('no commits in common')) {
      console.log('Branch does not exist in fork yet. Need to create it first.');
      console.log('Opening fork repo to create branch...');

      // Open our fork
      await page.goto('https://github.com/relentless-robotics/nuclei-templates');
      await page.waitForTimeout(3000);

      // Navigate to the file upload page for that directory
      console.log('Navigating to upload page...');
      await page.goto('https://github.com/relentless-robotics/nuclei-templates/upload/main/http/cves/2024');
      await page.waitForTimeout(3000);

      // Upload the file
      console.log('Uploading file...');
      const fileInput = await page.locator('input[type="file"]');
      await fileInput.setInputFiles('C:\\Users\\Footb\\Documents\\Github\\nuclei-templates\\http\\cves\\2024\\CVE-2024-3408.yaml');
      await page.waitForTimeout(3000);

      // Scroll down to commit section
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);

      // Create new branch
      console.log('Creating new branch...');
      const newBranchRadio = await page.locator('input[value="new-branch"]');
      await newBranchRadio.check();
      await page.waitForTimeout(500);

      const branchInput = await page.locator('input[name="new_branch"]');
      await branchInput.fill('add-cve-2024-3408');
      await page.waitForTimeout(1000);

      // Click propose
      console.log('Proposing new file...');
      const proposeButton = await page.locator('button:has-text("Propose"), button:has-text("Commit")').first();
      await proposeButton.click();
      await page.waitForTimeout(5000);

      console.log('Branch created! PR page should be opening...');

    } else if (pageText.includes('Able to merge') || pageText.includes('Open a pull request')) {
      console.log('Branch exists and is ready for PR!');
    }

    // Now we should be on the PR creation page or can navigate to it
    if (!page.url().includes('/compare/')) {
      await page.goto('https://github.com/projectdiscovery/nuclei-templates/compare/main...relentless-robotics:nuclei-templates:add-cve-2024-3408');
      await page.waitForTimeout(3000);
    }

    // Fill in PR details
    console.log('Step 3: Filling PR details...');

    const titleInput = await page.locator('input[name="pull_request[title]"], input#pull_request_title').first();
    await titleInput.fill('Add Nuclei template for CVE-2024-3408 (dtale RCE)');

    const bodyTextarea = await page.locator('textarea[name="pull_request[body]"], textarea#pull_request_body').first();
    const prBody = `/claim #14488

## Summary

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

Closes #14488`;

    await bodyTextarea.fill(prBody);
    await page.waitForTimeout(2000);

    // Submit
    console.log('Step 4: Submitting PR...');
    const createButton = await page.locator('button.btn-primary:has-text("Create pull request")').first();
    await createButton.click();
    await page.waitForTimeout(5000);

    const prUrl = page.url();
    console.log('✅ SUCCESS! PR Created: ' + prUrl);

    fs.writeFileSync('pr_url.txt', prUrl);
    console.log('PR URL saved to pr_url.txt');

    await page.waitForTimeout(5000);

  } catch (error) {
    console.error('ERROR:', error.message);
    await page.screenshot({ path: 'final_error.png' });
  }

  await browser.close();
})();
