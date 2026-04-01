"""Launch Razer embedding extraction on SECOND HALF only (days 87-173).
Neptune handles days 1-86. No overlap."""
import paramiko
import time

# Same script but with START_DAY=87 injected at top
EXTRACT_SCRIPT = r'''
import sys, os, gc, time, numpy as np, torch, psutil
from pathlib import Path

START_DAY = 87  # Razer does days 87-173, Neptune does 1-86

CHECKPOINT = Path(r'C:\Users\claude\Lvl3Quant\alpha_discovery\deep_models\results\wider_cnn\fold_74_2025-11-03.pt')
DATA_DIR = Path(r'C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache')
OUT_DIR = Path(r'C:\Users\claude\Lvl3Quant\data\processed\cnn_embeddings_fold74')
OUT_DIR.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(Path(r'C:\Users\claude\Lvl3Quant\alpha_discovery\deep_models')))
from book_spatial_cnn import BookSpatialCNN

WINDOW = 20
BATCH = 512
CHUNK = 2000
HORIZON = 100
TICK = 0.25

_captured = []
def hook_fn(module, input, output):
    _captured.append(output.squeeze(-1).cpu().float())

device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
model = BookSpatialCNN(
    window_size=20, num_levels=20, num_features=4,
    spatial_channels=(64,128,256,512), temporal_channels=512,
    dropout=0.15, num_classes=1
).to(device)
state = torch.load(str(CHECKPOINT), map_location=device, weights_only=True)
model.load_state_dict(state)
model.eval()
model.temporal_pool.register_forward_hook(hook_fn)
print(f'Model loaded on {device}. Starting from day {START_DAY}.', flush=True)

def compute_targets(mid, horizon=100, tick=0.25):
    n = len(mid)
    tgt = np.full(n, np.nan, dtype=np.float32)
    for i in range(n - horizon):
        w = mid[i+1:i+1+horizon]
        entry = mid[i]
        tgt[i] = (np.max(w) - entry) / tick - (entry - np.min(w)) / tick
    return tgt

files = sorted(DATA_DIR.glob('*_book_tensors.npz'))
# SPLIT: only process days from START_DAY onward
files = files[START_DAY - 1:]
print(f'Processing {len(files)} days (from day {START_DAY})', flush=True)

t0 = time.time()
for fi, f in enumerate(files):
    date = f.name.replace('_book_tensors.npz', '')
    out_file = OUT_DIR / f'{date}_embeddings.npz'
    if out_file.exists():
        print(f'[{fi+1}/{len(files)}] {date}: SKIP (exists)', flush=True)
        continue

    npz = np.load(str(f))
    bt = npz['book_tensors'].astype(np.float32)
    mid = npz['mid_prices'].copy()
    npz.close()
    np.log1p(bt[:,:,1], out=bt[:,:,1])
    np.log1p(bt[:,:,2], out=bt[:,:,2])
    np.log1p(bt[:,:,3], out=bt[:,:,3])

    n = len(bt)
    preds = np.zeros(n, dtype=np.float32)
    all_embs = []
    _captured.clear()

    with torch.no_grad():
        for cstart in range(0, n, CHUNK):
            cend = min(cstart + CHUNK, n)
            sl = max(0, cstart - WINDOW + 1)
            bg = torch.from_numpy(bt[sl:cend]).to(device)
            if len(bg) < WINDOW:
                del bg; continue
            w = bg.unfold(0, WINDOW, 1).permute(0,3,1,2).contiguous()
            off = sl + WINDOW - 1
            _captured.clear()
            for bs in range(0, len(w), BATCH):
                be = min(bs + BATCH, len(w))
                with torch.amp.autocast('cuda'):
                    out = model(w[bs:be]).squeeze(-1)
                preds[off+bs:off+be] = out.cpu().float().numpy()
            if _captured:
                ce = torch.cat(_captured, dim=0).numpy()
                all_embs.append((off, ce))
                _captured.clear()
            del bg, w
            torch.cuda.empty_cache()

    emb_full = np.zeros((n, 512), dtype=np.float32)
    for (off, ea) in all_embs:
        end = min(off + len(ea), n)
        emb_full[off:end] = ea[:end-off]

    targets = compute_targets(mid, HORIZON, TICK)
    vs, ve = WINDOW - 1, n - HORIZON
    if ve <= vs:
        print(f'[{fi+1}/{len(files)}] {date}: SKIP (too short)', flush=True)
        del bt, mid; gc.collect(); continue

    np.savez_compressed(str(out_file),
        embeddings=emb_full[vs:ve].astype(np.float16),
        predictions=preds[vs:ve],
        targets=targets[vs:ve])

    elapsed = time.time() - t0
    print(f'[{fi+1}/{len(files)}] {date}: {ve-vs} bars ({elapsed:.0f}s total)', flush=True)
    del bt, mid, preds, all_embs, emb_full, targets; gc.collect()

print(f'DONE in {time.time()-t0:.0f}s', flush=True)
'''

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('100.102.215.75', username='claude', password='Pb26116467', timeout=10)
print("Connected")

# Upload split script
sftp = ssh.open_sftp()
remote_script = 'C:/Users/claude/Lvl3Quant/scripts/extract_embeddings_razer_split.py'
with sftp.open(remote_script, 'w') as f:
    f.write(EXTRACT_SCRIPT)
print("Script uploaded (days 87-173 only)")
sftp.close()

# Launch
stdin, stdout, stderr = ssh.exec_command(
    r'wmic process call create "C:\Python311\python.exe -X utf8 C:\Users\claude\Lvl3Quant\scripts\extract_embeddings_razer_split.py","C:\Users\claude\Lvl3Quant"'
)
out = stdout.read().decode()
if 'ProcessId' in out:
    pid = out.split('ProcessId = ')[1].split(';')[0].strip()
    print(f"Launched PID: {pid}")

time.sleep(10)
stdin, stdout, stderr = ssh.exec_command(r'nvidia-smi --query-gpu=utilization.gpu,memory.used,power.draw --format=csv,noheader')
print(f"GPU: {stdout.read().decode().strip()}")
stdin, stdout, stderr = ssh.exec_command(r'powershell -Command "Get-Process python* | Where-Object {$_.WorkingSet64 -gt 100MB} | Select-Object Id,CPU,WorkingSet64 | Format-Table"')
print(f"Processes:\n{stdout.read().decode().strip()}")

ssh.close()
print("Done — Razer handles days 87-173, Neptune handles 1-86. Zero overlap.")
