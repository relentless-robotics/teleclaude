const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// GitHub Personal Access Token from API_KEYS.md
const GITHUB_PAT = 'ghp_YOUR_TOKEN_HERE';

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
    // gh auth status returns non-zero even on success due to stderr output
    if (error.stderr && error.stderr.includes('Logged in to github.com')) {
      console.log('\n✓ Successfully authenticated with GitHub!');
      console.log(error.stderr);
      return true;
    }
    console.error('\n❌ Authentication failed:');
    console.error(error.message);
    return false;
  }
}

if (require.main === module) {
  setupGitHubAuth();
}

module.exports = { setupGitHubAuth, GITHUB_PAT };
