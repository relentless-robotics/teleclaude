import os, sys, glob, json, numpy as np, time, warnings
warnings.filterwarnings('ignore')
try:
    import lightgbm as lgb
except ImportError:
    sys.exit('lightgbm not found')
from scipy.stats import spearmanr

DATA_DIRS = [
    r'C:\Users\claude\Documents\Lvl3Quant\data\processed\dl_book_cache',
    r'C:\Users\claude\Lvl3Quant\data\processed\dl_book_cache',
]
LOG = r'C:\Users\claude\lgbm_threshold_sweep.log'
OUT = r'C:\Users\claude\lgbm_threshold_results.json'
FORWARD_BARS = 100
TRAIN_DAYS = 40
VAL_DAYS = 20
THRESHOLDS = [50, 60, 70, 75, 80, 85, 90, 95, 99]


def log(m):
    t = time.strftime('%H:%M:%S')
    line = f'[{t}] {m}'
    print(line, flush=True)
    with open(LOG, 'a') as f:
        f.write(line + '\n')


DATA_DIR = next((d for d in DATA_DIRS if os.path.isdir(d)), None)
if not DATA_DIR:
    sys.exit('No data dir found')
log(f'Data: {DATA_DIR}')


def engineer_features(book):
    N = book.shape[0]
    bd = book[:, :10, 1]; ad = book[:, 10:, 1]
    bc = book[:, :10, 2]; ac = book[:, 10:, 2]
    ba = book[:, :10, 3]; aa = book[:, 10:, 3]
    td = bd.sum(1) + ad.sum(1)
    tb = bd.sum(1) - ad.sum(1)
    imb = tb / (td + 1e-9)
    v50 = np.array([np.std(imb[max(0, i-50):i+1]) for i in range(N)])
    v100 = np.array([np.std(imb[max(0, i-100):i+1]) for i in range(N)])
    qai = (ba[:, :5].mean(1) - aa[:, :5].mean(1)) / (ba[:, :5].mean(1) + aa[:, :5].mean(1) + 1e-9)
    m10 = np.array([book[i, 0, 0] - book[max(0, i-10), 0, 0] for i in range(N)])
    m50 = np.array([book[i, 0, 0] - book[max(0, i-50), 0, 0] for i in range(N)])
    m100 = np.array([book[i, 0, 0] - book[max(0, i-100), 0, 0] for i in range(N)])
    ir10 = np.array([np.mean(imb[max(0, i-10):i+1]) for i in range(N)])
    ir50 = np.array([np.mean(imb[max(0, i-50):i+1]) for i in range(N)])
    ir100 = np.array([np.mean(imb[max(0, i-100):i+1]) for i in range(N)])
    bwr = bd[:, 0] / (bd[:, 0] + ad[:, 0] + 1e-9)
    dc = bd[:, 0] / (td + 1e-9)
    feats = np.stack([imb, v50, v100, qai, m10, m50, m100, ir10, ir50, ir100,
                      bwr, dc, bd[:, 0], ad[:, 0], bc[:, 0], ac[:, 0],
                      ba[:, 0], aa[:, 0], td, tb], axis=1)
    return np.nan_to_num(feats, nan=0, posinf=0, neginf=0)


def load_day(f):
    d = np.load(f, allow_pickle=False)
    book = d['book_tensors'].astype(np.float32)
    mid = d['mid_prices'].astype(np.float32)
    X = engineer_features(book)
    N = len(mid)
    fwd = (mid[FORWARD_BARS:] - mid[:N - FORWARD_BARS])
    return X[:N - FORWARD_BARS], fwd


files = sorted(glob.glob(os.path.join(DATA_DIR, '*_book_tensors.npz')))
log(f'Files: {len(files)}')
if not files:
    sys.exit('No book_tensors.npz files found')

train_files = files[:TRAIN_DAYS]
val_files = files[TRAIN_DAYS:TRAIN_DAYS + VAL_DAYS]
log(f'Train: {len(train_files)}, Val: {len(val_files)}')

