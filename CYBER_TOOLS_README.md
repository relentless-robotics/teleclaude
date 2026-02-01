# Cybersecurity Tools Integration

This directory contains WSL2-based cybersecurity tools integrated as MCP skills for Teleclaude.

## Quick Start

### 1. Install WSL2 and Kali Linux

**Run as Administrator in PowerShell:**

```powershell
cd C:\Users\Footb\Documents\Github\teleclaude-main
.\setup_wsl_kali.ps1
```

This will:
- Enable WSL2 features (may require restart)
- Install Kali Linux distribution
- Install security tools (nmap, nikto, gobuster, ghidra, etc.)
- Set up directory structure

**Note:** You may be prompted to create a username/password for Kali Linux on first launch.

### 2. Verify Installation

```bash
node test_cyber_tools.js
```

This will check:
- WSL availability
- Kali Linux installation
- Security tool installation status
- Configuration

### 3. Configure Authorized Targets

Edit `config/cyber_authorized_targets.json` to authorize scan targets:

```json
{
  "authorized_targets": [
    "127.0.0.1",
    "localhost",
    "192.168.1.100"
  ]
}
```

**CRITICAL:** Only add systems you own or have explicit permission to test.

## Available Modules

### 1. WSL Bridge (`utils/wsl_bridge.js`)

Execute commands in WSL2 from Node.js with safety controls.

**Features:**
- Tool whitelisting
- Command validation
- Dangerous pattern blocking
- Automatic logging
- Timeout protection
- Path conversion (Windows ↔ WSL)

**Example:**
```javascript
const { runInWSL, runTool } = require('./utils/wsl_bridge');

// Run whitelisted tool
const result = await runTool('nmap', ['-sV', 'localhost']);

// Execute validated command
const output = await runInWSL('ping -c 4 127.0.0.1');
```

### 2. Ghidra Bridge (`utils/ghidra_bridge.js`)

Headless Ghidra analysis for reverse engineering.

**Features:**
- Binary analysis
- Function decompilation
- String extraction
- Function listing
- Automated script execution

**Example:**
```javascript
const { analyzeBinary, decompileFunction } = require('./utils/ghidra_bridge');

// Analyze binary
const analysis = await analyzeBinary('C:\\path\\to\\binary.exe');

// Decompile function
const code = await decompileFunction('C:\\path\\to\\binary.exe', '0x401000');
```

### 3. Cyber Tools Skill (`mcp/cyber-tools.js`)

High-level security testing interface.

**Categories:**
- **Network Reconnaissance:** nmap, DNS enumeration, masscan
- **Web Security:** nikto, gobuster, ffuf
- **Reverse Engineering:** Ghidra integration

**Example:**
```javascript
const { nmapScan, niktoScan, analyzeWithGhidra } = require('./mcp/cyber-tools');

// Port scan
const ports = await nmapScan('192.168.1.100', {
  scanType: 'service',
  ports: '1-1000'
});

// Web vulnerability scan
const vulns = await niktoScan('http://localhost:8080');

// Binary analysis
const analysis = await analyzeWithGhidra('C:\\suspicious.exe');
```

## Security Features

### 1. Target Authorization

All targets must be in `config/cyber_authorized_targets.json`.

Supported formats:
- Exact IP: `"192.168.1.100"`
- Hostname: `"myserver.local"`
- Wildcard: `"192.168.*.*"`

### 2. Tool Whitelisting

Only approved tools can run. See `ALLOWED_TOOLS` in `utils/wsl_bridge.js`.

Currently whitelisted:
- Network: nmap, masscan, rustscan, ping, traceroute
- Web: nikto, gobuster, ffuf, wfuzz, dirb, curl, wget
- Reverse Engineering: ghidra, analyzeHeadless, strings, objdump
- Analysis: tcpdump, wireshark, strace, ltrace

### 3. Dangerous Command Blocking

Commands matching these patterns are blocked:
- `rm -rf` (destructive file operations)
- `mkfs` (filesystem formatting)
- `dd if=` (disk writing)
- Fork bombs
- `chmod -R 777` (permission changes)
- System shutdown commands

### 4. Logging

All operations logged to:
- `logs/cyber_tools.log` - High-level operations
- `logs/wsl_commands.log` - Low-level WSL commands

### 5. Timeout Protection

All commands have configurable timeouts (default: 5 minutes for WSL, 10 minutes for Ghidra).

## Common Workflows

### Network Scanning

**TCP port scan:**
```javascript
const { nmapScan } = require('./mcp/cyber-tools');

const result = await nmapScan('192.168.1.100', {
  scanType: 'tcp',
  ports: '1-1000',
  verbose: true
});
```

**Service version detection:**
```javascript
const result = await nmapScan('192.168.1.100', {
  scanType: 'service',
  ports: '80,443,3000,8080'
});
```

**Vulnerability scan:**
```javascript
const result = await nmapScan('192.168.1.100', {
  scanType: 'vuln',
  ports: '1-1000'
});
```

### Web Application Testing

