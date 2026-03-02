# Security Module - Integration Guide

Quick guide for integrating the security module into teleclaude agents.

## 1. Main Bridge Integration (teleclaude.js)

Add to the top of your main bridge file:

```javascript
const security = require('./security');

// Initialize vault on startup
try {
  security.initVault(); // Reads VAULT_MASTER_KEY from environment
  console.log('✓ Security vault initialized');
} catch (err) {
  console.error('⚠️ Vault not initialized:', err.message);
  console.error('   Set VAULT_MASTER_KEY environment variable');
}

// Create safe logger for main process
const logger = security.createSafeLogger(console);
```

## 2. Background Agent Prompts

When spawning background agents, include security instructions:

```javascript
const agentPrompt = `
Task: ${userRequest}

IMPORTANT SECURITY RULES:
1. For any secret/credential, use vault.use("SECRET_NAME") syntax
2. Never hardcode API keys, passwords, or tokens
3. Available secrets: ${security.listSecrets().map(s => s.ref).join(', ')}

Example:
  const apiKey = vault.use("OPENAI_API_KEY");
  const token = vault.use("GITHUB_TOKEN");

Your code will be executed securely with secrets injected at runtime.
`;

// Spawn agent with secure executor
const executor = security.createExecutor(agentId);
```

## 3. Executing Agent Code

Replace direct code execution with secure execution:

```javascript
// BEFORE (UNSAFE):
const result = eval(llmGeneratedCode);

// AFTER (SECURE):
const executor = security.createExecutor(agentId);
const result = await executor.execute(llmGeneratedCode);
console.log(result.stdout); // Auto-redacted
```

## 4. Browser Automation Integration

For browser automation agents:

```javascript
const agentCode = `
const browser = require('./utils/browser');

async function automateLogin() {
  const session = await browser.launch({ stealth: true });

  await session.goto('https://github.com/login');

  // Use vault references - injected at runtime
  await session.type('#login_field', vault.use("GITHUB_EMAIL"));
  await session.type('#password', vault.use("GITHUB_PASSWORD"));

  await session.click('[type="submit"]', { waitForNavigation: true });
  await session.close();
}

automateLogin();
`;

const executor = security.createExecutor('browser-agent');
const result = await executor.execute(agentCode);
```

## 5. API Call Integration

For API integration agents:

```javascript
const apiAgentCode = `
const fetch = require('node-fetch');

async function callOpenAI(prompt) {
  const apiKey = vault.use("OPENAI_API_KEY");

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }]
    })
  });

  return await response.json();
}

callOpenAI("Hello, world!").then(r => console.log(JSON.stringify(r)));
`;

const executor = security.createExecutor('api-agent');
const result = await executor.execute(apiAgentCode);
// Output auto-redacted - API key never exposed
```

## 6. Discord/Telegram Message Sending

Use safe logger when sending messages:

```javascript
const { clean } = require('./security');

// Clean output before sending to user
const output = await someOperation();
const safeOutput = clean(output);
await send_to_discord(safeOutput);
```

## 7. Migration Workflow

One-time migration from existing credential files:

```bash
# 1. Set master password
export VAULT_MASTER_KEY="your-strong-password-here"

# 2. Migrate secrets
node security/migrate_secrets.js "$VAULT_MASTER_KEY"

# 3. Verify migration
node -e "const s=require('./security');s.initVault();console.log(s.listSecrets())"

# 4. Update API_KEYS.md and ACCOUNTS.md
# Replace actual values with: [MIGRATED_TO_VAULT]
```

## 8. Agent Permission Setup

For sensitive secrets, restrict access:

```javascript
// In setup/initialization script
security.initVault();

// Restrict production database password
security.setSecretPermissions('PRODUCTION_DB_PASSWORD', [
  'db-admin-agent',
  'backup-agent'
]);

// Restrict payment API keys
security.setSecretPermissions('STRIPE_SECRET_KEY', [
  'payment-agent',
  'billing-agent'
]);

// Unrestricted (any agent can access)
security.setSecretPermissions('PUBLIC_API_ENDPOINT', undefined);
```

## 9. Showing Available Secrets to LLM

When LLM needs to know what secrets exist:

```javascript
// Get LLM-safe list
const secretsList = security.listSecrets();

const prompt = `
Available secrets you can use:
${secretsList.map(s => `  - ${s.name}: ${s.ref}`).join('\n')}

Use vault.use("SECRET_NAME") to access them.
`;

// LLM sees references, not values
```

## 10. Error Handling

```javascript
const executor = security.createExecutor('agent-id');

try {
  const result = await executor.execute(code);

  if (!result.success) {
    // Execution failed
    const safeError = security.clean(result.stderr);
    await send_to_discord(`Error: ${safeError}`);
  } else {
    // Success
    const safeOutput = security.clean(result.stdout);
    await send_to_discord(safeOutput);
  }
} catch (err) {
  // Execution crashed
  const safeErr = security.clean(err.message);
  await send_to_discord(`Execution error: ${safeErr}`);
}
```

## 11. Custom Redaction Patterns

For domain-specific sensitive data:

```javascript
const { addRedactionPattern } = require('./security');

// Add pattern for internal user IDs
addRedactionPattern('user_id', /USER-[A-Z0-9]{10}/g, '[REDACTED:USER_ID]');

// Add pattern for session tokens
addRedactionPattern('session', /sess_[a-zA-Z0-9]{32}/g, '[REDACTED:SESSION]');

// Now these will auto-redact in all output
```

## 12. Audit Log Review

Periodic security review:

