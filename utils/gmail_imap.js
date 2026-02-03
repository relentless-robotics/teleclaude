/**
 * Gmail IMAP Access Module
 *
 * Provides programmatic email access via IMAP - no browser automation needed!
 *
 * Setup: Set GMAIL_APP_PASSWORD environment variable or update config below.
 *
 * Usage:
 *   const gmail = require('./utils/gmail_imap');
 *
 *   // Get recent emails
 *   const emails = await gmail.getRecent(10);
 *
 *   // Search emails
 *   const results = await gmail.search({ from: 'stripe.com', since: '7 days' });
 *
 *   // Get unread count
 *   const count = await gmail.getUnreadCount();
 */

const { ImapFlow } = require('imapflow');
const path = require('path');
const fs = require('fs');

// Configuration
const CONFIG = {
  email: 'relentlessrobotics@gmail.com',
  // App password - set via env var or update here after generation
  appPassword: process.env.GMAIL_APP_PASSWORD || 'YOUR_APP_PASSWORD_HERE',
  host: 'imap.gmail.com',
  port: 993,
  secure: true
};

// Load app password from API_KEYS.md if not in env
function loadAppPassword() {
  if (CONFIG.appPassword && CONFIG.appPassword !== 'YOUR_APP_PASSWORD_HERE') {
    return CONFIG.appPassword;
  }

  // Try to load from a config file
  const configPath = path.join(__dirname, '..', 'secure', 'gmail_app_password.txt');
  if (fs.existsSync(configPath)) {
    CONFIG.appPassword = fs.readFileSync(configPath, 'utf-8').trim();
    return CONFIG.appPassword;
  }

  return null;
}

// Create IMAP client
function createClient() {
  const password = loadAppPassword();
  if (!password || password === 'YOUR_APP_PASSWORD_HERE') {
    throw new Error('Gmail App Password not configured. Set GMAIL_APP_PASSWORD env var or save to secure/gmail_app_password.txt');
  }

  return new ImapFlow({
    host: CONFIG.host,
    port: CONFIG.port,
    secure: CONFIG.secure,
    auth: {
      user: CONFIG.email,
      pass: password
    },
    logger: false // Disable verbose logging
  });
}

/**
 * Get recent emails from inbox
 * @param {number} count - Number of emails to retrieve (default 10)
 * @returns {Promise<Array>} Array of email objects
 */
