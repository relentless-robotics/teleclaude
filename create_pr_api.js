const https = require('https');
const fs = require('fs');

// GitHub API token - we'll need to create one first or use basic auth
const username = 'relentless-robotics';
const password = 'Relentless@Robotics2026!';

function apiRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${username}:${password}`).toString('base64');

    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: path,
      method: method,
      headers: {
        'User-Agent': 'TeleClaude-Bot',
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(body || '{}'));
        } else {
          reject(new Error(`API Error ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

async function main() {
  try {
    console.log('Step 1: Checking if fork exists...');

    const fork = await apiRequest('GET', '/repos/relentless-robotics/nuclei-templates').catch(() => null);

    if (!fork) {
      console.log('Fork does not exist. Creating fork...');
      const newFork = await apiRequest('POST', '/repos/projectdiscovery/nuclei-templates/forks');
      console.log('Fork created:', newFork.html_url);
      // Wait for fork to be ready
      await new Promise(resolve => setTimeout(resolve, 5000));
    } else {
      console.log('Fork exists:', fork.html_url);
    }

    console.log('Step 2: Getting main branch ref...');
    const mainRef = await apiRequest('GET', '/repos/relentless-robotics/nuclei-templates/git/ref/heads/main');
    const mainSha = mainRef.object.sha;
    console.log('Main branch SHA:', mainSha);

    console.log('Step 3: Creating new branch ref...');
    const branchData = {
      ref: 'refs/heads/add-cve-2024-3408',
      sha: mainSha
    };

    const newBranch = await apiRequest('POST', '/repos/relentless-robotics/nuclei-templates/git/refs', branchData)
      .catch(e => {
        if (e.message.includes('already exists')) {
          console.log('Branch already exists');
          return { ref: 'refs/heads/add-cve-2024-3408' };
        }
        throw e;
      });

    console.log('Branch ready:', newBranch.ref);

    console.log('Step 4: Reading file content...');
    const fileContent = fs.readFileSync('C:\\Users\\Footb\\Documents\\Github\\nuclei-templates\\http\\cves\\2024\\CVE-2024-3408.yaml', 'utf-8');
    const base64Content = Buffer.from(fileContent).toString('base64');

    console.log('Step 5: Creating/updating file in branch...');
    const filePath = 'http/cves/2024/CVE-2024-3408.yaml';

    // Try to get existing file SHA (if it exists)
    const existingFile = await apiRequest('GET', `/repos/relentless-robotics/nuclei-templates/contents/${filePath}?ref=add-cve-2024-3408`)
      .catch(() => null);

    const fileData = {
      message: 'Add Nuclei template for CVE-2024-3408 (man-group/dtale Authentication Bypass & RCE)',
      content: base64Content,
      branch: 'add-cve-2024-3408'
    };

    if (existingFile && existingFile.sha) {
      fileData.sha = existingFile.sha;
      console.log('Updating existing file...');
    } else {
      console.log('Creating new file...');
    }

    const fileCommit = await apiRequest('PUT', `/repos/relentless-robotics/nuclei-templates/contents/${filePath}`, fileData);
    console.log('File committed:', fileCommit.commit.sha);

    console.log('Step 6: Creating Pull Request...');
    const prData = {
      title: 'Add Nuclei template for CVE-2024-3408 (dtale RCE)',
      head: 'relentless-robotics:add-cve-2024-3408',
      base: 'main',
      body: `## Summary

This PR adds a Nuclei template for CVE-2024-3408, a critical authentication bypass and remote code execution vulnerability in man-group/dtale.

## Vulnerability Details

- **CVE:** CVE-2024-3408
- **Severity:** Critical (CVSS 9.8)
- **Product:** man-group/dtale
- **Affected Versions:** Up to and including 3.10.0
- **Fixed Version:** 3.15.1

The vulnerability combines:
1. Hardcoded SECRET_KEY allowing session cookie forgery
2. Improper filter validation allowing arbitrary code execution

## Template Features

- Detects vulnerable dtale instances
- Tests for authentication bypass
- Verifies RCE capability via /test-filter endpoint
- Multiple matchers for reliable detection

## References

- https://nvd.nist.gov/vuln/detail/CVE-2024-3408
- https://github.com/advisories/GHSA-v9q6-fm48-rx74

## Related Issue

Closes #14488 ($100 Algora bounty)`,
      maintainer_can_modify: true
    };

    const pr = await apiRequest('POST', '/repos/projectdiscovery/nuclei-templates/pulls', prData);

    console.log('✅ PR CREATED:', pr.html_url);
    console.log('PR Number:', pr.number);

  } catch (error) {
    console.error('ERROR:', error.message);
  }
}

main();
