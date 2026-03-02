/**
 * Output Filter Module
 *
 * CRITICAL SECURITY: This module MUST be used to filter ALL output
 * before it reaches LLM context. Prevents secret leakage via:
 * - Agent output
 * - File reads
 * - Command execution results
 * - Error messages
 */

const { redactor } = require('./redactor');

// Additional patterns for things that look like secrets
const ADDITIONAL_PATTERNS = [
  // Master key pattern (if someone tries to output it)
  { name: 'vault_key', regex: /@2V\$ND4\*XM/g, replacement: '[REDACTED:VAULT_KEY]' },

  // Generic password patterns
  { name: 'password_value', regex: /['"]?password['"]?\s*[:=]\s*['"]([^'"]{6,})['"]?/gi, replacement: 'password=[REDACTED]' },

  // Environment variable dumps
  { name: 'env_dump', regex: /VAULT_[A-Z_]+=([^\s]+)/g, replacement: 'VAULT_***=[REDACTED]' },

  // Base64 encoded secrets (common leak vector)
  { name: 'base64_secret', regex: /(?:secret|password|key|token).*?([A-Za-z0-9+/]{20,}={0,2})/gi, replacement: '$1[REDACTED:BASE64]' },

  // Connection strings
  { name: 'connection_string', regex: /(?:mongodb|mysql|postgres|redis):\/\/[^:]+:[^@]+@/gi, replacement: '[REDACTED:CONNECTION_STRING]@' },
];

// Initialize additional patterns
for (const pattern of ADDITIONAL_PATTERNS) {
  redactor.addPattern(pattern.name, pattern.regex, pattern.replacement);
}

/**
 * Filter output for LLM consumption
 * This is the MAIN entry point - use this for all agent output
 */
function filterForLLM(output) {
  if (!output) return output;
  if (typeof output !== 'string') {
    output = JSON.stringify(output);
  }

  const result = redactor.redact(output);

  return {
    safe: result.text,
    wasFiltered: result.wasRedacted,
    filterCount: result.redactions.length,
    // Don't include what was filtered (that's sensitive info!)
  };
}

/**
 * Filter and return just the safe text
 */
function clean(output) {
  return filterForLLM(output).safe;
}

/**
 * Check if output contains secrets (without revealing what)
 */
function containsSecrets(output) {
  return filterForLLM(output).wasFiltered;
}

/**
 * Wrap a function to auto-filter its output
 */
function wrapWithFilter(fn) {
  return async function(...args) {
    const result = await fn(...args);
    if (typeof result === 'string') {
      return clean(result);
    }
    if (result && typeof result === 'object') {
      // Filter all string properties
      const filtered = {};
      for (const [key, value] of Object.entries(result)) {
        filtered[key] = typeof value === 'string' ? clean(value) : value;
      }
      return filtered;
    }
    return result;
  };
}

/**
 * Create a safe console logger
 */
const safeConsole = {
  log: (...args) => console.log(...args.map(a => typeof a === 'string' ? clean(a) : a)),
  error: (...args) => console.error(...args.map(a => typeof a === 'string' ? clean(a) : a)),
  warn: (...args) => console.warn(...args.map(a => typeof a === 'string' ? clean(a) : a)),
  info: (...args) => console.info(...args.map(a => typeof a === 'string' ? clean(a) : a)),
};

module.exports = {
  filterForLLM,
  clean,
  containsSecrets,
  wrapWithFilter,
  safeConsole,
  // Re-export redactor methods
  addPattern: (name, regex, replacement) => redactor.addPattern(name, regex, replacement),
};