async function getRecent(count = 10) {
  const client = createClient();
  const emails = [];

  try {
    await client.connect();

    const lock = await client.getMailboxLock('INBOX');
    try {
      // Get the last N messages
      const messages = client.fetch(`${Math.max(1, client.mailbox.exists - count + 1)}:*`, {
        envelope: true,
        bodyStructure: true,
        flags: true
      });

      for await (const msg of messages) {
        emails.push({
          uid: msg.uid,
          date: msg.envelope.date,
          from: msg.envelope.from?.[0]?.address || 'unknown',
          fromName: msg.envelope.from?.[0]?.name || '',
          subject: msg.envelope.subject || '(no subject)',
          isRead: msg.flags.has('\\Seen'),
          isStarred: msg.flags.has('\\Flagged')
        });
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (error) {
    console.error('IMAP Error:', error.message);
    throw error;
  }

  return emails.reverse(); // Most recent first
}

/**
 * Search emails with criteria
 * @param {Object} criteria - Search criteria
 * @param {string} criteria.from - From address contains
 * @param {string} criteria.subject - Subject contains
 * @param {string} criteria.since - Date string like "7 days" or "2024-01-01"
 * @param {boolean} criteria.unread - Only unread emails
 * @param {number} criteria.limit - Max results (default 20)
 * @returns {Promise<Array>} Array of matching emails
 */
async function search(criteria = {}) {
  const client = createClient();
  const emails = [];
  const limit = criteria.limit || 20;

  try {
    await client.connect();

    const lock = await client.getMailboxLock('INBOX');
    try {
      // Build search query
      const query = {};

      if (criteria.from) {
        query.from = criteria.from;
      }
      if (criteria.subject) {
        query.subject = criteria.subject;
      }
      if (criteria.since) {
        // Parse "7 days" format
        const match = criteria.since.match(/(\d+)\s*(day|week|month)/i);
        if (match) {
          const num = parseInt(match[1]);
          const unit = match[2].toLowerCase();
          const date = new Date();
          if (unit.startsWith('day')) date.setDate(date.getDate() - num);
          else if (unit.startsWith('week')) date.setDate(date.getDate() - num * 7);
          else if (unit.startsWith('month')) date.setMonth(date.getMonth() - num);
          query.since = date;
        } else {
          query.since = new Date(criteria.since);
        }
      }
      if (criteria.unread) {
        query.seen = false;
      }

      // Search
      const uids = await client.search(query);

      if (uids.length > 0) {
        // Fetch details for found messages (limit results)
        const fetchUids = uids.slice(-limit);
        const messages = client.fetch(fetchUids, {
          envelope: true,
          flags: true
        });

        for await (const msg of messages) {
          emails.push({
            uid: msg.uid,
            date: msg.envelope.date,
            from: msg.envelope.from?.[0]?.address || 'unknown',
            fromName: msg.envelope.from?.[0]?.name || '',
            subject: msg.envelope.subject || '(no subject)',
            isRead: msg.flags.has('\\Seen'),
            isStarred: msg.flags.has('\\Flagged')
          });
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (error) {
    console.error('IMAP Search Error:', error.message);
    throw error;
  }

  return emails.reverse();
}

/**
 * Get email body/content
 * @param {number} uid - Email UID
 * @returns {Promise<Object>} Email with body content
 */
async function getEmail(uid) {
  const client = createClient();
  let email = null;

  try {
    await client.connect();

    const lock = await client.getMailboxLock('INBOX');
    try {
      const message = await client.fetchOne(uid, {
        envelope: true,
        source: true,
        flags: true
      });

      if (message) {
        email = {
          uid: message.uid,
          date: message.envelope.date,
          from: message.envelope.from?.[0]?.address || 'unknown',
          fromName: message.envelope.from?.[0]?.name || '',
          to: message.envelope.to?.map(t => t.address) || [],
          subject: message.envelope.subject || '(no subject)',
          body: message.source?.toString() || '',
          isRead: message.flags.has('\\Seen')
        };
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (error) {
    console.error('IMAP Fetch Error:', error.message);
    throw error;
  }

  return email;
}

/**
 * Get unread email count
 * @returns {Promise<number>} Number of unread emails
 */
async function getUnreadCount() {
  const client = createClient();
  let count = 0;

  try {
    await client.connect();

    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ seen: false });
      count = uids.length;
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (error) {
    console.error('IMAP Error:', error.message);
    throw error;
  }

  return count;
}

/**
 * Get mailbox status
 * @returns {Promise<Object>} Mailbox info
 */
async function getStatus() {
  const client = createClient();
  let status = {};

  try {
    await client.connect();

    const lock = await client.getMailboxLock('INBOX');
    try {
      status = {
        total: client.mailbox.exists,
        recent: client.mailbox.recent,
        uidNext: client.mailbox.uidNext
      };

      // Get unread count
      const unreadUids = await client.search({ seen: false });
      status.unread = unreadUids.length;
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (error) {
    console.error('IMAP Error:', error.message);
    throw error;
  }

  return status;
}

/**
 * Test IMAP connection
 * @returns {Promise<boolean>} True if connection successful
 */
async function testConnection() {
  const client = createClient();

  try {
    await client.connect();
    console.log('✓ IMAP connection successful');
    console.log(`  Email: ${CONFIG.email}`);
    console.log(`  Server: ${CONFIG.host}:${CONFIG.port}`);
    await client.logout();
    return true;
  } catch (error) {
    console.error('✗ IMAP connection failed:', error.message);
    return false;
  }
}

// CLI test
if (require.main === module) {
  (async () => {
    console.log('Testing Gmail IMAP access...\n');

    const connected = await testConnection();
    if (!connected) {
      console.log('\nMake sure you have set the Gmail App Password:');
      console.log('  1. Go to https://myaccount.google.com/apppasswords');
      console.log('  2. Generate an app password');
      console.log('  3. Set GMAIL_APP_PASSWORD env var or save to secure/gmail_app_password.txt');
      process.exit(1);
    }

    console.log('\nGetting mailbox status...');
    const status = await getStatus();
    console.log('Status:', status);

    console.log('\nGetting recent emails...');
    const recent = await getRecent(5);
    recent.forEach((e, i) => {
      console.log(`${i + 1}. [${e.isRead ? ' ' : '*'}] ${e.from}: ${e.subject}`);
    });
  })();
}

module.exports = {
  getRecent,
  search,
  getEmail,
  getUnreadCount,
  getStatus,
  testConnection,
  CONFIG
};
