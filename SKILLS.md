# SKILLS.md - Workflows & Procedures

This file documents workflows for common tasks that require browser automation, login sequences, or multi-step processes.

**See also:** `docs/TOOLS_INDEX.md` for complete capability index.

---

## 🛠️ AVAILABLE TOOLS (Quick Reference)

| Tool | Location | Status | Cost |
|------|----------|--------|------|
| **Cursor CLI** | `utils/cursor_cli.js` | ✅ Ready | FREE (auto model) |
| **Gmail Helper** | `utils/gmail_helper.js` | ✅ Ready | Free |
| **Gmail API (OAuth)** | `utils/gmail_api.js` | ⚠️ Scripts Ready, Run `setup_gmail_oauth_final.js` | Free (requires OAuth) |
| **Playwright Helpers** | `utils/playwright_helpers.js` | ✅ Ready | Free |
| **Credentials Helper** | `utils/credentials.js` | ✅ Ready | Free |
| **CAPTCHA Handler** | `utils/captcha_handler.js` | ✅ Ready | Free |
| **Image Generator** | `utils/image_generator.js` | ⚠️ Needs API Key | OpenAI API |
| **TTS Generator** | `utils/tts_generator.js` | ⚠️ Needs API Key | OpenAI API |
| **WSL/Kali Tools** | `mcp/cyber-tools.js` | ✅ Ready | Free |
| **Sysinternals Suite** | `tools/sysinternals/` | ✅ Ready | Free |
| **Security Tools Docs** | `docs/SECURITY_TOOLS_REFERENCE.md` | ✅ Ready | Free |
| **Practice Targets** | `utils/practice_targets.js` | ✅ Ready | Free |
| **Docker (WSL2)** | `utils/wsl_bridge.js` | ✅ Ready | Free |
| **Docker Security** | `utils/docker_security.js` | ✅ Ready | Free |
| **KeePass Manager** | `utils/keepass_manager.js` | ✅ Ready | Free |
| **Bounty Scraper** | `scrape_all_bounties.js` | ✅ Ready | Free |

### Quick Commands

```bash
# Cursor CLI (FREE with auto model)
node utils/cursor_cli.js ask "question"
node utils/cursor_cli.js agent "task"

# Gmail (Browser Automation)
node utils/gmail_helper.js list
node utils/gmail_helper.js search "bounty"

# Gmail API (OAuth - More Reliable)
node utils/gmail_quickstart.js              # Test setup
node utils/gmail_init.js                    # First-time OAuth setup

# Bounty Scraper
node scrape_all_bounties.js

# Sysinternals Tools (Windows)
.\tools\sysinternals\autoruns.exe    # Startup analysis
.\tools\sysinternals\procexp.exe     # Process Explorer
.\tools\sysinternals\tcpview.exe     # Network monitor
```

---

## 🤖 Discord/Telegram Bridge Commands

Commands available when using the bot via Discord or Telegram:

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/status` | Check Claude process status and uptime |
| `/restart` | Gracefully restart Claude |
| `/kill` | Kill all Claude processes |
| `/reset` | Full reset (kill + restart fresh) |
| `/ping` | Check if bridge is responsive |
| `/logs [category]` | View recent logs (bridge, claude, mcp, agent, system) |
| `/pwd` | Show current working directory |
| `/cd <path>` | Change working directory |
| `/getfile <path>` | Download a file (25MB Discord / 50MB Telegram limit) |

**File Commands Notes:**
- `/cd` supports both absolute and relative paths
- `/getfile` resolves relative paths from current working directory
- Working directory persists across Claude restarts

---

## 🧠 Memory System v2 (Semantic Search)

The memory MCP server now includes TF-IDF semantic search for better recall.

**New Features:**
- **Semantic matching**: "code repo" finds memories about "github"
- **Synonym expansion**: Built-in synonyms for common terms
- **Similarity search**: Find related memories with `find_similar`
- **Relevance scoring**: See match quality in search results

**Storage Files:**
- `memory/memories.json` - Raw memory data
- `memory/semantic-index.json` - Search index (auto-generated)

**Semantic Search Examples:**
```
recall("where is code hosted")  → Finds GitHub repo memory
recall("payment processing")    → Finds Stripe/billing memories
recall("login issues")          → Finds OAuth/auth memories
```

---

## Template: Service Login

**Purpose:** Generic template for documenting a login workflow.

**URL:** https://example.com

**User Credentials:**
- Email: [configured in setup or API_KEYS.md]
- Password: [configured in setup or API_KEYS.md]

**Login Options:**
- Continue with Google
- Continue with email
- SSO (if applicable)

**Steps:**

1. Navigate to the service login page
2. Click the appropriate login method
3. Enter credentials when prompted
4. Handle 2FA if required:
   - For Google 2FA: Select "Tap Yes on phone/tablet"
   - Wait for user confirmation before proceeding
5. Verify successful login
6. Proceed with the intended task

**Notes:**
- Document any service-specific quirks here
- Include error handling tips
- Note rate limits or special requirements

---

## Template: API Key Generation

**Purpose:** Template for documenting API key generation for a service.

**URL:** https://example.com/api-keys

**Prerequisites:**
- Must be logged in (see login workflow above)
- May require billing/payment setup

**Steps:**

1. Navigate to API Keys section
2. Click "Create API key" or equivalent
3. Enter key name/description
4. Select permissions (if applicable)
5. **IMPORTANT:** Copy the key immediately - often shown only once!
6. Store the key in `API_KEYS.md`

**Key Format:**
- Example: `sk-xxx...` or `api_xxx...`

**API Endpoint:**
- Base URL: `https://api.example.com/v1`
- Authentication: Bearer token in header

