"""
Deep CNN Experiment — Deeper + Wider architecture with more context window.
Self-contained script for Uranus RTX 5090 (32GB VRAM).

Architecture vs Standard/Wider CNN:
  Standard: spatial=(32,64,128,256), temporal=256, window=20, ~4M params
  Wider:    spatial=(64,128,256,512), temporal=512, window=20, ~12-16M params
  THIS:     spatial=(64,128,256,512,512,1024), temporal=1024, window=50, ~35M params
            + 4 temporal res blocks, bigger compress layer, more dropout for regularization

Training: Simple 80/20 day split (NOT walkforward) for fast proof-of-concept.
Target: mfe_net_10s (Spearman IC).

Usage:
  python deep_cnn_experiment.py --data-dir C:/data/dl_book_cache --days 100
"""

import argparse
import gc
import json
import logging
import math
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
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    format='%(asctime)s [%(name)s] %(levelname)s: %(message)s',
    datefmt='%H:%M:%S',
    level=logging.INFO,
)
logger = logging.getLogger('deep_cnn')


# ---------------------------------------------------------------------------
# MFE Target Computation (from train_walkforward.py)
# ---------------------------------------------------------------------------

def compute_mfe_net(mid_prices: np.ndarray, day_boundaries: List[int],
                    horizon_bars: int = 100, tick_size: float = 0.25) -> np.ndarray:
    from numpy.lib.stride_tricks import sliding_window_view

    N = len(mid_prices)
    H = horizon_bars

    mfe_long  = np.full(N, np.nan, dtype=np.float32)
    mfe_short = np.full(N, np.nan, dtype=np.float32)

    mid_shifted = mid_prices[1:]
    valid_len   = N - H - 1

    if valid_len > 0:
        windows  = sliding_window_view(mid_shifted, H)[:valid_len]
        fwd_max  = windows.max(axis=1)
        fwd_min  = windows.min(axis=1)

        mfe_long[:valid_len]  = np.maximum(0.0, (fwd_max - mid_prices[:valid_len]) / tick_size)
        mfe_short[:valid_len] = np.maximum(0.0, (mid_prices[:valid_len] - fwd_min) / tick_size)

    n_days = len(day_boundaries) - 1
    for d in range(n_days - 1):
        day_end   = day_boundaries[d + 1]
        nan_start = max(day_boundaries[d], day_end - H)
        mfe_long[nan_start:day_end]  = np.nan
        mfe_short[nan_start:day_end] = np.nan

    mfe_net = (mfe_long - mfe_short).astype(np.float32)
    return mfe_net


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

class BookDataset(Dataset):
    def __init__(self, day_data_list, target, day_boundaries, window_size=50, subsample=1):
        self.window_size = window_size

        # Concatenate all book tensors
        tensors = np.concatenate([d['book_tensors'] for d in day_data_list], axis=0)
        # Log-transform features 1,2,3
        tensors[:, :, 1] = np.log1p(tensors[:, :, 1])
        tensors[:, :, 2] = np.log1p(tensors[:, :, 2])
        tensors[:, :, 3] = np.log1p(tensors[:, :, 3])
        self.tensors = tensors.astype(np.float32)
        self.target = target.astype(np.float32)

        # Build valid indices (need window_size bars of history within same day)
        valid_set = set()
        for day_idx in range(len(day_boundaries) - 1):
            start = day_boundaries[day_idx]
            end = day_boundaries[day_idx + 1]
            for i in range(start + window_size - 1, end):
                if i < len(target) and np.isfinite(target[i]):
                    valid_set.add(i)

        all_valid = sorted(valid_set)
        if subsample > 1:
            all_valid = all_valid[::subsample]
        self.valid_indices = np.array(all_valid, dtype=np.int64)

    def __len__(self):
        return len(self.valid_indices)

    def __getitem__(self, idx):
        i = int(self.valid_indices[idx])
        window = self.tensors[i - self.window_size + 1 : i + 1]  # (W, 20, 4)
        window = torch.from_numpy(window)
        target = float(self.target[i])
        return window, target


def collate_book(batch):
    windows = torch.stack([b[0] for b in batch])
    targets = torch.tensor([b[1] for b in batch], dtype=torch.float32)
    return windows, targets