log('Loading training data...')
Xs, ys = [], []
for fi in train_files:
    try:
        x, y = load_day(fi)
        Xs.append(x); ys.append(y)
    except Exception as e:
        log(f'  Skip {os.path.basename(fi)}: {e}')

X_tr = np.vstack(Xs)
y_tr = np.concatenate(ys)
log(f'Train shape: {X_tr.shape}, target std: {np.std(y_tr):.4f}')

lgb_params = dict(
    n_estimators=300, max_depth=6, learning_rate=0.05,
    subsample=0.8, colsample_bytree=0.8, min_child_samples=200,
    verbose=-1, device='gpu', gpu_use_dp=False
)
log('Training LGBM GPU model...')
t0 = time.time()
model = lgb.LGBMRegressor(**lgb_params)
model.fit(X_tr, y_tr,
          eval_set=[(X_tr[:5000], y_tr[:5000])],
          callbacks=[lgb.early_stopping(20, verbose=False), lgb.log_evaluation(50)])
log(f'Model trained in {time.time()-t0:.1f}s')

# === THRESHOLD SWEEP ===
results = {'model_trained': time.strftime('%Y-%m-%d %H:%M:%S'), 'thresholds': {}}

log('\n=== THRESHOLD SWEEP ===')
log(f'{"Pct":>5} {"IC":>8} {"Sortino":>9} {"WR":>8} {"avg_n":>8}')

for pct in THRESHOLDS:
    bucket_ics, bucket_sortinos, bucket_wrs, bucket_ns = [], [], [], []

    for fi in val_files:
        try:
            x, y = load_day(fi)
            preds = model.predict(x)
            thresh = np.percentile(np.abs(preds), pct)
            mask = np.abs(preds) > thresh
            if mask.sum() < 10:
                continue

            sub_preds = preds[mask]
            sub_y = y[mask]
            signed_y = sub_y * np.sign(sub_preds)

            # IC: correlation of |prediction| with |return|
            if len(sub_preds) > 5:
                ic = float(spearmanr(np.abs(sub_preds), np.abs(sub_y))[0])
            else:
                ic = 0.0

            neg = signed_y[signed_y < 0]
            ds = float(np.std(neg)) if len(neg) > 3 else 1e-9
            sortino = float(np.mean(signed_y)) / ds if ds > 0 else 0.0
            wr = float(np.mean(signed_y > 0))

            bucket_ics.append(ic)
            bucket_sortinos.append(sortino)
            bucket_wrs.append(wr)
            bucket_ns.append(int(mask.sum()))
        except Exception as e:
            log(f'  Val err {os.path.basename(fi)}: {e}')

    if bucket_ics:
        r = {
            'ic': round(float(np.mean(bucket_ics)), 4),
            'sortino': round(float(np.mean(bucket_sortinos)), 4),
            'wr': round(float(np.mean(bucket_wrs)), 4),
            'avg_n': round(float(np.mean(bucket_ns)), 1),
            'pct_filtered': round(100 - pct, 1)
        }
        results['thresholds'][pct] = r
        log(f'{pct:>5} {r["ic"]:>8.4f} {r["sortino"]:>9.3f} {r["wr"]:>8.3f} {r["avg_n"]:>8.0f}')
    else:
        log(f'{pct:>5}  -- no data --')

with open(OUT, 'w') as f:
    json.dump(results, f, indent=2)
log(f'\nDONE. Results: {OUT}')

# Summary
best_pct = max(results['thresholds'].items(), key=lambda x: x[1]['sortino'], default=(None, {}))
if best_pct[0]:
    log(f'BEST Sortino at pct={best_pct[0]}: Sortino={best_pct[1]["sortino"]:.3f} IC={best_pct[1]["ic"]:.4f} WR={best_pct[1]["wr"]:.3f} avg_n={best_pct[1]["avg_n"]:.0f}')
