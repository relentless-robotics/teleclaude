## GITHUB CLI INTEGRATION

**You have access to GitHub CLI (gh) for all GitHub operations!**

### Module Location

- **Primary Module:** `utils/github_cli.js`
- **Auth Setup:** `utils/gh_auth.js`
- **Installer:** `utils/install_gh.js`
- **Test Script:** `utils/test_gh.js`

### Authentication

The wrapper automatically loads the GitHub PAT from `gh_auth.js`. Authentication happens automatically - no manual `gh auth login` needed!

**Current credentials:**
- Account: relentless-robotics
- Token: Stored in gh_auth.js (full access to all GitHub features)

### Quick Usage

```javascript
const { github } = require('./utils/github_cli');

// Check if available
if (!github.isAvailable()) {
  console.log('Run: node utils/install_gh.js');
}

// View PR
const pr = github.prView(123, 'owner/repo');

// List PRs
const prs = github.prList('owner/repo', '--state open');

// Comment on PR
github.prComment(123, 'owner/repo', 'Great work!');

// Create PR
github.prCreate('owner/repo', 'Fix bug', 'This fixes the bug...', '--base main');

// View issue
const issue = github.issueView(456, 'owner/repo');

// Clone repo
github.repoClone('owner/repo', './local-dir');

// Raw API access
const data = github.api('repos/owner/repo/pulls/123');
```

### Available Methods

#### Pull Requests
- `github.prView(number, repo, opts)` - View PR details
- `github.prList(repo, opts)` - List PRs
- `github.prComment(number, repo, body)` - Add comment
- `github.prCreate(repo, title, body, opts)` - Create PR
- `github.prCheckout(number, repo)` - Checkout PR locally
- `github.prDiff(number, repo)` - View PR diff

#### Issues
- `github.issueView(number, repo)` - View issue
- `github.issueList(repo, opts)` - List issues
- `github.issueCreate(repo, title, body)` - Create issue

#### Repositories
- `github.repoView(repo)` - View repo info
- `github.repoClone(repo, dir)` - Clone repo
- `github.repoFork(repo)` - Fork repo

#### Raw API
- `github.api(endpoint, opts)` - Call any GitHub API endpoint
- `github.apiGet(endpoint)` - GET request
- `github.apiPost(endpoint, data)` - POST request
- `github.getComments(number, repo, type)` - Get PR/issue comments as JSON

#### Auth
- `github.authStatus()` - Check auth status
- `github.isAvailable()` - Check if CLI is installed
- `github.getPath()` - Get gh.exe path

### Advanced - Raw gh() Function

For commands not wrapped by convenience methods:

```javascript
const { gh } = require('./utils/github_cli');

// Any gh command
const result = gh('workflow list --repo owner/repo');
const release = gh('release view v1.0.0 --repo owner/repo');
```

### Working with Long Text

The wrapper automatically handles long text by writing to temp files:

```javascript
// Long comment (no size limit)
github.prComment(123, 'owner/repo', `
  Very long comment text...
  Multiple paragraphs...
  No problem!
`);

// Long PR body
github.prCreate('owner/repo', 'Title', `
  Very detailed PR description...
  Many sections...
  Auto-handled via temp file!
`);
```

### Error Handling

```javascript
try {
  const pr = github.prView(123, 'owner/repo');
  console.log(pr);
} catch (error) {
  console.error('Failed to fetch PR:', error.message);
  // Handle error
}
```

### Installation & Maintenance

**If gh CLI is not installed:**
```bash
node utils/install_gh.js
```

**To test installation:**
```bash
node utils/test_gh.js
```

**To check/refresh auth:**
```bash
node utils/gh_auth.js
```

### Important Notes

1. **Authentication is automatic** - PAT loaded from gh_auth.js
2. **Full GitHub access** - Token has all scopes
3. **No rate limit issues** - Authenticated requests have 5000/hour limit
4. **Long text handling** - Automatically uses temp files for comments/PRs
5. **JSON parsing** - Use `github.api()` for raw JSON responses

### Example Workflows

**View and comment on a bounty PR:**
```javascript
const { github } = require('./utils/github_cli');

// Get PR details
const pr = github.prView(15097, 'projectdiscovery/nuclei-templates');
console.log(pr);

// Get comments
const comments = github.getComments(15097, 'projectdiscovery/nuclei-templates', 'pr');

// Add a comment
github.prComment(15097, 'projectdiscovery/nuclei-templates', 'Reviewing this PR...');
```

**Create PR for bounty submission:**
```javascript
// Fork repo first
github.repoFork('algora-io/repo');

// After making changes locally...
const prUrl = github.prCreate('algora-io/repo',
  'Fix: Resolve issue #123',
  `## Summary
  - Fixed the bug in module X
  - Added tests

  Fixes #123

  Generated with Claude Code`,
  '--base main --head relentless-robotics:fix-123'
);
console.log('PR created:', prUrl);
```

**Monitor PR status:**
```javascript
// Check if PR has been merged
const pr = github.prView(123, 'owner/repo', '--json state,merged');
const data = JSON.parse(pr);
if (data.merged) {
  console.log('PR merged!');
}
```

---