# ---------------------------------------------------------------------------
# Model: Deep Spatial CNN
# ---------------------------------------------------------------------------

class SpatialResBlock(nn.Module):
    def __init__(self, in_ch, out_ch, dropout=0.1):
        super().__init__()
        self.conv1 = nn.Conv2d(in_ch, out_ch, kernel_size=(3, 3), padding=(1, 1), bias=False)
        self.bn1 = nn.BatchNorm2d(out_ch)
        self.conv2 = nn.Conv2d(out_ch, out_ch, kernel_size=(3, 3), padding=(1, 1), bias=False)
        self.bn2 = nn.BatchNorm2d(out_ch)
        self.dropout = nn.Dropout2d(dropout)

        if in_ch != out_ch:
            self.shortcut = nn.Sequential(
                nn.Conv2d(in_ch, out_ch, kernel_size=1, bias=False),
                nn.BatchNorm2d(out_ch),
            )
        else:
            self.shortcut = nn.Identity()

    def forward(self, x):
        identity = self.shortcut(x)
        out = F.gelu(self.bn1(self.conv1(x)))
        out = self.dropout(out)
        out = self.bn2(self.conv2(out))
        out = F.gelu(out + identity)
        return out


class TemporalResBlock(nn.Module):
    def __init__(self, channels, kernel_size=3, dropout=0.1):
        super().__init__()
        padding = kernel_size // 2
        self.conv1 = nn.Conv1d(channels, channels, kernel_size=kernel_size, padding=padding, bias=False)
        self.bn1 = nn.BatchNorm1d(channels)
        self.conv2 = nn.Conv1d(channels, channels, kernel_size=kernel_size, padding=padding, bias=False)
        self.bn2 = nn.BatchNorm1d(channels)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x):
        identity = x
        out = F.gelu(self.bn1(self.conv1(x)))
        out = self.dropout(out)
        out = self.bn2(self.conv2(out))
        out = F.gelu(out + identity)
        return out


