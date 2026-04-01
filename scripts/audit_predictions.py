#!/usr/bin/env python3
"""
Comprehensive prediction file audit for Lvl3Quant CNN WF stacked predictions.

Scans all NPZ files, groups by variant, cross-references with model checkpoints,
identifies anomalies, and produces a full manifest + audit report.

Usage:
    python scripts/audit_predictions.py
"""

import os
import sys
import json
import re
import numpy as np
from datetime import datetime, timedelta
from collections import defaultdict
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────────
LVL3_ROOT = Path("C:/Users/Footb/Documents/Github/Lvl3Quant")
PRED_DIR = LVL3_ROOT / "data" / "processed" / "cnn_wf_stacked_predictions"
MODELS_DIR = LVL3_ROOT / "models"
OUTPUT_DIR = LVL3_ROOT / "predictions"
MANIFEST_PATH = PRED_DIR / "_full_manifest.json"
AUDIT_REPORT_PATH = OUTPUT_DIR / "audit_report.json"
QCC_DB_PATH = Path("C:/Users/Footb/Documents/Github/teleclaude-main/data/qcc.db")

EXPECTED_SHAPE = (234000,)  # 10s predictions for full trading day

# Known partial trading days (half-days, shortened sessions)
PARTIAL_TRADING_DAYS = {
    "2025-07-03": "early_close",   # July 3 early close
    "2025-11-28": "early_close",   # Day after Thanksgiving
    "2025-12-24": "early_close",   # Christmas Eve
    "2025-12-31": "early_close",   # New Year's Eve (sometimes)
    "2026-01-02": "early_close",   # Jan 2 shortened
}

# Size threshold: files under this are checked for shape issues
SIZE_SUSPECT_THRESHOLD = 500_000  # 500KB (normal ~937KB compressed)

# ── Card-to-variant mapping ───────────────────────────────────────────────────
CARD_VARIANTS = {
    "Card1": "book_predstdExit_conv1.5_vol50",
    "Card2": "book_predstdExit_conv1.5_vol50",
    "Card3": "raw_rawExit_conv0.15_ethr0.0_vol70",
    "Card4": "book_predstdExit_conv2.0_vol70",
    "Card5": "raw_rawExit_conv0.05_ethr0.5_vol0",
    "Card6": "raw_rawExit_conv0.15_ethr0.0_vol70",
    "Card7": "smooth_smoothExit_conv1.5_ethr0.0_vol70",
    "Card8L": "raw_rawExit_conv0.15_ethr0.0_vol70",
    "Card9S": "raw_rawExit_conv0.05_ethr0.5_vol0",
    "Card10L": "book_predstdExit_conv2.0_vol70",
}

# ── Model checkpoint paths ────────────────────────────────────────────────────
MODEL_CHECKPOINTS = {
    "standard_cnn_wf": MODELS_DIR / "standard_cnn_wf" / "checkpoint.json",
    "wider_cnn_wf": MODELS_DIR / "wider_cnn_wf" / "checkpoint.json",
    "hybrid_v3_wf": MODELS_DIR / "hybrid_v3_wf" / "checkpoint.json",
    "5min_cnn_wf": MODELS_DIR / "5min_cnn_wf" / "checkpoint.json",
}

# ── US Market holidays (2025-2026) ────────────────────────────────────────────
US_MARKET_HOLIDAYS = {
    # 2025
    "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18",
    "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01",
    "2025-11-27", "2025-12-25",
    # 2026
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03",
    "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
    "2026-11-26", "2026-12-25",
}


