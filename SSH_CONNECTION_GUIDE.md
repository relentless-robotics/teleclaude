# SSH Connection Guide - Windows PC (Neptune)

This guide explains how to connect to your Windows PC remotely via SSH.

## Connection Information

| Field | Value |
|-------|-------|
| Computer Name | Neptune |
| Username | Footb |
| Password | TeleClaude2026! |
| SSH Port | 22 (default) |

## IP Addresses

| Type | Address | Use Case |
|------|---------|----------|
| Local (Wi-Fi) | 192.168.0.101 | Same network connections |
| Tailscale VPN | 100.109.245.73 | Secure remote access via Tailscale |
| Public | 50.88.210.26 | Internet access (requires port forwarding) |

## How to Connect

### From Same Local Network (Home/Office)

```bash
ssh Footb@192.168.0.101
```

When prompted for password, enter: `TeleClaude2026!`

### Via Tailscale (Recommended for Remote Access)

If you have Tailscale installed on both devices:

```bash
ssh Footb@100.109.245.73
```

This is the most secure method for remote access as it doesn't require port forwarding.

### From Internet (Public IP)

**IMPORTANT:** This requires router port forwarding configuration.

1. Log into your router admin panel
2. Forward external port 22 to internal IP 192.168.0.101 port 22
3. Then connect using:

```bash
ssh Footb@50.88.210.26
```

**Security Note:** Exposing SSH to the public internet requires strong passwords and/or key-based authentication. Consider using Tailscale instead.

## SSH Service Status

- Service: OpenSSH SSH Server (sshd)
- Status: Running
- Startup Type: Automatic
- Firewall: Configured (inbound allowed)

## Manual Password Setup Required

**IMPORTANT:** The password needs to be set manually with admin privileges.

Run this command in an elevated PowerShell (Run as Administrator):

```powershell
net user Footb TeleClaude2026!
```

## Testing the Connection

### Local Test (from Neptune itself)

```powershell
ssh Footb@localhost
```

### Remote Test

From another computer on the same network:

```bash
ssh Footb@192.168.0.101
```

## Troubleshooting

### Connection Refused
- Check if SSH service is running: `Get-Service sshd`
- Start service if needed: `Start-Service sshd`

### Authentication Failed
- Verify password was set correctly
- Check username is correct (case-sensitive)

### Timeout / No Route to Host
- Verify IP address is correct
- Check firewall rules
- For public IP, verify port forwarding is configured

### Permission Denied (public key)
- You may need to disable key authentication and use password
- Edit `C:\ProgramData\ssh\sshd_config`
- Ensure `PasswordAuthentication yes` is set
- Restart SSH service: `Restart-Service sshd`

## Security Best Practices

1. Change the password regularly
2. Use key-based authentication instead of passwords
3. Consider fail2ban or similar tools to prevent brute-force attacks
4. Use Tailscale VPN instead of exposing SSH to public internet
5. Enable two-factor authentication if possible
6. Monitor SSH logs: `C:\ProgramData\ssh\logs\`

## WSL Access After Setup

Once WSL is installed, you can SSH into Windows and then access WSL:

```bash
ssh Footb@192.168.0.101
# Then from Windows:
wsl
```

Or access WSL directly if WSL SSH is configured.

---

*Created: 2026-01-30*
*Status: SSH server ready, password needs manual setting*
