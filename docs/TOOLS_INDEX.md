# TeleClaude Tools & Capabilities Index

**Last Updated:** 2026-01-31

This document indexes all tools, utilities, and capabilities available in the TeleClaude system.

---

## Quick Reference

| Category | Tool | Location | Status |
|----------|------|----------|--------|
| **Messaging** | Discord Bridge | `mcp/discord-bridge.js` | ✅ Active |
| **Memory** | Persistent Memory | `mcp/memory-server.js` | ✅ Active |
| **Browser** | Playwright | `utils/playwright_helpers.js` | ✅ Ready |
| **AI Assistant** | Cursor CLI | `utils/cursor_cli.js` | ✅ Ready |
| **Passwords** | KeePass Manager | `utils/keepass_manager.js` | ✅ Ready |
| **Security** | Docker Security | `utils/docker_security.js` | ✅ Ready |
| **Practice Labs** | Practice Targets | `utils/practice_targets.js` | ✅ Ready |
| **WSL Bridge** | Kali Linux | `utils/wsl_bridge.js` | ✅ Ready |
| **Cyber Tools** | Nmap, Ghidra, etc. | `mcp/cyber-tools.js` | ✅ Ready |
| **Sysinternals** | Windows Tools | `tools/sysinternals/` | ✅ Ready |
| **Image Gen** | DALL-E 3 | `utils/image_generator.js` | ⚠️ Needs API Key |
| **TTS** | OpenAI TTS | `utils/tts_generator.js` | ⚠️ Needs API Key |

---

## Detailed Tool Categories

### 1. Communication & Automation

| Tool | Purpose | Usage |
|------|---------|-------|
| Discord MCP | Send messages to user | `send_to_discord(message)` |
| Gmail Helper | Email access | `node utils/gmail_helper.js` |
| Playwright | Browser automation | `utils/playwright_helpers.js` |
| Credentials | Auto-fill logins | `utils/credentials.js` |
| CAPTCHA Handler | Solve CAPTCHAs | `utils/captcha_handler.js` |

### 2. Security & Pentesting

| Tool | Purpose | Command |
|------|---------|---------|
| **Nmap** | Port scanning | `nmap -sV target` |
| **Nikto** | Web vulnerability | `nikto -h target` |
| **Gobuster** | Directory fuzzing | `gobuster dir -u target -w wordlist` |
| **SQLMap** | SQL injection | `sqlmap -u "url?id=1"` |
| **Hydra** | Password cracking | `hydra -l user -P pass.txt target ssh` |
| **John** | Hash cracking | `john --wordlist=dict.txt hashes` |
| **Hashcat** | GPU hash cracking | `hashcat -m 0 hashes.txt wordlist` |
| **Metasploit** | Exploitation | `msfconsole` |

### 3. Docker Containers

#### Security Containers (Anonymity)

| Container | Anonymity Level | Command |
|-----------|-----------------|---------|
| kali-tools | None (direct) | `node utils/docker_security.js start none` |
| kali-anon | Tor | `node utils/docker_security.js start tor` |
| kali-vpn | VPN | `node utils/docker_security.js start vpn` |
| kali-full-anon | VPN + Tor | `node utils/docker_security.js start full` |

#### Practice Targets (Vulnerable Labs)

| Target | Port | Start Command |
|--------|------|---------------|
| DVWA | 8081 | `node utils/practice_targets.js start dvwa` |
| Juice Shop | 3000 | `node utils/practice_targets.js start juice-shop` |
| WebGoat | 8080 | `node utils/practice_targets.js start webgoat` |
| bWAPP | 8082 | `node utils/practice_targets.js start bwapp` |
| Mutillidae | 8083 | `node utils/practice_targets.js start mutillidae` |
| NodeGoat | 4000 | `node utils/practice_targets.js start nodegoat` |
| WordPress | 8084 | `node utils/practice_targets.js start wordpress` |
| crAPI | 8888 | `node utils/practice_targets.js start crapi` |
| SSH | 2222 | `node utils/practice_targets.js start ssh` |

### 4. Windows Tools (Sysinternals)

| Tool | Purpose | Location |
|------|---------|----------|
| Autoruns | Startup analysis | `tools/sysinternals/autoruns.exe` |
| Process Explorer | Advanced task manager | `tools/sysinternals/procexp.exe` |
| TCPView | Network connections | `tools/sysinternals/tcpview.exe` |
| Process Monitor | Real-time monitoring | `tools/sysinternals/procmon.exe` |
| Strings | Binary string extraction | `tools/sysinternals/strings.exe` |
| PsExec | Remote execution | `tools/sysinternals/psexec.exe` |