**Sample Request:**
```shell
curl https://api.example.com/v1/endpoint \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

---

## How to Add New Workflows

When you successfully complete a new login or API key generation:

1. Copy the appropriate template above
2. Fill in the actual URLs, steps, and details
3. Include any screenshots or specific UI element names
4. Document error cases you encountered
5. Add the workflow to this file

This helps future sessions repeat the process correctly.

---

## Gmail API OAuth Setup (Google Cloud Console)

**Status:** ✅ Scripts Complete | ⚠️ Account permissions may vary

**Purpose:** Set up Gmail API OAuth 2.0 credentials for programmatic email access.

**Scripts Location:** `C:\Users\Footb\Documents\Github\teleclaude-main\setup_gmail_oauth_final.js`

### Automated Setup

```bash
# Run the automated setup script
node setup_gmail_oauth_final.js
```

The script automatically:
1. Creates a Google Cloud project
2. Enables Gmail API
3. Configures OAuth consent screen
4. Creates OAuth 2.0 Desktop credentials
5. Saves credentials to `secure/gmail_credentials.json`
6. Updates `API_KEYS.md`

### Key Technical Details

**ToS Checkbox Handling:**
- Google Cloud Console uses Material Design checkboxes
- Regular Playwright clicks don't work reliably
- Solution: JavaScript injection to set `checkbox.checked = true` and dispatch events
- Proven working in `setup_gmail_oauth_final.js`

**Account Chooser Handling:**
- Google shows "Choose an account" screen even with saved cookies
- Script detects this and clicks the correct account automatically

**Project Context:**
- Use `?project=PROJECT_NAME` in URLs to maintain project context
- Without this, credentials page shows "select a project" error

### Known Issues

**Access Boundary Policy Error:**
- Some Google accounts (especially those in organizations) may have restrictions
- Error: "resourcemanager.projects.get" permission missing
- Solutions:
  1. Click "Request permissions" button in console
  2. Use a personal Gmail without org restrictions
  3. Request "Project Mover" role

### After Credential Creation

```bash
# Complete OAuth authorization flow
node utils/gmail_init.js

# Test Gmail access
node utils/gmail_quickstart.js
```

### Files Created

| File | Purpose |
|------|---------|
| `secure/gmail_credentials.json` | OAuth client ID and secret |
| `secure/gmail_token.json` | Access/refresh tokens (after init) |

---

## Sysinternals Suite (Windows Security Tools)

**Status:** ✅ AVAILABLE - Downloaded 2026-01-31

**Location:** `C:\Users\Footb\Documents\Github\teleclaude-main\tools\sysinternals`

**Purpose:** Microsoft's official suite of 70+ advanced system utilities for Windows troubleshooting, security analysis, and system administration.

### Key Tools

| Tool | Purpose | Usage |
|------|---------|-------|
| **Autoruns** | View all autostart locations | `.\tools\sysinternals\autoruns.exe` |
| **Process Explorer** | Advanced task manager | `.\tools\sysinternals\procexp.exe` |
| **TCPView** | Real-time network connections | `.\tools\sysinternals\tcpview.exe` |
| **Process Monitor** | Real-time file/registry/process activity | `.\tools\sysinternals\procmon.exe` |
| **AccessChk** | View file/registry permissions | `.\tools\sysinternals\accesschk.exe` |
| **PsExec** | Execute processes remotely | `.\tools\sysinternals\psexec.exe` |
| **Strings** | Find readable strings in binaries | `.\tools\sysinternals\strings.exe` |
| **Sysmon** | System activity monitor (driver) | `.\tools\sysinternals\sysmon.exe` |

### Security Audit Workflows

#### Workflow: Comprehensive System Audit

**Purpose:** Full security scan of Windows system.

**Steps:**

1. **Network Analysis:**
   ```powershell
   # Active connections
   Get-NetTCPConnection | Where-Object State -eq 'Established' | Select LocalAddress, LocalPort, RemoteAddress, RemotePort, OwningProcess, @{Name='Process';Expression={(Get-Process -Id $_.OwningProcess).ProcessName}}

   # Listening ports
   Get-NetTCPConnection | Where-Object State -eq 'Listen' | Select LocalAddress, LocalPort, OwningProcess, @{Name='Process';Expression={(Get-Process -Id $_.OwningProcess).ProcessName}}
   ```

2. **Process Inspection:**
   ```powershell
   # Get all processes with paths
   Get-Process | Where-Object {$null -ne $_.Path} | Select Name, Id, Path, Company | Sort-Object Name

   # Check for suspicious locations
   Get-Process | Where-Object {$_.Path -like "*Temp*" -or $_.Path -like "*AppData\Local\*"}
   ```

3. **Autoruns GUI:**
   ```bash
   # Launch Autoruns for startup analysis
   .\tools\sysinternals\autoruns.exe
   ```
   Look for:
   - Unknown publishers
   - Entries in unusual locations
   - Services/drivers without descriptions

4. **Process Explorer GUI:**
   ```bash
   # Launch Process Explorer
   .\tools\sysinternals\procexp.exe
   ```
   Features:
   - See parent-child process relationships
   - Check digital signatures
   - View network connections per process
   - Inspect loaded DLLs

5. **TCPView Network Monitor:**
   ```bash
   # Real-time network connections
   .\tools\sysinternals\tcpview.exe
   ```
   Monitor for:
   - Unexpected outbound connections
   - Processes connecting to suspicious IPs
   - High-numbered ports

#### Workflow: Malware Analysis Prep

**Purpose:** Analyze suspicious executable safely.

**Prerequisites:** DO NOT run suspicious executables outside of sandbox!

**Steps:**

1. **Extract strings:**
   ```bash
   .\tools\sysinternals\strings.exe -n 8 C:\path\to\suspicious.exe > strings.txt
   ```
   Look for:
   - URLs/IP addresses
   - Registry keys
   - File paths
   - Encrypted/encoded data

2. **Process Monitor capture:**
   ```bash
   # Run in VM/sandbox only!
   .\tools\sysinternals\procmon.exe
   # Set filters for the suspicious process
   # Execute the malware (in sandbox!)
   # Review file/registry/network activity
   ```

3. **Combine with WSL/Ghidra:**
   ```javascript
   // Use Ghidra for static analysis
   const { analyzeWithGhidra, decompile } = require('./mcp/cyber-tools');
   const result = await analyzeWithGhidra('C:\\path\\to\\suspicious.exe');
   ```

### Command-Line Tools

Many Sysinternals tools have CLI versions ending in 'c' (e.g., autorunsc):

```powershell
# Get autorun entries as CSV
.\tools\sysinternals\autorunsc.exe -accepteula -a * -c > autoruns.csv

