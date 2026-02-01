/**
 * Gmail Helper Utility
 *
 * Provides easy interface for reading and sending emails via Gmail.
 * Uses Playwright with saved Google auth for reliable access.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const AUTH_STATE_PATH = path.join(__dirname, '..', 'browser_state', 'google_auth.json');
const SCREENSHOTS_DIR = path.join(__dirname, '..', 'screenshots');

class GmailHelper {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async init() {
    this.browser = await chromium.launch({ headless: false });
    this.context = await this.browser.newContext({
      storageState: AUTH_STATE_PATH
    });
    this.page = await this.context.newPage();
    await this.page.goto('https://mail.google.com', { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);
    return this;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  /**
   * Get list of recent emails
   * @param {number} count - Number of emails to fetch
   * @param {string} query - Optional search query
   */
  async getEmails(count = 10, query = '') {
    if (query) {
      const searchBox = await this.page.waitForSelector('input[aria-label="Search mail"]', { timeout: 10000 });
      await searchBox.fill(query);
      await searchBox.press('Enter');
      await this.page.waitForTimeout(2000);
    }

    const emails = await this.page.evaluate((maxCount) => {
      const rows = document.querySelectorAll('tr.zA');
      const results = [];

      for (let i = 0; i < Math.min(rows.length, maxCount); i++) {
        const row = rows[i];
        const sender = row.querySelector('.yP, .zF')?.getAttribute('name') || row.querySelector('.yP, .zF')?.textContent || 'Unknown';
        const subject = row.querySelector('.y6 span:first-child')?.textContent || row.querySelector('.bog')?.textContent || 'No subject';
        const snippet = row.querySelector('.y2')?.textContent || '';
        const date = row.querySelector('.xW span')?.getAttribute('title') || row.querySelector('.xW span')?.textContent || '';
        const isUnread = row.classList.contains('zE');

        results.push({ sender, subject, snippet, date, isUnread, index: i });
      }

      return results;
    }, count);

    return emails;
  }

  /**
   * Read a specific email by clicking on it
   * @param {number} index - Email index (0-based)
   */
  async readEmail(index = 0) {
    const rows = await this.page.$$('tr.zA');
    if (rows[index]) {
      await rows[index].click();
      await this.page.waitForTimeout(2000);

      const content = await this.page.evaluate(() => {
        const emailBody = document.querySelector('.a3s.aiL') || document.querySelector('[role="main"]');
        return emailBody ? emailBody.innerText : 'Could not read email content';
      });

      return content;
    }
    return null;
  }

  /**
   * Send an email
   * @param {string} to - Recipient email
   * @param {string} subject - Email subject
   * @param {string} body - Email body (plain text)
   */
  async sendEmail(to, subject, body) {
    // Click compose
    await this.page.click('div[gh="cm"]');
    await this.page.waitForTimeout(1000);

    // Fill recipient
    const toField = await this.page.waitForSelector('input[aria-label="To recipients"]', { timeout: 5000 });
    await toField.fill(to);

    // Fill subject
    const subjectField = await this.page.waitForSelector('input[name="subjectbox"]', { timeout: 5000 });
    await subjectField.fill(subject);

    // Fill body
    const bodyField = await this.page.waitForSelector('div[aria-label="Message Body"]', { timeout: 5000 });
    await bodyField.fill(body);

    // Send
    await this.page.keyboard.press('Control+Enter');
    await this.page.waitForTimeout(2000);

    return true;
  }

  /**
   * Search for emails
   * @param {string} query - Search query
   */
  async search(query) {
    const searchBox = await this.page.waitForSelector('input[aria-label="Search mail"]', { timeout: 10000 });
    await searchBox.fill(query);
    await searchBox.press('Enter');
    await this.page.waitForTimeout(2000);
    return this.getEmails(20);
  }

  /**
   * Take screenshot of current view
   * @param {string} filename - Screenshot filename
   */
  async screenshot(filename) {
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await this.page.screenshot({ path: filepath });
    return filepath;
  }

  /**
   * Go back to inbox
   */
  async goToInbox() {
    await this.page.click('a[href*="inbox"]');
    await this.page.waitForTimeout(2000);
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const gmail = new GmailHelper();

  try {
    await gmail.init();
    console.log('Gmail connected successfully\n');

    switch (command) {
      case 'list':
        const query = args[1] || '';
        const emails = await gmail.getEmails(10, query);
        console.log('Recent emails:');
        emails.forEach((e, i) => {
          const unread = e.isUnread ? '[NEW]' : '';
          console.log(`${i}. ${unread} ${e.sender}: ${e.subject}`);
          console.log(`   ${e.snippet.substring(0, 80)}...`);
          console.log(`   ${e.date}\n`);
        });
        break;

      case 'read':
        const index = parseInt(args[1]) || 0;
        const content = await gmail.readEmail(index);
        console.log('Email content:\n');
        console.log(content);
        break;

      case 'search':
        const searchQuery = args.slice(1).join(' ');
        const results = await gmail.search(searchQuery);
        console.log(`Search results for "${searchQuery}":`);
        results.forEach((e, i) => {
          console.log(`${i}. ${e.sender}: ${e.subject}`);
        });
        break;

      case 'send':
        const to = args[1];
        const subject = args[2];
        const body = args.slice(3).join(' ');
        if (!to || !subject || !body) {
          console.log('Usage: node gmail_helper.js send <to> "<subject>" "<body>"');
          break;
        }
        await gmail.sendEmail(to, subject, body);
        console.log(`Email sent to ${to}`);
        break;

      case 'screenshot':
        const filename = args[1] || 'gmail_screenshot.png';
        const filepath = await gmail.screenshot(filename);
        console.log(`Screenshot saved to ${filepath}`);
        break;

      default:
        console.log('Gmail Helper - Usage:');
        console.log('  node gmail_helper.js list [search_query]  - List recent emails');
        console.log('  node gmail_helper.js read <index>         - Read email at index');
        console.log('  node gmail_helper.js search <query>       - Search emails');
        console.log('  node gmail_helper.js send <to> "<subject>" "<body>" - Send email');
        console.log('  node gmail_helper.js screenshot [filename] - Take screenshot');
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await gmail.close();
  }
}

// Export for use as module
module.exports = { GmailHelper };

// Run if called directly
if (require.main === module) {
  main();
}
