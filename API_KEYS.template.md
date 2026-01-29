# API_KEYS.md - Stored API Keys

This file contains API keys that have been manually obtained (via browser login, etc.) and need to be stored for later use.

**Security Note:** This file contains sensitive credentials. Do not share or commit to public repositories.

---

## Setup Instructions

1. Copy this template: `cp API_KEYS.template.md API_KEYS.md`
2. Fill in your actual API keys in `API_KEYS.md`
3. The `API_KEYS.md` file is gitignored and will not be committed

---

## OpenAI Platform

| Field | Value |
|-------|-------|
| Service | OpenAI Platform |
| Key Name | your-key-name |
| API Key | `sk-your-openai-api-key-here` |
| Created | YYYY-MM-DD |

**How to get:** Visit https://platform.openai.com/api-keys and create a new secret key.

---

## Google AI Studio (Gemini API)

| Field | Value |
|-------|-------|
| Service | Google AI Studio (Gemini API) |
| Key Name | your-key-name |
| API Key | `AIzaSy-your-gemini-api-key-here` |
| Project | your-project-name |
| Project Number | your-project-number |
| Created | YYYY-MM-DD |
| Quota Tier | Tier 1 |

**How to get:** Visit https://aistudio.google.com/apikey and create a new API key.

---

## xAI Cloud Console (Grok API)

| Field | Value |
|-------|-------|
| Service | xAI Cloud Console (Grok API) |
| Key Name | your-key-name |
| API Key | `xai-your-xai-api-key-here` |
| API Endpoint | https://api.x.ai/v1/chat/completions |
| Permissions | All endpoints, All models |
| Created | YYYY-MM-DD |
| Console URL | https://console.x.ai |

**How to get:** Visit https://console.x.ai and create a new API key.

---

## Anthropic Claude Developer Platform

| Field | Value |
|-------|-------|
| Service | Anthropic Claude Developer Platform |
| Key Name | your-key-name |
| API Key | `sk-ant-api03-your-anthropic-api-key-here` |
| API Endpoint | https://api.anthropic.com/v1/messages |
| Workspace | Default |
| Organization | your-org-name |
| Created | YYYY-MM-DD |
| Console URL | https://console.anthropic.com |

**How to get:** Visit https://console.anthropic.com/settings/keys and create a new API key.

---

## Resend (Email API)

| Field | Value |
|-------|-------|
| Service | Resend (Email API) |
| Key Name | your-key-name |
| API Key | `re_your-resend-api-key-here` |
| API Endpoint | https://api.resend.com/emails |
| Permission | Full access |
| Domain | All Domains |
| Created | YYYY-MM-DD |
| Console URL | https://resend.com |

**How to get:** Visit https://resend.com/api-keys and create a new API key.

---

## Google Calendar API (OAuth 2.0)

| Field | Value |
|-------|-------|
| Service | Google Calendar API |
| Client Name | your-client-name |
| Client ID | `your-client-id.apps.googleusercontent.com` |
| Client Secret | `GOCSPX-your-client-secret-here` |
| Project | your-project-name |
| Application Type | Desktop app |
| Credentials File | `/path/to/your/google-calendar-credentials.json` |
| Token File | `/path/to/your/google-calendar/token.json` |
| MCP Server | `/path/to/your/google-calendar/dist/index.js` |
| Created | YYYY-MM-DD |
| Console URL | https://console.cloud.google.com/apis/credentials |

**How to get:**
1. Go to https://console.cloud.google.com/apis/credentials
2. Create OAuth 2.0 Client ID (Desktop app type)
3. Download the credentials JSON file

**Note:** This is an OAuth 2.0 credential that requires user consent. The first time it's used, it will open a browser for authentication.

---

## Gmail API (OAuth 2.0)