# List processes with details
.\tools\sysinternals\pslist.exe -t

# View handles for a process
.\tools\sysinternals\handle.exe -p <pid>
```

### PowerShell Integration

```powershell
# Run Sysinternals tools from PowerShell
$sysinternalsPath = "C:\Users\Footb\Documents\Github\teleclaude-main\tools\sysinternals"

# Auto-accept EULA and run
& "$sysinternalsPath\autorunsc.exe" -accepteula -a * -c | ConvertFrom-Csv
& "$sysinternalsPath\pslist.exe" -accepteula -t
```

### Node.js Integration

```javascript
const { execSync } = require('child_process');
const path = require('path');

const sysinternalsPath = path.join(__dirname, 'tools', 'sysinternals');

// Run Autoruns and parse CSV
function getAutoruns() {
  const cmd = `"${sysinternalsPath}\\autorunsc.exe" -accepteula -a * -c`;
  const output = execSync(cmd, { encoding: 'utf-8' });
  // Parse CSV output
  return output;
}

// List all handles for a process
function getHandles(pid) {
  const cmd = `"${sysinternalsPath}\\handle.exe" -accepteula -p ${pid}`;
  return execSync(cmd, { encoding: 'utf-8' });
}
```

### Best Practices

1. **First-Time Run:**
   - Tools show EULA on first run
   - Use `-accepteula` flag for automated scripts

2. **Elevated Privileges:**
   - Some tools require Administrator rights
   - Right-click → "Run as Administrator"

3. **Regular Updates:**
   - Download latest version periodically
   - Tools auto-update if run from \\live.sysinternals.com\tools

4. **Documentation:**
   - Official docs: https://docs.microsoft.com/sysinternals
   - Each tool has detailed help: `tool.exe /?`

### Common Use Cases

| Task | Tool | Command |
|------|------|---------|
| Find what's slowing boot | Autoruns | GUI or autorunsc.exe |
| Identify process using file | Process Explorer | GUI → Find Handle |
| Monitor registry changes | Process Monitor | GUI with registry filter |
| View network per process | TCPView | GUI |
| Kill unkillable process | Process Explorer | GUI → Kill Process Tree |
| Find strings in malware | Strings | `strings.exe -n 8 file.exe` |
| Remote command execution | PsExec | `psexec \\computer cmd` |

### Security Considerations

- **Sysinternals tools are safe** - Created by Microsoft
- **Malware may detect** Process Monitor/Autoruns and hide
- **Use in VM/sandbox** when analyzing unknown files
- **Digital signatures** - All tools are signed by Microsoft

---

## Cybersecurity Tools Skill

**Purpose:** Perform security testing and reverse engineering using WSL2 Kali Linux tools.

**Prerequisites:**
- WSL2 must be installed and configured
- Kali Linux distribution installed
- Security tools installed in Kali (nmap, nikto, gobuster, ghidra, etc.)

**Setup:**

1. **First-time setup** (run as Administrator):
   ```powershell
   cd C:\Users\Footb\Documents\Github\teleclaude-main
   .\setup_wsl_kali.ps1
   ```

2. **Verify installation:**
   ```javascript
   const { checkStatus } = require('./mcp/cyber-tools');
   const status = await checkStatus();
   console.log(status);
   ```

**Authorized Targets:**

Edit `config/cyber_authorized_targets.json` to authorize scan targets:
```json
{
  "authorized_targets": [
    "127.0.0.1",
    "localhost",
    "192.168.1.100",
    "mydevserver.local"
  ]
}
```

**CRITICAL: Only scan systems you own or have written permission to test.**

---

### Network Reconnaissance Workflows

#### Workflow: Basic Port Scan

**Purpose:** Discover open ports on a target system.

**Steps:**

1. Verify target is authorized:
   ```javascript
   const { isAuthorizedTarget } = require('./mcp/cyber-tools');
   const authorized = await isAuthorizedTarget('192.168.1.100');
   ```

2. Run TCP scan:
   ```javascript
   const { nmapScan } = require('./mcp/cyber-tools');

   const result = await nmapScan('192.168.1.100', {
     scanType: 'tcp',
     ports: '1-1000',
     verbose: true
   });

   console.log(result.output);
   ```

3. Parse results and identify open ports

**Common Scan Types:**
- `'ping'` - Host discovery (no port scan)
- `'tcp'` - TCP connect scan (default)
- `'udp'` - UDP scan (slower)
- `'service'` - Service version detection
- `'os'` - OS detection
- `'vuln'` - Vulnerability scripts

#### Workflow: Service Version Detection

**Purpose:** Identify services and versions running on open ports.

**Steps:**

```javascript
const { nmapScan } = require('./mcp/cyber-tools');

