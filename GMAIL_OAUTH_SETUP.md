# Gmail API OAuth Setup Guide

This guide will help you set up Gmail API access with OAuth authentication for TeleClaude.

## Prerequisites

- Google account: relentlessrobotics@gmail.com
- Access to Google Cloud Console

## Step-by-Step Setup

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click "Select a project" dropdown at the top
3. Click "New Project"
4. Enter project name: `TeleClaude Gmail API`
5. Click "Create"
6. Wait for project creation (may take 30-60 seconds)

### 2. Enable Gmail API

1. In the Cloud Console, go to [APIs & Services > Library](https://console.cloud.google.com/apis/library)
2. Make sure "TeleClaude Gmail API" is selected as the project
3. Search for "Gmail API"
4. Click on "Gmail API" from results
5. Click "Enable"
6. Wait for API to be enabled

### 3. Configure OAuth Consent Screen

1. Go to [APIs & Services > OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
2. Select "External" user type
3. Click "Create"
4. Fill in required fields:
   - App name: `TeleClaude Gmail`
   - User support email: `relentlessrobotics@gmail.com`
   - Developer contact email: `relentlessrobotics@gmail.com`
5. Click "Save and Continue"
6. On Scopes page, click "Save and Continue" (we'll add scopes via code)
7. On Test users page, click "Add Users" and add `relentlessrobotics@gmail.com`
8. Click "Save and Continue"
9. Review and click "Back to Dashboard"

### 4. Create OAuth 2.0 Credentials

1. Go to [APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)
2. Click "Create Credentials" > "OAuth client ID"
3. Select Application type: "Desktop app"
4. Name: `TeleClaude Desktop`
5. Click "Create"
6. On the popup, click "Download JSON"
7. Save the downloaded file as:
   ```
   C:\Users\Footb\Documents\Github\teleclaude-main\secure\gmail_credentials.json
   ```

### 5. Initialize OAuth Token

1. Open terminal in the project directory
2. Run the initialization script:
   ```bash
   cd C:\Users\Footb\Documents\Github\teleclaude-main
   node utils/gmail_init.js
   ```
3. A browser window will open automatically
4. Login to relentlessrobotics@gmail.com if not already logged in
5. Click "Allow" to grant permissions
6. Copy the authorization code shown
7. Paste it into the terminal when prompted
8. The script will save the token and test the API

### 6. Verify Setup

If successful, you should see:
```
Gmail API initialized successfully!
Found 5 recent emails:
- [Email subjects listed here]
```

## Files Created

- `C:\Users\Footb\Documents\Github\teleclaude-main\secure\gmail_credentials.json` - OAuth client credentials
- `C:\Users\Footb\Documents\Github\teleclaude-main\secure\gmail_token.json` - Access/refresh tokens (auto-created)

## Using the Gmail API

```javascript
const { GmailAPI } = require('./utils/gmail_api');

async function example() {
  const gmail = new GmailAPI();
  await gmail.initialize();

  // Search emails
  const emails = await gmail.searchEmails('from:noreply@github.com', 10);

  // Get specific email
  const email = await gmail.getMessage('message-id-here');

  // Send email
  await gmail.sendEmail('recipient@example.com', 'Subject', 'Body text');
}
```

## Troubleshooting

**Error: Credentials file not found**
- Make sure you downloaded the JSON and saved it to the correct path
- Check filename is exactly `gmail_credentials.json`

**Error: Invalid grant**
- Delete `secure/gmail_token.json` and run `gmail_init.js` again
- This re-authenticates with fresh credentials

**Browser doesn't open automatically**
- Copy the URL from terminal and open manually
- Complete OAuth flow in browser
- Copy authorization code back to terminal

**403 Access Not Configured**
- Make sure Gmail API is enabled in Cloud Console
- Wait a few minutes after enabling (can take time to propagate)

## Security Notes

- Keep `gmail_credentials.json` and `gmail_token.json` secure
- Never commit these files to public repositories
- They are already in `.gitignore`
- Tokens auto-refresh when expired (no need to re-authenticate)
