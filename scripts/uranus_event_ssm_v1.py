#!/usr/bin/env python3
"""
event_ssm_v1.py — State Space Model (S4-style) for MBO event sequences.
Architecture 1 for Uranus (RTX 5090 32GB VRAM).

State space models process sequences in O(N) vs O(N^2) for transformers.
Handles 5000-10000 event windows = 50-100 seconds of context.

Input: (N_events, 6) float32 per sample
  [time_delta_log, event_type_id, side_id, price_rel_ticks, qty_log, spread_ticks]
Output: 4 predictions [label_1s, label_5s, label_10s, label_30s]

Training:
  - Expanding window, 10 folds
  - Concat IC as primary metric
  - Mixed precision fp16
  - MLflow logging
  - Below-normal priority
"""

import os
import sys
import time
import math
import json
import random
import logging
import argparse
import warnings
from pathlib import Path
from datetime import datetime
from typing import Optional, Tuple, List

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader
import mlflow
import mlflow.pytorch

warnings.filterwarnings("ignore")

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [SSM-v1] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger("event_ssm_v1")

# ── Config ────────────────────────────────────────────────────────────────────
DATA_DIR   = Path(r"C:\Users\Nick\Lvl3Quant\data\processed\mbo_events")
RESULTS_DIR = Path(r"C:\Users\Nick\Lvl3Quant\results")
LOG_PATH   = Path(r"C:\Users\Nick\Lvl3Quant\results\event_mamba_v1.log")

MLFLOW_URIS = ["http://100.71.253.30:5000", "http://192.168.0.101:5000"]
EXPERIMENT_NAME = "event_ssm_v1"

# Event SSM hyperparameters
EVENT_FEATURES = 6
WINDOW_SIZE    = 5000    # events per sample (50-100s of context)
STRIDE         = 1000    # events between consecutive samples
D_MODEL        = 256     # state space dimension
N_LAYERS       = 6       # stacked SSM layers
D_STATE        = 64      # SSM state dimension (A matrix size)
D_CONV         = 4       # conv kernel size for input mixing
EXPAND         = 2       # expand factor for gating
N_HORIZONS     = 4       # 1s, 5s, 10s, 30s
DROPOUT        = 0.1
BATCH_SIZE     = 16
LR             = 2e-4
WEIGHT_DECAY   = 1e-2
MAX_EPOCHS     = 30
PATIENCE       = 5
N_FOLDS        = 10
NUM_WORKERS    = 8
SEED           = 42

HORIZON_KEYS   = ["labels_1s", "labels_5s", "labels_10s", "labels_30s"]
HORIZON_NAMES  = ["1s", "5s", "10s", "30s"]


# ── Set below-normal priority ──────────────────────────────────────────────────
def set_below_normal_priority():
    try:
        import ctypes
        ctypes.windll.kernel32.SetPriorityClass(
            ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000  # BELOW_NORMAL
        )
        log.info("Process priority set to BELOW_NORMAL")
    except Exception as e:
        log.warning(f"Could not set priority: {e}")


