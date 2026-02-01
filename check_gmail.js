const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const stateFile = 'C:/Users/Footb/Documents/Github/teleclaude-main/browser_state/google_auth.json';

  // Check if auth file exists
  if (!fs.existsSync(stateFile)) {
    console.log('ERROR: Google auth state file not found at ' + stateFile);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: stateFile });
  const page = await context.newPage();

  try {
    console.log('Navigating to Gmail...');
    await page.goto('https://mail.google.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for inbox to load
    await page.waitForTimeout(5000);

    // Check if we're logged in by looking for inbox elements
    const inboxLoaded = await page.locator('[role="main"]').count() > 0;

    if (!inboxLoaded) {
      console.log('ERROR: Inbox did not load properly. May need re-authentication.');
      await browser.close();
      process.exit(1);
    }

    console.log('Inbox loaded successfully');

    // Get unread count - look for unread indicator
    const unreadElement = await page.locator('[aria-label*="Inbox"]').first();
    const unreadText = await unreadElement.innerText().catch(() => 'Inbox');
    console.log('Unread indicator:', unreadText);

    // Get recent emails - look for email rows
    await page.waitForTimeout(2000);
    const emailRows = await page.locator('tr.zA').all();

    console.log('Found ' + emailRows.length + ' email rows');

    const emails = [];
    for (let i = 0; i < Math.min(10, emailRows.length); i++) {
      try {
        const row = emailRows[i];

        // Get subject
        const subjectElement = await row.locator('span.bog').first();
        const subject = await subjectElement.innerText().catch(() => 'No subject');

        // Get sender
        const senderElement = await row.locator('span[email]').first();
        const sender = await senderElement.getAttribute('email').catch(async () => {
          const nameElement = await row.locator('span.yW').first();
          return await nameElement.innerText().catch(() => 'Unknown');
        });

        // Check if unread (bold)
        const isUnread = await row.locator('span.zF').count() > 0;

        emails.push({
          subject: subject,
          sender: sender,
          unread: isUnread
        });
      } catch (e) {
        console.log('Error parsing row ' + i + ':', e.message);
      }
    }

    console.log('\n=== RESULTS ===');
    console.log(JSON.stringify({ unreadText, emails }, null, 2));

    await browser.close();
  } catch (error) {
    console.log('ERROR:', error.message);
    await browser.close();
    process.exit(1);
  }
})();
