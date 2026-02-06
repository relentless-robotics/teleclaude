# Security Module - Encrypted Vault & Auto-Redaction

**CRITICAL INFRASTRUCTURE**: This module prevents LLMs from seeing or leaking sensitive data.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    LLM Agent Layer                      │
│  - Only sees references: [SECURED:API_KEY]             │
│  - Generates code with vault.use("SECRET_NAME")        │
│  - Never sees actual secret values                     │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│                  Secure Executor                        │
│  - Injects secrets at runtime                          │
│  - Executes in sandboxed subprocess                    │
│  - Redacts all output before returning                 │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│                  Encrypted Vault                        │
│  - AES-256-GCM encryption                              │
│  - Secrets stored encrypted on disk                    │
│  - Agent-scoped permissions                            │
│  - Full audit logging                                  │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Initialize the Vault

```javascript
const security = require('./security');

// Set master password (environment variable recommended)
process.env.VAULT_MASTER_KEY = 'your-strong-master-password';

// Initialize vault
security.initVault();
```

### 2. Store Secrets

```javascript
// Store a secret
security.setSecret('OPENAI_API_KEY', 'sk-proj-abc123...', {
  service: 'OpenAI',
  created: '2026-02-04'
});

// List all secrets (safe - shows refs only)
const secrets = security.listSecrets();
console.log(secrets);
// [
//   {
//     name: 'OPENAI_API_KEY',
//     ref: '[SECURED:OPENAI_API_KEY]',
//     metadata: { service: 'OpenAI', created: '2026-02-04' }
//   }
// ]
```

### 3. LLM-Safe References

```javascript
// In LLM context, show only the reference
const ref = security.getSecretRef('OPENAI_API_KEY');
console.log(ref); // [SECURED:OPENAI_API_KEY]

// LLM generates code like this:
const code = `
const apiKey = vault.use("OPENAI_API_KEY");
console.log("Using key:", apiKey);
`;

// At runtime, the executor injects the actual value
const executor = security.createExecutor('my-agent');
const result = await executor.execute(code);
console.log(result.stdout); // "Using key: [REDACTED:OPENAI_API_KEY]"
```

### 4. Auto-Redaction

```javascript
// Any output containing secrets is automatically redacted
const text = 'My API key is sk-proj-abc123... and password is secret123';
const cleaned = security.clean(text);
console.log(cleaned);
// "My API key is [REDACTED:API_KEY] and password is [REDACTED]"

// Safe logger wrapper
const safeLogger = security.createSafeLogger(console);
safeLogger.log('My secret is sk-proj-abc123');
// Logs: "My secret is [REDACTED:API_KEY]"
```

## Migration from Existing Files

Migrate secrets from API_KEYS.md and ACCOUNTS.md:

```bash
# Migrate all secrets
node security/migrate_secrets.js "your-master-password"

# Migrate only API keys
node security/migrate_secrets.js "your-master-password" api

# Migrate only account passwords
node security/migrate_secrets.js "your-master-password" accounts
```

After migration, you can safely remove actual secret values from the markdown files and replace them with placeholders.

## Core Components

### 1. Vault (`vault.js`)

**Encrypted secret storage with agent-scoped permissions.**

```javascript
const { vault, init, set, getSecretRef } = require('./security/vault');

// Initialize
init('master-password');

// Store secret
set('GITHUB_TOKEN', 'ghp_abc123...', {
  service: 'GitHub',
  allowedAgents: ['github-agent', 'orchestrator']
});

// Get reference (safe for LLM)
const ref = getSecretRef('GITHUB_TOKEN'); // [SECURED:GITHUB_TOKEN]

// Get actual value (INTERNAL ONLY)
const value = vault.getInternal('GITHUB_TOKEN', 'github-agent');

// View audit log
const log = vault.getAuditLog(50);
```

**Encryption:**
- Algorithm: AES-256-GCM
- Key derivation: scrypt (32 bytes)
- Storage: `security/vault.enc` (encrypted)
- Audit: `security/audit.log` (plaintext log of access)