def is_trading_day(date_str):
    """Check if a date is a US market trading day (not weekend, not holiday)."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    if dt.weekday() >= 5:  # Saturday=5, Sunday=6
        return False
    if date_str in US_MARKET_HOLIDAYS:
        return False
    return True


def get_trading_days_between(start, end):
    """Return list of expected trading days between start and end (inclusive)."""
    days = []
    current = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")
    while current <= end_dt:
        ds = current.strftime("%Y-%m-%d")
        if is_trading_day(ds):
            days.append(ds)
        current += timedelta(days=1)
    return days


def parse_filename(filename):
    """Parse prediction filename into (date, variant) tuple.

    Handles two patterns:
      1. 2025-12-01_book_predstdExit_conv1.5_vol50.npz  (standard variant)
      2. 2025-12-01_event_predictions.npz  (legacy variant)
    """
    if not filename.endswith(".npz"):
        return None, None
    name = filename[:-4]  # strip .npz
    # Match date prefix
    m = re.match(r"^(\d{4}-\d{2}-\d{2})_(.+)$", name)
    if not m:
        return None, None
    return m.group(1), m.group(2)


def load_checkpoints():
    """Load all model checkpoint files and build date-to-fold mapping."""
    checkpoints = {}
    for model_name, cp_path in MODEL_CHECKPOINTS.items():
        if not cp_path.exists():
            print(f"  [WARN] Checkpoint not found: {cp_path}")
            continue
        with open(cp_path) as f:
            data = json.load(f)

        fold_details = data.get("fold_details", [])
        date_to_fold = {}
        for i, fd in enumerate(fold_details):
            test_date = fd.get("test_date")
            if test_date:
                date_to_fold[test_date] = {
                    "fold_index": i,
                    "fold_number": fd.get("fold", i + 1),
                    "ic": fd.get("ic", 0.0),
                    "train_days": fd.get("train_days"),
                    "n_test": fd.get("n_test"),
                    "skipped": fd.get("skipped_via_checkpoint", False),
                }

        checkpoints[model_name] = {
            "completed_folds": data.get("completed_folds", 0),
            "mean_ic": data.get("mean_ic", 0.0),
            "model_type": data.get("model_type", "unknown"),
            "wider_cnn": data.get("wider_cnn", False),
            "preds_file": data.get("preds_file", ""),
            "date_to_fold": date_to_fold,
            "all_test_dates": sorted(date_to_fold.keys()),
        }
    return checkpoints


def determine_model_for_variant(variant, checkpoints):
    """Heuristic to determine which model produced a variant's predictions.

    Standard CNN WF: produced most prediction variants (book_, raw_, smooth_, ema_, mom_, rolling_)
    Wider CNN WF: book predictions with wider architecture
    Hybrid v3 WF: hybrid_predictions
    Legacy: event_predictions, gnn_predictions, ensemble_*
    """
    if variant == "hybrid_predictions":
        return "hybrid_v3_wf"
    if variant == "event_predictions":
        return "legacy_event"
    if variant == "gnn_predictions":
        return "legacy_gnn"
    if variant.startswith("ensemble_"):
        return "legacy_ensemble"
    # All parameterized variants come from standard_cnn_wf walk-forward
    return "standard_cnn_wf"


def parse_variant_params(variant):
    """Extract normalization, exit, conviction, ethr, vol_gate from variant name."""
    params = {}

    # Legacy variants
    if variant in ("hybrid_predictions", "event_predictions", "gnn_predictions"):
        return {"type": "legacy", "variant": variant}
    if variant.startswith("ensemble_"):
        return {"type": "ensemble", "variant": variant}

    # Pattern: {norm}_{exit}_conv{conv}[_ethr{ethr}]_vol{vol}
    # Examples:
    #   book_predstdExit_conv1.5_vol50
    #   raw_rawExit_conv0.15_ethr0.0_vol70
    #   smooth_smoothExit_conv1.5_ethr0.0_vol70
    #   rolling_smoothExit_conv2.0_ethr0.5_vol50
    #   mom_emaExit_conv0.3_ethr0.0_vol50
    #   ema_bookExit_conv1.5_vol50

    m = re.match(
        r"^([a-z]+)_([a-zA-Z]+Exit)_conv([\d.]+)(?:_ethr([\d.]+))?_vol(\d+)$",
        variant
    )
    if m:
        params = {
            "type": "parameterized",
            "normalization": m.group(1),
            "exit_type": m.group(2),
            "conviction_threshold": float(m.group(3)),
            "edge_threshold": float(m.group(4)) if m.group(4) else None,
            "vol_gate": int(m.group(5)),
        }
    else:
        params = {"type": "unknown", "variant": variant}

    return params


def audit_files():
    """Main audit: scan all NPZ files and build variant groups."""
    print("=" * 70)
    print("PREDICTION FILE AUDIT")
    print(f"Directory: {PRED_DIR}")
    print("=" * 70)

    # ── Scan all files ────────────────────────────────────────────────────
    all_files = sorted(os.listdir(PRED_DIR))
    npz_files = [f for f in all_files if f.endswith(".npz")]
    other_files = [f for f in all_files if not f.endswith(".npz")]

    print(f"\nTotal files: {len(all_files)}")
    print(f"NPZ files: {len(npz_files)}")
    print(f"Other files: {other_files}")

    # ── Group by variant ──────────────────────────────────────────────────
    variants = defaultdict(lambda: {"files": {}, "dates": []})
    unparseable = []

    for fname in npz_files:
        date, variant = parse_filename(fname)
        if date is None:
            unparseable.append(fname)
            continue
        fpath = PRED_DIR / fname
        size = os.path.getsize(fpath)
        variants[variant]["files"][date] = {
            "filename": fname,
            "size_bytes": size,
        }
        variants[variant]["dates"].append(date)

    for v in variants:
        variants[v]["dates"] = sorted(set(variants[v]["dates"]))

    print(f"\nUnique variants: {len(variants)}")
    print(f"Unparseable filenames: {len(unparseable)}")
    if unparseable:
        for f in unparseable:
            print(f"  {f}")

    # ── Load checkpoints ──────────────────────────────────────────────────
    print("\n--- Loading model checkpoints ---")
    checkpoints = load_checkpoints()
    for name, cp in checkpoints.items():
        print(f"  {name}: {cp['completed_folds']} folds, "
              f"dates {cp['all_test_dates'][0] if cp['all_test_dates'] else '?'} to "
              f"{cp['all_test_dates'][-1] if cp['all_test_dates'] else '?'}, "
              f"mean_ic={cp['mean_ic']:.4f}")

    # ── Analyze each variant ──────────────────────────────────────────────
    print("\n--- Variant Analysis ---")
    variant_details = {}
    anomalies = []
    untraced_files = []

    for variant_name in sorted(variants.keys()):
        vdata = variants[variant_name]
        dates = vdata["dates"]
        files = vdata["files"]

        print(f"\n  [{variant_name}]")
        print(f"    Files: {len(files)}")
        print(f"    Date range: {dates[0]} to {dates[-1]}")

        # Parse variant parameters
        params = parse_variant_params(variant_name)

        # Determine source model
        model_name = determine_model_for_variant(variant_name, checkpoints)
        print(f"    Model: {model_name}")

        # Check for date gaps
        expected_days = get_trading_days_between(dates[0], dates[-1])
        actual_dates_set = set(dates)
        missing_dates = [d for d in expected_days if d not in actual_dates_set]
        extra_dates = [d for d in dates if d not in expected_days]

        if missing_dates:
            print(f"    Missing dates: {len(missing_dates)}")
            if len(missing_dates) <= 10:
                for md in missing_dates:
                    print(f"      {md}")
        if extra_dates:
            print(f"    Extra dates (non-trading?): {len(extra_dates)}")

        # Check file sizes and shapes
        sizes = [files[d]["size_bytes"] for d in dates]
        mean_size = sum(sizes) / len(sizes) if sizes else 0
        min_size = min(sizes) if sizes else 0
        max_size = max(sizes) if sizes else 0

        # Full shape verification for suspect files + sampling for large files
        shapes_ok = True
        wrong_shape_count = 0
        all_zero_count = 0
        partial_day_count = 0
        corrupt_count = 0
        file_issues = {}  # date -> list of issues

        for d in dates:
            finfo = files[d]
            s = finfo["size_bytes"]
            fpath = PRED_DIR / finfo["filename"]
            issues = []

            # Load and verify files under threshold, or sample 3 for large files
            need_load = s < SIZE_SUSPECT_THRESHOLD
            if not need_load and d in (dates[0], dates[len(dates)//2], dates[-1]):
                need_load = True  # Always sample first, middle, last

            if need_load:
                try:
                    data = np.load(fpath)
                    keys = list(data.keys())
                    if "predictions" not in keys:
                        issues.append("missing_predictions_key")
                        shapes_ok = False
                        corrupt_count += 1
                    else:
                        preds = data["predictions"]
                        finfo["shape"] = list(preds.shape)
                        finfo["nonzero_count"] = int(np.count_nonzero(preds))

                        if preds.shape != EXPECTED_SHAPE:
                            wrong_shape_count += 1
                            if d in PARTIAL_TRADING_DAYS:
                                issues.append("partial_day")
                                partial_day_count += 1
                            else:
                                issues.append("wrong_shape")
                                shapes_ok = False

                        if np.count_nonzero(preds) == 0:
                            all_zero_count += 1
                            issues.append("all_zeros")
                except Exception as e:
                    issues.append(f"load_error: {e}")
                    shapes_ok = False
                    corrupt_count += 1

            if issues:
                file_issues[d] = issues
                for issue in issues:
                    issue_type = issue.split(":")[0].strip()
                    anomalies.append({
                        "variant": variant_name,
                        "date": d,
                        "issue": issue_type,
                        "size_bytes": s,
                        "detail": issue if ":" in issue else None,
                    })

        print(f"    Size range: {min_size:,} - {max_size:,} bytes (mean {mean_size:,.0f})")
        print(f"    Shape verification: {'OK' if shapes_ok else 'ISSUES'}")
        if wrong_shape_count:
            print(f"    Wrong shape files: {wrong_shape_count} ({partial_day_count} partial days)")
        if all_zero_count:
            print(f"    All-zero files: {all_zero_count}")
        if corrupt_count:
            print(f"    Corrupt/unloadable: {corrupt_count}")
        if file_issues:
            shown = 0
            for d, issues in sorted(file_issues.items()):
                if shown < 3:
                    print(f"      {d}: {', '.join(issues)} ({files[d]['size_bytes']} bytes)")
                    shown += 1

        # Cross-reference with checkpoints
        fold_mapping = {}
        traceable_count = 0
        untraceable_count = 0

        if model_name in checkpoints:
            cp = checkpoints[model_name]
            for d in dates:
                if d in cp["date_to_fold"]:
                    fold_info = cp["date_to_fold"][d]
                    fold_mapping[d] = fold_info
                    traceable_count += 1
                else:
                    untraceable_count += 1
                    untraced_files.append({
                        "variant": variant_name,
                        "date": d,
                        "filename": files[d]["filename"],
                        "reason": f"date not in {model_name} checkpoint",
                    })
        elif model_name.startswith("legacy_"):
            # Legacy models don't have checkpoint cross-referencing
            traceable_count = 0
            untraceable_count = len(dates)
            for d in dates:
                untraced_files.append({
                    "variant": variant_name,
                    "date": d,
                    "filename": files[d]["filename"],
                    "reason": f"legacy model ({model_name}), no checkpoint",
                })
        else:
            untraceable_count = len(dates)
            for d in dates:
                untraced_files.append({
                    "variant": variant_name,
                    "date": d,
                    "filename": files[d]["filename"],
                    "reason": f"model {model_name} checkpoint not found",
                })

        print(f"    Traceable: {traceable_count}/{len(dates)}")

        # Determine which cards use this variant
        used_by_cards = [card for card, vsuffix in CARD_VARIANTS.items() if vsuffix == variant_name]

        # Build variant detail
        variant_details[variant_name] = {
            "model": model_name,
            "model_version": 1,
            "horizon_bars": 100,
            "params": params,
            "used_by_cards": used_by_cards,
            "date_range": [dates[0], dates[-1]],
            "file_count": len(files),
            "missing_dates": missing_dates,
            "extra_dates": extra_dates,
            "size_stats": {
                "min": min_size,
                "max": max_size,
                "mean": int(mean_size),
            },
            "shapes_verified": shapes_ok,
            "wrong_shape_count": wrong_shape_count,
            "partial_day_count": partial_day_count,
            "all_zero_count": all_zero_count,
            "corrupt_count": corrupt_count,
            "traceable_count": traceable_count,
            "untraceable_count": untraceable_count,
            "verified": shapes_ok and len(missing_dates) == 0 and untraceable_count == 0,
            "files": {},
        }

        # Build per-file detail
        for d in dates:
            finfo = files[d]
            file_info = {
                "filename": finfo["filename"],
                "size_bytes": finfo["size_bytes"],
            }
            if "shape" in finfo:
                file_info["shape"] = finfo["shape"]
            if "nonzero_count" in finfo:
                file_info["nonzero_count"] = finfo["nonzero_count"]
            if d in file_issues:
                file_info["issues"] = file_issues[d]
            if d in fold_mapping:
                fm = fold_mapping[d]
                file_info["fold_number"] = fm["fold_number"]
                file_info["fold_ic"] = fm["ic"]
                file_info["train_days"] = fm.get("train_days")
                file_info["skipped_checkpoint"] = fm.get("skipped", False)
            variant_details[variant_name]["files"][d] = file_info

    return variant_details, anomalies, untraced_files, unparseable, len(npz_files)


def check_card_alignment(variant_details):
    """Verify each card has complete predictions for its variant."""
    print("\n--- Card-to-Prediction Alignment ---")
    card_report = {}

    for card, variant in CARD_VARIANTS.items():
        if variant not in variant_details:
            print(f"  {card}: MISSING variant '{variant}' entirely!")
            card_report[card] = {
                "variant": variant,
                "status": "MISSING_VARIANT",
                "file_count": 0,
            }
            continue

        vd = variant_details[variant]
        missing = vd["missing_dates"]
        file_count = vd["file_count"]
        date_range = vd["date_range"]
        verified = vd["verified"]

        status = "OK" if verified else "ISSUES"
        if len(missing) > 0:
            status = f"GAPS ({len(missing)} missing dates)"

        print(f"  {card}: {variant}")
        print(f"    Files: {file_count}, Range: {date_range[0]} to {date_range[1]}")
        print(f"    Status: {status}")
        if missing and len(missing) <= 5:
            print(f"    Missing: {missing}")

        card_report[card] = {
            "variant": variant,
            "status": status,
            "file_count": file_count,
            "date_range": date_range,
            "missing_dates": missing,
            "verified": verified,
        }

    return card_report


def build_manifest(variant_details, anomalies, untraced_files, unparseable, total_files):
    """Build and save the full manifest JSON."""
    manifest = {
        "generated": datetime.now().isoformat(),
        "audit_version": "1.0",
        "prediction_directory": str(PRED_DIR),
        "total_files": total_files,
        "total_variants": len(variant_details),
        "expected_shape": list(EXPECTED_SHAPE),
        "horizon_bars": 100,
        "variants": variant_details,
        "untraced_files_count": len(untraced_files),
        "untraced_files": untraced_files,
        "anomalies_count": len(anomalies),
        "anomalies": anomalies,
        "unparseable_filenames": unparseable,
    }

    os.makedirs(PRED_DIR, exist_ok=True)
    with open(MANIFEST_PATH, "w") as f:
        json.dump(manifest, f, indent=2, default=str)
    print(f"\nManifest written: {MANIFEST_PATH}")
    print(f"  Size: {os.path.getsize(MANIFEST_PATH):,} bytes")

    return manifest


def build_audit_report(variant_details, anomalies, untraced_files, card_report, total_files):
    """Build a summary audit report."""
    # Variant summary table
    variant_summary = []
    for vname, vd in sorted(variant_details.items()):
        variant_summary.append({
            "variant": vname,
            "model": vd["model"],
            "file_count": vd["file_count"],
            "date_range": vd["date_range"],
            "missing_dates_count": len(vd["missing_dates"]),
            "used_by_cards": vd["used_by_cards"],
            "shapes_verified": vd["shapes_verified"],
            "wrong_shape_count": vd.get("wrong_shape_count", 0),
            "partial_day_count": vd.get("partial_day_count", 0),
            "all_zero_count": vd.get("all_zero_count", 0),
            "corrupt_count": vd.get("corrupt_count", 0),
            "traceable_pct": round(vd["traceable_count"] / max(vd["file_count"], 1) * 100, 1),
            "verified": vd["verified"],
        })

    # Group untraced by reason
    untraced_by_reason = defaultdict(int)
    for uf in untraced_files:
        untraced_by_reason[uf["reason"]] += 1

    total_wrong_shape = sum(v.get("wrong_shape_count", 0) for v in variant_details.values())
    total_all_zeros = sum(v.get("all_zero_count", 0) for v in variant_details.values())
    total_partial = sum(v.get("partial_day_count", 0) for v in variant_details.values())
    total_corrupt = sum(v.get("corrupt_count", 0) for v in variant_details.values())

    report = {
        "generated": datetime.now().isoformat(),
        "summary": {
            "total_npz_files": total_files,
            "total_variants": len(variant_details),
            "fully_verified_variants": sum(1 for v in variant_details.values() if v["verified"]),
            "variants_with_gaps": sum(1 for v in variant_details.values() if len(v["missing_dates"]) > 0),
            "total_anomalies": len(anomalies),
            "total_untraced_files": len(untraced_files),
            "total_wrong_shape_files": total_wrong_shape,
            "total_all_zero_files": total_all_zeros,
            "total_partial_day_files": total_partial,
            "total_corrupt_files": total_corrupt,
            "cards_with_issues": sum(1 for c in card_report.values() if c.get("status") != "OK"),
        },
        "variant_summary": variant_summary,
        "card_alignment": card_report,
        "anomalies": anomalies,
        "untraced_by_reason": dict(untraced_by_reason),
        "untraced_files_sample": untraced_files[:50],  # First 50 for readability
    }

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(AUDIT_REPORT_PATH, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"\nAudit report written: {AUDIT_REPORT_PATH}")

    return report


def write_variants_md(variant_details, card_report):
    """Write a markdown summary of all variants."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    md_path = OUTPUT_DIR / "variants.md"

    lines = [
        "# Prediction Variants Registry",
        f"",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"",
        f"## Summary",
        f"",
        f"| Variant | Model | Files | Date Range | Cards | Gaps | Verified |",
        f"|---------|-------|-------|------------|-------|------|----------|",
    ]

    for vname in sorted(variant_details.keys()):
        vd = variant_details[vname]
        cards_str = ", ".join(vd["used_by_cards"]) if vd["used_by_cards"] else "-"
        gaps = len(vd["missing_dates"])
        verified = "YES" if vd["verified"] else "NO"
        lines.append(
            f"| {vname} | {vd['model']} | {vd['file_count']} | "
            f"{vd['date_range'][0]} to {vd['date_range'][1]} | "
            f"{cards_str} | {gaps} | {verified} |"
        )

    lines += [
        "",
        "## Card Alignment",
        "",
        "| Card | Variant | Files | Status |",
        "|------|---------|-------|--------|",
    ]

    for card in sorted(card_report.keys()):
        cr = card_report[card]
        lines.append(f"| {card} | {cr['variant']} | {cr.get('file_count', 0)} | {cr['status']} |")

    lines += [
        "",
        "## Variant Parameters",
        "",
    ]

    for vname in sorted(variant_details.keys()):
        vd = variant_details[vname]
        p = vd.get("params", {})
        if p.get("type") == "parameterized":
            lines.append(f"### {vname}")
            lines.append(f"- Normalization: {p.get('normalization')}")
            lines.append(f"- Exit type: {p.get('exit_type')}")
            lines.append(f"- Conviction threshold: {p.get('conviction_threshold')}")
            if p.get("edge_threshold") is not None:
                lines.append(f"- Edge threshold: {p.get('edge_threshold')}")
            lines.append(f"- Vol gate: {p.get('vol_gate')}")
            lines.append(f"- Model: {vd['model']}")
            lines.append(f"- Horizon: {vd.get('horizon_bars', 100)} bars (10s)")
            lines.append("")

    with open(md_path, "w") as f:
        f.write("\n".join(lines))
    print(f"Variants markdown written: {md_path}")


