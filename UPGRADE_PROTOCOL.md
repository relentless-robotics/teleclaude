# UPGRADE_PROTOCOL.md - Safe Upgrade Procedure for TeleClaude

**CRITICAL: Follow this protocol exactly when reviewing external sources.**

This document ensures no data loss during upgrades by protecting critical files, and establishes our "Trust No Code, Only Ideas" security policy.

---

## SECURITY FIRST: Trust No Code, Only Ideas

**READ [SECURITY_POLICY.md](./SECURITY_POLICY.md) BEFORE ANY EXTERNAL CODE REVIEW.**

We do NOT copy code from external repositories. Instead:
1. Review external repos for **ideas and concepts** only
2. Document what we learned
3. Implement features **ourselves from scratch**
4. Test in Docker first
5. Deploy to production only after Docker testing passes

---

## Quick Reference - Decision Matrix

| File | Source | Action | Reason |
|------|--------|--------|--------|
| `lib/logger.js` | Both | REVIEW | Compare implementations, keep ours |
| `lib/platform.js` | Both | PRESERVE LOCAL | Has Discord additions (`getDiscordOutputFile`, `getCommandPath`) |
| `package.json` | Both | PRESERVE LOCAL | Has Discord.js, Playwright dependencies |
| `.gitignore` | Both | REVIEW FOR IDEAS | Check what patterns upstream ignores |
| `index.js` | External | REVIEW FOR IDEAS | Analyze approach, implement our own version |
| `chat.js` | External | REVIEW FOR IDEAS | Understand chat mode concept, implement ourselves |
| `start-daemon.sh` | External | REVIEW FOR IDEAS | Unix daemon pattern, implement ourselves |
| `CLAUDE.md` | Both | PRESERVE LOCAL | Has extensive Discord/automation docs |
| `lib/discord.js` | Local | PRESERVE | Local-only Discord implementation |
| `mcp/discord-*.js` | Local | PRESERVE | Local-only Discord MCP |
| `utils/*.js` | Local | PRESERVE | Local-only utilities |

---

## Pre-Upgrade Checklist

### Step 1: Verify Current State

```powershell
cd C:\Users\Footb\Documents\Github\teleclaude-main

# Check for uncommitted changes
git status

# Note current package version
type package.json | findstr version
```

### Step 2: Create Backup

**MANDATORY: Run this before ANY upgrade.**

```powershell
# Set backup location
$timestamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
$backupDir = "C:\Users\Footb\Documents\teleclaude-backup-$timestamp"
New-Item -ItemType Directory -Path $backupDir -Force

# === CRITICAL FILES ===
Copy-Item ".\ACCOUNTS.md" "$backupDir\" -Force
Copy-Item ".\API_KEYS.md" "$backupDir\" -Force
Copy-Item ".\config.json" "$backupDir\" -Force
Copy-Item ".\CLAUDE.md" "$backupDir\" -Force

# === BROWSER SESSIONS ===
if (Test-Path ".\browser_state") { Copy-Item ".\browser_state" "$backupDir\browser_state" -Recurse }
if (Test-Path ".\browser-data") { Copy-Item ".\browser-data" "$backupDir\browser-data" -Recurse }
if (Test-Path ".\browser_profile_stripe") { Copy-Item ".\browser_profile_stripe" "$backupDir\browser_profile_stripe" -Recurse }
if (Test-Path ".\browser_profile_edge") { Copy-Item ".\browser_profile_edge" "$backupDir\browser_profile_edge" -Recurse }
if (Test-Path ".\twitter-browser-data") { Copy-Item ".\twitter-browser-data" "$backupDir\twitter-browser-data" -Recurse }

# === LOCAL-ONLY CODE ===
Copy-Item ".\lib\discord.js" "$backupDir\" -Force
Copy-Item ".\mcp\discord-bridge.js" "$backupDir\" -Force
Copy-Item ".\mcp\discord-config.json" "$backupDir\" -Force
if (Test-Path ".\utils") { Copy-Item ".\utils" "$backupDir\utils" -Recurse }

# === WALLET KEYS ===
if (Test-Path ".\.keys") { Copy-Item ".\.keys" "$backupDir\.keys" -Recurse }

Write-Host "Backup created: $backupDir" -ForegroundColor Green
```

### Step 3: Verify Backup

```powershell
# List backup contents
Get-ChildItem $backupDir -Recurse | Measure-Object

# Should show: ACCOUNTS.md, API_KEYS.md, config.json, CLAUDE.md, discord.js, etc.
Get-ChildItem $backupDir
```

---

## Security Review Framework

When reviewing external code for ideas, use this checklist:

### Security Review Checklist

- [ ] **No malicious patterns** - No suspicious network calls, no credential harvesting
- [ ] **Understand the algorithm** - Can you explain it in plain language?
- [ ] **Identify dependencies** - What libraries does it use? Are they reputable?
- [ ] **Document the concept** - Write down the idea, not the code
- [ ] **Plan own implementation** - Design how YOU will implement it

