const { github } = require('./github_cli');

async function test() {
  console.log('=== GitHub CLI Test ===\n');

  console.log('GitHub CLI path:', github.getPath());
  console.log('Is available:', github.isAvailable());

  if (!github.isAvailable()) {
    console.log('\n❌ GitHub CLI not found!');
    console.log('Run: node utils/install_gh.js');
    return;
  }

  console.log('\n--- Auth Status ---');
  try {
    console.log(github.authStatus());
  } catch (error) {
    console.log('Not authenticated. Run: gh auth login');
  }

  console.log('\n--- Testing PR View ---');
  try {
    const pr = github.prView(15097, 'projectdiscovery/nuclei-templates');
    console.log(pr.substring(0, 500) + '...');
    console.log('\n✓ PR view successful!');
  } catch (error) {
    console.log('❌ PR view failed:', error.message);
  }

  console.log('\n--- Testing Repo View ---');
  try {
    const repo = github.repoView('cli/cli');
    console.log(repo.substring(0, 300) + '...');
    console.log('\n✓ Repo view successful!');
  } catch (error) {
    console.log('❌ Repo view failed:', error.message);
  }

  console.log('\n=== Test Complete ===');
}

test().catch(console.error);
