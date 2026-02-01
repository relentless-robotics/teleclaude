# SSH Access - Neptune (Windows)

## Connection Information

| Field | Value |
|-------|-------|
| **Hostname** | neptune |
| **Tailscale IP** | 100.109.245.73 |
| **Username** | Footb |
| **Password** | Stored in password manager |
| **Port** | 22 (default) |

## Security Configuration

**SSH is restricted to Tailscale network ONLY.**

- Only connections from 100.0.0.0/8 subnet are allowed
- Direct internet SSH is BLOCKED
- Must be connected to Tailscale to access

## Connecting

### From Another Tailscale Device

```bash
# Using Tailscale IP
ssh Footb@100.109.245.73

# Using MagicDNS (if enabled)
ssh Footb@neptune
```

### Retrieve Password

The SSH password is stored securely in the password manager:

```bash
cd C:\Users\Footb\Documents\Github\teleclaude-main
node password-cli.js get ssh-windows-neptune
```

Or set the master password and retrieve:
```bash
export PASSWORD_MASTER="TeleClaude-Master-2026"
node password-cli.js get ssh-windows-neptune
```

## Tailscale Network

### Your Devices
| Device | IP | Status |
|--------|-----|--------|
| neptune (this PC) | 100.109.245.73 | Online |
| jupiter | 100.102.174.30 | Online |
| farmspace | 100.90.192.108 | Online |

### Connecting from Other Devices

1. Ensure Tailscale is running on your device
2. Connect to the Tailscale network
3. SSH to neptune using the Tailscale IP

## Troubleshooting

### Cannot Connect

1. **Check Tailscale is running** on both devices
2. **Verify you're on the Tailscale network**:
   ```bash
   tailscale status
   ```
3. **Check SSH service is running** (on neptune):
   ```powershell
   Get-Service sshd
   ```

### Wrong Password

Retrieve the current password:
```bash
node password-cli.js get ssh-windows-neptune
```

### Firewall Blocking

SSH is only allowed from Tailscale IPs (100.x.x.x). If connecting from a non-Tailscale IP, you will be blocked.

## Admin Setup Required

If SSH isn't working, run the admin setup script as Administrator:

```powershell
cd C:\Users\Footb\Documents\Github\teleclaude-main
.\ADMIN_SETUP.ps1
```

This will:
1. Set the SSH password
2. Configure firewall for Tailscale-only access
3. Start/enable the SSH service
4. Install WSL/Kali (if needed)

## Security Notes

- Password is stored encrypted in `secrets/passwords.enc`
- Master password required to decrypt: `TeleClaude-Master-2026`
- All SSH access is logged by Windows
- Only Tailscale network can reach SSH port