**Directory enumeration:**
```javascript
const { gobusterDir } = require('./mcp/cyber-tools');

const result = await gobusterDir(
  'http://localhost:8080',
  '/usr/share/wordlists/dirb/common.txt',
  { extensions: 'php,html,txt' }
);
```

**Vulnerability scanning:**
```javascript
const { niktoScan } = require('./mcp/cyber-tools');

const result = await niktoScan('http://localhost:8080', {
  port: 8080,
  ssl: false
});
```

### Reverse Engineering

**Analyze binary:**
```javascript
const { analyzeWithGhidra, listBinaryFunctions, binaryStrings } = require('./mcp/cyber-tools');

// Full analysis
const analysis = await analyzeWithGhidra('C:\\malware.exe');

// List functions
const functions = await listBinaryFunctions('C:\\malware.exe');

// Extract strings
const strings = await binaryStrings('C:\\malware.exe', 4);
```

**Decompile function:**
```javascript
const { decompile } = require('./mcp/cyber-tools');

const code = await decompile('C:\\binary.exe', 'main');
// or by address
const code = await decompile('C:\\binary.exe', '0x401000');
```

## Troubleshooting

### WSL not installed

**Error:** "WSL is not available"

**Solution:**
1. Run `setup_wsl_kali.ps1` as Administrator
2. Restart computer if prompted
3. Launch Kali for first-time setup: `wsl -d kali-linux`

### Tool not found

**Error:** "Command 'nmap' is not in the whitelist"

**Solution:** Tool is not installed in Kali.

```bash
wsl -d kali-linux
sudo apt update
sudo apt install nmap
```

### Command validation failed

**Error:** "Command validation failed: not in whitelist"

**Solution:** Add tool to `ALLOWED_TOOLS` in `utils/wsl_bridge.js`, or use `skipValidation: true` (with caution).

### Target not authorized

**Error:** "Target X is not authorized"

**Solution:** Add target to `config/cyber_authorized_targets.json`.

### Ghidra timeout

**Error:** Analysis times out

**Solution:** Increase timeout for large binaries:

```javascript
const result = await analyzeWithGhidra('large.exe', {
  timeout: 1200000  // 20 minutes
});
```

### Permission denied

**Error:** "Permission denied" when running tool

**Solution:** Some tools require sudo (not currently supported). Use non-privileged alternatives:
- `nmap -sT` instead of `nmap -sS` (TCP connect vs SYN scan)
- `masscan` with non-privileged ports

## Best Practices

### 1. Always Verify Authorization

```javascript
const { isAuthorizedTarget } = require('./mcp/cyber-tools');

if (!await isAuthorizedTarget(target)) {
  throw new Error('Target not authorized');
}
```

### 2. Start with Least Aggressive Scans

- Ping scan before port scan
- TCP connect before SYN scan
- Limited port range before full scan

### 3. Monitor Logs

```bash
# Review operations
cat logs/cyber_tools.log

# Check WSL commands
cat logs/wsl_commands.log
```

### 4. Clean Up After Analysis

```javascript
const { cleanupProjects } = require('./utils/ghidra_bridge');

// Delete Ghidra projects older than 24 hours
await cleanupProjects(24);
```

### 5. Document Findings

- Keep notes on discovered vulnerabilities
- Save scan results to files
- Use responsible disclosure for findings

## Legal & Ethical Guidelines

**WHITE HAT ONLY:**

1. Only test systems you own or have explicit written permission to test
2. Never scan external networks without authorization
3. Report vulnerabilities responsibly to system owners
4. Understand local laws regarding security testing
5. All operations are logged - maintain accountability
6. Never use tools for malicious purposes
7. Respect rate limits and avoid DoS conditions

**Violation of these guidelines may be illegal and is strictly prohibited.**

## File Structure

```
teleclaude-main/
├── setup_wsl_kali.ps1          # WSL2 setup script
├── test_cyber_tools.js          # Integration test script
├── CYBER_TOOLS_README.md        # This file
├── utils/
│   ├── wsl_bridge.js            # WSL command execution
│   └── ghidra_bridge.js         # Ghidra integration
├── mcp/
│   └── cyber-tools.js           # High-level security tools
├── config/
│   └── cyber_authorized_targets.json  # Target whitelist
└── logs/
    ├── cyber_tools.log          # Operation log
    └── wsl_commands.log         # Command log
```

## Additional Resources

**Kali Linux Documentation:**
- https://www.kali.org/docs/

**Tool Documentation:**
- nmap: https://nmap.org/book/man.html
- nikto: https://github.com/sullo/nikto
- gobuster: https://github.com/OJ/gobuster
- Ghidra: https://ghidra-sre.org/

**Security Testing Guides:**
- OWASP Testing Guide: https://owasp.org/www-project-web-security-testing-guide/
- PTES: http://www.pentest-standard.org/

## Support

For issues or questions:
1. Check this README
2. Review SKILLS.md for workflow examples
3. Check CLAUDE.md for integration details
4. Review logs for error details

---

**Remember: Use these tools responsibly and ethically. Only test systems you own or have explicit permission to test.**
