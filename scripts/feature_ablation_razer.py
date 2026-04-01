"""
Feature Engineering Ablation Study — Razer 3070 (8GB VRAM)

Tests which engineered features actually add IC to the BookSpatialCNN model.

Experiments:
  1. BASELINE: Standard CNN with raw 4 features only (no engineering)
  2. BOOK_FEATURES: + 7 core book-derived features (OFI, pressure, spread, etc.)
  3. BOOK_PLUS: + 5 additional features (queue_decay, phantom_liquidity, etc.)
  4. INDIVIDUAL: Each of the 12 features tested individually vs baseline

Architecture: Small BookSpatialCNN — spatial=(32,64,128,256), temporal=256, ~4M params
Training: 5 epochs, 30 days, subsample=5 (fast ablation, not production)
Metric: Spearman IC on held-out day (walk-forward, last 5 days = test folds)
"""

import argparse
import gc
import json
import logging
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from scipy.stats import spearmanr
from torch.utils.data import DataLoader, Dataset

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
ROOT_DIR = Path(r"C:\Users\claude\Lvl3Quant")
MODELS_DIR = ROOT_DIR / "alpha_discovery" / "deep_models"
sys.path.insert(0, str(ROOT_DIR))
sys.path.insert(0, str(MODELS_DIR))

from book_spatial_cnn import BookSpatialCNN, BookTensorDataset
from feature_engineering import BookFeatureEngineer

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BOOK_DIR = str(ROOT_DIR / "data" / "processed" / "dl_book_cache")
OUTPUT_DIR = str(MODELS_DIR / "results" / "feature_ablation")
os.makedirs(OUTPUT_DIR, exist_ok=True)

logging.basicConfig(
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
    level=logging.INFO,
)
logger = logging.getLogger('feat_ablation')

# File handler
fh = logging.FileHandler(os.path.join(OUTPUT_DIR, f'ablation_{datetime.now().strftime("%Y%m%d_%H%M%S")}.log'))
fh.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s', datefmt='%H:%M:%S'))
logger.addHandler(fh)


# ---------------------------------------------------------------------------
# Feature configs for each experiment
# ---------------------------------------------------------------------------
ALL_OFF = {
    'order_flow_imbalance': False,
    'pressure_gradient': False,
    'spread': False,
    'queue_age_momentum': False,
    'depth_change_velocity': False,
    'book_asymmetry': False,
    'cumulative_depth_ratio': False,
    'queue_decay_rate': False,
    'phantom_liquidity': False,
    'book_renewal_asymmetry': False,
    'cross_level_pressure': False,
    'book_elasticity': False,
}

# Core 7 book features
BOOK_7 = {
    'order_flow_imbalance': True,
    'pressure_gradient': True,
    'spread': True,
    'queue_age_momentum': True,
    'depth_change_velocity': True,
    'book_asymmetry': True,
    'cumulative_depth_ratio': True,
    'queue_decay_rate': False,
    'phantom_liquidity': False,
    'book_renewal_asymmetry': False,
    'cross_level_pressure': False,
    'book_elasticity': False,
}

# All 12 features
ALL_12 = {k: True for k in ALL_OFF}

# Individual feature configs (one at a time)
INDIVIDUAL_FEATURES = list(ALL_OFF.keys())


def count_enabled_features(cfg: Dict[str, bool]) -> int:
    """Count how many features are enabled."""
    return sum(1 for v in cfg.values() if v)


# ---------------------------------------------------------------------------
# MFE target computation (simplified from train_walkforward.py)
# ---------------------------------------------------------------------------
def compute_mfe_net(mid_prices: np.ndarray, day_boundaries: List[int],
                    horizon: int = 100) -> np.ndarray:
    """
    Compute mfe_net_10s target: max favorable excursion (long) - max favorable excursion (short).
    horizon=100 bars = 10 seconds at 100ms bars.
    """
    n = len(mid_prices)
    targets = np.full(n, np.nan, dtype=np.float32)

    for i in range(n):
        end = min(i + horizon, n)
        # Don't cross day boundaries
        crossed = False
        for db in day_boundaries:
            if i < db <= end:
                crossed = True
                end = db
                break
        if end <= i + 1:
            continue

        future = mid_prices[i + 1:end]
        if len(future) == 0:
            continue

        current = mid_prices[i]
        mfe_long = (future - current).max()   # best upside
        mfe_short = (current - future).max()  # best downside
        targets[i] = mfe_long - mfe_short     # directional asymmetry

    return targets


