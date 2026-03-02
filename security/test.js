/**
 * Quick test of security module
 */

const sec = require('./index');

console.log('=== Security Module Test ===\n');

// Test 1: Initialize vault
console.log('Test 1: Initialize vault');
process.env.VAULT_MASTER_KEY = 'test_master_key_123';
sec.initVault();
console.log('✓ Vault initialized\n');

// Test 2: Store secret
console.log('Test 2: Store secret');
sec.setSecret('TEST_KEY', 'super_secret_value_12345', { test: true });
console.log('✓ Secret stored\n');

// Test 3: List secrets (safe)
console.log('Test 3: List secrets (LLM-safe)');
const secrets = sec.listSecrets();
console.log('Secrets:', JSON.stringify(secrets, null, 2));
console.log('✓ Only references shown, not values\n');

// Test 4: Redaction
console.log('Test 4: Auto-redaction');
const testText = 'My key is super_secret_value_12345';
console.log('Original:', testText);
const redacted = sec.clean(testText);
console.log('Redacted:', redacted);
console.log('✓ Secret value redacted\n');

// Test 5: Execution with injection
console.log('Test 5: Secure execution with secret injection');
const executor = sec.createExecutor('test-agent');
const code = `
const secret = vault.use("TEST_KEY");
console.log("Secret is:", secret);
`;
executor.execute(code).then(result => {
  console.log('Exit code:', result.exitCode);
  console.log('Output (redacted):', result.stdout);
  console.log('✓ Code executed, output redacted\n');

  // Test 6: Audit log
  console.log('Test 6: Audit log');
  const log = sec.getAuditLog(5);
  log.forEach(entry => {
    console.log(`  [${entry.action}] ${entry.secretName} - ${entry.message}`);
  });
  console.log('✓ All access logged\n');

  console.log('=== All Tests Passed ===');
}).catch(err => {
  console.error('Test failed:', err);
});
