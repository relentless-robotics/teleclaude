/**
 * KeePass Integration Module
 * Manages passwords in KeePass (.kdbx) database as backup storage
 *
 * Usage:
 *   const { KeePassManager } = require('./utils/keepass_manager');
 *   const kp = new KeePassManager('./passwords.kdbx', 'masterPassword');
 *   await kp.open();
 *   await kp.addEntry('GitHub', 'user@email.com', 'password123', 'https://github.com');
 *   await kp.save();
 */

const kdbxweb = require('kdbxweb');
const argon2 = require('argon2');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Configure kdbxweb to use argon2
kdbxweb.CryptoEngine.setArgon2Impl((password, salt, memory, iterations, length, parallelism, type, version) => {
  return argon2.hash(Buffer.from(password), {
    type: type === 0 ? argon2.argon2d : (type === 1 ? argon2.argon2i : argon2.argon2id),
    salt: Buffer.from(salt),
    memoryCost: memory,
    timeCost: iterations,
    parallelism: parallelism,
    hashLength: length,
    version: version,
    raw: true
  });
});

// Default database location
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'secure', 'teleclaude_passwords.kdbx');

class KeePassManager {
  constructor(dbPath = DEFAULT_DB_PATH, masterPassword = null) {
    this.dbPath = dbPath;
    this.masterPassword = masterPassword;
    this.db = null;
    this.credentials = null;
  }

  /**
   * Initialize credentials from master password
   * @param {string} password - Master password
   */
  setPassword(password) {
    this.masterPassword = password;
    this.credentials = new kdbxweb.Credentials(
      kdbxweb.ProtectedValue.fromString(password)
    );
  }

