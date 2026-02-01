const { github, gh } = require('./github_cli');

/**
 * GitHub CLI Wrapper - Usage Examples
 *
 * This file demonstrates all available GitHub CLI features
 */

async function examples() {
  console.log('=== GitHub CLI Wrapper Examples ===\n');

  // Check availability
  console.log('1. Checking GitHub CLI availability...');
  console.log('   Path:', github.getPath());
  console.log('   Available:', github.isAvailable());

  if (!github.isAvailable()) {
    console.log('\n❌ GitHub CLI not found. Run: node utils/install_gh.js');
    return;
  }

  // Check auth status
  console.log('\n2. Checking authentication...');
  try {
    const authStatus = github.authStatus();
    console.log(authStatus);
  } catch (error) {
    console.log('   Not authenticated');
  }

  console.log('\n3. Pull Request Examples:');

  // View a PR
  console.log('\n   a) View PR #15097 from nuclei-templates:');
  try {
    const pr = github.prView(15097, 'projectdiscovery/nuclei-templates');
    console.log('   ' + pr.substring(0, 200) + '...');
  } catch (error) {
    console.log('   ❌', error.message.split('\n')[0]);
  }

  // List PRs
  console.log('\n   b) List open PRs in a repo:');
  try {
    const prs = github.prList('cli/cli', '--limit 3 --state open');
    console.log('   ' + prs.substring(0, 200) + '...');
  } catch (error) {
    console.log('   ❌', error.message.split('\n')[0]);
  }

  console.log('\n4. Repository Examples:');

  // View repo
  console.log('\n   a) View repository info:');
  try {
    const repo = github.repoView('cli/cli');
    console.log('   ' + repo.substring(0, 200) + '...');
  } catch (error) {
    console.log('   ❌', error.message.split('\n')[0]);
  }

  console.log('\n5. API Examples:');

  // Raw API call
  console.log('\n   a) Get user info via API:');
  try {
    const user = github.api('user');
    const userData = JSON.parse(user);
    console.log('   Username:', userData.login);
    console.log('   Name:', userData.name);
    console.log('   Public repos:', userData.public_repos);
  } catch (error) {
    console.log('   ❌', error.message.split('\n')[0]);
  }

  // Get PR comments
  console.log('\n   b) Get PR comments (API):');
  try {
    const comments = github.getComments(15097, 'projectdiscovery/nuclei-templates', 'pr');
    console.log(`   Found ${comments.length} comments`);
    if (comments.length > 0) {
      console.log(`   First comment by: ${comments[0].user.login}`);
    }
  } catch (error) {
    console.log('   ❌', error.message.split('\n')[0]);
  }

  console.log('\n6. Raw gh() Command Examples:');

  // Custom commands
  console.log('\n   a) List workflows:');
  try {
    const workflows = gh('workflow list --repo cli/cli --limit 3');
    console.log('   ' + workflows.substring(0, 200) + '...');
  } catch (error) {
    console.log('   ❌', error.message.split('\n')[0]);
  }

  console.log('\n7. Practical Use Cases:');

  // Example: Check if PR is merged
  console.log('\n   a) Check PR merge status:');
  try {
    const prJson = gh('pr view 15097 --repo projectdiscovery/nuclei-templates --json state,merged,mergeable');
    const prData = JSON.parse(prJson);
    console.log('   State:', prData.state);
    console.log('   Merged:', prData.merged);
    console.log('   Mergeable:', prData.mergeable);
  } catch (error) {
    console.log('   ❌', error.message.split('\n')[0]);
  }

  // Example: Search issues
  console.log('\n   b) Search for bounty issues:');
  try {
    const issues = gh('search issues "label:bounty is:open" --limit 5');
    console.log('   ' + issues.substring(0, 300) + '...');
  } catch (error) {
    console.log('   ❌', error.message.split('\n')[0]);
  }

  console.log('\n=== Examples Complete ===');
}

// Example functions for common tasks

function checkPRStatus(prNumber, repo) {
  const pr = gh(`pr view ${prNumber} --repo ${repo} --json state,merged,mergeable,title`);
  return JSON.parse(pr);
}

function listBounties() {
  const issues = gh('search issues "label:bounty is:open" --limit 20 --json number,title,repository,url');
  return JSON.parse(issues);
}

function viewPRDiff(prNumber, repo) {
  return github.prDiff(prNumber, repo);
}

function addPRComment(prNumber, repo, comment) {
  return github.prComment(prNumber, repo, comment);
}

function createBountyPR(repo, branch, title, description) {
  return github.prCreate(repo, title, description, `--head ${branch}`);
}

function getUserRepos() {
  const repos = github.api('user/repos?type=owner&sort=updated');
  return JSON.parse(repos);
}

// Run examples if called directly
if (require.main === module) {
  examples().catch(console.error);
}

module.exports = {
  checkPRStatus,
  listBounties,
  viewPRDiff,
  addPRComment,
  createBountyPR,
  getUserRepos,
};
