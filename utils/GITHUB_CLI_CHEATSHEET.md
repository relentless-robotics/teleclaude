# GitHub CLI Quick Reference

## Import

```javascript
const { github, gh } = require('./utils/github_cli');
```

## Common Tasks

### View PR
```javascript
const pr = github.prView(15097, 'projectdiscovery/nuclei-templates');
```

### List Open PRs
```javascript
const prs = github.prList('owner/repo', '--state open --limit 10');
```

### Comment on PR
```javascript
github.prComment(123, 'owner/repo', 'Looks good to me!');
```

### Create PR
```javascript
github.prCreate('owner/repo', 'Fix bug in auth', 'This PR fixes authentication issue', '--base main');
```

### View Issue
```javascript
const issue = github.issueView(456, 'owner/repo');
```

### Create Issue
```javascript
github.issueCreate('owner/repo', 'Bug: Login fails', 'Steps to reproduce...');
```

### Clone Repo
```javascript
github.repoClone('owner/repo', './local-folder');
```

### Fork Repo
```javascript
github.repoFork('owner/repo');
```

### Get PR as JSON
```javascript
const prJson = gh('pr view 123 --repo owner/repo --json state,title,url,mergeable');
const data = JSON.parse(prJson);
```

### Search Bounties
```javascript
const bounties = gh('search issues "label:bounty is:open" --limit 20');
```

### Get User Info
```javascript
const user = github.api('user');
const userData = JSON.parse(user);
console.log(userData.login, userData.public_repos);
```

### Get PR Comments
```javascript
const comments = github.getComments(123, 'owner/repo', 'pr');
comments.forEach(c => console.log(c.user.login, c.body));
```

### Check PR Status
```javascript
const pr = gh('pr view 123 --repo owner/repo --json state,mergeable,mergedAt');
const status = JSON.parse(pr);
if (status.state === 'MERGED') {
  console.log('PR was merged at', status.mergedAt);
}
```

### List User Repos
```javascript
const repos = github.api('user/repos?sort=updated&per_page=10');
JSON.parse(repos).forEach(r => console.log(r.full_name));
```

### Raw Commands
```javascript
// Workflows
gh('workflow list --repo owner/repo');

// Releases
gh('release list --repo owner/repo');

// Gists
gh('gist list --limit 10');

// Notifications
gh('api notifications');
```

## Options Reference

### PR List Options
- `--state open|closed|merged|all`
- `--limit N`
- `--author username`
- `--label labelname`

### Issue List Options
- `--state open|closed|all`
- `--limit N`
- `--assignee username`
- `--label labelname`
- `--author username`

### JSON Fields (--json)

#### PR Fields
- state, title, url, number
- author, assignees, labels
- createdAt, updatedAt, closedAt, mergedAt
- mergeable, mergeStateStatus
- additions, deletions, changedFiles
- body, comments, reviews

#### Issue Fields
- state, title, url, number
- author, assignees, labels
- createdAt, updatedAt, closedAt
- body, comments

## Authentication

Already configured! Token loaded automatically from `gh_auth.js`.

Check status:
```bash
node utils/gh_auth.js
```

## Installation

Check if installed:
```bash
node utils/test_gh.js
```

Install if needed:
```bash
node utils/install_gh.js
```

## Error Handling

```javascript
try {
  const pr = github.prView(123, 'owner/repo');
  console.log(pr);
} catch (error) {
  console.error('Failed:', error.message);
}
```

## Tips

1. **Use convenience methods** for common tasks
2. **Use gh() for custom commands** not wrapped
3. **Use --json for structured data** when parsing needed
4. **Long text auto-handled** via temp files
5. **Authentication automatic** via GH_TOKEN
