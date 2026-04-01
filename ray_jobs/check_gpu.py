import os, socket, platform
hostname = socket.gethostname()
print(f"hostname: {hostname}")
print(f"platform: {platform.system()}")
try:
    import torch
    print(f"gpu: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none'}")
except:
    print("gpu: torch not found")
for root in ['C:/Users/claude/Lvl3Quant', 'C:/Users/Nick/Lvl3Quant', 'C:/Users/Footb/Documents/Github/Lvl3Quant']:
    d = os.path.join(root, 'data/processed/mbo_events')
    if os.path.isdir(d):
        files = [f for f in os.listdir(d) if f.endswith('.npz')]
        print(f"data_dir: {d} ({len(files)} files)")
        s = os.path.join(root, 'alpha_discovery/deep_models/train_event_transformer_fast.py')
        print(f"script: {os.path.exists(s)}")
        break
else:
    print("data_dir: NOT FOUND")
