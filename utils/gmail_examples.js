/**
 * Gmail API Usage Examples
 *
 * Common use cases for the Gmail API module
 */

const { GmailAPI } = require('./gmail_api');

/**
 * Example 1: Search for verification emails
 */
async function findVerificationEmails() {
  const gmail = new GmailAPI();
  await gmail.initialize();

  // Search for emails with "verify" or "verification" in subject
  const emails = await gmail.searchEmails('subject:(verify OR verification)', 10);

  console.log(`Found ${emails.length} verification emails:`);
  emails.forEach(email => {
    console.log(`- ${email.subject} from ${email.from}`);

    // Look for verification links in body
    const linkMatch = email.body.match(/https?:\/\/[^\s]+verify[^\s]*/i);
    if (linkMatch) {
      console.log(`  Verification link: ${linkMatch[0]}`);
    }
  });

  return emails;
}

/**
 * Example 2: Get verification codes from recent emails
 */
async function getVerificationCodes() {
  const gmail = new GmailAPI();
  await gmail.initialize();

  // Search for recent emails with common verification patterns
  const emails = await gmail.searchEmails('newer_than:1h (code OR verification OR OTP)', 5);

  const codes = [];
  emails.forEach(email => {
    // Look for 6-digit codes
    const codeMatch = email.body.match(/\b\d{6}\b/);
    if (codeMatch) {
      codes.push({
        code: codeMatch[0],
        from: email.from,
        subject: email.subject,
        date: email.date
      });
    }
  });

  console.log(`Found ${codes.length} verification codes:`);
  codes.forEach(item => {
    console.log(`- Code: ${item.code} from ${item.from}`);
  });

  return codes;
}

/**
 * Example 3: Check for emails from a specific service
 */
async function checkGitHubEmails() {
  const gmail = new GmailAPI();
  await gmail.initialize();

  const emails = await gmail.searchEmails('from:github.com newer_than:1d', 10);

  console.log(`GitHub emails from last 24 hours: ${emails.length}`);
  emails.forEach(email => {
    console.log(`- ${email.subject}`);
  });

  return emails;
}

/**
 * Example 4: Send a test email
 */
async function sendTestEmail() {
  const gmail = new GmailAPI();
  await gmail.initialize();

  const result = await gmail.sendEmail(
    'relentlessrobotics@gmail.com',
    'Test from TeleClaude Gmail API',
    'This is a test email sent via the Gmail API.\n\nIf you receive this, the API is working correctly!'
  );

  console.log('Email sent successfully!');
  console.log('Message ID:', result.id);

  return result;
}

/**
 * Example 5: Monitor for new emails (polling)
 */
async function monitorNewEmails(fromAddress, intervalSeconds = 30) {
  const gmail = new GmailAPI();
  await gmail.initialize();

  let lastCheckTime = Math.floor(Date.now() / 1000);

  console.log(`Monitoring for emails from: ${fromAddress}`);
  console.log('Press Ctrl+C to stop\n');

  setInterval(async () => {
    try {
      // Search for emails received after last check
      const emails = await gmail.searchEmails(
        `from:${fromAddress} after:${lastCheckTime}`,
        5
      );

      if (emails.length > 0) {
        console.log(`\n🔔 ${emails.length} new email(s) from ${fromAddress}:`);
        emails.forEach(email => {
          console.log(`  - ${email.subject}`);
          console.log(`    ${email.snippet.substring(0, 80)}...`);
        });
      }

      lastCheckTime = Math.floor(Date.now() / 1000);
    } catch (error) {
      console.error('Error checking emails:', error.message);
    }
  }, intervalSeconds * 1000);
}

/**
 * Example 6: Extract all links from an email
 */
async function extractLinksFromEmail(messageId) {
  const gmail = new GmailAPI();
  await gmail.initialize();

  const email = await gmail.getMessage(messageId);

  // Find all URLs in email body
  const urlRegex = /https?:\/\/[^\s<>"]+/g;
  const links = email.body.match(urlRegex) || [];

  console.log(`Found ${links.length} links in email:`);
  links.forEach(link => console.log(`  - ${link}`));

  return links;
}

/**
 * Example 7: Search by date range
 */
async function getEmailsInDateRange(startDate, endDate) {
  const gmail = new GmailAPI();
  await gmail.initialize();

  // Format: YYYY/MM/DD
  const query = `after:${startDate} before:${endDate}`;
  const emails = await gmail.searchEmails(query, 50);

  console.log(`Emails between ${startDate} and ${endDate}: ${emails.length}`);

  return emails;
}

/**
 * Example 8: Check for unread emails
 */
async function getUnreadEmails() {
  const gmail = new GmailAPI();
  await gmail.initialize();

  const emails = await gmail.searchEmails('is:unread', 20);

  console.log(`Unread emails: ${emails.length}`);
  emails.forEach(email => {
    console.log(`- ${email.subject} (from: ${email.from})`);
  });

  return emails;
}

// Export examples for use in other scripts
module.exports = {
  findVerificationEmails,
  getVerificationCodes,
  checkGitHubEmails,
  sendTestEmail,
  monitorNewEmails,
  extractLinksFromEmail,
  getEmailsInDateRange,
  getUnreadEmails
};

// If run directly, show menu
if (require.main === module) {
  console.log('Gmail API Examples');
  console.log('==================\n');
  console.log('1. Find verification emails');
  console.log('2. Get verification codes from recent emails');
  console.log('3. Check GitHub emails (last 24h)');
  console.log('4. Send test email');
  console.log('5. Get unread emails');
  console.log('6. Monitor for new emails (continuous)');
  console.log('\nRun individual functions:');
  console.log('  findVerificationEmails()');
  console.log('  getVerificationCodes()');
  console.log('  checkGitHubEmails()');
  console.log('  sendTestEmail()');
  console.log('  getUnreadEmails()');
  console.log('  monitorNewEmails("example@domain.com", 30)');
}
