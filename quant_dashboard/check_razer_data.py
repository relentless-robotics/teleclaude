"""Check where data lives on Razer."""
import paramiko
import warnings

warnings.filterwarnings('ignore')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('100.102.215.75', username='claude', password='Pb26116467', timeout=20)

cmds = [
    # Check if data dir exists anywhere
    r'dir C:\Users\claude\ /b 2>&1',
    r'dir C:\Users\claude\Lvl3Quant\ 2>&1',
    # Check train_walkforward cache dir setting
    r'findstr /n "cache_dir\|dl_book\|processed" C:\Users\claude\Lvl3Quant\alpha_discovery\deep_models\train_walkforward.py',
]

for cmd in cmds:
    stdin, stdout, _ = ssh.exec_command(cmd)
    out = stdout.read().decode().strip()
    print(f"\n=== {cmd[:70]} ===")
    print(out[:2000])

ssh.close()
