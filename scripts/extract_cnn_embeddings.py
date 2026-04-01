"""
extract_cnn_embeddings.py — Extract 512-dim pre-classifier embeddings from the
Wider BookSpatialCNN (temporal_channels=512, spatial=(64,128,256,512)).

WHAT THIS DOES:
  Loads each fold's trained weights from:
    C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\alpha_discovery\\deep_models\\results\\wider_cnn\\checkpoints\\
  Runs inference on OOT book tensor data from:
    C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\data\\processed\\dl_book_cache_oot\\
  Saves per-date NPZ files to:
    C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\data\\processed\\cnn_embeddings_oot\\

OUTPUT FORMAT (per date):
  NPZ with keys:
    embeddings:   (n_bars, 512) float32 — pre-classifier temporal pooling output
    mid_prices:   (n_bars,)     float64 — mid prices from source tensor
    date:         str           — YYYY-MM-DD

EMBEDDING LAYER:
  The Wider CNN classifier is:
    Linear(512 -> 256) -> GELU -> Dropout -> Linear(256 -> 3)
  We hook after temporal_pool (512-dim), BEFORE the classifier.
  This captures the richest representation for downstream LSTM/TFT.

FOLD SELECTION:
  For each OOT date we use the most recent fold whose test_date < oot_date.
  This ensures strict temporal ordering (no leakage).

USAGE:
  python scripts/extract_cnn_embeddings.py
  python scripts/extract_cnn_embeddings.py --batch-size 1024 --device cuda
  python scripts/extract_cnn_embeddings.py --dates 2026-01-02 2026-01-03
  python scripts/extract_cnn_embeddings.py --model-weights path/to/fold_83.pt
"""
import argparse
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn

# ── Paths ─────────────────────────────────────────────────────────────────────
NEPTUNE_LVL3 = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant")
DEEP_MODELS_DIR = NEPTUNE_LVL3 / "alpha_discovery" / "deep_models"
WIDER_CNN_DIR = DEEP_MODELS_DIR / "results" / "wider_cnn"
CHECKPOINTS_DIR = WIDER_CNN_DIR / "checkpoints"

# CRITICAL NOTE: Fold IC integrity
# Folds 37-75: IC range 0.05-0.24 — VALID (clean expanding window WF)
# Folds 76-83: IC range 0.35-0.69 — SUSPECT (potential leakage after warm-start fix)
# MEMORY.md: "rolled back to fold 75 IC=0.1458" confirms folds 76+ are invalid.
# The LAST VALID fold weight is fold_75_2025-11-04.pt (or fold_87 if the training
# continued cleanly after rollback — check neptune_training.log before trusting).
# For embedding extraction, use fold_75 or earlier for OOT dates > 2025-11-04.
LAST_VALID_FOLD_DATE = "2025-11-04"  # fold_75 test_date — use this for all OOT dates
OOT_CACHE_DIR = NEPTUNE_LVL3 / "data" / "processed" / "dl_book_cache_oot"
OUTPUT_DIR = NEPTUNE_LVL3 / "data" / "processed" / "cnn_embeddings_oot"

# Add deep_models to path so we can import BookSpatialCNN
sys.path.insert(0, str(DEEP_MODELS_DIR))

from book_spatial_cnn import BookSpatialCNN


# ── Wider CNN architecture (must match training) ──────────────────────────────
class WiderBookSpatialCNN(BookSpatialCNN):
    """2x wider BookSpatialCNN — matches the Neptune Mar 18 / expanding WF run.
    spatial_channels=(64,128,256,512), temporal_channels=512, ~12.6M params."""
    def __init__(self, **kwargs):
        kwargs["spatial_channels"] = (64, 128, 256, 512)
        kwargs["temporal_channels"] = 512
        kwargs["dropout"] = 0.15
        super().__init__(**kwargs)

    def forward_embed(self, x: torch.Tensor) -> torch.Tensor:
        """
        Returns 512-dim pre-classifier embeddings (temporal_pool output).
        No gradient computation — call inside torch.no_grad().

        Args:
            x: (batch, window_size=20, 20, 4) book snapshot window
        Returns:
            embeddings: (batch, 512) float32
        """
        B, T, L, F = x.shape

        # ---- Spatial processing ----
        x_spatial = x.reshape(B * T, 1, L, F)
        x_spatial = self.spatial_stem(x_spatial)
        x_spatial = self.spatial_res_blocks(x_spatial)
        x_spatial = self.spatial_pool(x_spatial)
        x_spatial = x_spatial.reshape(B * T, -1)
        x_spatial = self.spatial_compress(x_spatial)
        x_spatial = x_spatial.reshape(B, T, -1)

        # ---- Bid/Ask features ----
        bid_in = x[:, :, :10, :].reshape(B * T, 10, F).permute(0, 2, 1)
        ask_in = x[:, :, 10:, :].reshape(B * T, 10, F).permute(0, 2, 1)
        bid_feats = self.bid_conv(bid_in).squeeze(-1)
        ask_feats = self.ask_conv(ask_in).squeeze(-1)
        side_feats = torch.cat([bid_feats, ask_feats], dim=-1).reshape(B, T, -1)

        # ---- Temporal processing ----
        combined = torch.cat([x_spatial, side_feats], dim=-1).permute(0, 2, 1)
        temporal_out = self.temporal_stem(combined)
        temporal_out = self.temporal_res1(temporal_out)
        temporal_out = self.temporal_res2(temporal_out)
        temporal_out = self.temporal_pool(temporal_out).squeeze(-1)  # (B, 512)

        return temporal_out  # 512-dim pre-classifier embedding


