const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load GitHub token from gh_auth module
let GITHUB_TOKEN = null;
try {
  const { GITHUB_PAT } = require('./gh_auth');
  GITHUB_TOKEN = GITHUB_PAT;
} catch {
  // Fallback to environment variable
  GITHUB_TOKEN = process.env.GH_TOKEN;
}

// Possible gh.exe locations
const GH_PATHS = [
  path.join(__dirname, '../tools/gh/bin/gh.exe'),
  path.join(__dirname, '../tools/gh/gh.exe'),
  'C:\\Program Files\\GitHub CLI\\gh.exe',
  'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
  process.env.LOCALAPPDATA + '\\Programs\\GitHub CLI\\gh.exe',
];

function findGhPath() {
  for (const p of GH_PATHS) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  // Try PATH as fallback
  try {
    const result = execSync('where gh', { encoding: 'utf-8' });
    return result.trim().split('\n')[0];
  } catch {
    return null;
  }
}

const GH_PATH = findGhPath();

if (!GH_PATH) {
  console.warn('GitHub CLI not found. Run: node utils/install_gh.js');
}

function gh(args, options = {}) {
  if (!GH_PATH) {
    throw new Error('GitHub CLI not found. Install it first by running: node utils/install_gh.js');
  }

  const argsArray = typeof args === 'string' ? args.split(' ') : args;

  // Ensure GH_TOKEN is set in environment for authentication
  const env = {
    ...process.env,
    ...(options.env || {}),
  };

  if (GITHUB_TOKEN && !env.GH_TOKEN) {
    env.GH_TOKEN = GITHUB_TOKEN;
  }

  try {
    const result = execSync(`"${GH_PATH}" ${argsArray.join(' ')}`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      env,
      ...options,
    });
    return result;
  } catch (error) {
    if (error.stdout) return error.stdout;
    throw error;
  }
}

// Convenience methods
const github = {
  // Issues
  issueView: (number, repo) => gh(`issue view ${number} --repo ${repo}`),
  issueList: (repo, opts = '') => gh(`issue list --repo ${repo} ${opts}`),
  issueCreate: (repo, title, body) => gh(`issue create --repo ${repo} --title "${title}" --body "${body}"`),

  // Pull Requests
  prView: (number, repo, opts = '') => gh(`pr view ${number} --repo ${repo} ${opts}`),
  prList: (repo, opts = '') => gh(`pr list --repo ${repo} ${opts}`),
  prComment: (number, repo, body) => {
    // Use temp file for long comments
    const tmpFile = path.join(process.env.TEMP, `gh_comment_${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, body);
    try {
      const result = gh(`pr comment ${number} --repo ${repo} --body-file "${tmpFile}"`);
      return result;
    } finally {
      fs.unlinkSync(tmpFile);
    }
  },
  prCreate: (repo, title, body, opts = '') => {
    // Use temp file for long body text
    const tmpFile = path.join(process.env.TEMP, `gh_pr_body_${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, body);
    try {
      const result = gh(`pr create --repo ${repo} --title "${title}" --body-file "${tmpFile}" ${opts}`);
      return result;
    } finally {
      fs.unlinkSync(tmpFile);
    }
  },
  prCheckout: (number, repo) => gh(`pr checkout ${number} --repo ${repo}`),
  prDiff: (number, repo) => gh(`pr diff ${number} --repo ${repo}`),

  // Repos
  repoClone: (repo, dir) => gh(`repo clone ${repo} ${dir || ''}`),
  repoView: (repo) => gh(`repo view ${repo}`),
  repoFork: (repo) => gh(`repo fork ${repo}`),

  // API (raw GitHub API access)
  api: (endpoint, opts = '') => gh(`api ${endpoint} ${opts}`),
  apiGet: (endpoint) => gh(`api ${endpoint} --method GET`),
  apiPost: (endpoint, data) => {
    const tmpFile = path.join(process.env.TEMP, `gh_api_${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(data));
    try {
      const result = gh(`api ${endpoint} --method POST --input "${tmpFile}"`);
      return result;
    } finally {
      fs.unlinkSync(tmpFile);
    }
  },

  // Auth
  authStatus: () => gh('auth status'),
  authLogin: () => gh('auth login'),

  // Comments (get PR/issue comments)
  getComments: (number, repo, type = 'pr') => {
    const result = gh(`api repos/${repo}/${type === 'pr' ? 'pulls' : 'issues'}/${number}/comments`);
    return JSON.parse(result);
  },

  // Check if gh is available
  isAvailable: () => !!GH_PATH,
  getPath: () => GH_PATH,
};

module.exports = { gh, github, findGhPath, GH_PATH };