const result = await nmapScan('localhost', {
  scanType: 'service',
  ports: '80,443,3000,8080',
  verbose: true
});

// Result includes service names, versions, and details
```

**Use case:** Identifying outdated services with known vulnerabilities.

#### Workflow: DNS Enumeration

**Purpose:** Gather DNS records and WHOIS information for a domain.

**Steps:**

```javascript
const { dnsEnum } = require('./mcp/cyber-tools');

const result = await dnsEnum('example.com');

console.log('DNS Records:', result.dig);
console.log('WHOIS Info:', result.whois);
```

---

### Web Security Testing Workflows

#### Workflow: Web Vulnerability Scan

**Purpose:** Scan web application for common vulnerabilities.

**Steps:**

1. Run Nikto scanner:
   ```javascript
   const { niktoScan } = require('./mcp/cyber-tools');

   const result = await niktoScan('http://localhost:8080', {
     port: 8080,
     ssl: false
   });

   console.log(result.output);
   ```

2. Review findings for:
   - Outdated software versions
   - Security misconfigurations
   - Known vulnerabilities
   - Information disclosure

**Warning:** Nikto is aggressive and will be logged. Only scan authorized targets.

#### Workflow: Directory Enumeration

**Purpose:** Discover hidden directories and files on web server.

**Steps:**

1. Use gobuster with common wordlist:
   ```javascript
   const { gobusterDir } = require('./mcp/cyber-tools');

   const result = await gobusterDir(
     'http://localhost:8080',
     '/usr/share/wordlists/dirb/common.txt',
     {
       extensions: 'php,html,txt',
       threads: 10
     }
   );
   ```

2. Alternative: Use ffuf for fuzzing:
   ```javascript
   const { ffuzzer } = require('./mcp/cyber-tools');

   const result = await ffuzzer(
     'http://localhost:8080/FUZZ',
     '/usr/share/wordlists/dirb/common.txt',
     {
       filterCodes: '404',
       threads: 40
     }
   );
   ```

**Common wordlists in Kali:**
- `/usr/share/wordlists/dirb/common.txt` - Small, fast
- `/usr/share/wordlists/dirb/big.txt` - Comprehensive
- `/usr/share/wordlists/dirbuster/directory-list-2.3-medium.txt` - Very large

---

### Reverse Engineering Workflows

#### Workflow: Binary Analysis with Ghidra

**Purpose:** Analyze and decompile binary executables.

**Steps:**

1. Get basic binary information:
   ```javascript
   const { binaryInfo } = require('./mcp/cyber-tools');

   const info = await binaryInfo('C:\\path\\to\\binary.exe');
   console.log('File type:', info.fileType);
   console.log('Sample strings:', info.sampleStrings);
   ```

2. Run full Ghidra analysis:
   ```javascript
   const { analyzeWithGhidra } = require('./mcp/cyber-tools');

   const result = await analyzeWithGhidra('C:\\path\\to\\binary.exe', {
     projectName: 'my_analysis',
     analyze: true
   });

   console.log('Analysis complete:', result.success);
   console.log('Project path:', result.projectPath);
   ```

3. List all functions:
   ```javascript
   const { listBinaryFunctions } = require('./mcp/cyber-tools');

   const functions = await listBinaryFunctions('C:\\path\\to\\binary.exe');

   functions.forEach(f => {
     console.log(`${f.address}: ${f.name}`);
   });
   ```

4. Decompile specific function:
   ```javascript
   const { decompile } = require('./mcp/cyber-tools');

   const code = await decompile('C:\\path\\to\\binary.exe', '0x401000');
   console.log('Decompiled C code:\n', code);
   ```

**Use cases:**
- Malware analysis (BE CAREFUL - use sandbox)
- Reverse engineering proprietary protocols
- Understanding closed-source software behavior
- Finding vulnerabilities in binaries

#### Workflow: String Extraction

**Purpose:** Extract readable strings from binary for quick analysis.

**Steps:**

```javascript
const { binaryStrings } = require('./mcp/cyber-tools');

const strings = await binaryStrings('C:\\path\\to\\binary.exe', 4);

strings.forEach(s => {
  console.log(`${s.address}: ${s.value}`);
});

// Filter for interesting patterns
const urls = strings.filter(s => s.value.includes('http'));
const paths = strings.filter(s => s.value.includes('\\') || s.value.includes('/'));
```

**What to look for:**
- URLs and API endpoints
- File paths
- Error messages
- Hardcoded credentials (security issue!)
- Command strings

---

### Direct WSL Command Execution

**Purpose:** Run specific commands in WSL for custom operations.

**Steps:**

```javascript
const { runInWSL, runTool } = require('./utils/wsl_bridge');

// Run specific tool
const result = await runTool('nmap', ['-sV', 'localhost']);

// Run custom command (must be whitelisted)
const output = await runInWSL('ping -c 4 127.0.0.1', {
  timeout: 30000
});

// Skip validation (USE WITH EXTREME CAUTION)
const unsafeResult = await runInWSL('custom command', {
  skipValidation: true  // Only for trusted commands
});
```

**Path conversion:**
```javascript
const { windowsToWSLPath, wslToWindowsPath } = require('./utils/wsl_bridge');

