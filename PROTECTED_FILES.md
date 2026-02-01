# PROTECTED_FILES.md - Critical Data Manifest

**CRITICAL: Files in this manifest must NEVER be overwritten during upgrades.**

This document lists all files and directories that contain user data, credentials, session state, or other irreplaceable information.

---

## Quick Reference - NEVER OVERWRITE THESE

| Path | Type | Criticality |
|------|------|-------------|
| `ACCOUNTS.md` | Credentials | CRITICAL |
| `API_KEYS.md` | Credentials | CRITICAL |
| `config.json` | Configuration | CRITICAL |
| `.env` | Configuration | CRITICAL |
| `browser_state/` | Session Data | HIGH |
| `browser-data*/` | Session Data | HIGH |
| `browser_profile_*/` | Session Data | HIGH |
| `twitter-browser-data/` | Session Data | HIGH |
| `screenshots/` | Operational Data | MEDIUM |
| `logs/` | History | MEDIUM |
| `CLAUDE.md` | Customized Instructions | HIGH |

---

## Detailed File Inventory

### 1. CREDENTIAL FILES (CRITICAL - NEVER OVERWRITE)

#### ACCOUNTS.md
| Field | Value |
|-------|-------|
| Path | `./ACCOUNTS.md` |
| Type | Markdown |
| Contains | All account usernames, emails, passwords |
| Platforms | GitHub, Gumroad, Stripe, Solana, Alpaca, Vercel, Pinterest, X/Twitter |
| Backup Strategy | Copy to secure external location before upgrade |
| Recovery | Impossible without manual re-entry |

#### API_KEYS.md
| Field | Value |
|-------|-------|
| Path | `./API_KEYS.md` |
| Type | Markdown |
| Contains | API keys, secrets, wallet addresses |
| Services | Solana wallet, FMP, FRED, Stripe, GitHub |
| Backup Strategy | Copy to secure external location before upgrade |
| Recovery | Some keys can be regenerated; wallet keys are IRREPLACEABLE |

---

### 2. CONFIGURATION FILES (CRITICAL - NEVER OVERWRITE)

#### config.json
| Field | Value |
|-------|-------|
| Path | `./config.json` |
| Type | JSON |
| Contains | Discord/Telegram tokens, allowed users, mode, working directory, credentials |
| Backup Strategy | Copy before upgrade |
| Recovery | Requires re-running setup wizard |

#### .env (if exists)
| Field | Value |
|-------|-------|
| Path | `./.env` |
| Type | Environment file |
| Contains | Environment-specific configuration |
| Backup Strategy | Copy before upgrade |
| Note | May not exist; check before backup |

---

### 3. BROWSER SESSION DATA (HIGH - NEVER OVERWRITE)

These directories contain logged-in browser sessions. Deleting them forces re-authentication on all platforms.

#### browser_state/
| Field | Value |
|-------|-------|
| Path | `./browser_state/` |
| Type | Directory |
| Contains | Chrome profile with Google login session |
| Key Files | `chrome_profile/`, `google_auth.json`, `google_auth_script.js` |
| Size | ~500+ files (caches, cookies, local storage) |
| Backup Strategy | Copy entire directory before upgrade |
| Recovery | Requires re-authenticating with Google (2FA) |

#### browser-data/
| Field | Value |
|-------|-------|
| Path | `./browser-data/` |
| Type | Directory |
| Contains | Generic Playwright browser session |
| Backup Strategy | Copy entire directory if populated |

#### browser-data-v2/
| Field | Value |
|-------|-------|
| Path | `./browser-data-v2/` |
| Type | Directory |
| Contains | Secondary browser session |
| Backup Strategy | Copy entire directory if populated |

#### browser-data-stealth2/
| Field | Value |
|-------|-------|
| Path | `./browser-data-stealth2/` |
| Type | Directory |
| Contains | Stealth mode browser session |
| Backup Strategy | Copy entire directory if populated |

#### browser-data-vercel/
| Field | Value |
|-------|-------|
| Path | `./browser-data-vercel/` |
| Type | Directory |
| Contains | Vercel-specific browser session |
| Backup Strategy | Copy entire directory if populated |

#### browser_profile_stripe/
| Field | Value |
|-------|-------|
| Path | `./browser_profile_stripe/` |
| Type | Directory |
| Contains | Stripe dashboard browser session |
| Backup Strategy | Copy entire directory |
| Recovery | Requires Stripe re-login |

#### browser_profile_edge/
| Field | Value |
|-------|-------|
| Path | `./browser_profile_edge/` |
| Type | Directory |
| Contains | Edge browser profile |
| Backup Strategy | Copy entire directory |

#### twitter-browser-data/
| Field | Value |
|-------|-------|
| Path | `./twitter-browser-data/` |
| Type | Directory |
| Contains | X/Twitter browser session |
| Backup Strategy | Copy entire directory |

---

### 4. OPERATIONAL DATA (MEDIUM - PRESERVE)

#### screenshots/
| Field | Value |
|-------|-------|
| Path | `./screenshots/` |
| Type | Directory |
| Contains | 100+ automation screenshots, CAPTCHA screenshots |
| Subdirs | `./screenshots/captchas/` |
| Size | Variable, can be large |
| Backup Strategy | Optional - copy if historical record needed |
| Recovery | Not critical; generated during automation |

