#!/usr/bin/env node

/**
 * Gmail API Quick Start
 *
 * This script tests Gmail API access and shows recent emails.
 * Run after completing OAuth setup in GMAIL_OAUTH_SETUP.md
 */

const { GmailAPI } = require('./gmail_api');
const fs = require('fs');
const path = require('path');

async function quickStart() {
  console.log('='.repeat(60));
  console.log('Gmail API Quick Start');
  console.log('='.repeat(60));
  console.log();

  // Check if credentials exist
  const credPath = path.join(__dirname, '../secure/gmail_credentials.json');
  if (!fs.existsSync(credPath)) {
    console.error('❌ ERROR: Credentials file not found!');
    console.error(`   Expected at: ${credPath}`);
    console.error();
    console.error('Please complete the setup steps in GMAIL_OAUTH_SETUP.md:');
    console.error('1. Create Google Cloud project');
    console.error('2. Enable Gmail API');
    console.error('3. Create OAuth credentials');
    console.error('4. Download and save as gmail_credentials.json');
    console.error();
    process.exit(1);
  }

  console.log('✅ Credentials file found');
  console.log();

  // Initialize Gmail API
  console.log('Initializing Gmail API...');
  const gmail = new GmailAPI();

  try {
    await gmail.initialize();
    console.log('✅ Gmail API initialized successfully!');
    console.log();
  } catch (error) {
    console.error('❌ Failed to initialize Gmail API:', error.message);
    console.error();
    console.error('Common issues:');
    console.error('- Invalid credentials file format');
    console.error('- Gmail API not enabled in Google Cloud Console');
    console.error('- Network connectivity issues');
    console.error();
    process.exit(1);
  }

  // Test API by fetching recent emails
  console.log('Fetching recent emails...');
  console.log();

  try {
    const emails = await gmail.searchEmails('is:inbox', 5);

    if (emails.length === 0) {
      console.log('📭 No emails found in inbox');
    } else {
      console.log(`📧 Found ${emails.length} recent emails:\n`);

      emails.forEach((email, index) => {
        console.log(`${index + 1}. ${email.subject}`);
        console.log(`   From: ${email.from}`);
        console.log(`   Date: ${email.date}`);
        console.log(`   Snippet: ${email.snippet.substring(0, 100)}...`);
        console.log();
      });
    }

    console.log('='.repeat(60));
    console.log('✅ Gmail API is working correctly!');
    console.log('='.repeat(60));
    console.log();
    console.log('You can now use the Gmail API in your code:');
    console.log();
    console.log('  const { GmailAPI } = require("./utils/gmail_api");');
    console.log('  const gmail = new GmailAPI();');
    console.log('  await gmail.initialize();');
    console.log('  const emails = await gmail.searchEmails("from:example.com");');
    console.log();

  } catch (error) {
    console.error('❌ Failed to fetch emails:', error.message);
    console.error();
    console.error('Possible issues:');
    console.error('- OAuth token expired or invalid');
    console.error('- Insufficient permissions (scopes)');
    console.error('- Gmail API quota exceeded');
    console.error();
    console.error('Try deleting secure/gmail_token.json and running this script again.');
    process.exit(1);
  }
}

quickStart().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
