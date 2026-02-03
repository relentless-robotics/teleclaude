const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// GitHub Personal Access Token - GET YOUR OWN FROM:
// https://github.com/settings/tokens
// Required scopes: repo, read:org, workflow
const GITHUB_PAT = 'YOUR_GITHUB_PAT_HERE';

function setupGitHubAuth() {
  console.log('Setting up GitHub CLI authentication...');

  // Set environment variable for this process
  process.env.GH_TOKEN = GITHUB_PAT;

  // Write to .env file for persistence
  const envPath = path.join(__dirname, '../.env.github');
  fs.writeFileSync(envPath, `GH_TOKEN=${GITHUB_PAT}\n`);
  console.log(`Token saved to: ${envPath}`);

  // Test authentication
  const ghPath = path.join(__dirname, '../tools/gh/bin/gh.exe');

  try {
    const result = execSync(`"${ghPath}" auth status`, {
      encoding: 'utf-8',
      env: { ...process.env, GH_TOKEN: GITHUB_PAT },
      stdio: 'pipe'
    });
    console.log('\nAuthentication Status:');
    console.log(result);
    return true;
  } catch (error) {
    console.error('Auth check failed:', error.message);
    return false;
  }
}

function getAuthenticatedEnv() {
  return { ...process.env, GH_TOKEN: GITHUB_PAT };
}

module.exports = {
  setupGitHubAuth,
  getAuthenticatedEnv,
  GITHUB_PAT
};

// Run setup if called directly
if (require.main === module) {
  setupGitHubAuth();
}
