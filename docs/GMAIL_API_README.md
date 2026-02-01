# Gmail API Integration for TeleClaude

## Overview

TeleClaude now has robust Gmail API access via OAuth 2.0, replacing unreliable browser automation with official API integration.

## Why Gmail API vs Browser Automation?

| Feature | Browser Automation | Gmail API |
|---------|-------------------|-----------|
| Reliability | ❌ Breaks with UI changes | ✅ Stable API contract |
| Speed | ❌ Slow (loads UI) | ✅ Fast (direct API calls) |
| Authentication | ❌ Requires repeated login | ✅ Auto-refreshing tokens |
| Rate Limits | ⚠️ Blocked by Google easily | ✅ Official quota (1B requests/day free tier) |
| Email Search | ❌ Limited by UI | ✅ Powerful query syntax |
| Headless | ❌ Difficult | ✅ Native |

**Bottom line:** Gmail API is the professional, reliable way to access Gmail.

---

## Setup Status

### ✅ Completed

- [x] Gmail API module created (`utils/gmail_api.js`)
- [x] googleapis npm package installed
- [x] Initialization script (`utils/gmail_init.js`)
- [x] Quick start testing script (`utils/gmail_quickstart.js`)
- [x] Usage examples (`utils/gmail_examples.js`)
- [x] Setup guide (`GMAIL_OAUTH_SETUP.md`)
- [x] API_KEYS.md updated
- [x] SKILLS.md updated

### ⏳ Pending

- [ ] Google Cloud Console project creation
- [ ] Gmail API enabled
- [ ] OAuth credentials downloaded
- [ ] First OAuth token generated

---

## Quick Setup (5-10 minutes)

1. **Follow the setup guide:**
   ```
   Open: C:\Users\Footb\Documents\Github\teleclaude-main\GMAIL_OAUTH_SETUP.md
   ```

2. **Key steps:**
   - Create Google Cloud project "TeleClaude Gmail API"
   - Enable Gmail API
   - Create OAuth 2.0 Desktop credentials
   - Download JSON → save as `secure/gmail_credentials.json`

3. **Initialize OAuth:**
   ```bash
   node utils/gmail_init.js
   ```
   This opens a browser for one-time authorization, then saves the token.

4. **Test it works:**
   ```bash
   node utils/gmail_quickstart.js
   ```
   Should list your 5 most recent emails.

---

## Usage

### Basic Example

```javascript
const { GmailAPI } = require('./utils/gmail_api');

async function example() {
  const gmail = new GmailAPI();
  await gmail.initialize();

  // Search for verification emails
  const emails = await gmail.searchEmails('subject:verify', 10);

  emails.forEach(email => {
    console.log(email.subject);
    console.log(email.body);
  });
}
```

### Common Use Cases

**1. Find verification codes:**
```javascript
const emails = await gmail.searchEmails('newer_than:1h (code OR verify)', 5);
const code = emails[0].body.match(/\b\d{6}\b/)[0];
```

**2. Check for emails from a service:**
```javascript
const githubEmails = await gmail.searchEmails('from:github.com newer_than:1d', 10);
```

**3. Get unread emails:**
```javascript
const unread = await gmail.searchEmails('is:unread', 20);
```

**4. Send an email:**
```javascript
await gmail.sendEmail('recipient@example.com', 'Subject', 'Body text here');
```

**5. Extract links from email:**
```javascript
const email = await gmail.getMessage(messageId);
const links = email.body.match(/https?:\/\/[^\s]+/g);
```

---

## Available Scripts

| Script | Purpose |
|--------|---------|
| `utils/gmail_api.js` | Core Gmail API module |
| `utils/gmail_init.js` | First-time OAuth setup (generates token) |
| `utils/gmail_quickstart.js` | Test setup and list recent emails |
| `utils/gmail_examples.js` | Common usage patterns and examples |

---

## Gmail Search Query Syntax

The `searchEmails()` method supports powerful Gmail search operators:

| Operator | Example | Description |
|----------|---------|-------------|
| `from:` | `from:github.com` | Emails from sender |
| `to:` | `to:me` | Emails to recipient |
| `subject:` | `subject:verify` | Subject contains |
| `is:unread` | `is:unread` | Unread emails |
| `is:inbox` | `is:inbox` | Emails in inbox |
| `newer_than:` | `newer_than:1h` | Within time period (h=hours, d=days) |
| `older_than:` | `older_than:7d` | Older than time |
| `after:` | `after:2026/01/01` | After date |
| `before:` | `before:2026/02/01` | Before date |
| `has:attachment` | `has:attachment` | Has attachments |
| `OR` | `code OR verify` | Logical OR |

**Combine operators:**
```javascript
const query = 'from:noreply@github.com subject:verification newer_than:1h';
const emails = await gmail.searchEmails(query, 10);
```

---

## API Methods

### GmailAPI Class

```javascript
const gmail = new GmailAPI();
await gmail.initialize();
```

#### Methods

**`listMessages(query, maxResults)`**
- Returns array of message IDs and thread IDs
- `query`: Gmail search query (optional)
- `maxResults`: Number of results (default: 10)