def update_qcc_database(variant_details, card_report):
    """Update QCC SQLite database with prediction file data."""
    try:
        import sqlite3
    except ImportError:
        print("[WARN] sqlite3 not available, skipping QCC update")
        return

    if not QCC_DB_PATH.exists():
        print(f"[WARN] QCC database not found at {QCC_DB_PATH}, skipping update")
        return

    print(f"\n--- Updating QCC Database ---")
    conn = sqlite3.connect(str(QCC_DB_PATH))
    cur = conn.cursor()

    # Check if data_files table exists
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='data_files'")
    if not cur.fetchone():
        print("  [WARN] data_files table not found in QCC, skipping")
        conn.close()
        return

    # Insert/update prediction files
    inserted = 0
    updated = 0
    for vname, vd in variant_details.items():
        for date, finfo in vd["files"].items():
            fpath = str(PRED_DIR / finfo["filename"])
            try:
                cur.execute("""
                    INSERT INTO data_files (node, date, file_type, filename, path, size_bytes, row_count, verified_at)
                    VALUES (?, ?, 'prediction', ?, ?, ?, ?, ?)
                    ON CONFLICT(node, path) DO UPDATE SET
                        size_bytes = excluded.size_bytes,
                        row_count = excluded.row_count,
                        verified_at = excluded.verified_at
                """, (
                    "Razer",  # local machine
                    date,
                    finfo["filename"],
                    fpath,
                    finfo["size_bytes"],
                    finfo.get("shape", [EXPECTED_SHAPE[0]])[0] if isinstance(finfo.get("shape"), list) else EXPECTED_SHAPE[0],
                    datetime.now().isoformat(),
                ))
                if cur.rowcount > 0:
                    inserted += 1
            except Exception as e:
                # Might fail on unique constraint edge cases
                pass

    conn.commit()
    print(f"  QCC data_files: {inserted} rows inserted/updated")

    # Update card model bindings if cards table exists
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='cards'")
    if cur.fetchone():
        for card, cr in card_report.items():
            try:
                cur.execute("""
                    UPDATE cards SET model_variant = ?, updated_at = ?
                    WHERE name = ?
                """, (cr["variant"], datetime.now().isoformat(), card))
                if cur.rowcount > 0:
                    updated += 1
            except Exception:
                pass
        conn.commit()
        print(f"  QCC cards: {updated} rows updated")

    conn.close()