### Questions to Answer

| Question | Your Answer |
|----------|-------------|
| What problem does this solve? | |
| What is the general approach? | |
| What edge cases does it handle? | |
| What can we learn from it? | |
| How will we implement it ourselves? | |

### Example Review

```
External File: index.js (from gatordevin/teleclaude)

CONCEPT IDENTIFIED:
- Unified CLI/Telegram mode selection via command-line args
- Photo/document handling from Telegram
- Process management commands

WHAT WE LEARNED:
- Mode selection pattern using process.argv
- Telegram media handling approach
- Signal handling for graceful shutdown

OUR IMPLEMENTATION PLAN:
- Create our own index.js with mode selection
- Add Discord support (not in external)
- Implement media handling for both platforms
- Write our own process management
```

---

## Detailed File Comparison Results

### 1. lib/logger.js - IDENTICAL

Both versions are byte-for-byte identical. Either can be used.

**Action:** No change needed.

---

### 2. lib/platform.js - LOCAL WINS

| Feature | Upstream | Local |
|---------|----------|-------|
| `getOutputFile()` | Yes | Yes |
| `getDiscordOutputFile()` | NO | Yes |
| `getCommandPath()` | NO | Yes |
| All other functions | Same | Same |

**Why Local Wins:**
- Local is a superset of upstream
- Discord mode requires `getDiscordOutputFile()`
- Windows EXE resolution requires `getCommandPath()`

**Action:** Keep local version. If upstream adds new functions, merge them into local.

---

### 3. package.json - LOCAL WINS

| Dependency | Upstream | Local | Purpose |
|------------|----------|-------|---------|
| `node-telegram-bot-api` | Yes | Yes | Telegram |
| `node-pty` | Yes | Yes | PTY |
| `strip-ansi` | Yes | Yes | ANSI cleanup |
| `ethers` | Yes | NO | Crypto (unused) |
| `discord.js` | NO | Yes | Discord bot |
| `playwright` | NO | Yes | Browser automation |
| `@solana/web3.js` | NO | Yes | Solana wallet |
| `bs58` | NO | Yes | Base58 encoding |

**Why Local Wins:**
- Local has Discord.js for Discord mode
- Local has Playwright for browser automation
- Local has crypto dependencies for autonomy experiments
- Upstream has ethers.js which is unused

**Action:** Keep local package.json. When upgrading:
1. Check upstream for new dependencies
2. Add any new deps to local package.json
3. Run `npm install` after changes

---

### 4. .gitignore - MERGE BOTH

**Upstream additions to merge into local:**

```gitignore
# Wallet keys and crypto credentials
WALLET_KEYS.md

# Personal project tracking
PROJECTS.md

# MCP server configurations (may contain tokens/credentials)
mcp-servers/
MCP_CONFIG.md
.playwright-mcp/

# Separate projects (not part of TeleClaude)
contentmorph/

# Daemon logs
teleclaude-daemon.log

# Downloaded images and profile pictures
images/
*.png
*.jpg
*.jpeg
!screenshots/
```

**Action:** Append upstream entries to local .gitignore.

---

### 5. index.js - EXTERNAL SOURCE (REVIEW FOR IDEAS)

External repo has a complete `index.js` with:
- CLI/Telegram mode selection
- Photo/document handling from Telegram
- Process management commands
- Configuration bootstrap

**Local does NOT have this file.** It relies on separate entry points.

**Action (Trust No Code, Only Ideas):**
1. REVIEW external index.js for ideas and patterns
2. DOCUMENT the concepts (mode selection, media handling, etc.)
3. IMPLEMENT our own version from scratch with Discord support
4. TEST in Docker first before production

---

### 6. chat.js - EXTERNAL SOURCE (REVIEW FOR IDEAS)

External repo has a local CLI chat mode without needing Telegram/Discord.

**Action (Trust No Code, Only Ideas):**
1. REVIEW external chat.js for the concept
2. UNDERSTAND how local chat mode works
3. IMPLEMENT our own version from scratch
4. TEST in Docker first before production

---

### 7. start-daemon.sh - EXTERNAL SOURCE (REVIEW FOR IDEAS)

External repo has a Unix daemon script for background operation.

**Action (Trust No Code, Only Ideas):**
1. REVIEW for daemon patterns
2. IMPLEMENT our own version from scratch
3. Use relative paths
4. TEST in Docker first before production

---

### 8. CLAUDE.md - LOCAL WINS

| Section | Upstream | Local |
|---------|----------|-------|
| Basic messaging instructions | Yes | Yes |
| Discord support | NO | Yes |
| Browser authentication | NO | Yes |
| CAPTCHA handling | NO | Yes |
| Account management | NO | Yes |
| Credential helper docs | NO | Yes |

**Why Local Wins:**
- Local has extensive Discord documentation
- Local has browser automation protocols
- Local has account/credential management
- Upstream is Telegram-only and simpler

