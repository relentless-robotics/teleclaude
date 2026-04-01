"""Check Documents path and data on Razer."""
import paramiko
import warnings

warnings.filterwarnings('ignore')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('100.102.215.75', username='claude', password='Pb26116467', timeout=20)

cmds = [
    # Check the Documents Lvl3Quant that appeared in dir listing
    r'dir "C:\Users\claude\Documents\Lvl3Quant" /b 2>&1',
    r'dir "C:\Users\claude\Documents" /b 2>&1',
    # Check launch_inc.bat to see how training was done previously
    r'type C:\Users\claude\launch_inc.bat 2>&1',
    # Check if there's data anywhere
    r'dir C:\Users\claude\Lvl3Quant\alpha_discovery\deep_models\results\ /b 2>&1',
    # Check the weird path that appeared in dir
    r'dir "C:\UsersclaudeDocumentsLvl3Quantalpha_discoverydeep_models" /b 2>&1',
    # Check what's in alpha_discovery
    r'dir C:\Users\claude\Lvl3Quant\alpha_discovery\ /b 2>&1',
]

for cmd in cmds:
    stdin, stdout, _ = ssh.exec_command(cmd)
    out = stdout.read().decode().strip()
    print(f"\n=== {cmd[:80]} ===")
    print(out[:1500])

ssh.close()
