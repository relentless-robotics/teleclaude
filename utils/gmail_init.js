// utils/gmail_init.js
const { GmailAPI } = require('./gmail_api');

async function init() {
  console.log('Initializing Gmail API...');
  const gmail = new GmailAPI();
  await gmail.initialize();
  console.log('Gmail API initialized successfully!');

  // Test by listing recent emails
  console.log('\nTesting API - fetching recent emails...');
  const emails = await gmail.searchEmails('is:inbox', 5);
  console.log(`\nFound ${emails.length} recent emails:`);
  emails.forEach(e => console.log(`- ${e.subject} (from: ${e.from})`));
}

init().catch(console.error);
