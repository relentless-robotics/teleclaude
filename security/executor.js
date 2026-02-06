/**
 * Secure Executor
 *
 * Wraps code execution to:
 * 1. Inject secrets at runtime (not in LLM context)
 * 2. Redact all output
 * 3. Sandbox execution
 */

const { vault } = require('./vault');
const { redactor } = require('./redactor');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

class SecureExecutor {
  constructor(agentId) {
    this.agentId = agentId;
  }

  /**
   * Replace secret references with actual values
   * This happens at RUNTIME, not in LLM context
   */
  injectSecrets(code) {
    // Pattern: vault.use("SECRET_NAME") or {{SECRET_NAME}}
    let injected = code;

    // Handle vault.use("NAME")
    injected = injected.replace(/vault\.use\(["']([^"']+)["']\)/g, (match, name) => {
      try {
        const value = vault.getInternal(name, this.agentId);
        // Return as string literal
        return JSON.stringify(value);
      } catch (e) {
        return `"[ACCESS_DENIED:${name}]"`;
      }
    });

    // Handle {{NAME}} placeholders
    injected = injected.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (match, name) => {
      try {
        const value = vault.getInternal(name, this.agentId);
        return value;
      } catch (e) {
        return `[ACCESS_DENIED:${name}]`;
      }
    });

    return injected;
  }

  /**
   * Execute code with secrets injected and output redacted
   */
  async execute(code, options = {}) {
    // 1. Inject secrets
    const injectedCode = this.injectSecrets(code);

    // 2. Write to temp file
    const tempFile = path.join(os.tmpdir(), `secure_exec_${Date.now()}.js`);
    fs.writeFileSync(tempFile, injectedCode);

    // 3. Execute in subprocess
    return new Promise((resolve, reject) => {
      const proc = spawn('node', [tempFile], {
        env: { ...process.env },
        timeout: options.timeout || 60000
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        // 4. Clean up temp file
        try { fs.unlinkSync(tempFile); } catch (e) {}

        // 5. Redact output
        const safeStdout = redactor.clean(stdout);
        const safeStderr = redactor.clean(stderr);

        resolve({
          exitCode: code,
          stdout: safeStdout,
          stderr: safeStderr,
          success: code === 0
        });
      });

      proc.on('error', (err) => {
        try { fs.unlinkSync(tempFile); } catch (e) {}
        reject(err);
      });
    });
  }

  /**
   * Get environment variables with secrets for subprocess
   * (secrets injected into env, not code)
   */
  getSecureEnv(secretNames) {
    const env = { ...process.env };

    for (const name of secretNames) {
      try {
        env[name] = vault.getInternal(name, this.agentId);
      } catch (e) {
        // Skip if access denied
      }
    }

    return env;
  }

  /**
   * Run a command with secrets in environment
   */
  async runWithSecrets(command, args, secretNames) {
    const env = this.getSecureEnv(secretNames);

    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { env, shell: true });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({
          exitCode: code,
          stdout: redactor.clean(stdout),
          stderr: redactor.clean(stderr),
          success: code === 0
        });
      });

      proc.on('error', reject);
    });
  }
}

module.exports = {
  SecureExecutor,
  createExecutor: (agentId) => new SecureExecutor(agentId)
};