### 5. Reverse Engineering

| Tool | Purpose | Usage |
|------|---------|-------|
| Ghidra | Disassembly/Decompile | `analyzeHeadless` |
| Radare2 | RE framework | `r2 binary` |
| Binwalk | Firmware analysis | `binwalk -e firmware.bin` |
| Strings | String extraction | `strings binary` |

### 6. AI & Media

| Tool | Purpose | Usage |
|------|---------|-------|
| Cursor CLI | Parallel AI coding | `node utils/cursor_cli.js agent "task"` |
| DALL-E 3 | Image generation | `utils/image_generator.js` |
| OpenAI TTS | Text-to-speech | `utils/tts_generator.js` |

### 7. Data & Credentials

| Tool | Purpose | Usage |
|------|---------|-------|
| KeePass Manager | Password backup | `node utils/keepass_manager.js` |
| ACCOUNTS.md | Account credentials | Human-readable |
| API_KEYS.md | API keys | Human-readable |

---

## File Locations

```
teleclaude-main/
├── CLAUDE.md                    # Main operating instructions
├── SKILLS.md                    # Detailed skill documentation
├── ACCOUNTS.md                  # Account credentials
├── API_KEYS.md                  # API keys storage
├── docs/
│   ├── SECURITY_TOOLS_REFERENCE.md  # Security tool guides
│   └── TOOLS_INDEX.md           # This file
├── docker/
│   ├── docker-compose.yml       # Main compose file
│   ├── kali-tools/              # Base security container
│   ├── kali-anon/               # Tor anonymity container
│   ├── vpn-gateway/             # VPN routing container
│   └── practice-targets/        # Vulnerable labs
├── tools/
│   └── sysinternals/            # Windows security tools (70+)
├── utils/
│   ├── wsl_bridge.js            # WSL command execution
│   ├── docker_security.js       # Docker container manager
│   ├── practice_targets.js      # Practice labs manager
│   ├── keepass_manager.js       # Password backup
│   ├── cursor_cli.js            # Cursor AI integration
│   ├── playwright_helpers.js    # Browser automation
│   ├── credentials.js           # Auto-fill credentials
│   ├── captcha_handler.js       # CAPTCHA handling
│   ├── gmail_helper.js          # Gmail access
│   ├── image_generator.js       # DALL-E 3
│   └── tts_generator.js         # Text-to-speech
├── secure/
│   └── teleclaude_passwords.kdbx  # KeePass database
├── browser_state/
│   └── google_auth.json         # Browser session
└── logs/
    ├── wsl_commands.log         # WSL audit log
    └── cyber_tools.log          # Security tools log
```

---

## WSL Kali Linux Tools

### Installed/Installing

- **Reconnaissance:** nmap, masscan, rustscan
- **Web Testing:** nikto, gobuster, dirb, ffuf, sqlmap, whatweb, wpscan
- **Password:** hydra, john, hashcat
- **Exploitation:** metasploit-framework
- **Wireless:** aircrack-ng
- **OSINT:** theharvester, recon-ng, subfinder, amass
- **Analysis:** nuclei, enum4linux

### Whitelisted (120+ tools)

See `utils/wsl_bridge.js` for complete ALLOWED_TOOLS list.

---

## Security Protocols

### Permission Required

Before using offensive tools, must provide:
- **WHO:** Target system
- **WHAT:** Tool and action
- **WHERE:** IP/domain
- **WHEN:** Timing
- **WHY:** Purpose
- **HOW:** Plain English explanation

### Logging

All security operations logged to:
- `logs/wsl_commands.log`
- `logs/cyber_tools.log`

### Authorized Targets

Only scan systems in `config/cyber_authorized_targets.json`:
- localhost / 127.0.0.1
- Private ranges (192.168.*.*, 10.*.*.*, 172.16.*.*)
- Explicitly authorized targets

---

## Quick Start Commands

```bash
# Security scan (needs permission)
node utils/docker_security.js start tor
node utils/docker_security.js shell tor

# Practice hacking
node utils/practice_targets.js start dvwa
# Then visit http://localhost:8081

# Check passwords
node utils/keepass_manager.js list "YOUR_PASSWORD_HERE"

# AI assistance
node utils/cursor_cli.js ask "explain this code"

# System analysis
.\tools\sysinternals\procexp.exe
```

---

*This index is automatically referenced by Claude for capability awareness.*