const wslPath = windowsToWSLPath('C:\\Users\\Footb\\file.txt');
// Result: /mnt/c/Users/Footb/file.txt

const winPath = wslToWindowsPath('/mnt/c/Users/Footb/file.txt');
// Result: C:\Users\Footb\file.txt
```

---

### Security Best Practices

1. **Authorization First**
   - Always verify target is in authorized list
   - Never scan external systems without written permission
   - Document authorization in project notes

2. **Logging & Documentation**
   - All operations are automatically logged
   - Review logs regularly: `logs/cyber_tools.log`
   - Document findings and vulnerabilities

3. **Responsible Disclosure**
   - Report vulnerabilities to system owners
   - Give reasonable time to patch before public disclosure
   - Follow coordinated disclosure guidelines

4. **Scan Intensity**
   - Use least aggressive scans first
   - Avoid disrupting production systems
   - Schedule intensive scans during maintenance windows

5. **Legal Compliance**
   - Only test systems you own or have permission for
   - Understand local laws regarding security testing
   - Maintain documentation of authorization

6. **Data Handling**
   - Treat discovered data as confidential
   - Don't share credentials or sensitive info
   - Securely delete data when analysis is complete

---

### Troubleshooting

**WSL not available:**
```powershell
# Check WSL status
wsl --list --verbose

# Reinstall if needed
.\setup_wsl_kali.ps1
```

**Tool not installed:**
```bash
wsl -d kali-linux
sudo apt update
sudo apt install nmap nikto gobuster ghidra
```

**Command validation failed:**
- Check if tool is in ALLOWED_TOOLS (see `utils/wsl_bridge.js`)
- Verify command doesn't match DANGEROUS_PATTERNS
- Use `skipValidation: true` only if absolutely necessary

**Ghidra analysis timeout:**
```javascript
// Increase timeout for large binaries
const result = await analyzeWithGhidra('large.exe', {
  timeout: 1200000  // 20 minutes
});
```

**Permission errors:**
- Some tools require sudo (not currently supported)
- Use non-privileged scan options
- Run WSL as user, not root

---

---

## KeePass Password Backup

**Status:** ✅ AVAILABLE - Database created with imported credentials

**Location:** `secure/teleclaude_passwords.kdbx`

**Master Password:** Same as system default (Relaxing41!)

**Module:** `utils/keepass_manager.js`

### Quick Commands

```bash
# List all stored passwords
node utils/keepass_manager.js list "Relaxing41!"

# Import from ACCOUNTS.md & API_KEYS.md
node utils/keepass_manager.js import "Relaxing41!"

# Generate secure password
node utils/keepass_manager.js generate 24
```

### Node.js Usage

```javascript
const { KeePassManager } = require('./utils/keepass_manager');

const kp = new KeePassManager();
await kp.open('Relaxing41!');

// Add new entry
kp.addEntry('GitHub', 'user@example.com', 'password123', 'https://github.com');

// Add API key
kp.addApiKey('OpenAI', 'my-key', 'sk-xxx...', 'https://api.openai.com');

// Find entries
const results = kp.findByTitle('GitHub');
const password = kp.getPassword(results[0]);

// Save changes
await kp.save();
kp.close();
```

### Groups

The database has these default groups:
- **Accounts** - Login credentials
- **API Keys** - API keys and secrets
- **Services** - Service configurations
- **Crypto** - Cryptocurrency wallets/keys
- **Other** - Miscellaneous

### Backup Strategy

1. **Primary:** ACCOUNTS.md, API_KEYS.md (human-readable)
2. **Backup:** KeePass database (encrypted, portable)
3. **Optional:** Install KeePassXC for GUI access: `winget install KeePassXCTeam.KeePassXC`

### Security Notes

- Database uses AES-256 encryption with Argon2 key derivation
- Master password required to decrypt
- Can be synced via cloud storage (encrypted file is safe)
- Compatible with KeePassXC, KeePass2, and other KDBX readers

---

## Practice Targets (Local Hacking Labs)

**Status:** ✅ READY - Docker-based vulnerable environments

**Location:** `docker/practice-targets/` + `utils/practice_targets.js`

### Available Targets

| Target | Port | Difficulty | Description |
|--------|------|------------|-------------|
| `dvwa` | 8081 | Beginner | Classic web vulns (SQLi, XSS, CSRF) |
| `juice-shop` | 3000 | All levels | 100+ gamified challenges |
| `webgoat` | 8080 | Beginner | Guided security lessons |
| `bwapp` | 8082 | Beginner+ | 100+ web vulnerabilities |
| `mutillidae` | 8083 | Beginner+ | OWASP Top 10 with hints |
| `nodegoat` | 4000 | Intermediate | Vulnerable Node.js app |
| `wordpress` | 8084 | Intermediate | Old WordPress 4.6 |
| `crapi` | 8888 | Intermediate+ | API security testing |
| `ssh` | 2222 | Beginner | SSH brute force practice |

### Quick Start

```bash
# List all targets
node utils/practice_targets.js list

# Start specific target
node utils/practice_targets.js start dvwa
node utils/practice_targets.js start juice-shop

# Start all targets (resource intensive!)
node utils/practice_targets.js start all

# Check what's running
node utils/practice_targets.js status

# Get target info and challenges
node utils/practice_targets.js info dvwa
node utils/practice_targets.js challenges dvwa

