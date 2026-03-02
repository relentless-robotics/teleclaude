# BOUNTY_PROCESS.md - How to Claim and Complete Bounties

**Purpose:** Step-by-step process for claiming and completing Algora bounties correctly.

---

## Overview

Algora (algora.io) is a platform that lets open source projects fund GitHub issues with bounties. Contributors who submit accepted PRs receive the bounty payment.

---

## Step 1: Finding Bounties

### Where to Look:
- **Main page:** https://algora.io/bounties (shows all bounties)
- **By organization:** https://algora.io/[org-name]/bounties
  - Example: https://algora.io/projectdiscovery/bounties
  - Example: https://algora.io/tscircuit/bounties

### Filter by Technology:
The main page has filters for: TypeScript, JavaScript, Scala, CSS, Shell, Go, Python, etc.

### Finding Small Bounties:
- Scroll down the full page - smaller bounties ($100-$250) are often below the featured ones
- Check organization-specific pages for their bounty lists
- Look for "good first issue" or beginner-friendly tags

---

## Step 2: Evaluating a Bounty

Before claiming, check:

1. **Is it still open?**
   - Click through to the GitHub issue
   - Check if issue is still open (not closed)

2. **How many claims/PRs exist?**
   - Look at existing PRs referencing the issue
   - More competition = lower chance of winning

3. **Understand the requirements:**
   - Read the FULL issue description
   - Read ALL comments
   - Check any linked documentation

4. **Can you actually do it?**
   - Do you have the required skills?
   - Do you understand the codebase?
   - Is the scope reasonable?

---

## Step 3: Claiming a Bounty

### Method 1: Comment on Issue (Some projects)
Some projects require you to comment to claim:
```
/attempt
```
or
```
I'd like to work on this
```

### Method 2: Just Submit PR (Most projects)
Most Algora bounties don't require pre-claiming. You just:
1. Fork the repo
2. Make the fix
3. Submit PR with proper claim syntax

---

## Step 4: Setting Up the Repository

```bash
# Fork via GitHub UI or API
gh repo fork [org]/[repo] --clone

# Or clone your existing fork
git clone https://github.com/relentless-robotics/[repo].git
cd [repo]

# Create a branch for your work
git checkout -b fix-issue-[number]
# or
git checkout -b add-[feature-name]
```

---

## Step 5: Making the Fix

### Guidelines:
- Follow the project's coding style
- Keep changes focused on the issue
- Test your changes
- Don't over-engineer

### Code Quality:
- Code should look human-written
- Add comments only where necessary
- Follow existing patterns in the codebase
- No excessive documentation unless requested

---

## Step 6: Committing

```bash
# Stage your changes
git add [specific files]

# Commit with clear message
git commit -m "Fix [issue description]

- Brief bullet point of what changed
- Another point if needed

Fixes #[issue-number]"
```

---

## Step 7: Pushing

```bash
# Push to your fork
git push origin [branch-name]

# Or with PAT authentication
git push https://[PAT]@github.com/relentless-robotics/[repo].git [branch-name]
```

---

## Step 8: Creating the Pull Request

### PR Title:
Clear, concise description of what the PR does.
- Good: "Add Nuclei template for CVE-2024-3408 (dtale RCE)"
- Good: "Fix trace hover color not changing (#1130)"

### PR Body - IMPORTANT FOR BOUNTY CLAIM:

```markdown
## Description
[Brief description of what this PR does]

## Changes
- [What was changed]
- [Another change if applicable]

## Testing
[How you tested it]

## References
- Fixes #[issue-number]

/claim #[issue-number]
```

**CRITICAL:** The `/claim #[issue-number]` line is what Algora uses to associate your PR with the bounty!

---

## Step 9: After Submission

### Monitor the PR:
- Watch for reviewer comments
- Respond to feedback promptly
- Make requested changes quickly

### If Changes Requested:
```bash
# Make the changes locally
git add [files]
git commit -m "Address review feedback"
git push origin [branch-name]
```

### If PR is Merged:
- Bounty will be processed by Algora
- Payment typically within 2-7 business days
- You'll receive email notification

---

## Step 10: Receiving Payment

### First Time Setup:
- Algora uses Stripe Connect
- When your first bounty is approved, you'll be prompted to set up payment
- Requires bank account information

### Payment Timeline:
- After PR merge: 1-3 business days for Algora to process
- After processing: 2-5 business days for bank transfer

---

## Platform-Specific Notes

### ProjectDiscovery (nuclei-templates)
- **Bounty type:** CVE templates ($100 each)
- **Format:** YAML Nuclei templates
- **Location:** `http/cves/[year]/CVE-[year]-[number].yaml`
- **Claim syntax:** `/claim #[issue-number]` in PR body
- **Competition:** High - many contributors

**CRITICAL REQUIREMENTS FOR PROJECTDISCOVERY:**
1. Comment `/attempt #[issue]` on the GitHub issue FIRST
2. Template must include COMPLETE POC (not version-based detection only!)
3. **MUST EMAIL templates@projectdiscovery.io with:**
   - Your PR number
   - Docker setup commands for vulnerable environment
   - OR IP address of testable vulnerable instance
4. They will validate your POC before approving
5. Providing testable instance = faster validation = faster reward

**Email Template:**
```
Subject: Bounty Validation - PR #[number] - CVE-[number]

Hi ProjectDiscovery Team,

I submitted PR #[number] for the CVE-[number] bounty.

Vulnerable environment setup:
[Docker commands or instance details]

Please let me know if you need any additional information.

Thanks,
[Name]
```

### tscircuit
- **Bounty type:** Feature/bug fixes ($3-$500)
- **Format:** TypeScript/React
- **Competition:** Very high - bounties claimed within hours
- **Tip:** Monitor for new bounties

### ZIO (Scala)
- **Bounty type:** Features/fixes ($500-$4000)
- **Format:** Scala
- **Competition:** Medium - requires Scala expertise

---

## Our Submission Tracking

| Date | Bounty | Amount | PR | Status |
|------|--------|--------|-----|--------|
| 2026-01-30 | CVE-2024-3408 | $100 | #15097 | Awaiting review |
| 2026-01-30 | CVE-2018-20753 | $100 | #15099 | Awaiting review |

---

## Common Mistakes to Avoid

1. **Not including `/claim #[issue]`** - Algora won't associate your PR with the bounty
2. **Not reading the full issue** - Missing requirements
3. **Submitting to wrong branch** - Check if they want `main` or `dev`
4. **Poor PR description** - Makes review harder
5. **Not responding to feedback** - PR may be closed
6. **Working on already-claimed bounties** - Wasted effort

---

## Quick Reference

### GitHub PAT:
```
ghp_YOUR_TOKEN_HERE
```

### Our GitHub Account:
```
relentless-robotics
```

### PR Claim Syntax:
```
/claim #[issue-number]
```

### Check PR Status:
```bash
curl -s -H "Authorization: token [PAT]" \
  "https://api.github.com/repos/[org]/[repo]/pulls/[number]" \
  | grep -E '"state"|"merged"|"mergeable_state"'
```

---

*Last updated: 2026-01-30*
