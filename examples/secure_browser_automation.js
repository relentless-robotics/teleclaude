/**
 * Secure Browser Automation Example
 *
 * Demonstrates how to use the security module with browser automation
 * to prevent LLMs from seeing login credentials.
 */

const security = require('../security');
const { chromium } = require('playwright');

async function secureBrowserAutomation() {
  console.log('=== Secure Browser Automation Example ===\n');

  // 1. Initialize security vault
  console.log('Step 1: Initialize vault');
  process.env.VAULT_MASTER_KEY = 'demo-password-123';
  security.initVault();
  console.log('✓ Vault initialized\n');

  // 2. Store credentials (normally done during migration)
  console.log('Step 2: Store credentials');
  security.setSecret('GITHUB_EMAIL', 'user@example.com', {
    service: 'GitHub',
    purpose: 'Login automation'
  });
  security.setSecret('GITHUB_PASSWORD', 'demo_password_123', {
    service: 'GitHub',
    purpose: 'Login automation'
  });
  console.log('✓ Credentials stored in vault\n');

  // 3. LLM generates code (only sees references)
  console.log('Step 3: LLM generates automation code');
  console.log('LLM sees these references:');
  const emailRef = security.getSecretRef('GITHUB_EMAIL');
  const passwordRef = security.getSecretRef('GITHUB_PASSWORD');
  console.log(`  Email: ${emailRef}`);
  console.log(`  Password: ${passwordRef}`);
  console.log('');

  // This is what the LLM generates (using vault.use() placeholders)
  const llmGeneratedCode = `
const { chromium } = require('playwright');

async function loginToGitHub() {
  // LLM only knows about vault.use() - actual values injected at runtime
  const email = vault.use("GITHUB_EMAIL");
  const password = vault.use("GITHUB_PASSWORD");

  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log("Navigating to GitHub login...");
  await page.goto('https://github.com/login');

  console.log("Entering credentials...");
  await page.fill('#login_field', email);
  await page.fill('#password', password);

  console.log("Login form filled (credentials redacted in output)");
  await browser.close();
  console.log("Browser closed");
}

loginToGitHub();
  `;

  console.log('LLM generated code (with vault.use() placeholders):');
  console.log(llmGeneratedCode);
  console.log('');

  // 4. Execute securely
  console.log('Step 4: Execute with secure executor');
  const executor = security.createExecutor('browser-agent');
  const result = await executor.execute(llmGeneratedCode);

  console.log('Execution result:');
  console.log('  Exit code:', result.exitCode);
  console.log('  Success:', result.success);
  console.log('  Output (auto-redacted):');
  console.log('  ' + result.stdout.split('\n').join('\n  '));
  console.log('');

  // 5. Show audit trail
  console.log('Step 5: Security audit trail');
  const auditLog = security.getAuditLog(5);
  console.log('Recent access events:');
  auditLog.forEach(entry => {
    console.log(`  [${entry.action}] ${entry.secretName} by ${entry.agentId}`);
  });
  console.log('');

  console.log('=== Key Security Features Demonstrated ===');
  console.log('✓ LLM never saw actual email or password');
  console.log('✓ Code used vault.use() placeholders');
  console.log('✓ Secrets injected at runtime in subprocess');
  console.log('✓ Output auto-redacted before returning');
  console.log('✓ All access logged to audit trail');
  console.log('✓ Browser automation worked normally');
}

// Alternative: Using template placeholders instead of vault.use()
async function templatePlaceholderExample() {
  console.log('\n=== Template Placeholder Example ===\n');

  security.initVault();

  // LLM generates config with {{PLACEHOLDERS}}
  const configCode = `
const fs = require('fs');

const config = {
  github: {
    email: '{{GITHUB_EMAIL}}',
    password: '{{GITHUB_PASSWORD}}',
    api: 'https://api.github.com'
  }
};

console.log("Config generated (credentials redacted):");
console.log(JSON.stringify(config, null, 2));

fs.writeFileSync('/tmp/config.json', JSON.stringify(config));
console.log("Config saved to file");
  `;

  const executor = security.createExecutor('config-agent');
  const result = await executor.execute(configCode);

  console.log('Output (auto-redacted):');
  console.log(result.stdout);
}

// Run examples
if (require.main === module) {
  secureBrowserAutomation()
    .then(() => templatePlaceholderExample())
    .catch(console.error);
}

module.exports = { secureBrowserAutomation, templatePlaceholderExample };
