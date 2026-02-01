/**
 * Secure Password Manager
 *
 * Features:
 * - Cryptographically secure password generation
 * - AES-256-GCM encrypted storage
 * - Master password protection
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Storage paths
const SECRETS_DIR = path.join(__dirname, '..', 'secrets');
const PASSWORDS_FILE = path.join(SECRETS_DIR, 'passwords.enc');
const SALT_FILE = path.join(SECRETS_DIR, '.salt');

// Ensure secrets directory exists
if (!fs.existsSync(SECRETS_DIR)) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
}

// Character sets for password generation
const CHAR_SETS = {
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  numbers: '0123456789',
  symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
  // Unambiguous characters (no 0/O, 1/l/I)
  unambiguousLower: 'abcdefghjkmnpqrstuvwxyz',
  unambiguousUpper: 'ABCDEFGHJKMNPQRSTUVWXYZ',
  unambiguousNumbers: '23456789'
};

/**
 * Generate a cryptographically secure random password
 * @param {number} length - Password length (default 32)
 * @param {Object} options - Generation options
 * @returns {string} - Generated password
 */
function generatePassword(length = 32, options = {}) {
  const {
    lowercase = true,
    uppercase = true,
    numbers = true,
    symbols = true,
    unambiguous = false,
    excludeChars = ''
  } = options;

  // Build character pool
  let charPool = '';

  if (lowercase) {
    charPool += unambiguous ? CHAR_SETS.unambiguousLower : CHAR_SETS.lowercase;
  }
  if (uppercase) {
    charPool += unambiguous ? CHAR_SETS.unambiguousUpper : CHAR_SETS.uppercase;
  }
  if (numbers) {
    charPool += unambiguous ? CHAR_SETS.unambiguousNumbers : CHAR_SETS.numbers;
  }
  if (symbols) {
    charPool += CHAR_SETS.symbols;
  }

  // Remove excluded characters
  if (excludeChars) {
    for (const char of excludeChars) {
      charPool = charPool.replace(new RegExp(char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
    }
  }

  if (charPool.length === 0) {
    throw new Error('No characters available for password generation');
  }

  // Generate password using crypto.randomBytes
  const password = [];
  const randomBytes = crypto.randomBytes(length * 2); // Extra bytes for better distribution

  for (let i = 0; i < length; i++) {
    // Use two bytes for better distribution over the character pool
    const randomValue = (randomBytes[i * 2] << 8) | randomBytes[i * 2 + 1];
    const index = randomValue % charPool.length;
    password.push(charPool[index]);
  }

  // Ensure at least one character from each required set
  const requiredSets = [];
  if (lowercase) requiredSets.push(unambiguous ? CHAR_SETS.unambiguousLower : CHAR_SETS.lowercase);
  if (uppercase) requiredSets.push(unambiguous ? CHAR_SETS.unambiguousUpper : CHAR_SETS.uppercase);
  if (numbers) requiredSets.push(unambiguous ? CHAR_SETS.unambiguousNumbers : CHAR_SETS.numbers);
  if (symbols) requiredSets.push(CHAR_SETS.symbols);

  // Check and fix if any required set is missing
  for (let i = 0; i < requiredSets.length && i < length; i++) {
    const set = requiredSets[i];
    const hasChar = password.some(c => set.includes(c));

    if (!hasChar) {
      // Replace a random position with a character from the missing set
      const pos = crypto.randomInt(length);
      const charIndex = crypto.randomInt(set.length);
      password[pos] = set[charIndex];
    }
  }

  return password.join('');
}

/**
 * Generate a passphrase (multiple words)
 * @param {number} wordCount - Number of words
 * @param {string} separator - Word separator
 * @returns {string} - Generated passphrase
 */
function generatePassphrase(wordCount = 4, separator = '-') {
  // Simple word list for passphrases
  const words = [
    'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
    'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
    'yankee', 'zulu', 'anchor', 'bridge', 'castle', 'dragon', 'eagle', 'falcon',
    'garden', 'harbor', 'island', 'jungle', 'knight', 'lantern', 'mountain', 'nebula',
    'ocean', 'phoenix', 'quantum', 'rainbow', 'storm', 'thunder', 'universe', 'voyage',
    'wizard', 'xenon', 'yellow', 'zenith', 'cipher', 'binary', 'crypto', 'matrix'
  ];

  const passphrase = [];
  for (let i = 0; i < wordCount; i++) {
    const index = crypto.randomInt(words.length);
    passphrase.push(words[index]);
  }

  // Add a random number at the end for extra entropy
  passphrase.push(crypto.randomInt(100, 999).toString());

  return passphrase.join(separator);
}

/**
 * Derive encryption key from master password
 * @param {string} masterPassword - Master password
 * @returns {Buffer} - Derived key
 */
function deriveKey(masterPassword) {
  // Get or create salt
  let salt;
  if (fs.existsSync(SALT_FILE)) {
    salt = fs.readFileSync(SALT_FILE);
  } else {
    salt = crypto.randomBytes(32);
    fs.writeFileSync(SALT_FILE, salt);
  }

  // Derive key using PBKDF2
  return crypto.pbkdf2Sync(masterPassword, salt, 100000, 32, 'sha256');
}

/**
 * Encrypt data with AES-256-GCM
 * @param {string} data - Data to encrypt
 * @param {Buffer} key - Encryption key
 * @returns {string} - Encrypted data (base64)
 */
function encrypt(data, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(data, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  // Combine IV + authTag + encrypted data
  return Buffer.concat([iv, authTag, Buffer.from(encrypted, 'base64')]).toString('base64');
}

/**
 * Decrypt data with AES-256-GCM
 * @param {string} encryptedData - Encrypted data (base64)
 * @param {Buffer} key - Encryption key
 * @returns {string} - Decrypted data
 */
function decrypt(encryptedData, key) {
  const data = Buffer.from(encryptedData, 'base64');

  const iv = data.slice(0, 16);
  const authTag = data.slice(16, 32);
  const encrypted = data.slice(32);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, null, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Load password database
 * @param {string} masterPassword - Master password
 * @returns {Object} - Password database
 */
function loadDatabase(masterPassword) {
  if (!fs.existsSync(PASSWORDS_FILE)) {
    return {};
  }

  try {
    const encrypted = fs.readFileSync(PASSWORDS_FILE, 'utf8');
    const key = deriveKey(masterPassword);
    const decrypted = decrypt(encrypted, key);
    return JSON.parse(decrypted);
  } catch (error) {
    throw new Error('Failed to decrypt database. Wrong master password?');
  }
}

/**
 * Save password database
 * @param {Object} database - Password database
 * @param {string} masterPassword - Master password
 */
function saveDatabase(database, masterPassword) {
  const key = deriveKey(masterPassword);
  const encrypted = encrypt(JSON.stringify(database, null, 2), key);
  fs.writeFileSync(PASSWORDS_FILE, encrypted);
}

/**
 * Save a password entry
 * @param {string} service - Service name
 * @param {string} username - Username
 * @param {string} password - Password
 * @param {string} masterPassword - Master password
 * @param {Object} metadata - Additional metadata
 */
function savePassword(service, username, password, masterPassword, metadata = {}) {
  const database = loadDatabase(masterPassword);

  database[service] = {
    username,
    password,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    ...metadata
  };

  saveDatabase(database, masterPassword);
  console.log(`Password saved for: ${service}`);
}

/**
 * Get a password entry
 * @param {string} service - Service name
 * @param {string} masterPassword - Master password
 * @returns {Object|null} - Password entry or null
 */
function getPassword(service, masterPassword) {
  const database = loadDatabase(masterPassword);
  return database[service] || null;
}

/**
 * List all services (without passwords)
 * @param {string} masterPassword - Master password
 * @returns {Array} - List of service info
 */
function listServices(masterPassword) {
  const database = loadDatabase(masterPassword);

  return Object.entries(database).map(([service, data]) => ({
    service,
    username: data.username,
    created: data.created,
    updated: data.updated
  }));
}

/**
 * Delete a password entry
 * @param {string} service - Service name
 * @param {string} masterPassword - Master password
 */
function deletePassword(service, masterPassword) {
  const database = loadDatabase(masterPassword);

  if (database[service]) {
    delete database[service];
    saveDatabase(database, masterPassword);
    console.log(`Password deleted for: ${service}`);
    return true;
  }

  return false;
}

/**
 * Check password strength
 * @param {string} password - Password to check
 * @returns {Object} - Strength analysis
 */
function checkStrength(password) {
  const analysis = {
    length: password.length,
    hasLowercase: /[a-z]/.test(password),
    hasUppercase: /[A-Z]/.test(password),
    hasNumbers: /[0-9]/.test(password),
    hasSymbols: /[^a-zA-Z0-9]/.test(password),
    score: 0,
    rating: 'weak'
  };

  // Calculate score
  if (analysis.length >= 8) analysis.score += 1;
  if (analysis.length >= 12) analysis.score += 1;
  if (analysis.length >= 16) analysis.score += 1;
  if (analysis.length >= 24) analysis.score += 1;
  if (analysis.hasLowercase) analysis.score += 1;
  if (analysis.hasUppercase) analysis.score += 1;
  if (analysis.hasNumbers) analysis.score += 1;
  if (analysis.hasSymbols) analysis.score += 1;

  // Determine rating
  if (analysis.score >= 7) analysis.rating = 'very strong';
  else if (analysis.score >= 5) analysis.rating = 'strong';
  else if (analysis.score >= 3) analysis.rating = 'medium';
  else analysis.rating = 'weak';

  return analysis;
}

/**
 * Initialize the password manager with a master password
 * Creates the salt file if it doesn't exist
 * @param {string} masterPassword - Master password to use
 */
function initialize(masterPassword) {
  if (!fs.existsSync(SALT_FILE)) {
    const salt = crypto.randomBytes(32);
    fs.writeFileSync(SALT_FILE, salt);
  }

  if (!fs.existsSync(PASSWORDS_FILE)) {
    saveDatabase({}, masterPassword);
  }

  console.log('Password manager initialized');
}

module.exports = {
  generatePassword,
  generatePassphrase,
  savePassword,
  getPassword,
  listServices,
  deletePassword,
  checkStrength,
  initialize,
  loadDatabase,
  SECRETS_DIR,
  PASSWORDS_FILE
};