**Action:** Keep local version. Review upstream for any new workflow additions.

---

## Safe Feature Implementation Procedure

**REMEMBER: We review for ideas, implement ourselves. See [SECURITY_POLICY.md](./SECURITY_POLICY.md)**

### Phase 1: Review External Sources

Review external repos for ideas only:

```
1. Open external repo in browser (do NOT clone)
2. Read files to understand concepts
3. Document ideas in EXTERNAL_IDEAS_LOG.md
4. Close browser - no code copied
```

### Phase 2: Design Our Implementation

```
1. Based on ideas gathered, design our approach
2. Consider Discord support (not in external)
3. Plan our own architecture
4. Choose our own dependencies (audited)
```

### Phase 3: Implement From Scratch

```
1. Write new files ourselves (no copy-paste)
2. Follow our coding standards
3. Add comprehensive error handling
4. Include logging for debugging
```

### Phase 4: Docker Testing (MANDATORY)

```powershell
# Build and test in Docker BEFORE production
docker build -t teleclaude-test .
docker run -it --rm teleclaude-test

# Verify all functionality works
# Only proceed to Phase 5 if Docker tests pass
```

### Phase 5: Production Deployment

```powershell
# Only after Docker testing passes:
# Deploy changes to production
```

### Phase 6: Post-Implementation Verification

```powershell
$main = "C:\Users\Footb\Documents\Github\teleclaude-main"

# Verify critical files still exist
Test-Path "$main\ACCOUNTS.md"
Test-Path "$main\API_KEYS.md"
Test-Path "$main\config.json"
Test-Path "$main\lib\discord.js"
Test-Path "$main\mcp\discord-bridge.js"

# Verify dependencies
cd $main
npm install

# Test Discord mode
node lib\discord.js
```

### Phase 7: Update Documentation

```
1. Update EXTERNAL_IDEAS_LOG.md with implementation status
2. Mark Docker test as passed
3. Mark production deployment as complete
```

---

## Rollback Procedure

If something breaks after upgrade:

### Step 1: Stop Running Processes

```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
```

### Step 2: Restore from Backup

```powershell
# Find most recent backup
$backups = Get-ChildItem "C:\Users\Footb\Documents" -Directory | Where-Object { $_.Name -like "teleclaude-backup-*" } | Sort-Object LastWriteTime -Descending
$latestBackup = $backups[0].FullName

Write-Host "Restoring from: $latestBackup"

# Restore critical files
Copy-Item "$latestBackup\ACCOUNTS.md" "$main\" -Force
Copy-Item "$latestBackup\API_KEYS.md" "$main\" -Force
Copy-Item "$latestBackup\config.json" "$main\" -Force
Copy-Item "$latestBackup\CLAUDE.md" "$main\" -Force

# Restore browser state
if (Test-Path "$latestBackup\browser_state") {
    Remove-Item "$main\browser_state" -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item "$latestBackup\browser_state" "$main\browser_state" -Recurse
}

# Restore Discord code
Copy-Item "$latestBackup\discord.js" "$main\lib\discord.js" -Force
Copy-Item "$latestBackup\discord-bridge.js" "$main\mcp\discord-bridge.js" -Force
Copy-Item "$latestBackup\discord-config.json" "$main\mcp\discord-config.json" -Force
```

### Step 3: Reinstall Dependencies

```powershell
cd $main
Remove-Item node_modules -Recurse -Force -ErrorAction SilentlyContinue
npm install
```

### Step 4: Verify Restoration

```powershell
# Test that Discord mode works
node lib\discord.js

# Check config
type config.json
```

---

## Protected Files Summary

**NEVER overwrite during upgrade:**
- `ACCOUNTS.md` - Account credentials
- `API_KEYS.md` - API keys and secrets
- `config.json` - User configuration
- `CLAUDE.md` - Customized instructions
- `browser_state/` - Login sessions
- `browser-data*/` - Browser profiles
- `browser_profile_*/` - More browser profiles
- `.keys/` - Wallet private keys
- `lib/discord.js` - Discord implementation
- `mcp/discord-*.js/.json` - Discord MCP
- `utils/*.js` - Local utilities

---

## Reviewing External Code Safely

See [SECURITY_POLICY.md](./SECURITY_POLICY.md) for full details.

**Quick Summary:**

| Action | Allowed | Notes |
|--------|---------|-------|
| Read external code in browser | YES | For ideas only |
| Copy external code | NO | Never |
| Clone external repos | CAUTION | Only in isolated VM |
| Run external code | NO | Never on production machine |
| Implement ideas ourselves | YES | Always from scratch |

---

## Upgrade History

| Date | From | To | Notes |
|------|------|----|----|
| 2026-01-30 | Initial | - | Created upgrade protocol |
| 2026-01-30 | - | - | Updated to "Trust No Code, Only Ideas" policy |

---

*Last updated: 2026-01-30*
