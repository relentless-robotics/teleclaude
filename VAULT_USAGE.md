# Vault Usage Guide

All sensitive credentials have been migrated to an **encrypted vault** using AES-256-GCM encryption.

## Master Key

The vault master key is: **`@2V$ND4*XM`**

Store this key securely. Without it, you cannot access the vault.

---

## Vault Contents

The vault currently stores **20 secrets**:

### Authentication (8)
- `GOOGLE_MASTER_PASSWORD` - Google account master password
- `GITHUB_PASSWORD` - GitHub account password
- `GUMROAD_PASSWORD` - Gumroad account password
- `STRIPE_PASSWORD` - Stripe account password
- `TWITTER_PASSWORD` - Twitter/X account password
- `ALPACA_ACCOUNT_PASSWORD` - Alpaca trading account password
- `JUPITER_DESKTOP_SSH_PASSWORD` - Remote server SSH password
- `NEPTUNE_SSH_PASSWORD` - Windows PC SSH password

### API Keys (9)
- `ALPACA_API_KEY` - Alpaca API key
- `ALPACA_API_SECRET` - Alpaca API secret
- `GITHUB_PAT_AUTOMATION` - GitHub Personal Access Token (current)
- `GITHUB_PAT_OLD` - GitHub Personal Access Token (old)
- `FRED_API_KEY` - FRED API key for economic data
- `STRIPE_LIVE_PUBLISHABLE_KEY` - Stripe live publishable key
- `STRIPE_LIVE_SECRET_KEY` - Stripe live secret key
- `STRIPE_TEST_PUBLISHABLE_KEY` - Stripe test publishable key
- `STRIPE_TEST_SECRET_KEY` - Stripe test secret key

### OAuth (3)
- `GITHUB_OAUTH_CLIENT_ID` - GitHub OAuth app client ID
- `GITHUB_OAUTH_CLIENT_SECRET` - GitHub OAuth app client secret
- `VERCEL_OIDC_TOKEN` - Vercel OIDC token

---

## How to Use the Vault

### 1. In JavaScript/Node.js Code

```javascript
const { init, getInternal } = require('./security/vault');

// Initialize vault with master key
init('@2V$ND4*XM');

// Retrieve a secret
const password = getInternal('GOOGLE_MASTER_PASSWORD');
const apiKey = getInternal('ALPACA_API_KEY');
```

**Example - Alpaca Client:**
```javascript
const { getInternal } = require('../security/vault');

const keyId = getInternal('ALPACA_API_KEY');
const secretKey = getInternal('ALPACA_API_SECRET');

// Use in API calls
const alpaca = new Alpaca({ keyId, secretKey, paper: true });
```

### 2. In Markdown Files (API_KEYS.md, ACCOUNTS.md)

Use the placeholder format:

```markdown
| Password | `[SECURED:GOOGLE_MASTER_PASSWORD]` |
| API Key | `[SECURED:ALPACA_API_KEY]` |
```

This indicates the value is stored in the vault.

### 3. In JSON Config Files

Use the placeholder format:

```json
{
  "password": "[SECURED:JUPITER_DESKTOP_SSH_PASSWORD]"
}
```

Code that reads this config must check for `[SECURED:*]` and fetch from vault.

### 4. In .env Files

Use placeholder text:

```env
GH_TOKEN=SECURED_IN_VAULT
```

Code must load from vault instead of environment variable.

---

## Vault API Reference

### Initialize Vault
```javascript
const { init } = require('./security/vault');
init('@2V$ND4*XM');
```

**Must be called before any vault operations.**

### Get Secret (Internal Use)
```javascript
const { getInternal } = require('./security/vault');
const value = getInternal('SECRET_NAME');
```

**Returns actual secret value.** Use with caution.

### Get Secret Reference (Safe)
```javascript
const { ref } = require('./security/vault');
const placeholder = ref('SECRET_NAME');
// Returns: "[SECURED:SECRET_NAME]"
```

**Returns placeholder, never actual value.** Safe to log/display.

### List All Secrets
```javascript
const { list } = require('./security/vault');
const secrets = list();
// Returns array of { name, ref, metadata }
```

