"""Check data cache contents on Razer."""
import paramiko
import warnings

warnings.filterwarnings('ignore')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('100.102.215.75', username='claude', password='Pb26116467', timeout=20)

# Check the cache dir structure
cmds = [
    # How many files in the cache?
    r'dir C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache\ /b 2>&1 | find /c /v ""',
    # What do a few filenames look like?
    r'dir C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache\ /b 2>&1 | head',
    # List the data dir to see what's there
    r'dir C:\Users\claude\Lvl3Quant\data\processed\ /b 2>&1',
    # What's in the main data dir?
    r'dir C:\Users\claude\Lvl3Quant\data\ /b 2>&1',
]

for cmd in cmds:
    stdin, stdout, _ = ssh.exec_command(cmd)
    out = stdout.read().decode().strip()
    print(f"CMD: {cmd[:60]}")
    print(out[:1000])
    print()

# Also check train_walkforward more carefully -- how does it find dates?
# The issue is horizon_bars=600. Let's see a few cache filenames to understand naming
stdin2, stdout2, _ = ssh.exec_command(
    r'dir C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache\ /b 2>&1'
)
files = stdout2.read().decode().strip()
print("=== CACHE FILES (first 40) ===")
lines = files.splitlines()[:40]
for l in lines:
    print(l)

ssh.close()
