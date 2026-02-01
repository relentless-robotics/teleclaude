#!/usr/bin/env node

/**
 * Gmail API Setup Status Checker
 *
 * Verifies that all components are in place for Gmail API access
 */

const fs = require('fs');
const path = require('path');

const checks = [
  {
    name: 'googleapis package installed',
    check: () => {
      try {
        require.resolve('googleapis');
        return { ok: true };
      } catch {
        return { ok: false, fix: 'Run: npm install googleapis' };
      }
    }
  },
  {
    name: 'Gmail API module exists',
    check: () => {
      const modulePath = path.join(__dirname, 'gmail_api.js');
      if (fs.existsSync(modulePath)) {
        return { ok: true };
      }
      return { ok: false, fix: 'Module should exist at utils/gmail_api.js' };
    }
  },
  {
    name: 'secure/ directory exists',
    check: () => {
      const dirPath = path.join(__dirname, '../secure');
      if (fs.existsSync(dirPath)) {
        return { ok: true };
      }
      return { ok: false, fix: 'Run: mkdir secure' };
    }
  },
  {
    name: 'OAuth credentials file (gmail_credentials.json)',
    check: () => {
      const credPath = path.join(__dirname, '../secure/gmail_credentials.json');
      if (fs.existsSync(credPath)) {
        // Verify it's valid JSON
        try {
          const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
          if (cred.installed || cred.web) {
            return { ok: true, info: 'Credentials file is valid' };
          }
          return { ok: false, fix: 'File exists but format is invalid' };
        } catch {
          return { ok: false, fix: 'File exists but is not valid JSON' };
        }
      }
      return {
        ok: false,
        fix: 'Follow GMAIL_OAUTH_SETUP.md to download credentials from Google Cloud Console'
      };
    }
  },
  {
    name: 'OAuth token file (gmail_token.json)',
    check: () => {
      const tokenPath = path.join(__dirname, '../secure/gmail_token.json');
      if (fs.existsSync(tokenPath)) {
        try {
          const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
          if (token.access_token || token.refresh_token) {
            return { ok: true, info: 'Token exists and will auto-refresh if needed' };
          }
          return { ok: false, fix: 'Token file invalid format' };
        } catch {
          return { ok: false, fix: 'Token file not valid JSON' };
        }
      }
      return {
        ok: false,
        fix: 'Run: node utils/gmail_init.js (creates token on first auth)'
      };
    }
  }
];

console.log('Gmail API Setup Status Check');
console.log('='.repeat(60));
console.log();

let allGood = true;

checks.forEach(({ name, check }) => {
  const result = check();
  const icon = result.ok ? '✅' : '❌';
  console.log(`${icon} ${name}`);

  if (result.info) {
    console.log(`   ℹ️  ${result.info}`);
  }

  if (!result.ok) {
    allGood = false;
    console.log(`   Fix: ${result.fix}`);
  }

  console.log();
});

console.log('='.repeat(60));

if (allGood) {
  console.log('✅ All checks passed! Gmail API is ready to use.');
  console.log();
  console.log('Next steps:');
  console.log('  - Test it: node utils/gmail_quickstart.js');
  console.log('  - Examples: node utils/gmail_examples.js');
  console.log();
} else {
  console.log('⚠️  Setup incomplete. Follow the fixes above.');
  console.log();
  console.log('Quick start:');
  console.log('  1. Read GMAIL_OAUTH_SETUP.md for full setup guide');
  console.log('  2. Download credentials from Google Cloud Console');
  console.log('  3. Save as secure/gmail_credentials.json');
  console.log('  4. Run: node utils/gmail_init.js');
  console.log('  5. Run this check again');
  console.log();
}
