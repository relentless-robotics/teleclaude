/**
 * Secure Agent Execution Module
 *
 * CRITICAL: This module ensures LLMs NEVER see actual secrets.
 * Agents can USE secrets (they get injected at runtime), but
 * all output is redacted before returning to LLM context.
 *
 * Architecture:
 * 1. LLM requests agent execution with task description
 * 2. This module loads secrets from vault (LLM never sees them)
 * 3. Secrets injected as environment variables for agent process
 * 4. Agent output is REDACTED before returning to LLM
 * 5. LLM only sees [REDACTED:SECRET_NAME] placeholders
 */

const { spawn } = require('child_process');
const path = require('path');

// Lazy-load to avoid circular deps
let vault = null;
let redactor = null;

function getVault() {
  if (!vault) {
    vault = require('./vault').vault;
  }
  return vault;
}

function getRedactor() {
  if (!redactor) {
    redactor = require('./redactor').redactor;
  }
  return redactor;
}

/**
 * Load all secrets into environment variables format
 * INTERNAL ONLY - never expose to LLM
 */
function _loadSecretsToEnv() {
  const v = getVault();
  const env = { ...process.env };

  // Don't proceed if vault not initialized
  if (!v.masterKey) {
    return env;
  }

  const secrets = v.list();
  for (const secret of secrets) {
    try {
      const value = v.getInternal(secret.name, 'secure_agent_exec');
      // Prefix with VAULT_ so agents know these came from vault
      env[`VAULT_${secret.name}`] = value;
    } catch (e) {
      // Skip inaccessible secrets
    }
  }

  return env;
}

/**
 * Execute an agent with secrets injected, output redacted
 *
 * @param {string} command - Command to run (e.g., 'node', 'python')
 * @param {string[]} args - Command arguments
 * @param {object} options - Execution options
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
async function executeWithSecrets(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    timeout = 300000, // 5 min default
    maxOutputSize = 100000, // 100KB max output
  } = options;

  // Load secrets into env (LLM never sees this)
  const env = _loadSecretsToEnv();

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn(command, args, {
      cwd,
      env,
      shell: true,
      windowsHide: true
    });

    // Timeout handler
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (data) => {
      if (stdout.length < maxOutputSize) {
        stdout += data.toString();
      }
    });

    proc.stderr.on('data', (data) => {
      if (stderr.length < maxOutputSize) {
        stderr += data.toString();
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      // CRITICAL: Redact ALL output before returning to LLM
      const r = getRedactor();
      const redactedStdout = r.clean(stdout);
      const redactedStderr = r.clean(stderr);

      resolve({
        stdout: redactedStdout,
        stderr: redactedStderr,
        exitCode: killed ? -1 : code,
        wasKilled: killed,
        wasRedacted: redactedStdout !== stdout || redactedStderr !== stderr
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Process error: ${err.message}`));
    });
  });
}

/**
 * Execute a Node.js script with secrets
 */
async function executeNodeScript(scriptPath, args = [], options = {}) {
  return executeWithSecrets('node', [scriptPath, ...args], options);
}

/**
 * Execute a Python script with secrets
 */
async function executePythonScript(scriptPath, args = [], options = {}) {
  return executeWithSecrets('python', [scriptPath, ...args], options);
}

/**
 * Get a secret reference for agent instructions
 * This returns the ENV VAR NAME, not the actual value
 * Agent code should read: process.env.VAULT_SECRET_NAME
 */
function getSecretEnvVar(secretName) {
  return `VAULT_${secretName}`;
}

/**
 * Generate agent instructions that explain how to access secrets
 * WITHOUT revealing the actual values
 */
function generateAgentSecretInstructions(secretNames) {
  const instructions = [
    '## Accessing Secrets',
    '',
    'The following secrets are available as environment variables:',
    ''
  ];

  for (const name of secretNames) {
    instructions.push(`- \`process.env.VAULT_${name}\` - Access ${name}`);
  }

  instructions.push('');
  instructions.push('**IMPORTANT:** Never log or output these values directly.');
  instructions.push('They are automatically redacted from all output.');

  return instructions.join('\n');
}

/**
 * Validate that output doesn't contain secrets
 * Returns true if safe, false if secrets detected
 */
function validateOutputSafe(output) {
  const r = getRedactor();
  const result = r.redact(output);
  return !result.wasRedacted;
}

/**
 * Create a safe output message for LLM consumption
 * Ensures no secrets can leak through
 */
function createSafeOutput(result) {
  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    wasKilled: result.wasKilled,
    wasRedacted: result.wasRedacted,
    // These are ALWAYS redacted
    stdout: result.stdout,
    stderr: result.stderr,
    // Warning if secrets were found and redacted
    securityNote: result.wasRedacted
      ? '⚠️ Some output was redacted to protect secrets'
      : null
  };
}

module.exports = {
  executeWithSecrets,
  executeNodeScript,
  executePythonScript,
  getSecretEnvVar,
  generateAgentSecretInstructions,
  validateOutputSafe,
  createSafeOutput,
  // For testing only
  _loadSecretsToEnv
};