def main():
    start_time = datetime.now()

    # Step 1: Audit all prediction files
    variant_details, anomalies, untraced_files, unparseable, total_files = audit_files()

    # Step 5: Check card alignment
    card_report = check_card_alignment(variant_details)

    # Step 2: Build full manifest
    manifest = build_manifest(variant_details, anomalies, untraced_files, unparseable, total_files)

    # Step 4: Build audit report
    report = build_audit_report(variant_details, anomalies, untraced_files, card_report, total_files)

    # Step 3: Write variants markdown
    write_variants_md(variant_details, card_report)

    # Step 6: Update QCC database
    update_qcc_database(variant_details, card_report)

    # Final summary
    elapsed = (datetime.now() - start_time).total_seconds()
    print("\n" + "=" * 70)
    print("AUDIT COMPLETE")
    print("=" * 70)
    print(f"  Time: {elapsed:.1f}s")
    print(f"  Files scanned: {total_files}")
    print(f"  Variants found: {len(variant_details)}")
    s = report["summary"]
    print(f"  Fully verified: {s['fully_verified_variants']}/{s['total_variants']}")
    print(f"  Variants with gaps: {s['variants_with_gaps']}")
    print(f"  Anomalies: {s['total_anomalies']}")
    print(f"  Untraced files: {s['total_untraced_files']}")
    print(f"  Cards with issues: {s['cards_with_issues']}")
    print(f"\nOutputs:")
    print(f"  Manifest: {MANIFEST_PATH}")
    print(f"  Audit report: {AUDIT_REPORT_PATH}")
    print(f"  Variants doc: {OUTPUT_DIR / 'variants.md'}")


if __name__ == "__main__":
    main()
