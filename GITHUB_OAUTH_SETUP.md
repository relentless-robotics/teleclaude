# GitHub OAuth App Setup for TeleClaude Dashboard

## Status: In Progress

Created: 2026-01-31

## Task Overview

Setting up GitHub OAuth authentication for the TeleClaude Dashboard deployed on Vercel.

## Steps Completed

✅ **Step 1: Created automation script** (`setup_github_oauth.js`)
- Automated browser login to GitHub
- Form filling for OAuth app registration
- Screenshot capture at each step

✅ **Step 2: OAuth App Created on GitHub**
- Application Name: TeleClaude Dashboard
- Homepage URL: https://dashboard-app-black-kappa.vercel.app
- Callback URL: https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github
- Status: **Created** (automation succeeded until credential extraction)

✅ **Step 3: Created Vercel configuration script** (`configure_vercel_only.js`)
- Automated Vercel CLI environment variable setup
- Deployment trigger included

## Steps Remaining

⏳ **Manual step needed:** Extract OAuth credentials
1. Open https://github.com/settings/developers
2. Click on "TeleClaude Dashboard" app
3. Copy the Client ID
4. Generate a new Client Secret
5. Copy the Client Secret (shown only once!)

⏳ **Final step:** Configure Vercel and deploy
```bash
node configure_vercel_only.js <CLIENT_ID> <CLIENT_SECRET>
```

## OAuth App Details

| Field | Value |
|-------|-------|
| Application Name | TeleClaude Dashboard |
| Homepage URL | https://dashboard-app-black-kappa.vercel.app |
| Callback URL | https://dashboard-app-black-kappa.vercel.app/api/auth/callback/github |
| Description | Authentication for TeleClaude Dashboard |
| GitHub Account | relentless-robotics |

## Vercel Environment Variables

These will be set automatically by `configure_vercel_only.js`:

| Variable | Value | Source |
|----------|-------|--------|
| NEXTAUTH_URL | https://dashboard-app-black-kappa.vercel.app | Pre-configured |
| NEXTAUTH_SECRET | hpoTyr7DoFe4XigceonLDse9eJHqiZzPS07nDBCM0TA= | Pre-generated |
| GITHUB_CLIENT_ID | (from GitHub OAuth app) | User provides |
| GITHUB_CLIENT_SECRET | (from GitHub OAuth app) | User provides |

## Files Created

- `setup_github_oauth.js` - Full automation script (had credential extraction issue)
- `setup_github_oauth_manual.js` - Interactive version with manual credential input
- `check_github_oauth.js` - Browser helper to view existing OAuth apps
- `configure_vercel_only.js` - Vercel configuration and deployment script
- `github_oauth_credentials.json` - Saved credentials (will be created)
- `screenshots/oauth/` - Screenshots of the process

## Screenshots

Captured during automation:
- `before_create_*.png` - GitHub OAuth Apps page before creation
- `form_filled_*.png` - Filled OAuth app registration form
- `current_apps_*.png` - Current state of OAuth apps

## Usage After Setup

Once configured and deployed, users can:

1. Visit https://dashboard-app-black-kappa.vercel.app
2. Click "Sign in with GitHub"
3. Authorize the TeleClaude Dashboard app
4. Access the dashboard

## Troubleshooting

### OAuth App Not Found
- Check https://github.com/settings/developers
- Ensure logged in as `relentless-robotics`

### Vercel Env Var Issues
- Check https://vercel.com/riley-andersons-projects-c1704491/dashboard-app/settings/environment-variables
- Manually add missing variables via Vercel dashboard

### Deployment Failures
- Run manually: `cd dashboard-app && vercel --prod`
- Check Vercel deployment logs

## Security Notes

- Client Secret is shown only once after generation
- Credentials saved to `github_oauth_credentials.json` (gitignored)
- Never commit OAuth secrets to public repos
- Rotate secrets if compromised

## References

- GitHub OAuth Apps: https://github.com/settings/developers
- Vercel Dashboard: https://vercel.com/riley-andersons-projects-c1704491/dashboard-app
- NextAuth.js GitHub Provider: https://next-auth.js.org/providers/github

---

**Last Updated:** 2026-01-31
**Status:** Awaiting user to provide OAuth credentials
