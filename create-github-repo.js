const { chromium } = require('playwright');

async function createGitHubRepo() {
  const browser = await chromium.launch({
    headless: false,
    channel: 'msedge'
  });

  const page = await browser.newPage();

  try {
    console.log('Opening GitHub...');
    await page.goto('https://github.com/new');

    // Check if we need to login
    if (page.url().includes('/login')) {
      console.log('Logging into GitHub...');
      await page.fill('input[name="login"]', 'relentless-robotics');
      await page.fill('input[name="password"]', 'Relentless@Robotics2026!');
      await page.click('input[type="submit"]');
      await page.waitForTimeout(3000);
      await page.goto('https://github.com/new');
    }

    // Fill in repo details
    console.log('Creating repository...');
    await page.waitForSelector('input[name="repository[name]"]');
    await page.fill('input[name="repository[name]"]', 'teleclaude-dashboard');
    await page.fill('input[name="repository[description]"]', 'TeleClaude system monitoring dashboard with NextAuth authentication');

    // Keep it private
    await page.click('input[value="false"]'); // private radio button

    // Submit
    await page.click('button:has-text("Create repository")');
    await page.waitForTimeout(3000);

    // Get the remote URL
    const url = page.url();
    console.log('\nRepository created:', url);

    // Get the git remote URL
    const httpsUrl = url.replace('github.com', 'github.com') + '.git';
    const sshUrl = url.replace('https://github.com/', 'git@github.com:') + '.git';

    console.log('\nRemote URLs:');
    console.log('HTTPS:', httpsUrl);
    console.log('SSH:', sshUrl);

    console.log('\nTo push your code:');
    console.log(`cd C:\\Users\\Footb\\Documents\\Github\\teleclaude-main\\dashboard-app`);
    console.log(`git remote add origin ${httpsUrl}`);
    console.log(`git push -u origin master`);

    console.log('\nBrowser will stay open for 15 seconds...');
    await page.waitForTimeout(15000);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
}

createGitHubRepo().catch(console.error);