  /**
   * Create a new KeePass database
   * @param {string} password - Master password for the new database
   * @returns {Promise<void>}
   */
  async create(password = null) {
    if (password) {
      this.setPassword(password);
    }

    if (!this.credentials) {
      throw new Error('Master password not set. Call setPassword() first.');
    }

    // Create new database
    this.db = kdbxweb.Kdbx.create(this.credentials, 'TeleClaude Passwords');

    // Create default groups
    const root = this.db.getDefaultGroup();

    const groups = ['Accounts', 'API Keys', 'Services', 'Crypto', 'Other'];
    for (const groupName of groups) {
      this.db.createGroup(root, groupName);
    }

    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });

    // Save the new database
    await this.save();

    console.log(`Created new KeePass database: ${this.dbPath}`);
  }

  /**
   * Open existing KeePass database
   * @param {string} password - Master password (optional if already set)
   * @returns {Promise<void>}
   */
  async open(password = null) {
    if (password) {
      this.setPassword(password);
    }

    if (!this.credentials) {
      throw new Error('Master password not set. Call setPassword() or pass password to open().');
    }

    try {
      const data = await fs.readFile(this.dbPath);
      const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

      this.db = await kdbxweb.Kdbx.load(arrayBuffer, this.credentials);
      console.log(`Opened KeePass database: ${this.dbPath}`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`Database not found: ${this.dbPath}. Use create() to create a new database.`);
      }
      throw error;
    }
  }

  /**
   * Save the database
   * @returns {Promise<void>}
   */
  async save() {
    if (!this.db) {
      throw new Error('No database open. Call open() or create() first.');
    }

    const data = await this.db.save();
    await fs.writeFile(this.dbPath, Buffer.from(data));
    console.log(`Saved KeePass database: ${this.dbPath}`);
  }

  /**
   * Get or create a group by name
   * @param {string} groupName - Name of the group
   * @returns {Object} - KeePass group object
   */
  getGroup(groupName) {
    const root = this.db.getDefaultGroup();

    // Find existing group
    for (const group of root.groups) {
      if (group.name === groupName) {
        return group;
      }
    }

    // Create new group if not found
    return this.db.createGroup(root, groupName);
  }

  /**
   * Add a new entry to the database
   * @param {string} title - Entry title (e.g., "GitHub")
   * @param {string} username - Username or email
   * @param {string} password - Password
   * @param {string} url - URL (optional)
   * @param {string} notes - Additional notes (optional)
   * @param {string} groupName - Group name (default: "Accounts")
   * @returns {Object} - Created entry
   */
  addEntry(title, username, password, url = '', notes = '', groupName = 'Accounts') {
    if (!this.db) {
      throw new Error('No database open. Call open() or create() first.');
    }

    const group = this.getGroup(groupName);
    const entry = this.db.createEntry(group);

    entry.fields.set('Title', title);
    entry.fields.set('UserName', username);
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(password));
    entry.fields.set('URL', url);
    entry.fields.set('Notes', notes);

    entry.times.creationTime = new Date();
    entry.times.lastModTime = new Date();

    return entry;
  }

  /**
   * Add an API key entry
   * @param {string} service - Service name (e.g., "OpenAI")
   * @param {string} keyName - Key name/identifier
   * @param {string} apiKey - The API key
   * @param {string} endpoint - API endpoint (optional)
   * @param {string} notes - Additional notes
   * @returns {Object} - Created entry
   */
  addApiKey(service, keyName, apiKey, endpoint = '', notes = '') {
    const fullNotes = `Key Name: ${keyName}\nEndpoint: ${endpoint}\n\n${notes}`;
    return this.addEntry(service, keyName, apiKey, endpoint, fullNotes, 'API Keys');
  }

  /**
   * Find entries by title
   * @param {string} title - Title to search for (partial match)
   * @returns {Array} - Matching entries
   */
  findByTitle(title) {
    if (!this.db) {
      throw new Error('No database open.');
    }

    const results = [];
    const searchLower = title.toLowerCase();

    const searchGroup = (group) => {
      for (const entry of group.entries) {
        const entryTitle = entry.fields.get('Title') || '';
        if (entryTitle.toLowerCase().includes(searchLower)) {
          results.push(entry);
        }
      }
      for (const subGroup of group.groups) {
        searchGroup(subGroup);
      }
    };

    searchGroup(this.db.getDefaultGroup());
    return results;
  }

  /**
   * Get entry password (decrypted)
   * @param {Object} entry - KeePass entry
   * @returns {string} - Decrypted password
   */
  getPassword(entry) {
    const pwd = entry.fields.get('Password');
    if (pwd && pwd.getText) {
      return pwd.getText();
    }
    return pwd || '';
  }

  /**
   * Get all entries as plain objects
   * @returns {Array} - Array of entry objects
   */
  getAllEntries() {
    if (!this.db) {
      throw new Error('No database open.');
    }

    const entries = [];

    const processGroup = (group, groupPath = '') => {
      const currentPath = groupPath ? `${groupPath}/${group.name}` : group.name;

      for (const entry of group.entries) {
        entries.push({
          group: currentPath,
          title: entry.fields.get('Title') || '',
          username: entry.fields.get('UserName') || '',
          url: entry.fields.get('URL') || '',
          notes: entry.fields.get('Notes') || '',
          created: entry.times.creationTime,
          modified: entry.times.lastModTime,
          // Password not included for safety - use getPassword(entry)
          _entry: entry
        });
      }

      for (const subGroup of group.groups) {
        processGroup(subGroup, currentPath);
      }
    };

    processGroup(this.db.getDefaultGroup());
    return entries;
  }

  /**
   * Update an existing entry
   * @param {Object} entry - Entry to update
   * @param {Object} fields - Fields to update
   */
  updateEntry(entry, fields) {
    if (fields.title) entry.fields.set('Title', fields.title);
    if (fields.username) entry.fields.set('UserName', fields.username);
    if (fields.password) entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(fields.password));
    if (fields.url) entry.fields.set('URL', fields.url);
    if (fields.notes) entry.fields.set('Notes', fields.notes);

    entry.times.lastModTime = new Date();
  }

  /**
   * Delete an entry
   * @param {Object} entry - Entry to delete
   */
  deleteEntry(entry) {
    this.db.remove(entry);
  }

  /**
   * Import credentials from ACCOUNTS.md
   * @param {string} accountsPath - Path to ACCOUNTS.md
   * @returns {Promise<number>} - Number of entries imported
   */
  async importFromAccountsMd(accountsPath = null) {
    const filePath = accountsPath || path.join(__dirname, '..', 'ACCOUNTS.md');

    try {
      const content = await fs.readFile(filePath, 'utf-8');

      // Parse markdown tables for account info
      // This is a simple parser - adjust based on actual ACCOUNTS.md format
      const lines = content.split('\n');
      let imported = 0;

      let currentService = '';
      let inTable = false;

      for (const line of lines) {
        // Detect service headers
        if (line.startsWith('## ')) {
          currentService = line.replace('## ', '').trim();
          inTable = false;
        }

        // Detect table rows with credentials
        if (line.includes('|') && !line.includes('---')) {
          const cells = line.split('|').map(c => c.trim()).filter(c => c);

          // Look for email/password patterns
          if (cells.length >= 2) {
            const emailPattern = /[\w.-]+@[\w.-]+\.\w+/;
            const email = cells.find(c => emailPattern.test(c));

            // Simple heuristic: if we have an email, next non-email cell might be password
            if (email && currentService) {
              const otherCells = cells.filter(c => c !== email && !c.includes('http'));
              const possiblePassword = otherCells.find(c => c.length > 5 && !c.includes(' '));

              if (possiblePassword) {
                this.addEntry(
                  currentService,
                  email,
                  possiblePassword,
                  cells.find(c => c.includes('http')) || '',
                  `Imported from ACCOUNTS.md`,
                  'Accounts'
                );
                imported++;
              }
            }
          }
        }
      }

      if (imported > 0) {
        await this.save();
      }

      return imported;
    } catch (error) {
      console.error('Failed to import from ACCOUNTS.md:', error.message);
      return 0;
    }
  }

  /**
   * Import API keys from API_KEYS.md
   * @param {string} apiKeysPath - Path to API_KEYS.md
   * @returns {Promise<number>} - Number of keys imported
   */
  async importFromApiKeysMd(apiKeysPath = null) {
    const filePath = apiKeysPath || path.join(__dirname, '..', 'API_KEYS.md');

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      let imported = 0;

      let currentService = '';
      let currentKey = {};

      for (const line of lines) {
        // Detect service headers
        if (line.startsWith('## ')) {
          // Save previous key if exists
          if (currentKey.apiKey && currentService) {
            this.addApiKey(
              currentService,
              currentKey.keyName || 'default',
              currentKey.apiKey,
              currentKey.endpoint || '',
              currentKey.notes || ''
            );
            imported++;
          }

          currentService = line.replace('## ', '').trim();
          currentKey = {};
        }

        // Parse table rows
        if (line.includes('|') && line.includes('`')) {
          const match = line.match(/\|\s*API Key\s*\|\s*`([^`]+)`/i);
          if (match) {
            currentKey.apiKey = match[1];
          }

          const keyNameMatch = line.match(/\|\s*Key Name\s*\|\s*([^|]+)/i);
          if (keyNameMatch) {
            currentKey.keyName = keyNameMatch[1].trim();
          }

          const endpointMatch = line.match(/\|\s*API Endpoint\s*\|\s*([^|]+)/i);
          if (endpointMatch) {
            currentKey.endpoint = endpointMatch[1].trim();
          }
        }
      }

      // Don't forget the last entry
      if (currentKey.apiKey && currentService) {
        this.addApiKey(
          currentService,
          currentKey.keyName || 'default',
          currentKey.apiKey,
          currentKey.endpoint || '',
          ''
        );
        imported++;
      }

      if (imported > 0) {
        await this.save();
      }

      return imported;
    } catch (error) {
      console.error('Failed to import from API_KEYS.md:', error.message);
      return 0;
    }
  }

  /**
   * Generate a secure random password
   * @param {number} length - Password length
   * @param {Object} options - Character options
   * @returns {string} - Generated password
   */
  static generatePassword(length = 20, options = {}) {
    const {
      uppercase = true,
      lowercase = true,
      numbers = true,
      symbols = true
    } = options;

    let chars = '';
    if (uppercase) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (lowercase) chars += 'abcdefghijklmnopqrstuvwxyz';
    if (numbers) chars += '0123456789';
    if (symbols) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';

    const bytes = crypto.randomBytes(length);
    let password = '';

    for (let i = 0; i < length; i++) {
      password += chars[bytes[i] % chars.length];
    }

    return password;
  }

  /**
   * Close the database (clears from memory)
   */
  close() {
    this.db = null;
    this.credentials = null;
    this.masterPassword = null;
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const kp = new KeePassManager();

  try {
    switch (command) {
      case 'create':
        const createPassword = args[1] || 'TeleClaude2026!';
        await kp.create(createPassword);
        console.log('Database created successfully!');
        console.log(`Location: ${DEFAULT_DB_PATH}`);
        console.log(`Master password: ${createPassword}`);
        break;

      case 'import':
        const importPassword = args[1] || 'TeleClaude2026!';
        try {
          await kp.open(importPassword);
        } catch (e) {
          console.log('Database not found, creating new one...');
          await kp.create(importPassword);
        }

        const accountsImported = await kp.importFromAccountsMd();
        const apiKeysImported = await kp.importFromApiKeysMd();

        console.log(`Imported ${accountsImported} accounts and ${apiKeysImported} API keys`);
        break;

      case 'list':
        const listPassword = args[1] || 'TeleClaude2026!';
        await kp.open(listPassword);

        const entries = kp.getAllEntries();
        console.log(`\nFound ${entries.length} entries:\n`);

        for (const entry of entries) {
          console.log(`[${entry.group}] ${entry.title}`);
          console.log(`  Username: ${entry.username}`);
          console.log(`  URL: ${entry.url || 'N/A'}`);
          console.log('');
        }
        break;

      case 'generate':
        const length = parseInt(args[1]) || 20;
        console.log('Generated password:', KeePassManager.generatePassword(length));
        break;

      default:
        console.log('KeePass Manager - Password Backup Utility');
        console.log('');
        console.log('Usage:');
        console.log('  node keepass_manager.js create [password]   - Create new database');
        console.log('  node keepass_manager.js import [password]   - Import from ACCOUNTS.md & API_KEYS.md');
        console.log('  node keepass_manager.js list [password]     - List all entries');
        console.log('  node keepass_manager.js generate [length]   - Generate secure password');
        console.log('');
        console.log('Default password: TeleClaude2026!');
        console.log(`Database location: ${DEFAULT_DB_PATH}`);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    kp.close();
  }
}

// Run CLI if executed directly
if (require.main === module) {
  main();
}

module.exports = { KeePassManager, DEFAULT_DB_PATH };
