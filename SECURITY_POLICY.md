# SECURITY_POLICY.md - Trust No Code, Only Ideas

**CRITICAL: This document establishes our security posture for all external code.**

---

## Core Philosophy: Trust No Code, Only Ideas

We do NOT trust external developers or their code. External code can contain:
- **Supply chain attacks** - Malicious code hidden in dependencies
- **Backdoors** - Hidden access points for attackers
- **Data exfiltration** - Code that silently sends data to third parties
- **Credential theft** - Code that captures and leaks credentials
- **Quality issues** - Bugs, vulnerabilities, or unstable implementations

**Our approach:** Learn from external repos, implement ourselves.

---

## Why We Don't Copy External Code

### 1. Supply Chain Attacks Are Real

Recent high-profile incidents:
- **event-stream (2018)** - Malicious code added to steal cryptocurrency
- **ua-parser-js (2021)** - Hijacked to install cryptominers and password stealers
- **node-ipc (2022)** - Maintainer added code to wipe files on Russian/Belarusian systems
- **xz backdoor (2024)** - Sophisticated backdoor inserted by trusted contributor over years

### 2. You Can't Review What You Don't Write

Even well-meaning code can have:
- Unintentional security vulnerabilities
- Dependencies with their own vulnerabilities
- Assumptions that don't match our security requirements
- Logging that exposes sensitive data

### 3. Understanding Through Implementation

When you implement code yourself:
- You understand exactly what it does
- You can verify security properties
- You know where to look when debugging
- You maintain full control

---

## How to Properly Review External Repos for Ideas

### Step 1: Identify the Concept

Read the external code to understand:
- **What problem does it solve?**
- **What approach does it take?**
- **What are the key algorithms or patterns?**
- **What edge cases does it handle?**

**DO NOT** focus on implementation details or copy-paste code.

### Step 2: Document the Idea

Write down in plain language:
- The problem being solved
- The general approach
- Key insights or clever solutions
- Edge cases to consider

### Step 3: Design Your Own Implementation

Based on your understanding:
- Design your own architecture
- Choose your own libraries/dependencies
- Write your own code from scratch
- Test thoroughly

### Step 4: Log in EXTERNAL_IDEAS_LOG.md

Document:
- What external source you reviewed
- What ideas you extracted
- How you implemented them
- Testing status

---

## Checklist for Implementing Features Inspired by External Code

### Before Implementation

- [ ] Identified the problem/feature to implement
- [ ] Reviewed external source for ideas (NOT code)
- [ ] Documented the concept in plain language
- [ ] Designed our own implementation approach
- [ ] Listed all dependencies we'll need
- [ ] Verified dependencies are reputable (check npm audit, GitHub stars, maintainer history)

### During Implementation

- [ ] Writing code from scratch (NO copy-paste from external sources)
- [ ] Following our coding standards
- [ ] Adding appropriate error handling
- [ ] Adding logging for debugging
- [ ] Writing tests alongside code

### After Implementation

- [ ] Code review completed
- [ ] All tests pass locally
- [ ] Docker testing completed (see below)
- [ ] Documented in EXTERNAL_IDEAS_LOG.md
- [ ] Production deployment approved

---

## Docker Testing Requirements

**MANDATORY: All new features MUST be tested in Docker before production deployment.**

### Why Docker First?

1. **Isolation** - Mistakes don't affect production
2. **Reproducibility** - Same environment every time
3. **Safety** - Can wipe and restart without consequences
4. **Verification** - Proves code works in clean environment

### Docker Testing Procedure

```bash
# 1. Build the Docker image
docker build -t teleclaude-test .

# 2. Run the container
docker run -it --rm \
  -v $(pwd)/config.json:/app/config.json:ro \
  teleclaude-test

# 3. Test all functionality
# - Verify basic operation
# - Test edge cases
# - Check error handling
# - Verify no crashes/hangs

# 4. Check for security issues
# - No exposed ports unexpectedly
# - No sensitive data in logs
# - No unexpected network connections
```

### Production Deployment Criteria

Only deploy to production when:
- [ ] All Docker tests pass
- [ ] No security warnings or errors
- [ ] Functionality matches specification
- [ ] Performance is acceptable
- [ ] Rollback plan is ready