**Agent Permissions:**

```javascript
// Restrict a secret to specific agents
vault.setPermissions('PRODUCTION_DB_PASSWORD', ['db-agent', 'backup-agent']);

// Unauthorized access throws error
vault.getInternal('PRODUCTION_DB_PASSWORD', 'random-agent');
// Error: Agent random-agent not permitted to access PRODUCTION_DB_PASSWORD
```

### 2. Redactor (`redactor.js`)

**Auto-redaction engine that scrubs sensitive data from output.**

```javascript
const { redactor, redact, clean } = require('./security/redactor');

// Redact text (detailed)
const result = redact('My password is secret123 and API key is sk-abc...');
console.log(result);
// {
//   text: "My password is [REDACTED] and API key is [REDACTED:API_KEY]",
//   redactions: [
//     { pattern: 'password', count: 1 },
//     { pattern: 'api_key', count: 1 }
//   ],
//   wasRedacted: true
// }

// Redact text (simple)
const cleaned = clean('My password is secret123');
console.log(cleaned); // "My password is [REDACTED]"

// Add custom pattern
redactor.addPattern('ssn', /\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED:SSN]');
```

**Built-in Patterns:**
- API keys (OpenAI, AWS, etc.)
- Bearer tokens
- Passwords
- Private keys (PEM format)
- JWT tokens
- GitHub tokens
- Slack tokens
- Credit card numbers
- Email/password combos

**Vault Integration:**
The redactor automatically loads all secrets from the vault and creates redaction patterns for them.

### 3. Executor (`executor.js`)

**Secure execution wrapper with runtime secret injection.**

```javascript
const { createExecutor } = require('./security/executor');

const executor = createExecutor('my-agent');

// Code with secret references
const code = `
const apiKey = vault.use("OPENAI_API_KEY");
const response = await fetch('https://api.openai.com', {
  headers: { 'Authorization': 'Bearer ' + apiKey }
});
console.log('Response:', response);
`;

// Execute with secrets injected
const result = await executor.execute(code);
console.log(result.stdout); // Output is auto-redacted
console.log(result.success); // true/false
console.log(result.exitCode); // 0 on success
```

**Secret Injection Syntax:**

1. **Function call style:**
   ```javascript
   const key = vault.use("SECRET_NAME");
   ```
   At runtime, replaced with: `const key = "actual-secret-value";`

2. **Template placeholder style:**
   ```javascript
   const config = {
     apiKey: '{{OPENAI_API_KEY}}',
     password: '{{DB_PASSWORD}}'
   };
   ```
   At runtime: `apiKey: 'actual-key', password: 'actual-password'`

**Environment Variable Injection:**

```javascript
// Run command with secrets in environment
const result = await executor.runWithSecrets(
  'python',
  ['script.py'],
  ['OPENAI_API_KEY', 'DATABASE_URL']
);
// Secrets injected as env vars, output redacted
```

## Security Guarantees

### 1. LLMs Never See Secrets

- LLM context only contains references: `[SECURED:NAME]`
- Code generation uses placeholders: `vault.use("NAME")`
- Actual values injected at runtime AFTER LLM generates code

### 2. Encrypted at Rest

- All secrets encrypted with AES-256-GCM
- Master key derived from password using scrypt
- Vault file: `security/vault.enc` (safe to commit if needed)

### 3. Auto-Redaction

- All output automatically scrubbed before returning to LLM
- 10+ built-in patterns for common secrets
- Vault secrets automatically included in redaction patterns

### 4. Agent-Scoped Access

- Secrets can be restricted to specific agents
- Unauthorized access is logged and blocked
- Principle of least privilege

### 5. Audit Trail

- All access logged to `security/audit.log`
- Timestamped with agent ID and action
- Searchable for security review

## Usage Patterns

### Pattern 1: Browser Automation with Credentials