# Stop targets
node utils/practice_targets.js stop all
```

### Default Credentials

| Target | Username | Password |
|--------|----------|----------|
| DVWA | admin | password |
| bWAPP | bee | bug |
| Vuln SSH | root | root |
| Others | Register account | - |

### Recommended Practice Path

1. **Start with DVWA** - Set to "Low" security, practice basics
2. **Move to Juice Shop** - Modern app, gamified scoreboard
3. **Try WebGoat** - Guided lessons explain each vuln
4. **Challenge yourself** - crAPI for API testing, WordPress for real-world

### WARNING

These are **intentionally vulnerable**. Never expose to internet!
Run only on localhost/isolated networks.

---

## Docker Security Containers (Anonymity Stack)

**Status:** ✅ READY TO BUILD

**Location:** `docker/` directory + `utils/docker_security.js`

### Anonymity Levels

| Level | Container | Description | Speed |
|-------|-----------|-------------|-------|
| `none` | kali-tools | Direct connection | Fast |
| `tor` | kali-anon | Traffic through Tor | Slow |
| `vpn` | kali-vpn | Traffic through VPN | Medium |
| `full` | kali-full-anon | VPN + Tor | Very Slow |

### Quick Start

```bash
# Build all images (first time only)
node utils/docker_security.js build

# Start container with Tor anonymity
node utils/docker_security.js start tor

# Run tool through Tor
node utils/docker_security.js run nmap -sV target.com

# Check your exit IP
node utils/docker_security.js ip tor

# Interactive shell with full anonymity
node utils/docker_security.js shell full

# Stop all containers
node utils/docker_security.js stop
```

### Node.js Usage

```javascript
const { launchContainer, runSecurityTool } = require('./utils/docker_security');

// Launch container with Tor
await launchContainer('tor');

// Run nmap through Tor
const result = await runSecurityTool('nmap', ['-sV', 'target.com'], {
  anonymity: 'tor',
  stream: true
});

// Check IP
const ip = await getCurrentIP('tor');
```

### VPN Setup

Place VPN config in `docker/vpn-configs/`:
- WireGuard: `wg0.conf`
- OpenVPN: `client.ovpn`

```javascript
const { addVPNConfig } = require('./utils/docker_security');
addVPNConfig('/path/to/config.ovpn', 'openvpn');
addVPNConfig('/path/to/wg.conf', 'wireguard');
```

### Container Features

**kali-tools:**
- nmap, nikto, gobuster, sqlmap, hydra, john, hashcat
- No anonymity, fastest performance

**kali-anon:**
- All kali-tools + Tor + proxychains
- Auto-starts Tor on launch
- Use `proxychains4 <command>` for anonymity

**vpn-gateway:**
- Routes all connected container traffic through VPN
- Kill switch enabled by default

**kali-full-anon:**
- VPN + Tor layered
- Maximum anonymity, slowest speed

---

## Docker Containerization (WSL2)

**Status:** ✅ AVAILABLE - Docker 27.5.1 + Docker Compose 2.32.4

**Location:** WSL2 Kali Linux

**Credentials:** teleclaude / Relaxing41!

### Quick Reference

```bash
# Docker commands via WSL
node utils/cursor_cli.js ask "docker command"

# Or directly:
wsl -d kali-linux -u teleclaude -- docker ps
wsl -d kali-linux -u teleclaude -- docker-compose up -d
```

### Workflow: Build and Run Container

**Purpose:** Create and run a Docker container from a Dockerfile.

**Steps:**

1. Create Dockerfile in project directory
2. Build the image:
   ```javascript
   const { runTool } = require('./utils/wsl_bridge');
   await runTool('docker', ['build', '-t', 'myapp', '/mnt/c/path/to/project']);
   ```
3. Run the container:
   ```javascript
   await runTool('docker', ['run', '-d', '--name', 'myapp', '-p', '8080:8080', 'myapp']);
   ```
4. Verify it's running:
   ```javascript
   const result = await runTool('docker', ['ps']);
   console.log(result.stdout);
   ```

### Workflow: Docker Compose Stack

**Purpose:** Run multi-container applications.

**Steps:**

1. Create docker-compose.yml:
   ```yaml
   version: '3.8'
   services:
     web:
       build: .
       ports:
         - "3000:3000"
     db:
       image: postgres:15
       environment:
         POSTGRES_PASSWORD: secret
   ```

2. Start the stack:
   ```javascript
   const { runTool } = require('./utils/wsl_bridge');
   await runTool('docker-compose', ['-f', '/mnt/c/path/docker-compose.yml', 'up', '-d']);
   ```

3. View logs:
   ```javascript
   await runTool('docker-compose', ['-f', '/mnt/c/path/docker-compose.yml', 'logs']);
   ```

4. Stop the stack:
   ```javascript
   await runTool('docker-compose', ['-f', '/mnt/c/path/docker-compose.yml', 'down']);
   ```

### Workflow: Security Testing Container

**Purpose:** Create isolated container for security testing.

**Steps:**

1. Build Kali container:
   ```javascript
   const dockerfile = `
   FROM kalilinux/kali-rolling
   RUN apt update && apt install -y nmap nikto gobuster metasploit-framework
   WORKDIR /work
   CMD ["/bin/bash"]
   `;
   // Save dockerfile and build
   await runTool('docker', ['build', '-t', 'kali-security', '.']);
   ```

2. Run interactive session:
   ```javascript
   await runTool('docker', ['run', '-it', '--rm', '--network', 'host', 'kali-security']);
   ```

### Workflow: AI Agent Container

**Purpose:** Run Claude clones or other AI services in containers.

**Steps:**

1. Create container with API access:
   ```javascript
   await runTool('docker', [
     'run', '-d',
     '--name', 'claude-agent-1',
     '-e', 'ANTHROPIC_API_KEY=sk-ant-xxx',
     '-v', '/mnt/c/workspace:/work',
     'node:20-alpine',
     'node', '/work/agent.js'
   ]);
   ```

2. Monitor agent:
   ```javascript
   await runTool('docker', ['logs', '-f', 'claude-agent-1']);
   ```

### Common Docker Commands

| Task | Command |
|------|---------|
| List containers | `docker ps -a` |
| List images | `docker images` |
| Stop container | `docker stop <name>` |
| Remove container | `docker rm <name>` |
| Remove image | `docker rmi <name>` |
| Shell into container | `docker exec -it <name> bash` |
| View logs | `docker logs <name>` |
| Prune unused | `docker system prune -a` |

### Troubleshooting

**Docker service not running:**
```bash
wsl -d kali-linux -u root -- service docker start
```

**Permission denied:**
```bash
# User should be in docker group (already configured)
wsl -d kali-linux -u teleclaude -- groups
```

**Out of disk space:**
```bash
wsl -d kali-linux -u teleclaude -- docker system prune -a
```

---

## Money-Making & Bounty Tools

### Gmail Helper

**Location:** `utils/gmail_helper.js`

**Purpose:** Easy interface for reading/sending emails without browser automation overhead.

**CLI Usage:**
```bash
# List recent emails (optionally filter by search query)
node utils/gmail_helper.js list [search_query]

