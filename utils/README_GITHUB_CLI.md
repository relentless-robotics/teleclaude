# GitHub CLI Integration

This directory contains a complete GitHub CLI wrapper and utilities for interacting with GitHub from Node.js.

## Files

| File | Purpose |
|------|---------|
| `github_cli.js` | Main wrapper module with convenience methods |
| `gh_auth.js` | Authentication setup and token management |
| `install_gh.js` | Portable installer for GitHub CLI |
| `test_gh.js` | Test script to verify installation |
| `github_cli_examples.js` | Comprehensive usage examples |

## Quick Start

### 1. Check Installation

```bash
node utils/test_gh.js
```

If not installed, run:

```bash
node utils/install_gh.js
```

### 2. Basic Usage

```javascript
const { github } = require('./utils/github_cli');

// View a PR
const pr = github.prView(123, 'owner/repo');
console.log(pr);

// List issues
const issues = github.issueList('owner/repo', '--state open');

// Create a PR
github.prCreate('owner/repo', 'Fix bug', 'This fixes the bug in module X');
```

### 3. Authentication

Authentication is automatic! The wrapper loads the GitHub PAT from `gh_auth.js`.

To verify auth status:

```bash
node utils/gh_auth.js
```

## API Reference

### Pull Requests

```javascript
// View PR details
github.prView(number, repo, opts?)

// List PRs
github.prList(repo, opts?)

// Add comment
github.prComment(number, repo, body)

// Create PR
github.prCreate(repo, title, body, opts?)

// Checkout PR locally
github.prCheckout(number, repo)

// View PR diff
github.prDiff(number, repo)
```

### Issues

```javascript
// View issue
github.issueView(number, repo)

// List issues
github.issueList(repo, opts?)

// Create issue
github.issueCreate(repo, title, body)
```

### Repositories

```javascript
// View repo info
github.repoView(repo)

// Clone repo
github.repoClone(repo, dir?)

// Fork repo
github.repoFork(repo)
```

### Raw API Access

```javascript
// Generic API call
github.api(endpoint, opts?)

// GET request
github.apiGet(endpoint)

// POST request
github.apiPost(endpoint, data)

// Get comments as JSON
github.getComments(number, repo, type?)
```

### Utilities

```javascript
// Check if installed
github.isAvailable()

// Get gh.exe path
github.getPath()

// Check auth status
github.authStatus()
```

## Advanced Usage

### Custom gh Commands

For commands not wrapped by convenience methods:

```javascript
const { gh } = require('./utils/github_cli');

// Any gh command
const result = gh('workflow list --repo owner/repo');
const releases = gh('release list --repo owner/repo');
```

### Working with JSON

Get structured data using `--json`:

```javascript
const prJson = gh('pr view 123 --repo owner/repo --json state,title,url');
const prData = JSON.parse(prJson);

console.log(prData.state);
console.log(prData.title);
console.log(prData.url);
```

### Long Text Handling

The wrapper automatically uses temp files for long text:

```javascript
// No size limit on comments or PR bodies
github.prComment(123, 'owner/repo', `
  Very long comment...
  Multiple paragraphs...
  Markdown formatting...
`);
```

## Examples

See `github_cli_examples.js` for comprehensive examples including:

- Checking PR merge status
- Searching for bounty issues
- Viewing PR diffs
- Adding comments
- Creating PRs
- API usage
- Error handling

Run examples:

```bash
node utils/github_cli_examples.js
```

## Installation Details

### Location

GitHub CLI is installed to: `../tools/gh/`

Executable: `../tools/gh/bin/gh.exe`

### Authentication

Token: Stored in `gh_auth.js` (loaded from API_KEYS.md)

Account: relentless-robotics

Scopes: Full access (all scopes)

### Environment Variables

The wrapper automatically sets `GH_TOKEN` for all commands.

Alternatively, you can set it manually:

```javascript
process.env.GH_TOKEN = 'ghp_your_token_here';
```

## Troubleshooting

### "GitHub CLI not found"

Run the installer:

```bash
node utils/install_gh.js
```

### "Not authenticated"

Check auth status:

```bash
node utils/gh_auth.js
```

Verify token in `gh_auth.js` is correct.

### "Command failed"

Most errors include helpful messages. Common issues:

1. **Invalid repo format** - Use `owner/repo` format
2. **PR/issue not found** - Verify number and repo
3. **Permission denied** - Check token has required scopes
4. **Rate limit** - Authenticated requests have 5000/hour limit

## GitHub CLI Documentation

Official docs: https://cli.github.com/manual/

Command reference: https://cli.github.com/manual/gh

API reference: https://docs.github.com/en/rest

## Support

For issues with this wrapper:
1. Run `node utils/test_gh.js` to diagnose
2. Check `gh_auth.js` for auth issues
3. Try raw `gh` command to isolate problem

For GitHub CLI issues:
- Check official docs: https://cli.github.com/
- GitHub CLI repo: https://github.com/cli/cli