```javascript
const { getAuditLog } = require('./security');

// Get last 1000 access events
const log = getAuditLog(1000);

// Find denied access attempts
const denials = log.filter(e => e.action === 'GET_DENIED');
if (denials.length > 0) {
  console.warn('⚠️ Unauthorized access attempts:');
  denials.forEach(d => {
    console.log(`  ${d.timestamp}: ${d.agentId} tried to access ${d.secretName}`);
  });
}

// Find unusual access patterns
const accessCount = {};
log.forEach(e => {
  if (e.action === 'GET') {
    accessCount[e.secretName] = (accessCount[e.secretName] || 0) + 1;
  }
});

console.log('Secret access frequency:', accessCount);
```

## 13. Template Placeholder Style

Alternative to vault.use() syntax:

```javascript
const configCode = `
// Config file template
const config = {
  database: {
    host: 'localhost',
    port: 5432,
    password: '{{DB_PASSWORD}}'
  },
  api: {
    openai: {
      key: '{{OPENAI_API_KEY}}'
    },
    github: {
      token: '{{GITHUB_TOKEN}}'
    }
  }
};

console.log(JSON.stringify(config, null, 2));
`;

// Executor replaces {{PLACEHOLDERS}} with actual values
const executor = security.createExecutor('config-agent');
const result = await executor.execute(configCode);
```

## 14. Environment Variable Injection

For running external commands with secrets:

```javascript
const executor = security.createExecutor('script-agent');

// Run Python script with secrets in environment
const result = await executor.runWithSecrets(
  'python',
  ['data_processor.py'],
  ['DATABASE_URL', 'API_KEY', 'S3_SECRET']
);

// Secrets injected as env vars, output redacted
console.log(result.stdout);
```

## 15. Safe Logging Throughout

Wrap all loggers:

```javascript
const { createSafeLogger } = require('./security');

// Wrap console
const logger = createSafeLogger(console);

// Wrap custom logger
const winston = require('winston');
const customLogger = winston.createLogger({...});
const safeCustomLogger = createSafeLogger(customLogger);

// Now all logs auto-redact
logger.log('API key:', process.env.OPENAI_API_KEY);
// Logs: "API key: [REDACTED:API_KEY]"
```

## Complete Example: Secure Agent Flow

```javascript
const security = require('./security');
const { send_to_discord } = require('./mcp/discord');

async function handleUserRequest(userMessage, agentId) {
  // 1. Initialize security
  security.initVault();

  // 2. Get available secrets for LLM context
  const secrets = security.listSecrets();
  const secretRefs = secrets.map(s => `${s.name}: ${s.ref}`).join('\n');

  // 3. Build LLM prompt with references
  const llmPrompt = `
User request: ${userMessage}

Available secrets:
${secretRefs}

Use vault.use("SECRET_NAME") to access secrets in your code.

Generate JavaScript code to complete the task.
  `;

  // 4. LLM generates code (with vault.use() placeholders)
  const llmGeneratedCode = await callLLM(llmPrompt);

  // 5. Create secure executor
  const executor = security.createExecutor(agentId);

  // 6. Execute with secrets injected
  const result = await executor.execute(llmGeneratedCode);

  // 7. Send redacted output to user
  if (result.success) {
    await send_to_discord(`✓ Task complete:\n${result.stdout}`);
  } else {
    await send_to_discord(`✗ Error:\n${result.stderr}`);
  }

  // 8. Review audit log if needed
  const recentAccess = security.getAuditLog(10);
  const deniedAccess = recentAccess.filter(e => e.action === 'GET_DENIED');
  if (deniedAccess.length > 0) {
    console.warn('Permission denied events:', deniedAccess);
  }
}
```

## Checklist for New Agent

- [ ] Initialize vault in agent startup
- [ ] Use `createExecutor(agentId)` for code execution
- [ ] Include vault.use() instructions in LLM prompts
- [ ] Show only secret references in LLM context
- [ ] Redact all output before logging/sending
- [ ] Set agent permissions for sensitive secrets
- [ ] Review audit logs periodically
- [ ] Never hardcode credentials in code
- [ ] Use safe logger for all logging
- [ ] Test with vault.enc deleted (ensure graceful fallback)

## Environment Variables

Required:
```bash
export VAULT_MASTER_KEY="your-strong-password"
```

Optional (if using old credential files):
```bash
# These are deprecated - migrate to vault
# export OPENAI_API_KEY="..."
# export GITHUB_TOKEN="..."
```

## Security Best Practices

1. **Strong master password**: Use 32+ character random password
2. **Never commit master key**: Keep in environment variable only
3. **Regular audits**: Review audit.log weekly
4. **Least privilege**: Restrict agent permissions
5. **Rotate secrets**: Update vault secrets periodically
6. **Test redaction**: Verify output doesn't leak secrets
7. **Backup vault**: Keep encrypted backup with master password in secure location

## Troubleshooting

**Vault not initializing:**
- Ensure VAULT_MASTER_KEY is set
- Check vault.enc file permissions

**Secrets not redacting:**
- Call `redactor.buildPatterns()` after adding secrets
- Check secret value length (must be >4 chars)

**Permission denied:**
- Check agent ID matches allowed agents
- View permissions: `security.listSecrets()`

**Code execution fails:**
- Check vault.use() syntax is correct
- Verify secret exists in vault
- Check executor logs in audit.log

## Support Files

- `security/README.md` - Full documentation
- `security/INTEGRATION_GUIDE.md` - This file
- `examples/security_example.js` - Complete working example
- `security/test.js` - Quick test script