# Read specific email by index
node utils/gmail_helper.js read <index>

# Search emails
node utils/gmail_helper.js search <query>

# Send email
node utils/gmail_helper.js send <to> "<subject>" "<body>"

# Take screenshot
node utils/gmail_helper.js screenshot [filename]
```

**Module Usage:**
```javascript
const { GmailHelper } = require('./utils/gmail_helper');

const gmail = new GmailHelper();
await gmail.init();

// Get emails
const emails = await gmail.getEmails(10, 'algora');

// Send email
await gmail.sendEmail('someone@example.com', 'Subject', 'Body text');

await gmail.close();
```

---

### Bounty Process Guide

**Location:** `BOUNTY_PROCESS.md`

**Purpose:** Step-by-step documentation for claiming and completing Algora bounties.

**Contents:**
- Finding bounties on Algora
- Evaluating bounties before claiming
- Claiming process (comment, PR syntax)
- Submission guidelines
- Platform-specific requirements (ProjectDiscovery, tscircuit, etc.)
- Common mistakes to avoid
- Quick reference commands

---

### Project Tracker

**Location:** `PROJECT_TRACKER.md`

**Purpose:** Track all active money-making projects, bounty submissions, and pending payments.

**Contents:**
- Active bounty submissions table
- Pending payments
- Completed/paid history
- Active income streams (JumpTask, etc.)
- Revenue tracking by month

---

### Playwright Helpers

**Location:** `utils/playwright_helpers.js`

**Purpose:** Robust browser automation utilities to reduce timeouts and failures.

**Key Functions:**
```javascript
const {
  createRobustContext,  // Anti-detection browser setup
  safeGoto,             // Navigation with retry
  safeClick,            // Click with fallbacks
  safeType,             // Human-like typing with verification
  smartWait,            // Better element waiting
  waitForAny,           // Wait for multiple conditions
  debugScreenshot,      // Automatic debugging
  detectIssues,         // CAPTCHA/error detection
  withRetry             // Generic retry wrapper
} = require('./utils/playwright_helpers');
```

**Documentation:** See `utils/PLAYWRIGHT_BEST_PRACTICES.md` and `utils/PLAYWRIGHT_CHEATSHEET.md`

---

### Bounty Scraper

**Location:** `scrape_all_bounties.js`

**Purpose:** Scrape all bounties from Algora with full page scroll.

**Usage:**
```bash
node scrape_all_bounties.js
```

**Output:** Creates `BOUNTY_INDEX.md` with all discovered bounties.

---

### Credential & Auth Helpers

**Location:** `utils/credentials.js`

**Purpose:** Auto-fill login credentials for known sites.

**Usage:**
```javascript
const { autoFillLogin, createAuthenticatedContext } = require('./utils/credentials');

// Create browser context with saved Google auth
const context = await createAuthenticatedContext(browser);

// Auto-fill credentials on login page
await autoFillLogin(page);
```

**Supported sites:** Google, GitHub, Gumroad, Pinterest, Vercel, Twitter/X

---

### CAPTCHA Handler

**Location:** `utils/captcha_handler.js`

**Purpose:** Detect CAPTCHAs and coordinate with user for solving.

**Usage:**
```javascript
const { detectCaptcha, screenshotCaptcha, handleCaptchaWithUser } = require('./utils/captcha_handler');

