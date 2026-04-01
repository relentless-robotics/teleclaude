"""Diagnostic: find out what user Ray worker runs as on Razer, and what paths it can access."""
import os, sys, socket, subprocess, pathlib

print(f"hostname: {socket.gethostname()}")
print(f"platform: {sys.platform}")

# Who am I?
rc = subprocess.run("whoami", shell=True, capture_output=True, text=True)
print(f"whoami: {rc.stdout.strip()}")

rc2 = subprocess.run("echo %USERNAME%", shell=True, capture_output=True, text=True)
print(f"USERNAME: {rc2.stdout.strip()}")

rc3 = subprocess.run("echo %USERPROFILE%", shell=True, capture_output=True, text=True)
print(f"USERPROFILE: {rc3.stdout.strip()}")

# What dirs can I write to?
test_paths = [
    "C:/Users/claude/Lvl3Quant",
    "C:/Lvl3Quant",
    "C:/tmp/Lvl3Quant",
    "C:/Users/Public/Lvl3Quant",
]
for p in test_paths:
    try:
        pathlib.Path(p).mkdir(parents=True, exist_ok=True)
        # Try to write a file
        test_file = pathlib.Path(p) / "_test_write.txt"
        test_file.write_text("ok")
        test_file.unlink()
        print(f"WRITABLE: {p}")
    except Exception as e:
        print(f"NO ACCESS: {p} — {e}")

# Check if C:\Users\claude exists and is listable
for p in ["C:/Users/claude", "C:/Users"]:
    try:
        items = os.listdir(p)
        print(f"LISTABLE: {p} ({len(items)} items)")
    except Exception as e:
        print(f"NOT LISTABLE: {p} — {e}")

# Check icacls on claude's dir
rc4 = subprocess.run('icacls "C:\\Users\\claude\\Lvl3Quant"', shell=True, capture_output=True, text=True)
print(f"icacls C:\\Users\\claude\\Lvl3Quant:\n{rc4.stdout.strip()}\n{rc4.stderr.strip()}")

# Check if we can run icacls to grant ourselves access
rc5 = subprocess.run(
    'whoami /groups | findstr /i "admin"',
    shell=True, capture_output=True, text=True
)
print(f"admin groups: {rc5.stdout.strip() or '(none)'}")
