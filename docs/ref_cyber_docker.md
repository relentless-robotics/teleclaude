## CYBERSECURITY TOOLS (WSL2 Integration + Sysinternals)

**You have access to professional cybersecurity tools via WSL2 Kali Linux AND Microsoft Sysinternals Suite.**

### Setup Status

Before using cyber tools, verify installations:
- **WSL2 Setup:** `setup_wsl_kali.ps1` (run as Administrator)
- **WSL Status Check:** Import cyber-tools module and call `checkStatus()`
- **Sysinternals:** ✅ Downloaded and ready at `tools/sysinternals/`

### Available Modules

1. **WSL Bridge** (`utils/wsl_bridge.js`)
   - Execute commands in WSL2 from Node.js
   - Tool whitelisting and validation
   - Command logging for audit trail

2. **Ghidra Bridge** (`utils/ghidra_bridge.js`)
   - Headless Ghidra analysis
   - Binary decompilation
   - Function listing and string extraction

3. **Cyber Tools** (`mcp/cyber-tools.js`)
   - Network reconnaissance (nmap, masscan)
   - Web security testing (nikto, gobuster, ffuf)
   - Reverse engineering (Ghidra integration)

4. **Sysinternals Suite** (`tools/sysinternals/`)
   - 70+ Windows security/diagnostic tools
   - Process Explorer, Autoruns, TCPView, Process Monitor
   - String extraction, registry analysis, network monitoring
   - See SKILLS.md for detailed usage guide

### Security Policy - CRITICAL

**WHITE HAT ONLY. All scanning is logged.**

### MANDATORY: Permission Required for Security Tools

**Before using ANY offensive/colorhat security tool, I MUST ask for explicit permission with:**

| Question | What to Explain |
|----------|-----------------|
| **WHO** | Target system/network/IP |
| **WHAT** | Specific tool and action |
| **WHERE** | Exact IP/domain being tested |
| **WHEN** | Immediate or scheduled |
| **WHY** | Purpose and goal of the test |
| **HOW** | Plain English explanation of what the tool does |

**Example Request:**
```
"May I run an nmap service scan on 192.168.1.100?

WHO: Your local server at 192.168.1.100
WHAT: nmap with -sV flag (version detection)
WHERE: 192.168.1.100 ports 1-1000
WHEN: Now
WHY: Discover what services are running
HOW: Sends TCP probes to identify service versions on open ports

Approve? (yes/no)"
```

**Tools requiring permission:**
- Network scanners (nmap, masscan, rustscan)
- Web scanners (nikto, gobuster, sqlmap)
- Password tools (hydra, john, hashcat)
- Exploitation frameworks (metasploit)
- Any tool that sends probes to external targets

**Exceptions (no permission needed):**
- Reading local files/logs
- Analyzing binaries with Ghidra (offline)
- Passive OSINT (theHarvester, amass passive mode)
- Localhost-only scans (127.0.0.1)

---

1. **Target Authorization**
   - Only scan targets listed in `config/cyber_authorized_targets.json`
   - Default authorized: localhost, 127.0.0.1, private IP ranges (192.168.*.*, 10.0.*.*, 172.16.*.*)
   - Scanning unauthorized targets is ILLEGAL

2. **Logging**
   - All operations logged to `logs/cyber_tools.log`
   - All WSL commands logged to `logs/wsl_commands.log`

3. **Tool Whitelist**
   - Only approved security tools can run
   - See `ALLOWED_TOOLS` in `wsl_bridge.js`

4. **Dangerous Command Protection**
   - Commands like `rm -rf`, `dd`, fork bombs are blocked
   - Validation occurs before execution

### Usage Examples

**Network Scanning:**
```javascript
const { nmapScan, dnsEnum } = require('./mcp/cyber-tools');

// TCP scan localhost
const result = await nmapScan('127.0.0.1', {
  scanType: 'tcp',
  ports: '1-1000'
});

// Service version detection
const services = await nmapScan('192.168.1.100', {
  scanType: 'service',
  ports: '80,443,8080'
});

// DNS enumeration
const dns = await dnsEnum('example.com');
```

**Web Security Testing:**
```javascript
const { niktoScan, gobusterDir } = require('./mcp/cyber-tools');

// Web vulnerability scan
const vulns = await niktoScan('http://localhost:8080', {
  port: 8080
});

// Directory enumeration
const dirs = await gobusterDir('http://localhost:8080',
  '/usr/share/wordlists/dirb/common.txt'
);
```

**Reverse Engineering:**
```javascript
const { analyzeWithGhidra, decompile, binaryStrings } = require('./mcp/cyber-tools');

// Analyze binary with Ghidra
const analysis = await analyzeWithGhidra('C:\\path\\to\\binary.exe');

// Decompile specific function
const code = await decompile('C:\\path\\to\\binary.exe', '0x401000');

// Extract strings
const strings = await binaryStrings('C:\\path\\to\\binary.exe', 4);
```

