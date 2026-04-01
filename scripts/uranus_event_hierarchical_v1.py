#!/usr/bin/env python3
"""
event_hierarchical_v1.py — Hierarchical Transformer for MBO event streams.
Architecture 2 for Uranus (RTX 5090 32GB VRAM).

Two-level hierarchy:
  Level 1: "Micro" transformer — processes events within each 1-second chunk
           4 layers, 64-dim, handles within-second microstructure
  Level 2: "Macro" transformer — processes chunk embeddings over 30-60 seconds
           4 layers, 128-dim, handles multi-second trends

This avoids O(N^2) over 5.6M events by chunking first.
30s window = ~30 one-second chunks x ~185 events/chunk (avg)
Can handle 60s = 60 chunks with 32GB VRAM.

Input: (N_events, 6) float32 per sample
Output: (B, 4) predictions for 1s/5s/10s/30s horizons
"""

import os
import sys
import math
import json
import time
import random
import logging
import warnings
from pathlib import Path
from datetime import datetime
from typing import List, Tuple, Optional

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
    format="%(asctime)s [Hier-v1] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("event_hierarchical_v1")

# ── Config ─────────────────────────────────────────────────────────────────────
DATA_DIR    = Path(r"C:\Users\Nick\Lvl3Quant\data\processed\mbo_events")
RESULTS_DIR = Path(r"C:\Users\Nick\Lvl3Quant\results")
LOG_PATH    = Path(r"C:\Users\Nick\Lvl3Quant\results\event_hierarchical_v1.log")

MLFLOW_URIS     = ["http://100.71.253.30:5000", "http://192.168.0.101:5000"]
EXPERIMENT_NAME = "event_hierarchical_v1"

# Architecture
EVENT_FEATURES   = 6
CHUNK_SECONDS    = 1.0      # seconds per chunk (Level 1)
WINDOW_SECONDS   = 30.0     # total context window (Level 2)
MAX_EVENTS_PER_CHUNK = 512  # max events per 1s chunk (pad/truncate)
MAX_CHUNKS       = 30       # number of chunks (window / chunk_size)

# Level 1: Micro transformer (within-second)
MICRO_D_MODEL    = 64
MICRO_N_HEADS    = 4
MICRO_N_LAYERS   = 4
MICRO_D_FF       = 256
MICRO_DROPOUT    = 0.1

# Level 2: Macro transformer (across seconds)
MACRO_D_MODEL    = 128
MACRO_N_HEADS    = 8
MACRO_N_LAYERS   = 4
MACRO_D_FF       = 512
MACRO_DROPOUT    = 0.1

N_HORIZONS  = 4
HORIZON_NAMES = ["1s", "5s", "10s", "30s"]
HORIZON_KEYS  = ["labels_1s", "labels_5s", "labels_10s", "labels_30s"]

BATCH_SIZE   = 16
LR           = 2e-4
WEIGHT_DECAY = 1e-2
MAX_EPOCHS   = 30
PATIENCE     = 5
N_FOLDS      = 10
NUM_WORKERS  = 8
SEED         = 42

# Expected event rate (for chunking by time)
# Each event has time_delta_log = log1p(delta_ms). We use this to segment chunks.
# time_delta_log feature (index 0) = log1p(time since last event in ms)


# ── Priority ───────────────────────────────────────────────────────────────────
def set_below_normal_priority():
    try:
        import ctypes
        ctypes.windll.kernel32.SetPriorityClass(
            ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000
        )
        log.info("Process priority set to BELOW_NORMAL")
    except Exception as e:
        log.warning(f"Could not set priority: {e}")


