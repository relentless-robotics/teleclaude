# Gmail OAuth Credentials Setup Guide

## Manual Setup Instructions (5 minutes)

Follow these steps to create OAuth credentials for Gmail API access:

### Step 1: Create a New Google Cloud Project

1. Go to: https://console.cloud.google.com/projectcreate
2. Log in with: **relentlessrobotics@gmail.com**
3. Enter project name: **teleclaude-gmail-oauth**
4. **IMPORTANT:** If you see an "Organization" dropdown, select **"No organization"**
   - This avoids the access boundary policy issue
5. Click **Create**
6. Wait 10-15 seconds for project creation

### Step 2: Enable Gmail API

1. Go to: https://console.cloud.google.com/apis/library/gmail.googleapis.com
2. Make sure your new project is selected (top left dropdown)
3. Click **Enable**
4. Wait for API to be enabled

### Step 3: Configure OAuth Consent Screen

1. Go to: https://console.cloud.google.com/apis/credentials/consent
2. Select **External** user type
3. Click **Create**
4. Fill in the form:
   - **App name:** TeleClaude Gmail Access
   - **User support email:** relentlessrobotics@gmail.com
   - **Developer contact information:** relentlessrobotics@gmail.com
5. Click **Save and Continue** through all 4 steps:
   - Step 1: App information (fill as above)
   - Step 2: Scopes (leave empty for now)
   - Step 3: Test users (leave empty)
   - Step 4: Summary (review and confirm)

### Step 4: Create OAuth Credentials

1. Go to: https://console.cloud.google.com/apis/credentials
2. Click **Create Credentials** (top left)
3. Select **OAuth client ID**
4. Application type: **Desktop app**
5. Name: **TeleClaude Gmail Client**
6. Click **Create**

### Step 5: Copy Credentials

A dialog will appear with your credentials:

1. **Copy the Client ID** (looks like: `123456789-abc...apps.googleusercontent.com`)
2. **Copy the Client Secret** (looks like: `GOCSPX-abc123...`)
3. Click **OK**

### Step 6: Send Credentials to Me

Reply with:
```
Client ID: [paste here]
Client Secret: [paste here]
```

I will then:
- Save them to `./secure/gmail_credentials.json`
- Add them to `./API_KEYS.md`
- Format them correctly for Gmail API authentication

---

## Alternative: If You Get "Access Boundary Policy" Error

If you see an error about "access boundary policy" or "additional access needed":

### Option 1: Request Role (May Not Work)
- Click the "Request role" button for "Project Mover"
- If it requires admin approval and you can't approve it yourself, this won't work

### Option 2: Use Personal Gmail Account
- Create the project under a different Gmail account (not in an organization)
- Use that account's credentials for TeleClaude

### Option 3: Contact Google Workspace Admin
- If relentlessrobotics@gmail.com is part of a Google Workspace organization
- Contact the workspace admin to grant OAuth creation permissions

---

## Troubleshooting

**"Project already exists"**
- Add a number suffix: `teleclaude-gmail-oauth-2`

**"OAuth consent screen not configured"**
- Make sure you completed Step 3 fully

**"Can't create credentials"**
- Verify Gmail API is enabled (Step 2)
- Refresh the page and try again

**"Invalid client"**
- Make sure you selected "Desktop app" type
- Don't select "Web application"

---

## After Setup Complete

Once I have the credentials, I'll create a `gmail_credentials.json` file in this format:

```json
{
  "installed": {
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET",
    "project_id": "teleclaude-gmail-oauth",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "redirect_uris": ["http://localhost", "urn:ietf:wg:oauth:2.0:oob"]
  }
}
```

This file can then be used with Gmail API libraries to authenticate and access Gmail.