# ---------------------------------------------------------------------------
# Dataset with feature engineering support
# ---------------------------------------------------------------------------
class AblationDataset(Dataset):
    """
    Book tensor dataset with configurable feature engineering.
    Loads NPZ files, applies feature engineering, returns windowed samples.
    """
    def __init__(self, npz_files: List[Path], feature_config: Dict[str, bool],
                 window_size: int = 20, horizon: int = 100, subsample: int = 5):
        self.window_size = window_size
        self.horizon = horizon
        self.subsample = subsample

        n_extra = count_enabled_features(feature_config)
        self.n_features = 4 + n_extra
        self.feature_engineer = BookFeatureEngineer(features=feature_config) if n_extra > 0 else None

        # Load data
        all_tensors = []
        all_mids = []
        day_boundaries = [0]

        for f in npz_files:
            data = np.load(f)
            tensors = data['book_tensors'].astype(np.float32)
            mids = data['mid_prices'].astype(np.float64)
            all_tensors.append(tensors)
            all_mids.append(mids)
            day_boundaries.append(day_boundaries[-1] + len(tensors))

        self.tensors = np.concatenate(all_tensors, axis=0)  # (N, 20, 4)
        self.mids = np.concatenate(all_mids, axis=0)
        self.day_boundaries = day_boundaries

        # Normalize: log1p for depth, orders, age (already done in NPZ? Check)
        # Apply log1p to depth (col 1), orders (col 2), age (col 3) if not already
        for col in [1, 2, 3]:
            vals = self.tensors[:, :, col]
            if vals.min() >= 0 and vals.max() > 50:  # not already log1p'd
                self.tensors[:, :, col] = np.log1p(vals)

        # Compute targets
        self.targets = compute_mfe_net(self.mids, self.day_boundaries, horizon)

        # Build valid indices (not crossing day boundaries, have valid target)
        self.valid_indices = []
        for i in range(len(self.tensors) - window_size - horizon):
            if np.isnan(self.targets[i + window_size - 1]):
                continue
            # Check day boundary
            crossed = False
            for j in range(len(day_boundaries) - 1):
                db = day_boundaries[j + 1]
                if i < db <= i + window_size:
                    crossed = True
                    break
            if not crossed:
                self.valid_indices.append(i)

        # Subsample
        if subsample > 1:
            self.valid_indices = self.valid_indices[::subsample]

        logger.info(f"  Dataset: {len(npz_files)} files, {len(self.tensors)} bars, "
                     f"{len(self.valid_indices)} samples (subsample={subsample}), "
                     f"{self.n_features} features")

    def __len__(self):
        return len(self.valid_indices)

    def __getitem__(self, idx):
        i = self.valid_indices[idx]
        window = self.tensors[i:i + self.window_size]  # (W, 20, 4)
        target = self.targets[i + self.window_size - 1]

        x = torch.tensor(window, dtype=torch.float32)  # (W, 20, 4)

        if self.feature_engineer is not None:
            # Feature engineer expects (B, T, 20, 4), add batch dim
            x_batch = x.unsqueeze(0)  # (1, W, 20, 4)
            x_batch = self.feature_engineer(x_batch)  # (1, W, 20, 4+N)
            x = x_batch.squeeze(0)  # (W, 20, 4+N)

        y = torch.tensor(target, dtype=torch.float32)
        return x, y


# ---------------------------------------------------------------------------
# Training loop
# ---------------------------------------------------------------------------
def train_one_fold(model: nn.Module, train_loader: DataLoader, val_loader: DataLoader,
                   epochs: int, lr: float, device: torch.device) -> Dict:
    """Train model and return IC on validation set."""
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)
    loss_fn = nn.MSELoss()

    model.to(device)
    best_ic = -1.0
    train_losses = []

    for epoch in range(epochs):
        model.train()
        epoch_loss = 0.0
        n_batches = 0

        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            optimizer.zero_grad()

            # Model expects (B, W, 20, F) — our dataset returns (W, 20, F) per sample
            logits = model(x)

            # If model outputs classification logits (3 classes), use the directional score
            if logits.shape[-1] == 3:
                # Convert to regression: P(up) - P(down)
                probs = F.softmax(logits, dim=-1)
                pred = probs[:, 2] - probs[:, 0]  # up_prob - down_prob
            else:
                pred = logits.squeeze(-1)

            loss = loss_fn(pred, y)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

            epoch_loss += loss.item()
            n_batches += 1

        scheduler.step()
        avg_loss = epoch_loss / max(n_batches, 1)
        train_losses.append(avg_loss)

        # Validation IC
        model.eval()
        all_preds = []
        all_targets = []
        with torch.no_grad():
            for x, y in val_loader:
                x = x.to(device)
                logits = model(x)
                if logits.shape[-1] == 3:
                    probs = F.softmax(logits, dim=-1)
                    pred = probs[:, 2] - probs[:, 0]
                else:
                    pred = logits.squeeze(-1)
                all_preds.extend(pred.cpu().numpy())
                all_targets.extend(y.numpy())

        ic, _ = spearmanr(all_preds, all_targets)
        if np.isnan(ic):
            ic = 0.0
        if ic > best_ic:
            best_ic = ic

        logger.info(f"    Epoch {epoch+1}/{epochs}: loss={avg_loss:.6f}, val_IC={ic:.4f}")

    return {
        'best_ic': best_ic,
        'final_ic': ic,
        'train_losses': train_losses,
    }