| Field | Value |
|-------|-------|
| Service | Gmail API |
| Client Name | your-client-name |
| Client ID | `your-client-id.apps.googleusercontent.com` |
| Client Secret | `GOCSPX-your-client-secret-here` |
| Project | your-project-name |
| Application Type | Desktop app |
| Credentials File | `/path/to/your/google-credentials.json` |
| Token File | `/path/to/your/gmail/token.json` |
| MCP Server | `/path/to/your/gmail/dist/index.js` |
| OAuth Port | 9848 |
| Scopes | gmail.readonly, gmail.send, gmail.modify |
| Created | YYYY-MM-DD |
| Console URL | https://console.cloud.google.com/apis/credentials |

**How to get:** Same as Google Calendar API - can use the same OAuth client with different scopes.

---

## Cloudflare Pages (Wrangler CLI)

| Field | Value |
|-------|-------|
| Service | Cloudflare Pages / Workers |
| Key Name | your-key-name |
| API Token | `your-cloudflare-api-token-here` |
| Account ID | `your-cloudflare-account-id` |
| Subdomain | `your-subdomain.workers.dev` |
| Permissions | Cloudflare Pages:Edit, Workers Scripts:Edit, etc. |
| Dashboard URL | https://dash.cloudflare.com |
| Created | YYYY-MM-DD |

**How to get:**
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Create a custom token with required permissions

**Deployment Commands:**
```bash
# Set environment variable for Wrangler
export CLOUDFLARE_API_TOKEN="your-api-token"

# Deploy static site
wrangler pages deploy ./dist --project-name=my-project
```

---

## Alpaca Trading API (Paper)

| Field | Value |
|-------|-------|
| Service | Alpaca Paper Trading |
| API Key | `your-alpaca-paper-api-key` |
| API Secret | `your-alpaca-paper-api-secret` |
| API URL | https://paper-api.alpaca.markets |

**How to get:** Visit https://alpaca.markets and create paper trading API keys.

---

## Alpaca Trading API (LIVE - REAL MONEY)

| Field | Value |
|-------|-------|
| Service | Alpaca LIVE Trading |
| API Key | `your-alpaca-live-api-key` |
| API Secret | `your-alpaca-live-api-secret` |
| API URL | https://api.alpaca.markets |

**WARNING:** This is for LIVE trading with REAL MONEY.

---

## Stripe (LIVE)

| Field | Value |
|-------|-------|
| Service | Stripe LIVE |
| Secret Key | `sk_live_your-stripe-secret-key` |
| Public Key | `pk_live_your-stripe-public-key` |

**WARNING:** These are LIVE keys for REAL payments.

**How to get:** Visit https://dashboard.stripe.com/apikeys

---

## Twitter/X API

| Field | Value |
|-------|-------|
| Service | Twitter/X API |
| API Key | `your-twitter-api-key` |
| API Secret Key | `your-twitter-api-secret` |
| Access Token | `your-twitter-access-token` |
| Access Token Secret | `your-twitter-access-token-secret` |
| Bearer Token | `your-twitter-bearer-token` |
| Client ID | `your-twitter-client-id` |
| Client Secret | `your-twitter-client-secret` |

**How to get:** Visit https://developer.twitter.com/en/portal/dashboard

---

## Financial Modeling Prep (FMP)

| Field | Value |
|-------|-------|
| Service | Financial Modeling Prep |
| API Key | `your-fmp-api-key` |

**How to get:** Visit https://financialmodelingprep.com/developer/docs

---

## Gumroad

| Field | Value |
|-------|-------|
| Service | Gumroad |
| Access Token | `your-gumroad-access-token` |
| App ID | `your-gumroad-app-id` |
| App Secret | `your-gumroad-app-secret` |
| Redirect URI | http://localhost:9742/callback |

**How to get:** Visit https://gumroad.com/settings/advanced#application-form

---

## Telegram Bot

| Field | Value |
|-------|-------|
| Service | Telegram Bot API |
| Bot Token | `your-telegram-bot-token` |
| Allowed User IDs | your-telegram-user-id |

**How to get:**
1. Message @BotFather on Telegram
2. Send /newbot and follow prompts
3. Get your user ID from @userinfobot

---

*Add new keys in the same format above.*
