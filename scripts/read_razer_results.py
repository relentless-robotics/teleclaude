"""Read Razer CNN z-score LGBM results."""
import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('100.102.215.75', username='claude', password='Pb26116467', timeout=10)

stdin, stdout, stderr = ssh.exec_command(
    r'type C:\Users\claude\Lvl3Quant\alpha_discovery\results\cnn_lgbm_features\cnn_zscore_lgbm_results.json'
)
print(stdout.read().decode())

stdin, stdout, stderr = ssh.exec_command(
    r'type C:\Users\claude\Lvl3Quant\alpha_discovery\results\cnn_lgbm_features\experiment_summary.csv'
)
print("---CSV---")
print(stdout.read().decode())

ssh.close()