# ---------------------------------------------------------------------------
# Main ablation
# ---------------------------------------------------------------------------
def run_ablation(args):
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    logger.info(f"Device: {device}")
    if device.type == 'cuda':
        logger.info(f"GPU: {torch.cuda.get_device_name(0)}, "
                     f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB")

    # Find NPZ files, take last N days
    npz_files = sorted(Path(BOOK_DIR).glob('*_book_tensors.npz'))
    if not npz_files:
        logger.error(f"No NPZ files found in {BOOK_DIR}")
        return

    logger.info(f"Found {len(npz_files)} NPZ files total")

    # Use last 35 days (30 train + 5 test folds)
    n_days = min(args.days + args.test_folds, len(npz_files))
    npz_files = npz_files[-n_days:]
    logger.info(f"Using {n_days} days for ablation ({n_days - args.test_folds} train, {args.test_folds} test folds)")

    # Define experiments
    experiments = []

    if args.mode in ('all', 'groups'):
        experiments.extend([
            ('baseline_raw4', ALL_OFF),
            ('book_7_features', BOOK_7),
            ('all_12_features', ALL_12),
        ])

    if args.mode in ('all', 'individual'):
        for feat_name in INDIVIDUAL_FEATURES:
            cfg = dict(ALL_OFF)
            cfg[feat_name] = True
            experiments.append((f'single_{feat_name}', cfg))

    results = {}
    total_start = time.time()

    for exp_name, feat_config in experiments:
        n_extra = count_enabled_features(feat_config)
        n_features = 4 + n_extra
        logger.info(f"\n{'='*60}")
        logger.info(f"EXPERIMENT: {exp_name} ({n_features} features, {n_extra} engineered)")
        logger.info(f"{'='*60}")

        fold_ics = []

        for fold_idx in range(args.test_folds):
            test_day_idx = len(npz_files) - args.test_folds + fold_idx
            train_files = npz_files[:test_day_idx]
            test_files = [npz_files[test_day_idx]]

            # Purge gap: drop last training day
            if len(train_files) > 1:
                train_files = train_files[:-1]

            logger.info(f"  Fold {fold_idx+1}/{args.test_folds}: "
                         f"train={len(train_files)} days, test=1 day "
                         f"({test_files[0].stem})")

            try:
                # Build datasets
                train_ds = AblationDataset(train_files, feat_config,
                                           window_size=args.window, horizon=100,
                                           subsample=args.subsample)
                test_ds = AblationDataset(test_files, feat_config,
                                          window_size=args.window, horizon=100,
                                          subsample=1)  # no subsampling on test

                if len(train_ds) < 100 or len(test_ds) < 50:
                    logger.warning(f"    Skipping fold: too few samples "
                                    f"(train={len(train_ds)}, test={len(test_ds)})")
                    continue

                train_loader = DataLoader(train_ds, batch_size=args.batch_size,
                                          shuffle=True, num_workers=0, pin_memory=True)
                test_loader = DataLoader(test_ds, batch_size=args.batch_size,
                                         shuffle=False, num_workers=0, pin_memory=True)

                # Build model — SMALL to fit in 8GB
                model = BookSpatialCNN(
                    window_size=args.window,
                    num_levels=20,
                    num_features=n_features,
                    spatial_channels=(32, 64, 128, 256),
                    temporal_channels=256,
                    dropout=args.dropout,
                    num_classes=3,
                )
                n_params = sum(p.numel() for p in model.parameters())
                if fold_idx == 0:
                    logger.info(f"  Model params: {n_params:,} ({n_params/1e6:.2f}M)")

                # Train
                fold_result = train_one_fold(model, train_loader, test_loader,
                                              epochs=args.epochs, lr=args.lr,
                                              device=device)
                fold_ics.append(fold_result['best_ic'])
                logger.info(f"    Fold {fold_idx+1} best IC: {fold_result['best_ic']:.4f}")

            except Exception as e:
                logger.error(f"    Fold {fold_idx+1} failed: {e}")
                import traceback
                traceback.print_exc()

            finally:
                # Free GPU memory
                gc.collect()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

        # Summarize experiment
        if fold_ics:
            mean_ic = np.mean(fold_ics)
            std_ic = np.std(fold_ics)
            results[exp_name] = {
                'n_features': n_features,
                'n_engineered': n_extra,
                'enabled_features': [k for k, v in feat_config.items() if v],
                'fold_ics': fold_ics,
                'mean_ic': float(mean_ic),
                'std_ic': float(std_ic),
                'min_ic': float(np.min(fold_ics)),
                'max_ic': float(np.max(fold_ics)),
            }
            logger.info(f"  RESULT: mean_IC={mean_ic:.4f} +/- {std_ic:.4f} "
                         f"(range: {np.min(fold_ics):.4f} to {np.max(fold_ics):.4f})")
        else:
            results[exp_name] = {'error': 'no valid folds'}
            logger.warning(f"  RESULT: NO VALID FOLDS")

    # ---------------------------------------------------------------------------
    # Final summary
    # ---------------------------------------------------------------------------
    elapsed = time.time() - total_start
    logger.info(f"\n{'='*60}")
    logger.info(f"ABLATION STUDY COMPLETE — {elapsed/60:.1f} minutes")
    logger.info(f"{'='*60}")

    # Sort by mean IC
    sorted_results = sorted(
        [(k, v) for k, v in results.items() if 'mean_ic' in v],
        key=lambda x: x[1]['mean_ic'],
        reverse=True,
    )

    logger.info(f"\n{'Experiment':<35} {'Features':>8} {'Mean IC':>10} {'Std':>8} {'Range':>20}")
    logger.info("-" * 85)

    baseline_ic = results.get('baseline_raw4', {}).get('mean_ic', 0)

    for name, r in sorted_results:
        delta = r['mean_ic'] - baseline_ic if baseline_ic else 0
        delta_str = f"({delta:+.4f})" if name != 'baseline_raw4' else ""
        logger.info(f"  {name:<33} {r['n_features']:>8} {r['mean_ic']:>10.4f} {r['std_ic']:>8.4f} "
                     f"[{r['min_ic']:.4f}, {r['max_ic']:.4f}] {delta_str}")

    # Save results JSON
    results_path = os.path.join(OUTPUT_DIR, f'ablation_results_{datetime.now().strftime("%Y%m%d_%H%M%S")}.json')
    with open(results_path, 'w') as f:
        json.dump(results, f, indent=2)
    logger.info(f"\nResults saved to: {results_path}")

    # Also save a summary
    summary_path = os.path.join(OUTPUT_DIR, 'ablation_summary.json')
    summary = {
        'timestamp': datetime.now().isoformat(),
        'device': str(device),
        'n_days': n_days,
        'epochs': args.epochs,
        'subsample': args.subsample,
        'elapsed_minutes': elapsed / 60,
        'baseline_ic': baseline_ic,
        'ranked_results': [
            {'experiment': name, 'mean_ic': r['mean_ic'], 'delta_vs_baseline': r['mean_ic'] - baseline_ic,
             'features': r.get('enabled_features', [])}
            for name, r in sorted_results
        ],
    }
    with open(summary_path, 'w') as f:
        json.dump(summary, f, indent=2)
    logger.info(f"Summary saved to: {summary_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Feature Engineering Ablation Study')
    parser.add_argument('--mode', choices=['all', 'groups', 'individual'], default='groups',
                        help='all=groups+individual, groups=baseline/7/12, individual=each feature solo')
    parser.add_argument('--days', type=int, default=30, help='Training days')
    parser.add_argument('--test-folds', type=int, default=5, help='Number of test folds')
    parser.add_argument('--epochs', type=int, default=5, help='Epochs per fold')
    parser.add_argument('--batch-size', type=int, default=512, help='Batch size')
    parser.add_argument('--subsample', type=int, default=5, help='Subsample training data')
    parser.add_argument('--window', type=int, default=20, help='Window size (bars)')
    parser.add_argument('--lr', type=float, default=1e-3, help='Learning rate')
    parser.add_argument('--dropout', type=float, default=0.2, help='Dropout rate')
    args = parser.parse_args()

    logger.info("Feature Engineering Ablation Study")
    logger.info(f"Config: mode={args.mode}, days={args.days}, epochs={args.epochs}, "
                 f"subsample={args.subsample}, batch_size={args.batch_size}")

    run_ablation(args)
