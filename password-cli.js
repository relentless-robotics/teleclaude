#!/usr/bin/env node
/**
 * Password Manager CLI
 *
 * Usage:
 *   node password-cli.js generate [length] [--no-symbols] [--unambiguous]
 *   node password-cli.js passphrase [words]
 *   node password-cli.js save <service> <username> [password]
 *   node password-cli.js get <service>
 *   node password-cli.js list
 *   node password-cli.js delete <service>
 *   node password-cli.js strength <password>
 *   node password-cli.js init
 */

const readline = require('readline');
const {
  generatePassword,
  generatePassphrase,
  savePassword,
  getPassword,
  listServices,
  deletePassword,
  checkStrength,
  initialize
} = require('./utils/password_manager');

// Default master password (for automated use - in production, prompt for this)
const DEFAULT_MASTER = process.env.PASSWORD_MASTER || 'TeleClaude-Master-2026';

const args = process.argv.slice(2);
const command = args[0];

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const masterPassword = process.env.PASSWORD_MASTER || DEFAULT_MASTER;

  switch (command) {
    case 'generate': {
      const length = parseInt(args[1]) || 32;
      const options = {
        symbols: !args.includes('--no-symbols'),
        unambiguous: args.includes('--unambiguous')
      };

      const password = generatePassword(length, options);
      const strength = checkStrength(password);

      console.log('\n=== Generated Password ===');
      console.log(password);
      console.log(`\nLength: ${password.length}`);
      console.log(`Strength: ${strength.rating} (${strength.score}/8)`);
      break;
    }

    case 'passphrase': {
      const words = parseInt(args[1]) || 4;
      const passphrase = generatePassphrase(words);
      const strength = checkStrength(passphrase);

      console.log('\n=== Generated Passphrase ===');
      console.log(passphrase);
      console.log(`\nStrength: ${strength.rating} (${strength.score}/8)`);
      break;
    }

    case 'save': {
      const service = args[1];
      const username = args[2];
      let password = args[3];

      if (!service || !username) {
        console.error('Usage: node password-cli.js save <service> <username> [password]');
        process.exit(1);
      }

      if (!password) {
        password = await prompt('Enter password (or press Enter to generate): ');
        if (!password) {
          password = generatePassword(32);
          console.log(`Generated password: ${password}`);
        }
      }

      savePassword(service, username, password, masterPassword);
      console.log(`\nSaved password for ${service}`);
      break;
    }

    case 'get': {
      const service = args[1];

      if (!service) {
        console.error('Usage: node password-cli.js get <service>');
        process.exit(1);
      }

      const entry = getPassword(service, masterPassword);

      if (entry) {
        console.log('\n=== Password Entry ===');
        console.log(`Service: ${service}`);
        console.log(`Username: ${entry.username}`);
        console.log(`Password: ${entry.password}`);
        console.log(`Created: ${entry.created}`);
        console.log(`Updated: ${entry.updated}`);
      } else {
        console.log(`No password found for: ${service}`);
      }
      break;
    }

    case 'list': {
      const services = listServices(masterPassword);

      if (services.length === 0) {
        console.log('No passwords stored');
      } else {
        console.log('\n=== Stored Services ===');
        console.log('Service'.padEnd(30) + 'Username'.padEnd(30) + 'Created');
        console.log('-'.repeat(80));

        for (const entry of services) {
          console.log(
            entry.service.padEnd(30) +
            entry.username.padEnd(30) +
            entry.created.split('T')[0]
          );
        }
      }
      break;
    }

    case 'delete': {
      const service = args[1];

      if (!service) {
        console.error('Usage: node password-cli.js delete <service>');
        process.exit(1);
      }

      const confirm = await prompt(`Delete password for ${service}? (yes/no): `);

      if (confirm.toLowerCase() === 'yes') {
        if (deletePassword(service, masterPassword)) {
          console.log('Password deleted');
        } else {
          console.log('Service not found');
        }
      } else {
        console.log('Cancelled');
      }
      break;
    }

    case 'strength': {
      const password = args[1];

      if (!password) {
        console.error('Usage: node password-cli.js strength <password>');
        process.exit(1);
      }

      const analysis = checkStrength(password);

      console.log('\n=== Password Strength ===');
      console.log(`Length: ${analysis.length}`);
      console.log(`Has lowercase: ${analysis.hasLowercase}`);
      console.log(`Has uppercase: ${analysis.hasUppercase}`);
      console.log(`Has numbers: ${analysis.hasNumbers}`);
      console.log(`Has symbols: ${analysis.hasSymbols}`);
      console.log(`Score: ${analysis.score}/8`);
      console.log(`Rating: ${analysis.rating}`);
      break;
    }

    case 'init': {
      initialize(masterPassword);
      console.log('Password manager initialized with master password');
      console.log('Master password is set via PASSWORD_MASTER env var or defaults');
      break;
    }

    default:
      console.log(`
Password Manager CLI

Commands:
  generate [length]           Generate a random password (default: 32 chars)
    --no-symbols              Exclude symbols
    --unambiguous             Use unambiguous characters only

  passphrase [words]          Generate a passphrase (default: 4 words)

  save <service> <username>   Save a password
    [password]                Optional - will prompt or generate if omitted

  get <service>               Retrieve a password

  list                        List all stored services

  delete <service>            Delete a password

  strength <password>         Check password strength

  init                        Initialize the password manager

Environment:
  PASSWORD_MASTER             Master password (default: TeleClaude-Master-2026)

Examples:
  node password-cli.js generate 24
  node password-cli.js generate 32 --no-symbols
  node password-cli.js passphrase 5
  node password-cli.js save ssh-windows Footb
  node password-cli.js get ssh-windows
  node password-cli.js list
`);
  }
}

main().catch(console.error);
