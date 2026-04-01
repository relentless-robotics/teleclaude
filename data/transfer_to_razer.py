import paramiko
import os

host = '100.102.215.75'
user = 'claude'
password = 'Pb26116467'
remote_dir = 'C:/Users/claude/Documents/Lvl3Quant/alpha_discovery/deep_models/results'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(host, port=22, username=user, password=password, timeout=30, allow_agent=False, look_for_keys=False)
sftp = client.open_sftp()

files = [
    ('checkpoint_book_20260317_resume.json', remote_dir + '/checkpoint_book_20260317_resume.json'),
    ('ckpt_preds_book_20260317_resume.npz', remote_dir + '/ckpt_preds_book_20260317_resume.npz'),
]

base = os.path.dirname(os.path.abspath(__file__))

for fname, remote_path in files:
    local = os.path.join(base, fname)
    print(f'Transferring {fname} -> {remote_path}')
    sftp.put(local, remote_path)
    print(f'  Done ({os.path.getsize(local)} bytes)')

sftp.close()
client.close()
print('All transfers complete!')