**Never returns actual values.**

### Add New Secret
```javascript
const { set } = require('./security/vault');
set('NEW_SECRET', 'actual_value', {
  source: 'where it came from',
  category: 'api|authentication|oauth'
});
```

### Delete Secret
```javascript
const { delete: deleteSecret } = require('./security/vault');
deleteSecret('SECRET_NAME');
```

---

## Files Updated

The following files now reference the vault instead of hardcoded secrets:

### JavaScript/Node.js
- ✅ `swing_options/alpaca_client.js` - Alpaca API credentials
- ✅ `utils/browser_profiles.js` - Google, GitHub, Gumroad passwords
- ✅ `utils/remote_compute.js` - SSH password for jupiter-desktop

### Markdown
- ✅ `API_KEYS.md` - All API keys and passwords replaced with `[SECURED:NAME]`
- ✅ `ACCOUNTS.md` - All passwords replaced with `[SECURED:NAME]`

### Configuration
- ✅ `config/remote_servers.json` - SSH password replaced with `[SECURED:NAME]`
- ✅ `.env.github` - Token replaced with `SECURED_IN_VAULT`
- ✅ `dashboard-app/.env.local` - Token replaced with `SECURED_IN_VAULT`

---

## Security Features

### Encryption
- **Algorithm:** AES-256-GCM
- **Key derivation:** scrypt (32-byte key from master password)
- **Authentication:** GCM auth tag for tamper detection
- **Storage:** `security/vault.enc` (encrypted file)

### Audit Trail
- All vault access is logged to `security/audit.log`
- Includes: timestamp, action, secret name, agent ID
- Use for security auditing and debugging

### Agent Permissions
- Secrets can be scoped to specific agents
- Use `setPermissions(name, allowedAgents)` to restrict access
- Unauthorized access throws error

---

## Best Practices

### DO:
- ✅ Initialize vault once at app startup
- ✅ Use `getInternal()` only when actually needed
- ✅ Use `ref()` for logging/display
- ✅ Add metadata when storing secrets
- ✅ Check audit log regularly
- ✅ Keep master key secure (password manager)

### DON'T:
- ❌ Log actual secret values
- ❌ Store secrets in code/config (use vault)
- ❌ Share master key publicly
- ❌ Hardcode secrets anymore
- ❌ Commit vault.enc to public repos (already in .gitignore)

---

## Troubleshooting

### "Vault not initialized"
```javascript
const { init } = require('./security/vault');
init('@2V$ND4*XM');
```

### "Secret not found"
```javascript
const { list } = require('./security/vault');
console.log(list()); // Check available secrets
```

### "Unable to authenticate data"
- Master key is incorrect
- Vault file is corrupted
- Solution: Re-run migration script

### Need to Re-migrate
```bash
node security/migrate_to_vault.js
```

---

## Migration Log

Migration was performed on: **2026-02-04**

- Total secrets migrated: 20
- Errors: 0
- Log file: `logs/vault_migration.json`

---

## Environment Variable Support

For compatibility with existing code, you can export vault secrets as environment variables:

```javascript
const { init, getInternal } = require('./security/vault');

// Initialize vault
init('@2V$ND4*XM');

// Export to environment
process.env.ALPACA_API_KEY = getInternal('ALPACA_API_KEY');
process.env.ALPACA_API_SECRET = getInternal('ALPACA_API_SECRET');
```

**Or create a startup script:**
```javascript
// scripts/init_vault_env.js
const { init, getInternal, list } = require('./security/vault');

init('@2V$ND4*XM');

const secrets = list();
secrets.forEach(({ name }) => {
  try {
    process.env[name] = getInternal(name);
  } catch (error) {
    console.warn(`Could not export ${name}:`, error.message);
  }
});

console.log('✓ Vault secrets exported to environment variables');
```

---

## Vault Status

```
Location: security/vault.enc
Size: ~2KB (encrypted)
Master Key: @2V$ND4*XM
Secrets: 20
Last Updated: 2026-02-04
Status: OPERATIONAL ✅
```

---

For questions or issues, check the audit log at `security/audit.log`.