---

## Reviewing External Code Safely

### DO:

- Read code in a browser (GitHub web interface)
- Take notes on concepts and algorithms
- Understand the "why" behind design decisions
- Look for patterns and best practices
- Learn from their test cases and edge case handling

### DO NOT:

- Clone the repo to your machine (unless in isolated VM)
- Run any code from external sources
- Copy-paste code into your projects
- Install their dependencies directly
- Trust that "popular" means "safe"

### If You Must Clone:

1. Use a VM or container
2. Disable network access in the VM
3. Do not run any commands (npm install, etc.)
4. Only read the files
5. Delete the clone when done

---

## Approved Dependency Sources

When you need external dependencies, use only:

1. **Official packages** from established organizations
2. **High-reputation packages** (1000+ GitHub stars, active maintenance)
3. **Packages we've audited** (document in this file)

### Audit Checklist for New Dependencies

- [ ] Package has >1000 stars and active maintenance
- [ ] Package has been around for >1 year
- [ ] No recent security advisories
- [ ] `npm audit` shows no vulnerabilities
- [ ] Source code is readable and understandable
- [ ] Dependencies are minimal and reputable

---

## Incident Response

If you suspect malicious code:

1. **STOP** - Do not run anything else
2. **DISCONNECT** - Isolate affected systems from network
3. **DOCUMENT** - Screenshot and log everything
4. **ASSESS** - Determine what was compromised
5. **REMEDIATE** - Clean install from known-good backup
6. **ROTATE** - Change all credentials that may have been exposed

---

## CODE BOUNTY SECURITY RULES (MANDATORY)

**CRITICAL: When working on Algora or any code bounties, these rules are NON-NEGOTIABLE.**

### Absolute Prohibitions

| Rule | Description |
|------|-------------|
| **NO External IPs** | Never point to, connect to, or reference unknown external IP addresses |
| **NO Blind Execution** | Never run code we don't 100% understand line-by-line |
| **NO Root Access** | All bounty code runs in isolated, non-root environments ONLY |
| **NO Network Leaks** | No outbound connections to untrusted destinations |
| **NO Credential Exposure** | Never commit or expose credentials in bounty PRs |

### Mandatory Bounty Workflow

1. **Read First** - Review the entire codebase/issue before touching anything
2. **Understand Completely** - If you don't understand a line, research it before proceeding
3. **Docker Sandbox** - ALL bounty code testing happens in Docker containers
4. **Network Isolation** - Test containers should have no internet access when possible
5. **Code Review** - Every line of our code reviewed before submission
6. **No Secrets** - Never put real credentials, API keys, or tokens in bounty code

### Red Flags to Watch For

Immediately STOP and report if bounty code requires:
- Connections to hardcoded IP addresses
- Downloading additional scripts/binaries from external URLs
- Elevated privileges or root access
- Disabling security features
- Access to system directories (/etc, /root, C:\Windows, etc.)
- Cryptocurrency wallet addresses or private keys
- Obfuscated or minified code that must be executed

### Safe Bounty Categories

| Category | Risk Level | Notes |
|----------|------------|-------|
| Documentation fixes | LOW | Safe - just text |
| Typo corrections | LOW | Safe - just text |
| Test additions | MEDIUM | Review test code carefully |
| Bug fixes | MEDIUM | Understand the bug and fix completely |
| New features | HIGH | Full code review required |
| Infrastructure changes | CRITICAL | Extra scrutiny, Docker testing mandatory |

### Before Claiming Any Bounty

- [ ] Read the ENTIRE issue and related code
- [ ] Understand what the fix requires
- [ ] Verify no suspicious requirements (external IPs, root access, etc.)
- [ ] Confirm we can complete it safely
- [ ] Plan Docker testing approach

---

## Summary

| Action | Allowed | Notes |
|--------|---------|-------|
| Read external code for ideas | YES | In browser only |
| Copy external code | NO | Never |
| Clone external repos | CAUTION | Only in isolated VM |
| Run external code | NO | Never on production machine |
| Implement ideas ourselves | YES | Always from scratch |
| Use audited dependencies | YES | After review |
| **Bounty work** | CAUTION | Follow bounty security rules above |

---

*Last updated: 2026-01-30*
