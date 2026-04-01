"""Quant Dashboard Configuration — All paths, constants, and metadata."""
import os
from pathlib import Path

# === ROOT PATHS ===
TELECLAUDE_ROOT = Path(r"C:\Users\Footb\Documents\Github\teleclaude-main")
LVL3QUANT_ROOT = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant")

# === DATA PATHS ===
RESULTS_DIR = LVL3QUANT_ROOT / "alpha_discovery" / "results"
DEEP_MODEL_RESULTS = LVL3QUANT_ROOT / "alpha_discovery" / "deep_models" / "results"
EVENT_LOGS_DIR = LVL3QUANT_ROOT / "live_trading" / "logs" / "events"
BOOK_CACHE_DIR = LVL3QUANT_ROOT / "data" / "processed" / "dl_book_cache"
BOOK_CACHE_OOT_DIR = LVL3QUANT_ROOT / "data" / "processed" / "dl_book_cache_oot"
PREDICTIONS_DIR = DEEP_MODEL_RESULTS
CHASE_SWEEP_FILE = TELECLAUDE_ROOT / "chase_sweep_results.json"
WF_FILL_SIM_FILE = DEEP_MODEL_RESULTS / "wf_fill_sim_results.json"

# === TRADING CONSTANTS ===
ES_TICK_VALUE = 12.50          # $/tick for ES futures
ES_TICK_SIZE = 0.25            # Minimum price increment
RT_COMMISSION = 4.70           # Round-trip commission $
COMMISSION_TICKS = 0.376       # Commission in ticks (4.70/12.50)
SPREAD_TICKS = 1.0             # Typical bid-ask spread
TRADING_DAYS_PER_YEAR = 252

# === RESULT FILE PATTERNS ===
CNN_OOT_PATTERN = "cnn_oot_sim_results_*.json"
MFE_SWEEP_PATTERN = "mfe_sweep_*.json"
GA_SIGNAL_PATTERN = "ga_signal_sweep_*.json"
FILL_SIM_PATTERN = "fill_sim_*.json"
IC_ANALYSIS_PATTERN = "longer_horizon_ic_*.json"

# === DATA TYPE LABELS ===
RESULT_TYPE_MAP = {
    "cnn_oot_sim_results": {
        "name": "CNN Out-of-Time Simulation",
        "model": "BookSpatialCNN",
        "sim_type": "Rust MBO Fill Sim",
        "description": "OOT validation using truly unseen Dec-Mar data with realistic MBO fills",
    },
    "chase_sweep_results": {
        "name": "Chase/Cancel-Replace Sweep",
        "model": "BookSpatialCNN",
        "sim_type": "Rust MBO Fill Sim (IS)",
        "description": "In-sample sweep of chase execution parameters (3,996 configs)",
    },
    "wf_fill_sim_results": {
        "name": "Walk-Forward Fill Simulation",
        "model": "BookSpatialCNN (Walk-Forward)",
        "sim_type": "Rust MBO Fill Sim",
        "description": "Walk-forward retrained model with incremental OOT predictions",
    },
    "mfe_sweep": {
        "name": "MFE/MAE Analysis Sweep",
        "model": "BookSpatialCNN",
        "sim_type": "Rust MBO Fill Sim",
        "description": "Maximum Favorable/Adverse Excursion analysis across 128 configs",
    },
    "fill_sim": {
        "name": "Fill Simulation (Passive)",
        "model": "Various",
        "sim_type": "Rust MBO Fill Sim",
        "description": "Passive limit order fill simulation results",
    },
    "ga_signal_sweep": {
        "name": "Genetic Algorithm Signal Sweep",
        "model": "ET/LightGBM",
        "sim_type": "Rust MBO Fill Sim",
        "description": "GA-optimized signal parameter sweep",
    },
}

# === STRATEGY STATUS ===
STRATEGY_STATUS = {
    "BookSpatialCNN": {"status": "VALIDATED", "color": "#00ff00"},
    "BookGNN": {"status": "NEEDS SIM", "color": "#ffaa00"},
    "ET": {"status": "DEAD (untradeable)", "color": "#ff4444"},
    "LightGBM": {"status": "DEAD (untradeable)", "color": "#ff4444"},
    "Vol Prediction": {"status": "DEAD (VRP)", "color": "#ff4444"},
    "Composite": {"status": "DEAD", "color": "#ff4444"},
    "Market Orders": {"status": "DEAD", "color": "#ff4444"},
}

# === COMPUTE NODES ===
COMPUTE_NODES = {
    "Neptune": {
        "gpu": "RTX 3090", "ip": "localhost",
        "description": "Primary training + fill_sim node"
    },
    "Uranus": {
        "gpu": "RTX 5090", "ip": "100.100.83.37",
        "description": "Walk-forward training (68 folds)"
    },
    "Jupiter": {
        "gpu": "None (CPU)", "ip": "192.168.0.108",
        "description": "WF sweep + fill_sim workers"
    },
    "Saturn": {
        "gpu": "None (CPU)", "ip": "10.0.0.2 (via Jupiter)",
        "description": "Leakage audit complete, idle"
    },
}
