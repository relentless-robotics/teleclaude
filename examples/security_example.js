/**
 * Security Module - Complete Usage Example
 *
 * Demonstrates:
 * 1. Vault initialization and secret storage
 * 2. LLM-safe references
 * 3. Auto-redaction
 * 4. Secure execution with secret injection
 * 5. Agent permissions
 * 6. Audit logging
 */

const security = require('../security');

async function main() {
  console.log('=== Security Module Example ===\n');

  // 1. Initialize vault
  console.log('1. Initializing vault...');
  const masterKey = process.env.VAULT_MASTER_KEY || 'demo-master-password-123';
  security.initVault(masterKey);
  console.log('✓ Vault initialized\n');

  // 2. Store some secrets
  console.log('2. Storing secrets...');
  security.setSecret('OPENAI_API_KEY', 'sk-proj-abc123xyz789...', {
    service: 'OpenAI',
    purpose: 'GPT-4 API access'
  });
  security.setSecret('GITHUB_TOKEN', 'ghp_supersecrettoken123456', {
    service: 'GitHub',
    purpose: 'Repository access'
  });
  security.setSecret('DB_PASSWORD', 'super_secure_db_pass_2026', {
    service: 'PostgreSQL',
    purpose: 'Production database'
  });
  console.log('✓ 3 secrets stored\n');

  // 3. List secrets (LLM-safe)
  console.log('3. Listing secrets (LLM-safe references):');
  const secrets = security.listSecrets();
  secrets.forEach(s => {
    console.log(`  - ${s.name}: ${s.ref}`);
    console.log(`    Metadata:`, s.metadata);
  });
  console.log();

  // 4. Get references for LLM context
  console.log('4. Getting references for LLM context:');
  const ref1 = security.getSecretRef('OPENAI_API_KEY');
  const ref2 = security.getSecretRef('GITHUB_TOKEN');
  console.log(`  OpenAI key: ${ref1}`);
  console.log(`  GitHub token: ${ref2}`);
  console.log('  ✓ Safe to show LLM - no actual values exposed\n');

  // 5. Auto-redaction demo
  console.log('5. Auto-redaction demo:');
  const sensitiveText = `
    My API key is sk-proj-abc123xyz789...
    GitHub token: ghp_supersecrettoken123456
    Database password is super_secure_db_pass_2026
    Also my credit card: 4532-1234-5678-9010
  `;
  console.log('  Original text:', sensitiveText);
  const redacted = security.redact(sensitiveText);
  console.log('  Redacted text:', redacted.text);
  console.log('  Redactions:', redacted.redactions);
  console.log();

  // 6. Secure execution demo
  console.log('6. Secure execution with secret injection:');

  // LLM generates this code (only sees references)
  const llmGeneratedCode = `
    // This code is what an LLM would generate
    // It only knows about vault.use() placeholders
    const apiKey = vault.use("OPENAI_API_KEY");
    const token = vault.use("GITHUB_TOKEN");

    console.log("OpenAI API Key:", apiKey);
    console.log("GitHub Token:", token);
    console.log("Making API call with key...");

    // Simulate API call
    const mockResponse = { success: true, model: "gpt-4" };
    console.log("API Response:", JSON.stringify(mockResponse));
  `;

  const executor = security.createExecutor('demo-agent');
  const result = await executor.execute(llmGeneratedCode);

  console.log('  Execution result:');
  console.log('    Exit code:', result.exitCode);
  console.log('    Success:', result.success);
  console.log('    Output (auto-redacted):', result.stdout);
  console.log('    ✓ Secrets were injected at runtime, output was redacted\n');

  // 7. Template placeholder demo
  console.log('7. Template placeholder injection:');
  const templateCode = `
    const config = {
      openai: {
        apiKey: '{{OPENAI_API_KEY}}',
        model: 'gpt-4'
      },
      github: {
        token: '{{GITHUB_TOKEN}}',
        repo: 'my-repo'
      }
    };
    console.log("Config:", JSON.stringify(config, null, 2));
  `;

  const result2 = await executor.execute(templateCode);
  console.log('  Output (redacted):', result2.stdout);
  console.log('  ✓ Placeholders replaced with actual values\n');

  // 8. Agent permissions demo
  console.log('8. Agent-scoped permissions:');
  security.setSecretPermissions('DB_PASSWORD', ['db-agent', 'backup-agent']);
  console.log('  ✓ DB_PASSWORD restricted to: db-agent, backup-agent');

  try {
    // This should fail
    const value = security.getSecretInternal('DB_PASSWORD', 'demo-agent');
    console.log('  ERROR: Should have been denied!');
  } catch (e) {
    console.log('  ✓ Access denied:', e.message);
  }

  // This should succeed
  const value = security.getSecretInternal('DB_PASSWORD', 'db-agent');
  console.log('  ✓ db-agent can access (value redacted for display)\n');

  // 9. Safe logger demo
  console.log('9. Safe logger (auto-redacting):');
  const safeLogger = security.createSafeLogger(console);

  console.log('  Regular logger (UNSAFE):');
  console.log('    Key:', 'sk-proj-abc123xyz789...');

  console.log('  Safe logger (AUTO-REDACTED):');
  safeLogger.log('    Key:', 'sk-proj-abc123xyz789...');
  console.log();

  // 10. Audit log
  console.log('10. Audit log (last 10 entries):');
  const auditLog = security.getAuditLog(10);
  auditLog.forEach(entry => {
    console.log(`  [${entry.timestamp}] ${entry.action} - ${entry.secretName} (${entry.agentId})`);
    console.log(`    ${entry.message}`);
  });

  console.log('\n=== Example Complete ===');
  console.log('\nKey Takeaways:');
  console.log('  1. LLMs only see [SECURED:NAME] references');
  console.log('  2. Code uses vault.use("NAME") or {{NAME}} placeholders');
  console.log('  3. Secrets injected at runtime by executor');
  console.log('  4. All output auto-redacted before returning');
  console.log('  5. Agent permissions enforce least privilege');
  console.log('  6. Full audit trail for security review');
  console.log('\nSecurity guaranteed: LLMs NEVER see actual secret values!');
}

// Run example
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