```javascript
const { createExecutor } = require('./security');
const executor = createExecutor('browser-agent');

// LLM generates this code (only sees reference)
const browserCode = `
const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://github.com/login');
await page.fill('#login_field', vault.use("GITHUB_EMAIL"));
await page.fill('#password', vault.use("GITHUB_PASSWORD"));
await page.click('[type="submit"]');
`;

// Executor injects secrets and runs
const result = await executor.execute(browserCode);
console.log(result.stdout); // Auto-redacted
```

### Pattern 2: API Calls

```javascript
// LLM generates
const apiCode = `
const apiKey = vault.use("OPENAI_API_KEY");
const response = await fetch('https://api.openai.com/v1/models', {
  headers: { 'Authorization': 'Bearer ' + apiKey }
});
const data = await response.json();
console.log(JSON.stringify(data));
`;

const result = await executor.execute(apiCode);
// Output redacted, API key never exposed
```

### Pattern 3: Configuration Files

```javascript
// LLM generates config template
const configCode = `
const fs = require('fs');
const config = {
  database: {
    host: 'localhost',
    password: '{{DB_PASSWORD}}'
  },
  api: {
    key: '{{OPENAI_API_KEY}}'
  }
};
fs.writeFileSync('config.json', JSON.stringify(config));
`;

// Executor injects secrets into {{PLACEHOLDERS}}
const result = await executor.execute(configCode);
// config.json written with actual values
```

### Pattern 4: Safe Logging

```javascript
const { createSafeLogger } = require('./security');

// Wrap any logger
const logger = createSafeLogger(console);

// Log safely - secrets auto-redacted
logger.log('API key:', process.env.OPENAI_API_KEY);
// Logs: "API key: [REDACTED:API_KEY]"

logger.error('Auth failed with password:', userPassword);
// Logs: "Auth failed with password: [REDACTED]"
```

## Advanced Features

### Custom Redaction Patterns

```javascript
const { addRedactionPattern } = require('./security');

// Add pattern for SSN
addRedactionPattern('ssn', /\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED:SSN]');

// Add pattern for internal IDs
addRedactionPattern('internal_id', /ID-[A-Z0-9]{10}/g, '[REDACTED:INTERNAL_ID]');
```

### Audit Log Analysis

```javascript
const { getAuditLog } = require('./security');

// Get recent access
const log = getAuditLog(100);

// Find all access by agent
const agentAccess = log.filter(e => e.agentId === 'github-agent');

// Find failed access attempts
const failures = log.filter(e => e.action === 'GET_FAILED' || e.action === 'GET_DENIED');

console.log('Security events:', failures);
```

### Permission Management

```javascript
const { setSecretPermissions } = require('./security');

// Restrict critical secrets
setSecretPermissions('PRODUCTION_DB_PASSWORD', ['db-admin-agent']);
setSecretPermissions('AWS_SECRET_KEY', ['aws-deployment-agent', 'orchestrator']);

// Public secrets (all agents)
setSecretPermissions('PUBLIC_API_ENDPOINT', undefined);
```

## Best Practices

### 1. Use Strong Master Password

```bash
# Set as environment variable (recommended)
export VAULT_MASTER_KEY="$(openssl rand -base64 32)"

# Or use a strong passphrase
export VAULT_MASTER_KEY="correct-horse-battery-staple-teleclaude-2026"
```

### 2. Initialize Vault Once Per Session

```javascript
// In main entry point
const security = require('./security');
security.initVault(); // Loads encrypted vault

// All agents/modules can now use it
```

### 3. Always Use References in LLM Context

```javascript
// WRONG - exposes secret to LLM
const prompt = `Use this API key: ${process.env.OPENAI_API_KEY}`;

// CORRECT - only shows reference
const ref = security.getSecretRef('OPENAI_API_KEY');
const prompt = `Use this API key: ${ref}`;
// LLM sees: "Use this API key: [SECURED:OPENAI_API_KEY]"
```

### 4. Scope Agent Permissions

```javascript
// Give each agent only the secrets it needs
security.setSecretPermissions('GITHUB_TOKEN', ['github-agent', 'pr-agent']);
security.setSecretPermissions('SLACK_WEBHOOK', ['notification-agent']);
```