# ── Micro Transformer (Level 1: events → chunk embedding) ─────────────────────
class MicroTransformer(nn.Module):
    """
    Processes events within a 1-second chunk.
    Input: (B*C, E, 6) where C=num_chunks, E=events_per_chunk
    Output: (B*C, micro_d) chunk embedding via CLS token
    """
    def __init__(self, d_model=MICRO_D_MODEL, n_heads=MICRO_N_HEADS,
                 n_layers=MICRO_N_LAYERS, d_ff=MICRO_D_FF, dropout=MICRO_DROPOUT):
        super().__init__()
        self.d_model = d_model

        # Input projection
        self.input_norm = nn.LayerNorm(EVENT_FEATURES)
        self.embed = nn.Linear(EVENT_FEATURES, d_model)

        # CLS token
        self.cls_token = nn.Parameter(torch.zeros(1, 1, d_model))
        nn.init.trunc_normal_(self.cls_token, std=0.02)

        # Positional encoding (learnable, up to max_events+1)
        self.pos_embed = nn.Embedding(MAX_EVENTS_PER_CHUNK + 1, d_model)

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=n_heads,
            dim_feedforward=d_ff,
            dropout=dropout,
            batch_first=True,
            norm_first=True,   # Pre-norm (more stable)
        )
        self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=n_layers)
        self.norm = nn.LayerNorm(d_model)

    def forward(self, x: torch.Tensor, mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        """
        x: (BC, E, 6) where BC = batch*chunks, E = events per chunk
        mask: (BC, E) True = padding (should be ignored)
        Returns: (BC, d_model) — CLS embedding
        """
        BC, E, _ = x.shape
        x = self.input_norm(x)
        x = self.embed(x)   # (BC, E, d_model)

        # Positional encoding
        pos_ids = torch.arange(E, device=x.device).unsqueeze(0)
        x = x + self.pos_embed(pos_ids)   # (BC, E, d_model)

        # Prepend CLS token
        cls = self.cls_token.expand(BC, -1, -1)   # (BC, 1, d_model)
        x = torch.cat([cls, x], dim=1)             # (BC, E+1, d_model)

        # Extend mask: CLS is never masked
        if mask is not None:
            cls_mask = torch.zeros(BC, 1, dtype=torch.bool, device=x.device)
            full_mask = torch.cat([cls_mask, mask], dim=1)   # (BC, E+1)
        else:
            full_mask = None

        # Transformer (key_padding_mask=True means IGNORE that position)
        x = self.transformer(x, src_key_padding_mask=full_mask)   # (BC, E+1, d_model)
        x = self.norm(x)

        return x[:, 0]   # CLS token: (BC, d_model)


# ── Macro Transformer (Level 2: chunks → prediction) ──────────────────────────
class MacroTransformer(nn.Module):
    """
    Processes chunk embeddings over 30-60 seconds.
    Input: (B, C, micro_d) chunk embeddings
    Output: (B, 4) multi-horizon predictions
    """
    def __init__(self, micro_d=MICRO_D_MODEL, d_model=MACRO_D_MODEL,
                 n_heads=MACRO_N_HEADS, n_layers=MACRO_N_LAYERS,
                 d_ff=MACRO_D_FF, dropout=MACRO_DROPOUT, n_horizons=N_HORIZONS):
        super().__init__()
        self.d_model = d_model

        # Project micro embeddings to macro space
        self.proj = nn.Linear(micro_d, d_model)

        # CLS token for final prediction
        self.cls_token = nn.Parameter(torch.zeros(1, 1, d_model))
        nn.init.trunc_normal_(self.cls_token, std=0.02)

        # Positional encoding (learnable, up to MAX_CHUNKS+1)
        self.pos_embed = nn.Embedding(MAX_CHUNKS + 1, d_model)

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=n_heads,
            dim_feedforward=d_ff,
            dropout=dropout,
            batch_first=True,
            norm_first=True,
        )
        self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=n_layers)
        self.norm = nn.LayerNorm(d_model)

        # Multi-horizon prediction heads
        self.heads = nn.ModuleList([
            nn.Sequential(
                nn.Linear(d_model, d_model // 2),
                nn.GELU(),
                nn.Dropout(dropout),
                nn.Linear(d_model // 2, 1),
            )
            for _ in range(n_horizons)
        ])

    def forward(self, chunk_embs: torch.Tensor) -> torch.Tensor:
        """
        chunk_embs: (B, C, micro_d)
        Returns: (B, n_horizons)
        """
        B, C, _ = chunk_embs.shape
        x = self.proj(chunk_embs)   # (B, C, d_model)

        # Positional encoding
        pos_ids = torch.arange(C, device=x.device).unsqueeze(0)
        x = x + self.pos_embed(pos_ids)

        # CLS token
        cls = self.cls_token.expand(B, -1, -1)
        x = torch.cat([cls, x], dim=1)   # (B, C+1, d_model)

        x = self.transformer(x)   # (B, C+1, d_model)
        x = self.norm(x)

        # Use CLS + last chunk embedding for prediction
        cls_out  = x[:, 0]    # (B, d_model)
        last_out = x[:, -1]   # (B, d_model)
        combined = (cls_out + last_out) / 2

        preds = [head(combined) for head in self.heads]
        return torch.cat(preds, dim=-1)   # (B, 4)


# ── Full Model ─────────────────────────────────────────────────────────────────
class HierarchicalEventModel(nn.Module):
    """
    Two-level hierarchical event model.
    Level 1: MicroTransformer (per second chunk)
    Level 2: MacroTransformer (across chunks)
    """
    def __init__(self):
        super().__init__()
        self.micro = MicroTransformer()
        self.macro = MacroTransformer(micro_d=MICRO_D_MODEL)

    def forward(self, chunks: torch.Tensor, chunk_masks: torch.Tensor) -> torch.Tensor:
        """
        chunks: (B, C, E, 6) — B batches, C chunks, E events per chunk, 6 features
        chunk_masks: (B, C, E) — True = padding
        Returns: (B, 4)
        """
        B, C, E, F = chunks.shape

        # Flatten batch and chunks for micro transformer
        chunks_flat = chunks.view(B * C, E, F)
        masks_flat  = chunk_masks.view(B * C, E)

        # All-padding chunks: mark them so macro can skip
        # A chunk is "empty" if all events are masked
        chunk_empty = masks_flat.all(dim=-1).view(B, C)   # (B, C)

        # Level 1: process each chunk
        micro_embs = self.micro(chunks_flat, masks_flat)   # (B*C, micro_d)
        micro_embs = micro_embs.view(B, C, -1)              # (B, C, micro_d)

        # Zero out empty chunk embeddings
        micro_embs = micro_embs * (~chunk_empty).float().unsqueeze(-1)

        # Level 2: process chunk sequence
        preds = self.macro(micro_embs)   # (B, 4)
        return preds


# ── Dataset ────────────────────────────────────────────────────────────────────
class HierarchicalEventDataset(Dataset):
    """
    Segments events into time-based chunks for the hierarchical model.
    Each sample covers WINDOW_SECONDS of data, split into CHUNK_SECONDS chunks.
    """

    def __init__(self, files: List[Path], window_sec: float = WINDOW_SECONDS,
                 chunk_sec: float = CHUNK_SECONDS, stride_sec: float = 5.0,
                 augment: bool = False):
        self.window_sec  = window_sec
        self.chunk_sec   = chunk_sec
        self.n_chunks    = int(window_sec / chunk_sec)
        self.stride_sec  = stride_sec
        self.augment     = augment
        self.samples     = []   # (file_id, end_event_idx)
        self.data_cache  = {}
        self._load_files(files)

    def _load_files(self, files: List[Path]):
        for fpath in files:
            try:
                npz  = np.load(fpath, allow_pickle=False)
                evts = npz["events"].astype(np.float32)  # (N, 6)
                labs = np.stack([
                    npz["labels_1s"].astype(np.float32),
                    npz["labels_5s"].astype(np.float32),
                    npz["labels_10s"].astype(np.float32),
                    npz["labels_30s"].astype(np.float32),
                ], axis=1)   # (N, 4)

                # Build cumulative time array from time_delta_log
                # time_delta_log = log1p(delta_ms) → delta_ms = exp(x) - 1
                # Cumulative sum gives absolute time in ms from start
                delta_ms = np.expm1(evts[:, 0].astype(np.float64)).clip(0, 10000)
                cum_time_ms = np.cumsum(delta_ms)
                cum_time_s  = cum_time_ms / 1000.0

                file_id = len(self.data_cache)
                self.data_cache[file_id] = (evts, labs, cum_time_s)

                # Stride through file: each sample ends at time t, covers [t-window, t]
                total_sec = float(cum_time_s[-1]) if len(cum_time_s) > 0 else 0
                t = self.window_sec
                while t <= total_sec:
                    # Find event index at time t
                    end_idx = int(np.searchsorted(cum_time_s, t))
                    end_idx = min(end_idx, len(evts) - 1)
                    if end_idx > 0:
                        self.samples.append((file_id, end_idx, t))
                    t += self.stride_sec

            except Exception as e:
                log.warning(f"Failed to load {fpath.name}: {e}")

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        file_id, end_idx, end_time = self.samples[idx]
        evts, labs, cum_time_s = self.data_cache[file_id]

        start_time = end_time - self.window_sec
        start_idx  = int(np.searchsorted(cum_time_s, start_time))
        start_idx  = max(0, start_idx)

        window_evts = evts[start_idx:end_idx]   # (N_window, 6)
        label = labs[end_idx]                    # (4,)

        # Relative time within window
        window_time = cum_time_s[start_idx:end_idx] - start_time   # seconds from window start

        # Chunk into N_CHUNKS second-by-second buckets
        chunks = np.zeros((self.n_chunks, MAX_EVENTS_PER_CHUNK, EVENT_FEATURES), dtype=np.float32)
        masks  = np.ones( (self.n_chunks, MAX_EVENTS_PER_CHUNK), dtype=bool)   # True = pad

        for c in range(self.n_chunks):
            t_start = c * self.chunk_sec
            t_end   = (c + 1) * self.chunk_sec
            mask = (window_time >= t_start) & (window_time < t_end)
            chunk_evts = window_evts[mask]

            if len(chunk_evts) > 0:
                n = min(len(chunk_evts), MAX_EVENTS_PER_CHUNK)
                # Truncate from center to keep most recent events
                if len(chunk_evts) > MAX_EVENTS_PER_CHUNK:
                    chunk_evts = chunk_evts[-MAX_EVENTS_PER_CHUNK:]
                    n = MAX_EVENTS_PER_CHUNK
                chunks[c, :n] = chunk_evts[:n]
                masks[c,  :n] = False   # not padding

        # Augmentation
        if self.augment:
            # Small noise on event features
            noise_mask = ~masks   # True where real events exist
            noise = np.random.normal(0, 0.01, chunks.shape).astype(np.float32)
            chunks += noise * noise_mask[:, :, None]

        return (
            torch.from_numpy(chunks),     # (C, E, 6)
            torch.from_numpy(masks),      # (C, E) bool
            torch.from_numpy(label),      # (4,)
        )


def collate_fn(batch):
    chunks  = torch.stack([b[0] for b in batch])    # (B, C, E, 6)
    masks   = torch.stack([b[1] for b in batch])    # (B, C, E) bool
    labels  = torch.stack([b[2] for b in batch])    # (B, 4)
    return chunks, masks, labels


# ── IC computation ─────────────────────────────────────────────────────────────
def compute_ic(preds: np.ndarray, labels: np.ndarray) -> float:
    p = preds - preds.mean()
    l = labels - labels.mean()
    denom = (np.std(p) * np.std(l)) + 1e-8
    return float(np.mean(p * l) / denom)


# ── Training ───────────────────────────────────────────────────────────────────
def train_fold(model, train_loader, val_loader, fold_idx: int,
               device: torch.device, fold_preds_path: Path):

    optimizer = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=MAX_EPOCHS)
    scaler    = torch.amp.GradScaler("cuda")

    best_val_loss  = float("inf")
    best_state     = None
    patience_ctr   = 0

    for epoch in range(1, MAX_EPOCHS + 1):
        model.train()
        train_losses = []
        for chunks, masks, labels in train_loader:
            chunks = chunks.to(device, non_blocking=True)
            masks  = masks.to( device, non_blocking=True)
            labels = labels.to(device, non_blocking=True)

            optimizer.zero_grad()
            with torch.amp.autocast("cuda"):
                preds = model(chunks, masks)   # (B, 4)
                loss  = F.mse_loss(preds, labels)

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
            for chunks, masks, labels in val_loader:
                chunks = chunks.to(device, non_blocking=True)
                masks  = masks.to( device, non_blocking=True)
                labels = labels.to(device, non_blocking=True)
                with torch.amp.autocast("cuda"):
                    preds = model(chunks, masks)
                    loss  = F.mse_loss(preds, labels)
                val_losses.append(loss.item())
                all_preds.append(preds.float().cpu().numpy())
                all_labels.append(labels.float().cpu().numpy())

        val_loss   = np.mean(val_losses)
        train_loss = np.mean(train_losses)
        all_preds  = np.concatenate(all_preds)
        all_labels = np.concatenate(all_labels)

        ics      = [compute_ic(all_preds[:, h], all_labels[:, h]) for h in range(N_HORIZONS)]
        mean_ic  = np.mean(ics)

        log.info(
            f"Fold {fold_idx} Epoch {epoch}/{MAX_EPOCHS} | "
            f"train={train_loss:.5f} val={val_loss:.5f} | "
            f"IC: {', '.join(f'{n}={v:.4f}' for n, v in zip(HORIZON_NAMES, ics))} | "
            f"mean_IC={mean_ic:.4f}"
        )

        mlflow.log_metrics({
            f"fold{fold_idx}_train_loss": train_loss,
            f"fold{fold_idx}_val_loss":   val_loss,
            f"fold{fold_idx}_mean_ic":    mean_ic,
            **{f"fold{fold_idx}_ic_{n}": v for n, v in zip(HORIZON_NAMES, ics)},
        }, step=epoch)

        if val_loss < best_val_loss:
            best_val_loss = val_loss
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
            patience_ctr = 0
        else:
            patience_ctr += 1
            if patience_ctr >= PATIENCE:
                log.info(f"Fold {fold_idx}: Early stop at epoch {epoch}")
                break

    # Restore best
    if best_state:
        model.load_state_dict(best_state)

    # Final val pass for concat IC
    model.eval()
    all_preds, all_labels = [], []
    with torch.no_grad():
        for chunks, masks, labels in val_loader:
            chunks = chunks.to(device, non_blocking=True)
            masks  = masks.to( device, non_blocking=True)
            with torch.amp.autocast("cuda"):
                preds = model(chunks, masks)
            all_preds.append(preds.float().cpu().numpy())
            all_labels.append(labels.float().cpu().numpy())

    all_preds  = np.concatenate(all_preds)
    all_labels = np.concatenate(all_labels)
    np.savez_compressed(fold_preds_path, preds=all_preds, labels=all_labels)

    ics = [compute_ic(all_preds[:, h], all_labels[:, h]) for h in range(N_HORIZONS)]
    return ics, best_state


def get_sorted_files():
    return sorted(DATA_DIR.glob("*_mbo_events.npz"))


def make_folds(files, n_folds=N_FOLDS):
    n = len(files)
    block_size = n // (n_folds + 1)
    folds = []
    for fold in range(n_folds):
        train_end = (fold + 1) * block_size
        val_end   = train_end + block_size
        if val_end > n:
            val_end = n
        if train_end >= val_end:
            continue
        folds.append((fold, files[:train_end], files[train_end:val_end]))
    return folds


def compute_concat_ic(all_preds, all_labels):
    preds  = np.concatenate(all_preds)
    labels = np.concatenate(all_labels)
    return [compute_ic(preds[:, h], labels[:, h]) for h in range(N_HORIZONS)]


# ── Main ────────────────────────────────────────────────────────────────────────
def main():
    set_below_normal_priority()
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    random.seed(SEED)

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

    fh = logging.FileHandler(LOG_PATH, mode="a")
    fh.setFormatter(logging.Formatter("%(asctime)s [Hier-v1] %(message)s"))
    log.addHandler(fh)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    log.info(f"Device: {device}, CUDA: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A'}")
    log.info(f"Architecture: Hierarchical — {MAX_CHUNKS} chunks x {MAX_EVENTS_PER_CHUNK} events")
    log.info(f"Level 1 (Micro): d={MICRO_D_MODEL}, {MICRO_N_LAYERS} layers, {MICRO_N_HEADS} heads")
    log.info(f"Level 2 (Macro): d={MACRO_D_MODEL}, {MACRO_N_LAYERS} layers, {MACRO_N_HEADS} heads")

    # MLflow
    mlflow_uri = None
    for uri in MLFLOW_URIS:
        try:
            import urllib.request
            urllib.request.urlopen(uri + "/api/2.0/mlflow/experiments/list", timeout=3)
            mlflow_uri = uri
            log.info(f"MLflow: {uri}")
            break
        except Exception:
            continue

    if mlflow_uri:
        mlflow.set_tracking_uri(mlflow_uri)
    else:
        mlflow.set_tracking_uri(str(RESULTS_DIR / "mlruns"))
        log.warning("MLflow offline, logging locally")

    mlflow.set_experiment(EXPERIMENT_NAME)

    # Data
    files = get_sorted_files()
    if len(files) < 5:
        log.error(f"Need 5+ data files, found {len(files)} in {DATA_DIR}")
        log.error("Run uranus_transfer_mbo_data.py first!")
        sys.exit(1)

    log.info(f"Found {len(files)} .npz files: {files[0].name} → {files[-1].name}")
    folds = make_folds(files, N_FOLDS)
    log.info(f"Created {len(folds)} expanding window folds")

    with mlflow.start_run(run_name=f"event_hierarchical_v1_{datetime.now().strftime('%Y%m%d_%H%M')}"):
        mlflow.log_params({
            "model": "HierarchicalEventModel",
            "micro_d_model": MICRO_D_MODEL,
            "micro_n_layers": MICRO_N_LAYERS,
            "macro_d_model": MACRO_D_MODEL,
            "macro_n_layers": MACRO_N_LAYERS,
            "max_chunks": MAX_CHUNKS,
            "max_events_per_chunk": MAX_EVENTS_PER_CHUNK,
            "window_sec": WINDOW_SECONDS,
            "chunk_sec": CHUNK_SECONDS,
            "batch_size": BATCH_SIZE,
            "lr": LR,
            "max_epochs": MAX_EPOCHS,
            "n_folds": N_FOLDS,
            "n_files": len(files),
        })

        all_fold_preds  = []
        all_fold_labels = []
        all_fold_ics    = []

        for fold_idx, train_files, val_files in folds:
            log.info(f"\n{'='*60}")
            log.info(f"FOLD {fold_idx+1}/{len(folds)}: "
                     f"train={len(train_files)}, val={len(val_files)} files")

            train_ds = HierarchicalEventDataset(train_files, augment=True)
            val_ds   = HierarchicalEventDataset(val_files,   augment=False)

            if len(train_ds) == 0 or len(val_ds) == 0:
                log.warning(f"Fold {fold_idx}: empty, skipping")
                continue

            log.info(f"Train samples: {len(train_ds)}, Val samples: {len(val_ds)}")

            train_loader = DataLoader(
                train_ds, batch_size=BATCH_SIZE, shuffle=True,
                num_workers=NUM_WORKERS, pin_memory=True, drop_last=True,
                collate_fn=collate_fn, persistent_workers=True,
            )
            val_loader = DataLoader(
                val_ds, batch_size=BATCH_SIZE, shuffle=False,
                num_workers=NUM_WORKERS, pin_memory=True,
                collate_fn=collate_fn, persistent_workers=True,
            )

            model = HierarchicalEventModel().to(device)
            n_params = sum(p.numel() for p in model.parameters())
            log.info(f"Model params: {n_params:,}")

            fold_preds_path = RESULTS_DIR / f"event_hierarchical_v1_fold{fold_idx:02d}_preds.npz"

            fold_ics, best_state = train_fold(
                model, train_loader, val_loader, fold_idx, device, fold_preds_path
            )
            all_fold_ics.append(fold_ics)

            saved = np.load(fold_preds_path)
            all_fold_preds.append(saved["preds"])
            all_fold_labels.append(saved["labels"])

            # Save weights
            weights_path = RESULTS_DIR / f"event_hierarchical_v1_fold{fold_idx:02d}.pt"
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

        # Final concat IC
        if all_fold_preds:
            concat_ics      = compute_concat_ic(all_fold_preds, all_fold_labels)
            mean_per_fold   = [np.mean(ics) for ics in all_fold_ics]

            log.info(f"\n{'='*60}")
            log.info("FINAL RESULTS — HierarchicalEventModel v1")
            log.info(f"Concat IC:      " + ", ".join(f"{n}={v:.4f}" for n, v in zip(HORIZON_NAMES, concat_ics)))
            log.info(f"Mean fold IC:   {np.mean(mean_per_fold):.4f}")
            log.info(f"Min/Max fold:   {min(mean_per_fold):.4f} / {max(mean_per_fold):.4f}")
            log.info(f"Positive folds: {sum(1 for v in mean_per_fold if v > 0)}/{len(mean_per_fold)}")

            mlflow.log_metrics({
                "concat_ic_mean": float(np.mean(concat_ics)),
                **{f"concat_ic_{n}": float(v) for n, v in zip(HORIZON_NAMES, concat_ics)},
                "mean_per_fold_ic": float(np.mean(mean_per_fold)),
            })

            summary = {
                "model": "HierarchicalEventModel_v1",
                "architecture": f"Micro(d={MICRO_D_MODEL}, L={MICRO_N_LAYERS}) + Macro(d={MACRO_D_MODEL}, L={MACRO_N_LAYERS})",
                "window_sec": WINDOW_SECONDS,
                "n_chunks": MAX_CHUNKS,
                "events_per_chunk": MAX_EVENTS_PER_CHUNK,
                "concat_ic": {n: float(v) for n, v in zip(HORIZON_NAMES, concat_ics)},
                "per_fold_mean_ic": float(np.mean(mean_per_fold)),
                "n_folds": len(all_fold_ics),
                "timestamp": datetime.now().isoformat(),
            }
            summary_path = RESULTS_DIR / "event_hierarchical_v1_summary.json"
            summary_path.write_text(json.dumps(summary, indent=2))
            log.info(f"Summary saved to {summary_path}")

    log.info("Training complete.")


if __name__ == "__main__":
    main()