# ── Helpers ───────────────────────────────────────────────────────────────────
def load_fold_weights(pt_path: Path, device: torch.device) -> WiderBookSpatialCNN:
    """Load a WiderBookSpatialCNN from a fold .pt checkpoint.

    NOTE: train_walkforward.py saves models with num_classes=1 (regression head).
    We load with num_classes=1 to match the checkpoint exactly, then use
    forward_embed() which bypasses the classifier entirely (no num_classes sensitivity).
    """
    model = WiderBookSpatialCNN(window_size=20, num_levels=20, num_features=4, num_classes=1)
    state_dict = torch.load(str(pt_path), map_location=device, weights_only=True)
    model.load_state_dict(state_dict)
    model.to(device)
    model.eval()
    return model


def get_fold_map(checkpoints_dir: Path) -> Dict[str, Path]:
    """
    Build a map: test_date_str -> .pt file path.
    Fold files are named fold_<N>_YYYY-MM-DD.pt
    Returns dict sorted by date.
    """
    fold_map = {}
    for pt in sorted(checkpoints_dir.glob("fold_*.pt")):
        if pt.name == "latest.pt":
            continue
        # Parse date from filename: fold_83_2025-11-14.pt
        parts = pt.stem.split("_", 2)  # ['fold', '83', '2025-11-14']
        if len(parts) == 3:
            fold_map[parts[2]] = pt
    return fold_map


def select_model_for_date(
    oot_date: str,
    fold_map: Dict[str, Path],
    last_valid_fold_date: str = LAST_VALID_FOLD_DATE,
) -> Optional[Path]:
    """
    Select the most recent VALID fold trained BEFORE oot_date.

    INTEGRITY FILTER: Folds 76+ (test_date > 2025-11-04) have anomalously high ICs
    (0.35-0.69) consistent with leakage from the warm-start fix. We cap at
    LAST_VALID_FOLD_DATE = '2025-11-04' (fold_75) which is the last confirmed clean fold.

    fold_map keys are test_dates (the day used as the WF test fold).
    We want: max(date) where date <= last_valid_fold_date AND date < oot_date.
    """
    valid_folds = {
        d: p for d, p in fold_map.items()
        if d < oot_date and d <= last_valid_fold_date
    }
    if not valid_folds:
        return None
    latest_date = max(valid_folds.keys())
    return valid_folds[latest_date]


def preprocess_book_tensors(raw: np.ndarray) -> np.ndarray:
    """
    Apply the same preprocessing as BookTensorDataset:
      - Log-transform depth, orders, queue_age (features 1, 2, 3)
      - Feature 0 (price_relative_to_mid) left as-is
    Input/output: (n_bars, 20, 4) float32
    """
    out = raw.astype(np.float32)
    out[:, :, 1] = np.log1p(out[:, :, 1])  # log(1 + depth)
    out[:, :, 2] = np.log1p(out[:, :, 2])  # log(1 + num_orders)
    out[:, :, 3] = np.log1p(out[:, :, 3])  # log(1 + queue_age)
    return out


def build_windows(tensors: np.ndarray, window_size: int = 20) -> Tuple[np.ndarray, np.ndarray]:
    """
    Slide a window of `window_size` over tensors.
    Returns (windows, valid_bar_indices).
    windows[i] corresponds to tensors[valid_bar_indices[i] - window_size + 1 : valid_bar_indices[i] + 1]
    NOTE: the last `horizon` bars are excluded to avoid partial-horizon targets.
    For embedding extraction we don't need targets, so we include all bars with enough history.
    """
    n_bars = len(tensors)
    valid_indices = list(range(window_size - 1, n_bars))
    if not valid_indices:
        return np.empty((0, window_size, 20, 4), dtype=np.float32), np.array([], dtype=np.int64)

    windows = np.stack(
        [tensors[i - window_size + 1 : i + 1] for i in valid_indices],
        axis=0,
    )  # (n_valid, window_size, 20, 4)
    return windows, np.array(valid_indices, dtype=np.int64)