### 5. Review Audit Logs Regularly

```javascript
// Weekly security review
const log = security.getAuditLog(1000);
const denials = log.filter(e => e.action === 'GET_DENIED');
if (denials.length > 0) {
  console.warn('Unauthorized access attempts:', denials);
}
```

### 6. Never Commit Vault Master Key

```bash
# .gitignore
.env
security/vault.enc  # Optional - encrypted so safe to commit
security/audit.log  # Contains access history

# .env (not committed)
VAULT_MASTER_KEY=your-strong-password-here
```

### 7. Rotate Secrets Periodically

```javascript
// Update a secret
security.setSecret('GITHUB_TOKEN', 'new-token-value', {
  rotated: new Date().toISOString(),
  previous: security.getSecretRef('GITHUB_TOKEN')
});
```

## Troubleshooting

### "VAULT_MASTER_KEY environment variable required"

```bash
# Set the environment variable
export VAULT_MASTER_KEY="your-password"

# Or pass directly (less secure)
security.initVault('your-password');
```

### "Failed to load vault"

- Wrong master password
- Corrupted vault file
- Solution: Delete `security/vault.enc` and re-migrate secrets

### "Agent not permitted to access SECRET"

- Secret has restricted permissions
- Check allowed agents: `security.listSecrets()`
- Add agent: `security.setSecretPermissions('SECRET', ['agent-id'])`

### Redaction not working

```javascript
// Rebuild patterns
const { redactor } = require('./security');
redactor.buildPatterns();

// Check what was redacted
const result = redactor.redact('test text');
console.log(result.redactions);
```

## Files

```
security/
├── vault.js              # Encrypted vault core
├── redactor.js           # Auto-redaction engine
├── executor.js           # Secure execution wrapper
├── index.js              # Unified exports
├── migrate_secrets.js    # Import from API_KEYS.md/ACCOUNTS.md
├── README.md             # This file
├── vault.enc             # Encrypted secrets (created on first use)
└── audit.log             # Access audit trail (created on first use)
```

## API Reference

### Vault

- `initVault(masterKey?)` - Initialize vault with master password
- `setSecret(name, value, metadata?)` - Store a secret
- `getSecretRef(name)` - Get LLM-safe reference
- `listSecrets()` - List all secrets (refs only)
- `deleteSecret(name)` - Delete a secret
- `getSecretInternal(name, agentId)` - Get actual value (internal use)
- `getAuditLog(limit?)` - Get audit log entries
- `setSecretPermissions(name, allowedAgents)` - Set agent permissions

### Redactor

- `redact(text)` - Redact and return detailed result
- `clean(text)` - Redact and return clean text
- `addRedactionPattern(name, regex, replacement)` - Add custom pattern
- `createSafeLogger(baseLogger)` - Create auto-redacting logger

### Executor

- `createExecutor(agentId)` - Create executor for agent
- `executor.execute(code, options?)` - Run code with secrets injected
- `executor.injectSecrets(code)` - Replace placeholders (internal)
- `executor.getSecureEnv(secretNames)` - Get env with secrets
- `executor.runWithSecrets(cmd, args, secretNames)` - Run command with secrets

## Security Considerations

1. **Master password security**: Store in environment variable, never in code
2. **Vault file**: Encrypted so safe to commit, but audit.log may contain sensitive metadata
3. **Subprocess isolation**: Secrets only visible in subprocess memory during execution
4. **Redaction coverage**: Review audit logs for any missed patterns
5. **Agent trust**: Only create executors for trusted agent code
6. **Rotation**: Regularly update secrets and master password
7. **Backup**: Keep encrypted backup of vault.enc with master password in secure location

## Example Integration

See `examples/security_example.js` for complete integration example with browser automation, API calls, and safe logging.

## Support

For issues or questions:
1. Check troubleshooting section
2. Review audit logs for access issues
3. Test with simple examples first
4. Verify master password is correct