# ── SSM Core: Simplified S4-style State Space Model ───────────────────────────
class SSMKernel(nn.Module):
    """
    S4D (Diagonal State Space) kernel using FFT-based convolution.
    Much faster than sequential scan for long sequences (5000+ events).

    The key insight: the SSM recurrence h_t = A*h_{t-1} + B*u_t with
    diagonal A is equivalent to a causal convolution with kernel
    K[k] = C * A^k * B. We compute this efficiently via FFT.

    Reference: "On the Parameterization and Initialization of Diagonal
    State Space Models" (Gu et al. 2022)
    """
    def __init__(self, d_model: int, d_state: int):
        super().__init__()
        self.d_model = d_model
        self.d_state = d_state

        # Log-parametrize A eigenvalues for stability: A_real = -exp(A_log)
        # Use complex-valued A for better expressivity (real + imaginary parts)
        self.A_log  = nn.Parameter(torch.randn(d_model, d_state // 2))
        self.A_imag = nn.Parameter(torch.randn(d_model, d_state // 2) * math.pi)
        # B and C projections (real-valued for simplicity)
        self.B = nn.Parameter(torch.randn(d_model, d_state) * 0.1)
        self.C = nn.Parameter(torch.randn(d_model, d_state) * 0.1)
        # D: skip connection (direct feedthrough)
        self.D = nn.Parameter(torch.ones(d_model))
        # Step size (log-parametrized for positivity)
        self.log_dt = nn.Parameter(torch.zeros(d_model) - 3.0)  # dt ~ 0.05

    def _get_kernel(self, L: int, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
        """
        Compute the SSM convolution kernel K[k] = C * A^k * B for k=0..L-1.
        Shape: (d_model, L)
        """
        dt = torch.exp(self.log_dt)   # (d_model,)

        # Complex A eigenvalues: A_c = -exp(A_log) + i * A_imag
        A_real = -torch.exp(self.A_log)   # (d_model, d_state//2)
        A_imag = self.A_imag               # (d_model, d_state//2)
        # Discretize: A_bar = exp(dt * A_c), shape: (d_model, d_state//2) complex
        dt_A_real = dt.unsqueeze(-1) * A_real   # (d_model, d_state//2)
        dt_A_imag = dt.unsqueeze(-1) * A_imag   # (d_model, d_state//2)

        # Powers: A_bar^k = exp(k * dt * A_c)
        # For k = 0..L-1: shape (L, d_model, d_state//2)
        k = torch.arange(L, device=device, dtype=torch.float32)   # (L,)
        k_real = k.view(L, 1, 1) * dt_A_real.unsqueeze(0)   # (L, d_model, d_state//2)
        k_imag = k.view(L, 1, 1) * dt_A_imag.unsqueeze(0)   # (L, d_model, d_state//2)
        # A_bar^k: real = exp(k_real)*cos(k_imag), imag = exp(k_real)*sin(k_imag)
        exp_k = torch.exp(k_real)
        Ak_real = exp_k * torch.cos(k_imag)   # (L, d_model, d_state//2)
        Ak_imag = exp_k * torch.sin(k_imag)   # (L, d_model, d_state//2)

        # B_bar = dt * B (use first d_state//2 as real, rest as imaginary)
        B_r = (dt.unsqueeze(-1) * self.B[:, :self.d_state//2]).unsqueeze(0)   # (1, d_model, d_state//2)
        B_i = (dt.unsqueeze(-1) * self.B[:, self.d_state//2:]).unsqueeze(0)   # (1, d_model, d_state//2)
        C_r = self.C[:, :self.d_state//2].unsqueeze(0)   # (1, d_model, d_state//2)
        C_i = self.C[:, self.d_state//2:].unsqueeze(0)   # (1, d_model, d_state//2)

        # K[k] = 2 * Re(C * (A_bar^k * B_bar)) summed over d_state//2
        # (A_bar^k * B_bar): real = Ak_real*B_r - Ak_imag*B_i, imag = Ak_real*B_i + Ak_imag*B_r
        prod_real = Ak_real * B_r - Ak_imag * B_i   # (L, d_model, d_state//2)
        prod_imag = Ak_real * B_i + Ak_imag * B_r   # (L, d_model, d_state//2)
        # K[k] = 2 * Re(C * prod) = 2*(C_r*prod_real - C_i*prod_imag)
        K = 2.0 * (C_r * prod_real - C_i * prod_imag).sum(-1)   # (L, d_model)
        return K.transpose(0, 1)   # (d_model, L)

    def forward(self, u: torch.Tensor) -> torch.Tensor:
        """
        u: (B, L, d_model) — sequence of inputs
        Returns: y: (B, L, d_model)

        FFT-based causal convolution: O(L log L) instead of O(L^2).
        Handles L=5000-10000 efficiently on GPU.
        """
        B_sz, L, d = u.shape
        device = u.device

        # Get convolution kernel
        K = self._get_kernel(L, device, u.dtype)   # (d_model, L)

        # Causal convolution via FFT:
        # y = IFFT(FFT(K) * FFT(u)) — need padding to 2L for causal
        fft_size = 2 * L
        # u: (B, L, d) -> (B, d, L) for channel-wise FFT
        u_t = u.transpose(1, 2)   # (B, d, L)

        # FFT of both
        K_f = torch.fft.rfft(K,   n=fft_size, dim=-1)   # (d, fft_size//2+1) complex
        u_f = torch.fft.rfft(u_t, n=fft_size, dim=-1)   # (B, d, fft_size//2+1) complex

        # Element-wise multiply and IFFT
        y_f = K_f.unsqueeze(0) * u_f   # (B, d, fft_size//2+1)
        y   = torch.fft.irfft(y_f, n=fft_size, dim=-1)[:, :, :L]   # (B, d, L) — causal trim

        y = y.transpose(1, 2)   # (B, L, d)
        y = y + u * self.D.unsqueeze(0).unsqueeze(0)   # skip connection
        return y


class SSMLayer(nn.Module):
    """
    S4D layer: SSM + gating (Mamba-style selective) + residual.
    """
    def __init__(self, d_model: int, d_state: int, d_conv: int, expand: int, dropout: float):
        super().__init__()
        self.d_model = d_model
        d_inner = d_model * expand

        # Input projection (split into 2 for gating)
        self.in_proj = nn.Linear(d_model, d_inner * 2, bias=False)
        # Conv mix across events
        self.conv1d = nn.Conv1d(d_inner, d_inner, kernel_size=d_conv, padding=d_conv - 1, groups=d_inner)
        # SSM
        self.ssm = SSMKernel(d_inner, d_state)
        # Output projection
        self.out_proj = nn.Linear(d_inner, d_model, bias=False)
        # Norm
        self.norm = nn.LayerNorm(d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """x: (B, L, d_model)"""
        residual = x
        x = self.norm(x)

        # Project: split into SSM path and gate
        xz = self.in_proj(x)   # (B, L, 2*d_inner)
        x_ssm, z = xz.chunk(2, dim=-1)   # each (B, L, d_inner)

        # Causal conv mixing
        x_ssm = x_ssm.transpose(1, 2)   # (B, d_inner, L)
        x_ssm = self.conv1d(x_ssm)[:, :, :x.shape[1]]   # causal: trim right
        x_ssm = x_ssm.transpose(1, 2)   # (B, L, d_inner)
        x_ssm = F.silu(x_ssm)

        # SSM
        y = self.ssm(x_ssm)   # (B, L, d_inner)

        # Gating (Mamba-style)
        y = y * F.silu(z)

        # Output projection
        y = self.out_proj(y)
        y = self.dropout(y)
        return y + residual


class EventSSM(nn.Module):
    """
    Full SSM model for MBO event streams.
    Input: (B, L, 6) raw event features
    Output: (B, 4) predictions for 1s/5s/10s/30s horizons
    """
    def __init__(self, d_model: int = D_MODEL, n_layers: int = N_LAYERS,
                 d_state: int = D_STATE, d_conv: int = D_CONV,
                 expand: int = EXPAND, n_horizons: int = N_HORIZONS,
                 dropout: float = DROPOUT):
        super().__init__()
        self.d_model = d_model

        # Input embedding: project raw event features
        self.input_norm = nn.LayerNorm(EVENT_FEATURES)
        self.embed = nn.Sequential(
            nn.Linear(EVENT_FEATURES, d_model),
            nn.SiLU(),
            nn.Linear(d_model, d_model),
            nn.LayerNorm(d_model),
        )

        # Stacked SSM layers
        self.layers = nn.ModuleList([
            SSMLayer(d_model, d_state, d_conv, expand, dropout)
            for _ in range(n_layers)
        ])
        self.final_norm = nn.LayerNorm(d_model)

        # Multi-horizon prediction heads
        self.heads = nn.ModuleList([
            nn.Sequential(
                nn.Linear(d_model, d_model // 2),
                nn.SiLU(),
                nn.Linear(d_model // 2, 1),
            )
            for _ in range(n_horizons)
        ])

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """
        x: (B, L, 6) event features
        Returns: (B, 4) predictions
        """
        x = self.input_norm(x)
        x = self.embed(x)   # (B, L, d_model)

        for layer in self.layers:
            x = layer(x)

        x = self.final_norm(x)

        # Pool: use the LAST event's representation (most recent = highest value)
        # Also take max across last 10% of window for robustness
        last_pct = max(1, x.shape[1] // 10)
        x_last = x[:, -1, :]           # (B, d_model)
        x_recent = x[:, -last_pct:, :].mean(dim=1)   # (B, d_model)
        x_pooled = (x_last + x_recent) / 2           # (B, d_model)

        preds = [head(x_pooled) for head in self.heads]   # list of (B, 1)
        return torch.cat(preds, dim=-1)   # (B, 4)


# ── Dataset ───────────────────────────────────────────────────────────────────
class MBOEventDataset(Dataset):
    """Load MBO event .npz files and slice into windows."""

    def __init__(self, files: List[Path], window_size: int = WINDOW_SIZE,
                 stride: int = STRIDE, augment: bool = False):
        self.window_size = window_size
        self.stride = stride
        self.augment = augment
        self.samples = []   # (file_idx, event_start_idx)
        self.data_cache = {}
        self._load_files(files)

    def _load_files(self, files: List[Path]):
        for fpath in files:
            try:
                npz = np.load(fpath, allow_pickle=False)
                events = npz["events"].astype(np.float32)   # (N, 6)
                labels = np.stack([
                    npz["labels_1s"].astype(np.float32),
                    npz["labels_5s"].astype(np.float32),
                    npz["labels_10s"].astype(np.float32),
                    npz["labels_30s"].astype(np.float32),
                ], axis=1)   # (N, 4)

                N = events.shape[0]
                file_id = len(self.data_cache)
                self.data_cache[file_id] = (events, labels)

                # Each sample ends at event_start + window_size
                for start in range(0, N - self.window_size, self.stride):
                    self.samples.append((file_id, start))
            except Exception as e:
                log.warning(f"Failed to load {fpath.name}: {e}")

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        file_id, start = self.samples[idx]
        events, labels = self.data_cache[file_id]
        end = start + self.window_size

        x = events[start:end]       # (W, 6)
        y = labels[end - 1]         # (4,) — label at the last event

        # Data augmentation (training only): small noise on numeric features
        if self.augment:
            noise = np.random.normal(0, 0.01, x.shape).astype(np.float32)
            x = x + noise

        return torch.from_numpy(x), torch.from_numpy(y)


def get_sorted_files() -> List[Path]:
    files = sorted(DATA_DIR.glob("*_mbo_events.npz"))
    return files


def make_folds(files: List[Path], n_folds: int):
    """Expanding window folds: train grows, val is next block."""
    n = len(files)
    block_size = n // (n_folds + 1)
    folds = []
    for fold in range(n_folds):
        train_end = (fold + 1) * block_size
        val_end = train_end + block_size
        if val_end > n:
            val_end = n
        if train_end >= val_end:
            continue
        train_files = files[:train_end]
        val_files   = files[train_end:val_end]
        folds.append((fold, train_files, val_files))
    return folds


# ── Training utils ─────────────────────────────────────────────────────────────
def compute_ic(preds: np.ndarray, labels: np.ndarray) -> float:
    """Pearson IC between preds and labels."""
    p = preds - preds.mean()
    l = labels - labels.mean()
    denom = (np.std(p) * np.std(l)) + 1e-8
    return float(np.mean(p * l) / denom)


def train_fold(model, train_loader, val_loader, fold_idx: int,
               device: torch.device, fold_preds_path: Path):
    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=MAX_EPOCHS)
    scaler = torch.amp.GradScaler("cuda")

    best_val_loss = float("inf")
    best_model_state = None
    patience_ctr = 0

    for epoch in range(1, MAX_EPOCHS + 1):
        # Train
        model.train()
        train_losses = []
        for x, y in train_loader:
            x = x.to(device, non_blocking=True)
            y = y.to(device, non_blocking=True)
            optimizer.zero_grad()
            with torch.amp.autocast("cuda"):
                pred = model(x)   # (B, 4)
                loss = F.mse_loss(pred, y)
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(optimizer)
            scaler.update()
            train_losses.append(loss.item())

        scheduler.step()

        # Validate
        model.eval()
        val_losses = []
        all_preds, all_labels = [], []
        with torch.no_grad():
            for x, y in val_loader:
                x = x.to(device, non_blocking=True)
                y = y.to(device, non_blocking=True)
                with torch.amp.autocast("cuda"):
                    pred = model(x)
                    loss = F.mse_loss(pred, y)
                val_losses.append(loss.item())
                all_preds.append(pred.float().cpu().numpy())
                all_labels.append(y.float().cpu().numpy())

        val_loss = np.mean(val_losses)
        all_preds = np.concatenate(all_preds, axis=0)
        all_labels = np.concatenate(all_labels, axis=0)

        # Per-horizon IC
        ics = [compute_ic(all_preds[:, h], all_labels[:, h]) for h in range(N_HORIZONS)]
        mean_ic = np.mean(ics)
        train_loss = np.mean(train_losses)

        log.info(
            f"Fold {fold_idx} Epoch {epoch}/{MAX_EPOCHS} | "
            f"train_loss={train_loss:.5f} val_loss={val_loss:.5f} | "
            f"IC: {', '.join(f'{n}={v:.4f}' for n, v in zip(HORIZON_NAMES, ics))} | "
            f"mean_IC={mean_ic:.4f}"
        )

        mlflow.log_metrics({
            f"fold{fold_idx}_train_loss": train_loss,
            f"fold{fold_idx}_val_loss": val_loss,
            f"fold{fold_idx}_mean_ic": mean_ic,
            **{f"fold{fold_idx}_ic_{n}": v for n, v in zip(HORIZON_NAMES, ics)},
        }, step=epoch)

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_model_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
            patience_ctr = 0
        else:
            patience_ctr += 1
            if patience_ctr >= PATIENCE:
                log.info(f"Fold {fold_idx}: Early stop at epoch {epoch}")
                break

    # Restore best and save predictions
    if best_model_state:
        model.load_state_dict(best_model_state)

    model.eval()
    all_preds, all_labels = [], []
    with torch.no_grad():
        for x, y in val_loader:
            x = x.to(device, non_blocking=True)
            with torch.amp.autocast("cuda"):
                pred = model(x)
            all_preds.append(pred.float().cpu().numpy())
            all_labels.append(y.float().cpu().numpy())

    all_preds = np.concatenate(all_preds, axis=0)
    all_labels = np.concatenate(all_labels, axis=0)
    np.savez_compressed(fold_preds_path, preds=all_preds, labels=all_labels)
    log.info(f"Fold {fold_idx} predictions saved to {fold_preds_path}")

    ics = [compute_ic(all_preds[:, h], all_labels[:, h]) for h in range(N_HORIZONS)]
    return ics, best_model_state


def compute_concat_ic(all_fold_preds: list, all_fold_labels: list) -> List[float]:
    """Concatenate all fold predictions and compute IC across entire test period."""
    preds = np.concatenate(all_fold_preds, axis=0)
    labels = np.concatenate(all_fold_labels, axis=0)
    ics = [compute_ic(preds[:, h], labels[:, h]) for h in range(N_HORIZONS)]
    return ics


# ── Main ────────────────────────────────────────────────────────────────────────
def main():
    set_below_normal_priority()
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    random.seed(SEED)

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Add file handler to log
    fh = logging.FileHandler(LOG_PATH, mode="a")
    fh.setFormatter(logging.Formatter("%(asctime)s [SSM-v1] %(message)s"))
    log.addHandler(fh)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    log.info(f"Device: {device}, CUDA: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A'}")

    # Setup MLflow
    mlflow_uri = None
    for uri in MLFLOW_URIS:
        try:
            import urllib.request
            urllib.request.urlopen(uri + "/api/2.0/mlflow/experiments/list", timeout=3)
            mlflow_uri = uri
            log.info(f"MLflow connected: {uri}")
            break
        except Exception:
            continue

    if mlflow_uri:
        mlflow.set_tracking_uri(mlflow_uri)
    else:
        mlflow.set_tracking_uri(str(RESULTS_DIR / "mlruns"))
        log.warning("MLflow offline, logging locally")

    mlflow.set_experiment(EXPERIMENT_NAME)

    # Load files
    files = get_sorted_files()
    if len(files) < 5:
        log.error(f"Need at least 5 data files, found {len(files)} in {DATA_DIR}")
        log.error("Run data transfer first! python uranus_transfer_mbo_data.py")
        sys.exit(1)

    log.info(f"Found {len(files)} .npz files, dates: {files[0].name} to {files[-1].name}")
    folds = make_folds(files, N_FOLDS)
    log.info(f"Created {len(folds)} expanding window folds")

    with mlflow.start_run(run_name=f"event_ssm_v1_{datetime.now().strftime('%Y%m%d_%H%M')}"):
        mlflow.log_params({
            "model": "EventSSM",
            "d_model": D_MODEL,
            "n_layers": N_LAYERS,
            "d_state": D_STATE,
            "window_size": WINDOW_SIZE,
            "stride": STRIDE,
            "batch_size": BATCH_SIZE,
            "lr": LR,
            "max_epochs": MAX_EPOCHS,
            "n_folds": N_FOLDS,
            "n_files": len(files),
        })

        all_fold_preds = []
        all_fold_labels = []
        all_fold_ics = []

        for fold_idx, train_files, val_files in folds:
            log.info(f"\n{'='*60}")
            log.info(f"FOLD {fold_idx+1}/{len(folds)}: "
                     f"train={len(train_files)} files, val={len(val_files)} files")

            train_ds = MBOEventDataset(train_files, augment=True)
            val_ds   = MBOEventDataset(val_files,   augment=False)

            if len(train_ds) == 0 or len(val_ds) == 0:
                log.warning(f"Fold {fold_idx}: empty dataset, skipping")
                continue

            log.info(f"Train samples: {len(train_ds)}, Val samples: {len(val_ds)}")

            train_loader = DataLoader(
                train_ds, batch_size=BATCH_SIZE, shuffle=True,
                num_workers=NUM_WORKERS, pin_memory=True, drop_last=True,
                persistent_workers=True,
            )
            val_loader = DataLoader(
                val_ds, batch_size=BATCH_SIZE, shuffle=False,
                num_workers=NUM_WORKERS, pin_memory=True,
                persistent_workers=True,
            )

            model = EventSSM().to(device)
            n_params = sum(p.numel() for p in model.parameters())
            log.info(f"Model params: {n_params:,}")

            fold_preds_path = RESULTS_DIR / f"event_ssm_v1_fold{fold_idx:02d}_preds.npz"

            fold_ics, best_state = train_fold(
                model, train_loader, val_loader, fold_idx, device, fold_preds_path
            )
            all_fold_ics.append(fold_ics)

            # Load saved preds for concat IC
            saved = np.load(fold_preds_path)
            all_fold_preds.append(saved["preds"])
            all_fold_labels.append(saved["labels"])

            # Save fold model weights
            weights_path = RESULTS_DIR / f"event_ssm_v1_fold{fold_idx:02d}.pt"
            torch.save(best_state, weights_path)
            log.info(f"Fold {fold_idx} weights saved to {weights_path}")

            log.info(
                f"Fold {fold_idx} ICs: "
                + ", ".join(f"{n}={v:.4f}" for n, v in zip(HORIZON_NAMES, fold_ics))
            )
            mlflow.log_metrics({
                f"fold{fold_idx}_final_ic_{n}": v
                for n, v in zip(HORIZON_NAMES, fold_ics)
            })

        # Concat IC across all folds
        if all_fold_preds:
            concat_ics = compute_concat_ic(all_fold_preds, all_fold_labels)
            mean_per_fold = [np.mean(ics) for ics in all_fold_ics]

            log.info(f"\n{'='*60}")
            log.info("FINAL RESULTS — EventSSM v1")
            log.info(f"Concat IC:  " + ", ".join(f"{n}={v:.4f}" for n, v in zip(HORIZON_NAMES, concat_ics)))
            log.info(f"Mean per-fold IC: {np.mean(mean_per_fold):.4f}")
            log.info(f"Min/Max fold IC:  {min(mean_per_fold):.4f} / {max(mean_per_fold):.4f}")
            log.info(f"Positive folds:   {sum(1 for v in mean_per_fold if v > 0)}/{len(mean_per_fold)}")

            mlflow.log_metrics({
                "concat_ic_mean": float(np.mean(concat_ics)),
                **{f"concat_ic_{n}": float(v) for n, v in zip(HORIZON_NAMES, concat_ics)},
                "mean_per_fold_ic": float(np.mean(mean_per_fold)),
            })

            # Save summary
            summary = {
                "model": "EventSSM_v1",
                "architecture": "S4-style SSM, 6 layers, d_model=256",
                "window_events": WINDOW_SIZE,
                "concat_ic": {n: float(v) for n, v in zip(HORIZON_NAMES, concat_ics)},
                "per_fold_mean_ic": float(np.mean(mean_per_fold)),
                "n_folds": len(all_fold_ics),
                "timestamp": datetime.now().isoformat(),
            }
            summary_path = RESULTS_DIR / "event_ssm_v1_summary.json"
            summary_path.write_text(json.dumps(summary, indent=2))
            log.info(f"Summary saved to {summary_path}")

    log.info("Training complete.")


if __name__ == "__main__":
    main()