#### logs/
| Field | Value |
|-------|-------|
| Path | `./logs/` |
| Type | Directory |
| Contains | Daily activity logs (agent, system, mcp, bridge, claude) |
| Pattern | `*-YYYY-MM-DD.log` |
| Backup Strategy | Optional - copy for debugging/audit trail |
| Recovery | Not critical; new logs generated automatically |

---

### 5. LOCAL CUSTOMIZATIONS (HIGH - REVIEW BEFORE OVERWRITE)

#### CLAUDE.md
| Field | Value |
|-------|-------|
| Path | `./CLAUDE.md` |
| Type | Markdown |
| Contains | Custom instructions, workflow documentation |
| Customizations | Discord support, browser auth docs, CAPTCHA handling, account management |
| Backup Strategy | Copy before upgrade; merge upstream changes manually |
| Why Protected | Contains LOCAL-SPECIFIC customizations that upstream lacks |

#### lib/discord.js (LOCAL ONLY)
| Field | Value |
|-------|-------|
| Path | `./lib/discord.js` |
| Type | JavaScript |
| Contains | Discord bridge implementation |
| Note | Does NOT exist in upstream; must preserve |

#### mcp/discord-bridge.js (LOCAL ONLY)
| Field | Value |
|-------|-------|
| Path | `./mcp/discord-bridge.js` |
| Type | JavaScript |
| Contains | MCP server for Discord send_to_discord tool |
| Note | Does NOT exist in upstream; must preserve |

#### mcp/discord-config.json (LOCAL ONLY)
| Field | Value |
|-------|-------|
| Path | `./mcp/discord-config.json` |
| Type | JSON |
| Contains | MCP configuration for Discord mode |
| Note | Does NOT exist in upstream; must preserve |

#### utils/discord_captcha.js (LOCAL ONLY)
| Field | Value |
|-------|-------|
| Path | `./utils/discord_captcha.js` |
| Type | JavaScript |
| Contains | CAPTCHA handling for Discord mode |
| Note | Does NOT exist in upstream; must preserve |

#### utils/credentials.js (LOCAL ONLY)
| Field | Value |
|-------|-------|
| Path | `./utils/credentials.js` |
| Type | JavaScript |
| Contains | Credential auto-fill for known sites |
| Note | Does NOT exist in upstream; must preserve |

#### utils/captcha_handler.js (LOCAL ONLY)
| Field | Value |
|-------|-------|
| Path | `./utils/captcha_handler.js` |
| Type | JavaScript |
| Contains | CAPTCHA detection and handling |
| Note | Does NOT exist in upstream; must preserve |

---

### 6. KEYS DIRECTORY (CRITICAL IF EXISTS)

#### .keys/
| Field | Value |
|-------|-------|
| Path | `./.keys/` |
| Type | Directory |
| Contains | Solana wallet private keys |
| Key Files | `solana-wallet.json` |
| Backup Strategy | CRITICAL - copy to secure offline location |
| Recovery | IMPOSSIBLE - funds permanently lost without backup |

---

## Backup Command Reference

### Full Protected Data Backup (PowerShell)

```powershell
# Create backup directory
$backupDir = "C:\Users\Footb\Documents\teleclaude-backup-$(Get-Date -Format 'yyyy-MM-dd-HHmmss')"
New-Item -ItemType Directory -Path $backupDir

# Copy critical files
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\ACCOUNTS.md" $backupDir
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\API_KEYS.md" $backupDir
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\config.json" $backupDir
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\CLAUDE.md" $backupDir
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\.env" $backupDir -ErrorAction SilentlyContinue

# Copy browser sessions
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\browser_state" $backupDir -Recurse
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\browser-data" $backupDir -Recurse -ErrorAction SilentlyContinue
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\browser_profile_stripe" $backupDir -Recurse -ErrorAction SilentlyContinue
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\browser_profile_edge" $backupDir -Recurse -ErrorAction SilentlyContinue

# Copy local-only code files
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\lib\discord.js" $backupDir
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\mcp\discord-bridge.js" $backupDir
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\mcp\discord-config.json" $backupDir
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\utils" $backupDir -Recurse

# Copy keys if they exist
Copy-Item "C:\Users\Footb\Documents\Github\teleclaude-main\.keys" $backupDir -Recurse -ErrorAction SilentlyContinue

Write-Host "Backup complete: $backupDir"
```

---

## Summary

### Files that MUST be backed up before ANY upgrade:
1. `ACCOUNTS.md`
2. `API_KEYS.md`
3. `config.json`
4. `.env` (if exists)
5. `browser_state/` directory
6. `.keys/` directory (if exists)

### Files that SHOULD be backed up:
1. `CLAUDE.md`
2. `lib/discord.js`
3. `mcp/discord-*.js/.json`
4. `utils/*.js`
5. All `browser-data*` and `browser_profile_*` directories

### Files that CAN be recreated:
1. `screenshots/` (operational data)
2. `logs/` (generated automatically)
3. `node_modules/` (reinstalled via npm install)

---

*Last updated: 2026-01-30*