**`getMessage(messageId)`**
- Returns full email object with parsed headers and body
- `messageId`: Gmail message ID

**`searchEmails(query, maxResults)`**
- Combines `listMessages` and `getMessage`
- Returns array of full email objects

**`sendEmail(to, subject, body)`**
- Sends an email
- Returns sent message object

**Email Object Structure:**
```javascript
{
  id: 'message-id',
  threadId: 'thread-id',
  from: 'sender@example.com',
  to: 'recipient@example.com',
  subject: 'Email subject',
  date: 'Mon, 1 Jan 2026 12:00:00 +0000',
  body: 'Full email body text',
  snippet: 'Preview snippet...'
}
```

---

## Security & Privacy

### Credentials Storage

- **OAuth Credentials:** `secure/gmail_credentials.json`
  - Contains client ID and secret (not sensitive alone)
  - Safe to keep in version control if private repo
  - Added to `.gitignore` for safety

- **Access Tokens:** `secure/gmail_token.json`
  - Contains access and refresh tokens
  - **NEVER commit to version control**
  - Auto-generated on first run
  - Auto-refreshes when expired

### OAuth Scopes

The API requests minimal permissions:
- `gmail.readonly` - Read emails only
- `gmail.send` - Send emails on your behalf

No permissions to:
- Delete emails
- Modify settings
- Access other Google services

### Revoking Access

To revoke access:
1. Visit https://myaccount.google.com/permissions
2. Find "TeleClaude Gmail" or "TeleClaude Desktop"
3. Click "Remove Access"

To re-authenticate:
```bash
rm secure/gmail_token.json
node utils/gmail_init.js
```

---

## Troubleshooting

### "Credentials file not found"
- Run the setup guide: `GMAIL_OAUTH_SETUP.md`
- Make sure file is saved as `secure/gmail_credentials.json`

### "Invalid grant" or "Token expired"
- Delete token and re-authenticate:
  ```bash
  rm secure/gmail_token.json
  node utils/gmail_init.js
  ```

### "403 Access Not Configured"
- Make sure Gmail API is enabled in Google Cloud Console
- Wait 1-2 minutes after enabling (propagation delay)

### "Quota exceeded"
- Free tier: 1 billion requests/day (you won't hit this)
- If exceeded, check for infinite loops in code

### "OAuth consent required"
- First-time setup requires browser authorization
- Run `gmail_init.js` to generate token
- Only needed once (token auto-refreshes)

---

## Integration with TeleClaude

### Replacing Browser Automation

**Old way (unreliable):**
```javascript
const page = await browser.newPage();
await page.goto('https://mail.google.com');
await page.click('...');  // Breaks when UI changes
```

**New way (reliable):**
```javascript
const { GmailAPI } = require('./utils/gmail_api');
const gmail = new GmailAPI();
await gmail.initialize();
const emails = await gmail.searchEmails('verification');
```

### Common TeleClaude Workflows

**Account verification:**
```javascript
// Old: Ask user to check email manually
// New: Check email automatically
const codes = await gmail.searchEmails('code OR verify newer_than:5m', 1);
const code = codes[0].body.match(/\b\d{6}\b/)[0];
```

**Monitoring for notifications:**
```javascript
// Check for new bounty notifications
const bounties = await gmail.searchEmails('from:algora.io subject:bounty newer_than:1h');
```

**Email-based workflows:**
```javascript
// Process GitHub PR notifications
const prs = await gmail.searchEmails('from:notifications@github.com subject:"pull request"');
```

---

## Rate Limits & Quotas

**Gmail API Free Tier:**
- 1,000,000,000 quota units/day (essentially unlimited for our use)
- 250 quota units/second/user

**Quota costs:**
- Read email: 5 units
- Send email: 100 units
- List messages: 5 units

**Example:** You can read 200,000 emails/day or send 10,000 emails/day.

**Best practices:**
- Cache email data when possible
- Don't poll aggressively (use reasonable intervals)
- Batch operations when searching multiple criteria

---

## Future Enhancements

Possible improvements:
- [ ] Real-time push notifications (Gmail Push API)
- [ ] Label management
- [ ] Attachment downloads
- [ ] Draft management
- [ ] Thread operations
- [ ] Batch email processing
- [ ] Gmail filters/rules management

---

## Resources

- **Setup Guide:** `GMAIL_OAUTH_SETUP.md`
- **Examples:** `utils/gmail_examples.js`
- **API Reference:** https://developers.google.com/gmail/api
- **Search Syntax:** https://support.google.com/mail/answer/7190
- **OAuth Setup:** https://developers.google.com/gmail/api/auth/web-server

---

## Support

For issues:
1. Check the troubleshooting section above
2. Review `GMAIL_OAUTH_SETUP.md` for setup steps
3. Run `node utils/gmail_quickstart.js` to test
4. Check logs for error messages

Common fixes solve 90% of issues:
```bash
# Fix most auth issues:
rm secure/gmail_token.json
node utils/gmail_init.js

# Verify credentials file exists:
ls secure/gmail_credentials.json

# Test basic functionality:
node utils/gmail_quickstart.js
```