def extract_embeddings_for_day(
    npz_path: Path,
    model: WiderBookSpatialCNN,
    device: torch.device,
    batch_size: int = 1024,
    window_size: int = 20,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Extract 512-dim embeddings for all valid bars on a single OOT day.

    Returns:
        embeddings:    (n_valid, 512) float32
        mid_prices:    (n_bars,) float64 — full day (pre-windowing)
        valid_indices: (n_valid,) int64 — bar indices in [0, n_bars) with embeddings
    """
    data = np.load(str(npz_path))
    raw_tensors = data["book_tensors"]   # (n_bars, 20, 4)
    mid_prices = data["mid_prices"]       # (n_bars,)

    tensors = preprocess_book_tensors(raw_tensors)
    # Stream windows in chunks to avoid OOM (234K windows × 20 × 20 × 4 = 1.5GB if materialized)
    n_bars = len(tensors)
    valid_indices = list(range(window_size - 1, n_bars))

    if not valid_indices:
        return (
            np.empty((0, 512), dtype=np.float32),
            mid_prices,
            np.array([], dtype=np.int64),
        )

    all_embeddings = []
    for chunk_start in range(0, len(valid_indices), batch_size):
        chunk_indices = valid_indices[chunk_start : chunk_start + batch_size]
        # Build only this chunk's windows
        batch = np.stack(
            [tensors[i - window_size + 1 : i + 1] for i in chunk_indices],
            axis=0,
        )
        batch_t = torch.from_numpy(batch).to(device)
        with torch.no_grad():
            emb = model.forward_embed(batch_t)  # (batch, 512)
        all_embeddings.append(emb.cpu().numpy())
        del batch, batch_t  # free memory immediately

    embeddings = np.concatenate(all_embeddings, axis=0)  # (n_valid, 512)
    return embeddings, mid_prices, np.array(valid_indices, dtype=np.int64)


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Extract wider CNN 512-dim embeddings for OOT dates")
    parser.add_argument("--oot-cache-dir", default=str(OOT_CACHE_DIR),
                        help="Directory with YYYY-MM-DD_book_tensors.npz files")
    parser.add_argument("--checkpoints-dir", default=str(CHECKPOINTS_DIR),
                        help="Directory with fold_N_YYYY-MM-DD.pt weight files")
    parser.add_argument("--output-dir", default=str(OUTPUT_DIR),
                        help="Output directory for embedding NPZ files")
    parser.add_argument("--dates", nargs="*", default=None,
                        help="Specific OOT dates to process (YYYY-MM-DD). Default: all.")
    parser.add_argument("--model-weights", default=None,
                        help="Use a single .pt file for ALL dates (ignores fold selection)")
    parser.add_argument("--batch-size", type=int, default=1024)
    parser.add_argument("--window-size", type=int, default=20)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--skip-existing", action="store_true", default=True,
                        help="Skip dates where output NPZ already exists")
    parser.add_argument("--no-skip-existing", dest="skip_existing", action="store_false")
    args = parser.parse_args()

    device = torch.device(args.device)
    oot_cache_dir = Path(args.oot_cache_dir)
    checkpoints_dir = Path(args.checkpoints_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── Discover OOT dates ────────────────────────────────────────────────────
    all_oot_files = sorted(oot_cache_dir.glob("*_book_tensors.npz"))
    if not all_oot_files:
        print(f"ERROR: No book tensor NPZ files found in {oot_cache_dir}")
        sys.exit(1)

    date_to_file = {f.name.replace("_book_tensors.npz", ""): f for f in all_oot_files}

    if args.dates:
        dates_to_process = [d for d in args.dates if d in date_to_file]
        missing = [d for d in args.dates if d not in date_to_file]
        if missing:
            print(f"WARNING: dates not found in OOT cache: {missing}")
    else:
        dates_to_process = sorted(date_to_file.keys())

    print(f"OOT dates to process: {len(dates_to_process)} ({dates_to_process[0]} .. {dates_to_process[-1]})")

    # ── Build fold map ────────────────────────────────────────────────────────
    if args.model_weights:
        # Single model for all dates
        single_model_path = Path(args.model_weights)
        print(f"Using single model weights: {single_model_path}")
        fold_map = None
    else:
        fold_map = get_fold_map(checkpoints_dir)
        if not fold_map:
            # Fallback: use latest.pt
            latest = checkpoints_dir / "latest.pt"
            if latest.exists():
                print(f"WARNING: No fold_N_*.pt files found. Using latest.pt for all dates.")
                fold_map = None
                args.model_weights = str(latest)
            else:
                print(f"ERROR: No fold weights found in {checkpoints_dir}")
                sys.exit(1)
        else:
            print(f"Found {len(fold_map)} fold checkpoints: {min(fold_map.keys())} .. {max(fold_map.keys())}")

    # ── Load model cache (avoid reloading same .pt repeatedly) ───────────────
    loaded_model_cache: Dict[str, WiderBookSpatialCNN] = {}

    def get_model(pt_path: Path) -> WiderBookSpatialCNN:
        key = str(pt_path)
        if key not in loaded_model_cache:
            # Evict old models to save GPU memory (keep only 2 loaded)
            if len(loaded_model_cache) >= 2:
                evict_key = next(iter(loaded_model_cache))
                del loaded_model_cache[evict_key]
            loaded_model_cache[key] = load_fold_weights(pt_path, device)
        return loaded_model_cache[key]

    # ── Process each date ─────────────────────────────────────────────────────
    results_summary = []
    skipped = 0
    failed = 0

    for date_str in dates_to_process:
        out_path = output_dir / f"{date_str}_cnn_embeddings.npz"

        if args.skip_existing and out_path.exists():
            print(f"  SKIP {date_str} (already exists)")
            skipped += 1
            continue

        # Select model weights for this date
        if args.model_weights:
            pt_path = Path(args.model_weights)
        else:
            pt_path = select_model_for_date(date_str, fold_map)
            if pt_path is None:
                print(f"  SKIP {date_str}: no fold trained before this date")
                skipped += 1
                continue

        try:
            model = get_model(pt_path)
            npz_in = date_to_file[date_str]

            embeddings, mid_prices, valid_indices = extract_embeddings_for_day(
                npz_in, model, device,
                batch_size=args.batch_size,
                window_size=args.window_size,
            )

            # Save
            np.savez_compressed(
                str(out_path),
                embeddings=embeddings,           # (n_valid, 512) float32
                mid_prices=mid_prices,            # (n_bars,)  float64
                valid_bar_indices=valid_indices,  # (n_valid,) int64
                date=np.array(date_str),
                model_weights=np.array(str(pt_path)),
                embedding_dim=np.array(512),
                window_size=np.array(args.window_size),
            )

            n_bars = len(mid_prices)
            n_valid = len(embeddings)
            print(f"  OK {date_str}: {n_valid}/{n_bars} bars embedded using {pt_path.name}")
            results_summary.append({
                "date": date_str,
                "n_bars": int(n_bars),
                "n_embedded": int(n_valid),
                "model": pt_path.name,
                "output": str(out_path),
            })

        except Exception as e:
            print(f"  ERROR {date_str}: {e}")
            failed += 1

    # ── Summary ───────────────────────────────────────────────────────────────
    summary_path = output_dir / "extraction_summary.json"
    with open(str(summary_path), "w") as f:
        json.dump({
            "total_dates": len(dates_to_process),
            "processed": len(results_summary),
            "skipped": skipped,
            "failed": failed,
            "embedding_dim": 512,
            "arch": "WiderBookSpatialCNN(spatial=(64,128,256,512), temporal=512)",
            "layer": "temporal_pool output (pre-classifier)",
            "results": results_summary,
        }, f, indent=2)

    print(f"\nDone. Processed={len(results_summary)}, skipped={skipped}, failed={failed}")
    print(f"Summary saved to: {summary_path}")
    print(f"Embeddings saved to: {output_dir}")
    print(f"\nEmbedding shape per date: (n_valid_bars, 512)")
    print(f"Load example:")
    print(f"  data = np.load('{output_dir / dates_to_process[0]}_cnn_embeddings.npz')")
    print(f"  embeddings = data['embeddings']  # shape (n_bars, 512)")
    print(f"  mid_prices = data['mid_prices']  # shape (n_bars,)")
    print(f"\nNext steps:")
    print(f"  1. Feed embeddings as input sequence to LSTM: (batch, seq_len, 512)")
    print(f"  2. Feed as token embeddings to TFT temporal encoder")
    print(f"  3. Concatenate with LGBM features for boosted temporal model")


if __name__ == "__main__":
    main()