const captchaInfo = await detectCaptcha(page);
if (captchaInfo) {
  const screenshotPath = await screenshotCaptcha(page, captchaInfo);
  // Notify user via Discord, wait for solution
}
```

**Supported types:** reCAPTCHA, hCaptcha, Cloudflare Turnstile, text CAPTCHAs, Arkose

---

## Key Documentation Files

| File | Purpose |
|------|---------|
| `ACCOUNTS.md` | Master index of all accounts & credentials |
| `API_KEYS.md` | Stored API keys and secrets |
| `BOUNTY_PROCESS.md` | How to claim/complete bounties |
| `PROJECT_TRACKER.md` | Track submissions & payments |
| `CLAUDE.md` | Main operating instructions |

---

## Cursor CLI (AI Coding Assistant)

**Location:** `utils/cursor_cli.js`

**Status:** ✅ AVAILABLE - Ready to use!

**Purpose:** Use Cursor AI agent from the command line for parallel AI coding tasks.

**Requirements:** Cursor Pro subscription (active)

**Cursor Path:** `C:\Users\Footb\AppData\Local\Programs\cursor\`

### ⚠️ IMPORTANT: Model Selection

**ALWAYS use `auto` model - it's FREE with Cursor Pro!**

| Model | Cost | Use Case |
|-------|------|----------|
| `auto` | **FREE** ✅ | Default - use for everything! |
| `claude-3.5-sonnet` | Uses quota | Only if auto fails |
| `gpt-4o` | Uses quota | Only if auto fails |

The wrapper defaults to `auto` model automatically.

### CLI Commands

```bash
# Start interactive agent
cursor agent

# Non-interactive mode
cursor agent --print "your task"

# List previous conversations
cursor agent ls

# Resume conversation
cursor agent resume [thread_id]

# Open file in Cursor
cursor path/to/file.js

# Open folder
cursor path/to/folder
```

### Agent Modes

| Mode | Command | Purpose |
|------|---------|---------|
| Agent | `/agent` or default | General coding tasks |
| Ask | `/ask` | Questions without file edits |
| Plan | `/plan` | Design approach first |

### Node.js Wrapper Usage

```javascript
const {
    cursorAsk,
    cursorPlan,
    cursorAgent,
    openInCursor
} = require('./utils/cursor_cli');

// Ask a question (no file changes)
const answer = await cursorAsk('Explain this function');

// Plan an approach
const plan = await cursorPlan('Refactor auth system');

// Run agent task
const result = await cursorAgent('Fix the bug in user.js');

// Open file in Cursor IDE
openInCursor('src/app.js');
```

### Cloud Handoff

Prefix with `&` to send task to cloud and continue later:
```
& Refactor the entire codebase
```
Pick up later at: https://cursor.com/agents

### Key Features

- **MCP Support** - Respects mcp.json configuration
- **Rules** - Loads from .cursor/rules, AGENTS.md, CLAUDE.md
- **Context** - Use `@` prefix to select files
- **Resume** - Continue previous conversations

### Use Cases

1. **Parallel AI Work** - Run Cursor on one task while Claude works on another
2. **Code Review** - Use `/ask` mode to analyze code
3. **Refactoring** - Use `/plan` then `/agent` for large changes
4. **Quick Fixes** - Non-interactive mode for simple tasks

---

## Bug Bounty Platforms

### HackerOne

**URL:** https://hackerone.com

**Purpose:** Bug bounty platform connecting security researchers with companies.

**Account:** (See ACCOUNTS.md for credentials)

**Getting Started:**
1. Complete profile and verify email
2. Take the Hacker101 CTF challenges for practice
3. Start with programs marked "Beginner Friendly"
4. Focus on: XSS, IDOR, CSRF, Auth bypasses

**Tips:**
- Read program policies carefully
- Start with wide-scope programs
- Document everything
- Use Burp Suite for testing

**Payout:** Typically 30-90 days after validation

---

### Bugcrowd

**URL:** https://bugcrowd.com

**Purpose:** Bug bounty and vulnerability disclosure platform.

**Account:** (See ACCOUNTS.md for credentials)

**Getting Started:**
1. Complete researcher profile
2. Verify identity if required
3. Look for "P4" and "P5" (lower severity) bugs first
4. Graduate to higher severity as skills improve

**Program Types:**
- Public programs (anyone can join)
- Private programs (invite-only, less competition)
- VDPs (Vulnerability Disclosure - reputation only)

**Payout:** Varies by program, typically faster than HackerOne

---

## Chrome Extension Development

### Overview

Chrome extensions can generate significant passive income through:
- Premium subscriptions ($3-30/month)
- Freemium with paid features
- Affiliate commissions
- One-time purchases

### Quick Start Template

**File Structure:**
```
my-extension/
├── manifest.json
├── popup.html
├── popup.js
├── background.js
├── content.js
├── styles.css
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

**manifest.json (Manifest V3):**
```json
{
  "manifest_version": 3,
  "name": "Extension Name",
  "version": "1.0.0",
  "description": "What it does",
  "permissions": ["storage", "activeTab"],
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"]
  }]
}
```

### Monetization Strategies

1. **Freemium Model:**
   - Free: Basic features
   - Paid: Advanced features, no limits
   - Use Stripe for payments

2. **Subscription (Recommended):**
   - Monthly/yearly plans
   - Use Stripe Billing or Gumroad

3. **Affiliate:**
   - Price comparison → affiliate links
   - Product recommendations

### Publishing

1. Create developer account: https://chrome.google.com/webstore/devconsole
2. Pay $5 one-time fee
3. Submit for review (1-3 days)
4. Promote via social media, Product Hunt

### High-Value Extension Ideas

| Idea | Revenue Model | Difficulty |
|------|---------------|------------|
| AI Writing Assistant | Subscription | Medium |
| Price Tracker | Affiliate | Easy |
| Tab Manager | Freemium | Easy |
| Social Scheduler | Subscription | Medium |
| Privacy Checker | Freemium | Easy |
| Job App Autofill | Subscription | Medium |

### Resources

- Chrome Extension Docs: https://developer.chrome.com/docs/extensions/
- Manifest V3 Migration: https://developer.chrome.com/docs/extensions/mv3/intro/
- Chrome Web Store: https://chrome.google.com/webstore/devconsole

---

*Add new workflows as they are discovered/documented.*
