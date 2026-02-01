# Post-Restart Setup Instructions

This document tracks what has been completed and what still needs to be done for WSL and SSH setup.

## Current Status: 2026-01-30

### ✅ COMPLETED (No Restart Required)

#### SSH Server Configuration
- OpenSSH Server is INSTALLED and RUNNING
- SSH service set to Automatic startup
- Firewall rules configured and enabled (inbound SSH allowed)
- Connection information documented in ACCOUNTS.md
- SSH connection guide created (SSH_CONNECTION_GUIDE.md)

#### System Information Gathered
- Computer name: Neptune
- Username: Footb
- Local IP (Wi-Fi): 192.168.0.101
- Tailscale IP: 100.109.245.73
- Public IP: 50.88.210.26

#### WSL Status Checked
- WSL2 is available on the system
- No distributions currently installed
- Can install distributions without restart

### ⚠️ REQUIRES MANUAL STEPS (No Restart Needed)

#### 1. Set Password for SSH Access

**Priority: HIGH**

The password needs to be set with administrator privileges:

```powershell
# Run PowerShell as Administrator (Right-click > Run as Administrator)
net user Footb TeleClaude2026!
```

**Why:** Windows doesn't allow password changes without admin elevation. This is required for SSH login to work.

**How to verify it worked:**
```powershell
ssh Footb@localhost
# Should prompt for password, then successfully connect
```

#### 2. Install WSL Distribution (Optional)

**Priority: MEDIUM**

WSL2 is ready, but no Linux distributions are installed yet.

To install Kali Linux (or any distribution):

```powershell
# List available distributions
wsl --list --online

# Install Kali Linux
wsl --install -d kali-linux

# Or install Ubuntu
wsl --install -d Ubuntu
```

**No restart required** - distributions install without rebooting.

**Default distributions available:**
- Ubuntu (most popular)
- Debian
- kali-linux
- Ubuntu-20.04, Ubuntu-22.04, Ubuntu-24.04
- openSUSE-Leap-15.6
- SUSE-Linux-Enterprise-15-SP5
- Fedora

#### 3. Configure Port Forwarding (For External SSH Access)

**Priority: LOW (Optional)**

Only needed if you want to SSH from outside your local network (and not using Tailscale).

**Steps:**
1. Log into your router's admin panel (usually http://192.168.0.1 or http://192.168.1.1)
2. Navigate to Port Forwarding / Virtual Server section
3. Create new rule:
   - External Port: 22 (or custom port like 2222)
   - Internal IP: 192.168.0.101
   - Internal Port: 22
   - Protocol: TCP
4. Save and apply

**Recommended alternative:** Use Tailscale VPN (already installed) instead of port forwarding for secure remote access.

### 📋 NO RESTART REQUIRED

**Important:** All completed configurations are active immediately. No system restart is needed.

- SSH service is running and ready
- Firewall rules are active
- WSL2 is ready for distribution installation

## Quick Connection Test

Once password is set, test SSH access:

### From Local Computer (Neptune)
```powershell
ssh Footb@localhost
# Password: TeleClaude2026!
```

### From Another Device (Same Network)
```bash
ssh Footb@192.168.0.101
# Password: TeleClaude2026!
```

### Via Tailscale (Remote Access)
```bash
ssh Footb@100.109.245.73
# Password: TeleClaude2026!
```

## Next Steps After Password Set

1. Test SSH connection locally: `ssh Footb@localhost`
2. Test from another device on network: `ssh Footb@192.168.0.101`
3. Optionally install WSL distribution: `wsl --install -d kali-linux`
4. Consider setting up SSH key-based authentication (more secure than passwords)

## Files Created/Updated

- `ACCOUNTS.md` - Added SSH access credentials
- `SSH_CONNECTION_GUIDE.md` - Complete SSH connection instructions
- `POST_RESTART_SETUP.md` - This file

## Security Recommendations

1. After setting password, change it from the default if desired
2. Consider SSH key-based authentication instead of password
3. Use Tailscale for remote access instead of exposing SSH to internet
4. Monitor SSH login attempts: Check Event Viewer > Windows Logs > Security
5. Consider changing SSH port from default 22 to custom port
6. Enable Windows Firewall logging for SSH connections

---

*Created: 2026-01-30*
*Everything is ready except manual password setting*