class DeepBookSpatialCNN(nn.Module):
    """
    Deep + Wide variant of BookSpatialCNN.

    Key differences from standard:
    - 6 spatial res blocks (vs 3): [64, 128, 256, 512, 512, 1024]
    - 4 temporal res blocks (vs 2) with 1024 channels
    - Window size 50 (5 seconds context vs 2 seconds)
    - Bigger spatial compress (512 vs 256)
    - Separate bid/ask conv with 64 channels each (vs 32)
    - ~35M parameters
    """
    def __init__(
        self,
        window_size: int = 50,
        num_levels: int = 20,
        num_features: int = 4,
        spatial_channels: Tuple[int, ...] = (64, 128, 256, 512, 512, 1024),
        temporal_channels: int = 1024,
        spatial_compress_dim: int = 512,
        dropout: float = 0.15,
        num_classes: int = 1,
    ):
        super().__init__()
        self.window_size = window_size
        self.num_levels = num_levels
        self.num_features = num_features

        # Spatial stem
        self.spatial_stem = nn.Sequential(
            nn.Conv2d(1, spatial_channels[0], kernel_size=(3, 3), padding=(1, 1), bias=False),
            nn.BatchNorm2d(spatial_channels[0]),
            nn.GELU(),
        )

        # 5 spatial res blocks (channel transitions)
        spatial_res_layers = []
        for i in range(len(spatial_channels) - 1):
            spatial_res_layers.append(
                SpatialResBlock(spatial_channels[i], spatial_channels[i + 1], dropout=dropout * 0.5)
            )
        self.spatial_res_blocks = nn.Sequential(*spatial_res_layers)

        # Pool across feature dimension
        self.spatial_pool = nn.AdaptiveAvgPool2d((num_levels, 1))

        spatial_out_dim = spatial_channels[-1] * num_levels  # 1024 * 20 = 20480

        # Compress spatial features (bigger than standard)
        self.spatial_compress = nn.Sequential(
            nn.Linear(spatial_out_dim, spatial_compress_dim),
            nn.GELU(),
            nn.Dropout(dropout),
        )

        # Bid/Ask specific convolutions (wider)
        self.bid_conv = nn.Sequential(
            nn.Conv1d(num_features, 64, kernel_size=3, padding=1),
            nn.GELU(),
            nn.Conv1d(64, 64, kernel_size=3, padding=1),
            nn.GELU(),
            nn.AdaptiveAvgPool1d(1),
        )
        self.ask_conv = nn.Sequential(
            nn.Conv1d(num_features, 64, kernel_size=3, padding=1),
            nn.GELU(),
            nn.Conv1d(64, 64, kernel_size=3, padding=1),
            nn.GELU(),
            nn.AdaptiveAvgPool1d(1),
        )

        # Temporal processor
        temporal_in = spatial_compress_dim + 128  # 512 + 128 = 640

        self.temporal_stem = nn.Sequential(
            nn.Conv1d(temporal_in, temporal_channels, kernel_size=7, padding=3, bias=False),
            nn.BatchNorm1d(temporal_channels),
            nn.GELU(),
        )

        # 4 temporal residual blocks with varying kernel sizes
        self.temporal_res1 = TemporalResBlock(temporal_channels, kernel_size=7, dropout=dropout)
        self.temporal_res2 = TemporalResBlock(temporal_channels, kernel_size=5, dropout=dropout)
        self.temporal_res3 = TemporalResBlock(temporal_channels, kernel_size=5, dropout=dropout)
        self.temporal_res4 = TemporalResBlock(temporal_channels, kernel_size=3, dropout=dropout)

        self.temporal_pool = nn.AdaptiveAvgPool1d(1)

        # Classification head (deeper)
        self.classifier = nn.Sequential(
            nn.Linear(temporal_channels, temporal_channels // 2),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(temporal_channels // 2, temporal_channels // 4),
            nn.GELU(),
            nn.Dropout(dropout * 0.5),
            nn.Linear(temporal_channels // 4, num_classes),
        )

    def forward(self, x):
        B, T, L, F_dim = x.shape

        # Process each bar spatially
        x_spatial = x.reshape(B * T, 1, L, F_dim)
        x_spatial = self.spatial_stem(x_spatial)
        x_spatial = self.spatial_res_blocks(x_spatial)
        x_spatial = self.spatial_pool(x_spatial)
        x_spatial = x_spatial.reshape(B * T, -1)
        x_spatial = self.spatial_compress(x_spatial)
        x_spatial = x_spatial.reshape(B, T, -1)

        # Bid/Ask features
        bid_in = x[:, :, :10, :].reshape(B * T, 10, F_dim).permute(0, 2, 1)
        ask_in = x[:, :, 10:, :].reshape(B * T, 10, F_dim).permute(0, 2, 1)

        bid_feats = self.bid_conv(bid_in).squeeze(-1)
        ask_feats = self.ask_conv(ask_in).squeeze(-1)
        side_feats = torch.cat([bid_feats, ask_feats], dim=-1)
        side_feats = side_feats.reshape(B, T, -1)

        # Combine and process temporally
        combined = torch.cat([x_spatial, side_feats], dim=-1)
        combined = combined.permute(0, 2, 1)

        temporal_out = self.temporal_stem(combined)
        temporal_out = self.temporal_res1(temporal_out)
        temporal_out = self.temporal_res2(temporal_out)
        temporal_out = self.temporal_res3(temporal_out)
        temporal_out = self.temporal_res4(temporal_out)
        temporal_out = self.temporal_pool(temporal_out)
        temporal_out = temporal_out.squeeze(-1)

        logits = self.classifier(temporal_out)
        return logits


# ---------------------------------------------------------------------------
# Data Loading
# ---------------------------------------------------------------------------

def get_available_dates(cache_dir: str) -> List[str]:
    suffix = '_book_tensors.npz'
    files = sorted(Path(cache_dir).glob(f'*{suffix}'))
    dates = [f.name.replace(suffix, '') for f in files]
    return dates


def load_day_files(cache_dir: str, dates: List[str]):
    cache_path = Path(cache_dir)
    suffix = '_book_tensors.npz'

    all_data = []
    all_mids = []
    boundaries = [0]

    for date in dates:
        fname = cache_path / f'{date}{suffix}'
        if not fname.exists():
            logger.warning(f'  Missing file: {fname.name}, skipping')
            continue
        npz = np.load(fname)
        all_data.append(dict(npz))
        all_mids.append(npz['mid_prices'])
        boundaries.append(boundaries[-1] + len(npz['mid_prices']))

    mid_concat = np.concatenate(all_mids) if all_mids else np.array([])
    return all_data, mid_concat, boundaries


# ---------------------------------------------------------------------------
# Training Loop
# ---------------------------------------------------------------------------

@torch.no_grad()
def evaluate(model, loader, device):
    model.eval()
    all_preds = []
    all_targets = []
    criterion = nn.HuberLoss(delta=1.0)
    total_loss = 0.0
    total_n = 0

    for batch in loader:
        windows, targets = batch
        windows = windows.to(device)
        targets_dev = targets.to(device)

        with torch.amp.autocast('cuda'):
            preds = model(windows).squeeze(-1)
            loss = criterion(preds, targets_dev)

        n = targets.shape[0]
        total_loss += loss.item() * n
        total_n += n
        all_preds.append(preds.cpu().float().numpy())
        all_targets.append(targets.numpy())

    if not all_preds:
        return 0.0, 0.0

    val_loss = total_loss / max(total_n, 1)
    preds_arr = np.concatenate(all_preds)
    targets_arr = np.concatenate(all_targets)

    mask = np.isfinite(preds_arr) & np.isfinite(targets_arr)
    if mask.sum() < 10:
        return 0.0, val_loss

    ic, _ = spearmanr(preds_arr[mask], targets_arr[mask])
    return float(ic) if np.isfinite(ic) else 0.0, val_loss


def main():
    parser = argparse.ArgumentParser(description='Deep CNN Experiment')
    parser.add_argument('--data-dir', type=str, required=True,
                        help='Directory with _book_tensors.npz files')
    parser.add_argument('--output-dir', type=str, default='./deep_cnn_results',
                        help='Where to save results')
    parser.add_argument('--days', type=int, default=100,
                        help='Number of days to use')
    parser.add_argument('--epochs', type=int, default=5,
                        help='Training epochs')
    parser.add_argument('--batch-size', type=int, default=256,
                        help='Batch size')
    parser.add_argument('--lr', type=float, default=2e-4,
                        help='Learning rate')
    parser.add_argument('--window-size', type=int, default=50,
                        help='Context window (bars). 50 = 5 seconds')
    parser.add_argument('--subsample-train', type=int, default=3,
                        help='Subsample factor for training data')
    parser.add_argument('--horizon-bars', type=int, default=100,
                        help='Forward horizon (100 = 10s at 100ms)')
    parser.add_argument('--val-days', type=int, default=20,
                        help='Number of days for validation')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--spatial-channels', type=str, default='64,128,256,512,512,1024',
                        help='Spatial channel progression (comma-separated)')
    parser.add_argument('--temporal-channels', type=int, default=1024,
                        help='Temporal hidden channels')
    parser.add_argument('--dropout', type=float, default=0.15,
                        help='Dropout rate')
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    os.makedirs(args.output_dir, exist_ok=True)

    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    spatial_channels = tuple(int(x) for x in args.spatial_channels.split(','))

    logger.info('=' * 70)
    logger.info('DEEP CNN EXPERIMENT')
    logger.info(f'  Data dir:           {args.data_dir}')
    logger.info(f'  Output dir:         {args.output_dir}')
    logger.info(f'  Device:             {device}')
    logger.info(f'  Days:               {args.days}')
    logger.info(f'  Val days:           {args.val_days}')
    logger.info(f'  Window size:        {args.window_size} bars ({args.window_size * 0.1:.1f}s)')
    logger.info(f'  Spatial channels:   {spatial_channels}')
    logger.info(f'  Temporal channels:  {args.temporal_channels}')
    logger.info(f'  Dropout:            {args.dropout}')
    logger.info(f'  Batch size:         {args.batch_size}')
    logger.info(f'  LR:                 {args.lr}')
    logger.info(f'  Epochs:             {args.epochs}')
    logger.info(f'  Subsample:          {args.subsample_train}')
    logger.info(f'  Horizon:            {args.horizon_bars} bars ({args.horizon_bars * 0.1:.1f}s)')
    logger.info('=' * 70)

    # Load dates
    dates = get_available_dates(args.data_dir)
    if args.days and args.days < len(dates):
        dates = dates[:args.days]

    n_total = len(dates)
    logger.info(f'  Found {n_total} days: {dates[0]} .. {dates[-1]}')

    if n_total < args.val_days + 10:
        raise ValueError(f'Not enough days: need at least {args.val_days + 10}, got {n_total}')

    # Split: train on first N-val_days, validate on last val_days
    train_dates = dates[:-args.val_days]
    val_dates = dates[-args.val_days:]
    logger.info(f'  Train: {len(train_dates)} days ({train_dates[0]}..{train_dates[-1]})')
    logger.info(f'  Val:   {len(val_dates)} days ({val_dates[0]}..{val_dates[-1]})')

    # Load training data
    logger.info('Loading training data...')
    t0 = time.time()
    train_data, train_mids, train_bounds = load_day_files(args.data_dir, train_dates)
    train_target = compute_mfe_net(train_mids, train_bounds, args.horizon_bars)
    logger.info(f'  Train: {len(train_mids):,} bars loaded in {time.time()-t0:.1f}s')
    logger.info(f'  Train target stats: mean={np.nanmean(train_target):.4f}, std={np.nanstd(train_target):.4f}')

    # Z-score normalize target
    target_mean = np.nanmean(train_target)
    target_std = np.nanstd(train_target)
    if target_std > 0:
        train_target = (train_target - target_mean) / target_std
    logger.info(f'  Target z-scored: mean={np.nanmean(train_target):.4f}, std={np.nanstd(train_target):.4f}')

    train_ds = BookDataset(train_data, train_target, train_bounds,
                          window_size=args.window_size, subsample=args.subsample_train)
    logger.info(f'  Train samples: {len(train_ds):,}')

    # Free raw data
    del train_data, train_mids
    gc.collect()

    # Load validation data
    logger.info('Loading validation data...')
    t0 = time.time()
    val_data, val_mids, val_bounds = load_day_files(args.data_dir, val_dates)
    val_target = compute_mfe_net(val_mids, val_bounds, args.horizon_bars)
    if target_std > 0:
        val_target = (val_target - target_mean) / target_std
    logger.info(f'  Val: {len(val_mids):,} bars loaded in {time.time()-t0:.1f}s')

    val_ds = BookDataset(val_data, val_target, val_bounds,
                        window_size=args.window_size, subsample=1)
    logger.info(f'  Val samples: {len(val_ds):,}')

    del val_data, val_mids
    gc.collect()

    # DataLoaders
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True,
                             collate_fn=collate_book, num_workers=2, pin_memory=True,
                             drop_last=True)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size * 2, shuffle=False,
                           collate_fn=collate_book, num_workers=2, pin_memory=True)

    # Build model
    model = DeepBookSpatialCNN(
        window_size=args.window_size,
        spatial_channels=spatial_channels,
        temporal_channels=args.temporal_channels,
        dropout=args.dropout,
        num_classes=1,
    ).to(device)

    n_params = sum(p.numel() for p in model.parameters())
    logger.info(f'  Model parameters: {n_params:,}')
    logger.info(f'  GPU memory: {torch.cuda.memory_allocated()/1e9:.2f} GB allocated')

    # Optimizer + scheduler
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(
        optimizer, max_lr=args.lr,
        epochs=args.epochs, steps_per_epoch=len(train_loader),
        pct_start=0.1, anneal_strategy='cos',
    )
    scaler = torch.amp.GradScaler('cuda')
    criterion = nn.HuberLoss(delta=1.0)

    # Training
    best_ic = -999
    best_epoch = -1
    results = {
        'config': {
            'spatial_channels': list(spatial_channels),
            'temporal_channels': args.temporal_channels,
            'window_size': args.window_size,
            'dropout': args.dropout,
            'batch_size': args.batch_size,
            'lr': args.lr,
            'epochs': args.epochs,
            'n_params': n_params,
            'train_days': len(train_dates),
            'val_days': len(val_dates),
            'subsample': args.subsample_train,
            'horizon_bars': args.horizon_bars,
        },
        'epochs': [],
    }

    logger.info('\n' + '=' * 70)
    logger.info('TRAINING START')
    logger.info('=' * 70)

    total_start = time.time()

    for epoch in range(args.epochs):
        epoch_start = time.time()
        model.train()
        total_loss = 0.0
        total_n = 0

        for batch_idx, batch in enumerate(train_loader):
            windows, targets = batch
            windows = windows.to(device)
            targets = targets.to(device)

            optimizer.zero_grad()

            with torch.amp.autocast('cuda'):
                preds = model(windows).squeeze(-1)
                loss = criterion(preds, targets)

            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(optimizer)
            scaler.update()
            scheduler.step()

            n = targets.shape[0]
            total_loss += loss.item() * n
            total_n += n

            if (batch_idx + 1) % 50 == 0:
                avg = total_loss / total_n
                lr_now = optimizer.param_groups[0]['lr']
                mem = torch.cuda.memory_allocated() / 1e9
                logger.info(f'  Epoch {epoch+1} batch {batch_idx+1}/{len(train_loader)}: '
                          f'loss={avg:.6f}, lr={lr_now:.2e}, GPU={mem:.1f}GB')

        train_loss = total_loss / max(total_n, 1)

        # Evaluate
        val_ic, val_loss = evaluate(model, val_loader, device)
        epoch_time = time.time() - epoch_start

        epoch_result = {
            'epoch': epoch + 1,
            'train_loss': train_loss,
            'val_loss': val_loss,
            'val_ic': val_ic,
            'epoch_time': epoch_time,
            'lr': optimizer.param_groups[0]['lr'],
        }
        results['epochs'].append(epoch_result)

        is_best = val_ic > best_ic
        if is_best:
            best_ic = val_ic
            best_epoch = epoch + 1
            # Save best model
            torch.save({
                'epoch': epoch + 1,
                'model_state_dict': model.state_dict(),
                'optimizer_state_dict': optimizer.state_dict(),
                'val_ic': val_ic,
                'val_loss': val_loss,
                'config': results['config'],
            }, os.path.join(args.output_dir, 'best_model.pt'))

        marker = ' *** BEST ***' if is_best else ''
        logger.info(f'Epoch {epoch+1}/{args.epochs}: '
                   f'train_loss={train_loss:.6f}, val_loss={val_loss:.6f}, '
                   f'val_IC={val_ic:.4f}, time={epoch_time:.1f}s{marker}')

        # Save checkpoint every epoch
        torch.save({
            'epoch': epoch + 1,
            'model_state_dict': model.state_dict(),
            'val_ic': val_ic,
        }, os.path.join(args.output_dir, f'checkpoint_epoch{epoch+1}.pt'))

    total_time = time.time() - total_start
    results['total_time'] = total_time
    results['best_ic'] = best_ic
    results['best_epoch'] = best_epoch

    # Save results JSON
    with open(os.path.join(args.output_dir, 'results.json'), 'w') as f:
        json.dump(results, f, indent=2)

    logger.info('\n' + '=' * 70)
    logger.info('TRAINING COMPLETE')
    logger.info(f'  Total time:   {total_time:.1f}s ({total_time/60:.1f}m)')
    logger.info(f'  Best IC:      {best_ic:.4f} (epoch {best_epoch})')
    logger.info(f'  Parameters:   {n_params:,}')
    logger.info(f'  Architecture: spatial={list(spatial_channels)}, temporal={args.temporal_channels}')
    logger.info(f'  Window:       {args.window_size} bars ({args.window_size * 0.1:.1f}s)')
    logger.info('=' * 70)

    # Print comparison reference
    logger.info('\nREFERENCE ICs (standard CNN walkforward):')
    logger.info('  Standard CNN (4M params, w=20): IC ~0.073')
    logger.info('  Wider CNN (12M params, w=20):   IC ~0.10-0.14')
    logger.info(f'  THIS Deep CNN ({n_params/1e6:.1f}M params, w={args.window_size}): IC = {best_ic:.4f}')


if __name__ == '__main__':
    main()