**Direct WSL Commands:**
```javascript
const { runInWSL, runTool } = require('./utils/wsl_bridge');

// Run whitelisted tool
const result = await runTool('nmap', ['-sV', 'localhost']);

// Execute command (validated against whitelist)
const output = await runInWSL('ping -c 4 127.0.0.1');
```

### Adding Authorized Targets

To authorize a new target, edit `config/cyber_authorized_targets.json`:

```json
{
  "authorized_targets": [
    "127.0.0.1",
    "localhost",
    "192.168.1.100",
    "myserver.local"
  ]
}
```

Supports wildcards: `"192.168.*.*"` matches entire subnet.

### Best Practices

1. **Always verify authorization** before scanning
2. **Use least aggressive scan types** to avoid disruption
3. **Monitor logs** to track all security operations
4. **Responsible disclosure** - report vulnerabilities to owners
5. **Never scan external targets** without written permission
6. **Document findings** in logs or reports
7. **Clean up** - Use `cleanupProjects()` for old Ghidra data

### Tool Availability Check

```javascript
const { checkStatus } = require('./mcp/cyber-tools');

const status = await checkStatus();
// Returns: { wsl: true/false, tools: {...}, config: {...} }
```

### Troubleshooting

**WSL not available:**
- Run `setup_wsl_kali.ps1` as Administrator
- May require system restart after enabling features

**Tool not installed:**
- Run: `wsl -d kali-linux`
- Install: `sudo apt install [tool-name]`

**Permission denied:**
- Some tools require sudo (will fail in current implementation)
- Run non-privileged scans when possible

**Command blocked:**
- Check if tool is in ALLOWED_TOOLS whitelist
- Verify command doesn't match DANGEROUS_PATTERNS

---

## DOCKER CONTAINERIZATION (WSL2)

**You have access to Docker in WSL2 Kali Linux for containerizing services.**

### Setup Status

- **Docker Version:** 27.5.1
- **Docker Compose:** 2.32.4
- **Location:** WSL2 Kali Linux (`wsl -d kali-linux`)
- **User:** teleclaude (password: YOUR_PASSWORD_HERE)

### Quick Commands

```bash
# Run Docker commands via WSL
wsl -d kali-linux -u teleclaude -- docker ps
wsl -d kali-linux -u teleclaude -- docker images
wsl -d kali-linux -u teleclaude -- docker-compose up -d

# Start Docker service (if not running)
wsl -d kali-linux -u root -- service docker start
```

### Node.js Integration

```javascript
const { runInWSL, runTool } = require('./utils/wsl_bridge');

// Run Docker commands
const containers = await runTool('docker', ['ps', '-a']);
const images = await runTool('docker', ['images']);

// Build and run containers
await runTool('docker', ['build', '-t', 'myapp', '.']);
await runTool('docker', ['run', '-d', '--name', 'myapp', 'myapp']);

// Docker Compose
await runTool('docker-compose', ['up', '-d']);
await runTool('docker-compose', ['logs', '-f']);
```

### Use Cases

1. **Containerized Security Tools**
   - Run security scanners in isolated containers
   - Disposable environments for malware analysis
   - Network segmentation for testing

2. **AI Agent Clones**
   - Run multiple Claude instances in containers
   - Parallel task processing
   - Isolated workspaces

3. **Service Deployment**
   - Web servers (nginx, Apache)
   - Databases (PostgreSQL, MongoDB)
   - Custom APIs and services

### Example Dockerfiles

**Security Scanner Container:**
```dockerfile
FROM kalilinux/kali-rolling
RUN apt update && apt install -y nmap nikto gobuster
CMD ["/bin/bash"]
```

**Node.js Service:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

### Docker Commands Reference

| Command | Purpose |
|---------|---------|
| `docker ps` | List running containers |
| `docker ps -a` | List all containers |
| `docker images` | List images |
| `docker build -t name .` | Build image |
| `docker run -d name` | Run container detached |
| `docker exec -it name bash` | Shell into container |
| `docker logs name` | View container logs |
| `docker stop name` | Stop container |
| `docker rm name` | Remove container |
| `docker rmi name` | Remove image |
| `docker-compose up -d` | Start all services |
| `docker-compose down` | Stop all services |

### Storage & Volumes

Docker data in WSL is stored at:
- Images/Containers: `/var/lib/docker/`
- Volumes: `/var/lib/docker/volumes/`

To persist data, use volumes:
```bash
docker run -v /host/path:/container/path myimage
```

### Networking

- Containers can access Windows via `host.docker.internal`
- WSL2 ports are accessible from Windows
- Use `-p hostport:containerport` for port mapping

---

