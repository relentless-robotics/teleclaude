#!/usr/bin/env python3
"""
Optuna Meta-Model Hyperparameter Optimization — Saturn
Objective: maximize Sortino after fill sim.
Tunes: LGBM hyperparameters + gate threshold.
100+ trials.

Deployment: /home/saturn/Lvl3Quant/
"""
import sys, json, time, logging, subprocess, tempfile, shutil
import numpy as np
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import optuna
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    HAS_OPTUNA = True
except ImportError:
    HAS_OPTUNA = False

try:
    import lightgbm as lgb
    HAS_LGB = True
except ImportError:
    HAS_LGB = False

logging.basicConfig(
    format='%(asctime)s [meta_optuna] %(levelname)s: %(message)s',
    datefmt='%H:%M:%S',
    level=logging.INFO,
)
log = logging.getLogger('meta_optuna')

LVL3_ROOT = Path("/home/saturn/Lvl3Quant")
BINARY = LVL3_ROOT / "rust_cache_builder" / "target" / "release" / "fill_sim_cli"
MBO_DIR = LVL3_ROOT / "data" / "raw" / "mbo"
CNN_PRED_DIR = LVL3_ROOT / "data" / "processed" / "cnn_wf_sim_predictions"
OUT_DIR = LVL3_ROOT / "data" / "processed" / "meta_optuna_results"
STUDY_DB = OUT_DIR / "meta_optuna_study.db"
OUT_DIR.mkdir(parents=True, exist_ok=True)

N_TRIALS = 100
WORKERS = 40
N_FILL_SIM_WORKERS = 40

# Meta-model training: use wider CNN predictions as base signal + engineered features
# The meta-model takes per-bar features and predicts whether the CNN signal will be profitable

# Load all available per-day prediction files
def load_all_predictions():
    """Load all available CNN prediction files and their corresponding MBO dates."""
    pred_files = sorted(CNN_PRED_DIR.glob("*.npz"))
    valid = []
    for pf in pred_files:
        stem = pf.stem
        date = stem[:10].replace('-', '')
        mbo = MBO_DIR / f"glbx-mdp3-{date}.mbo.dbn.zst"
        if mbo.exists():
            valid.append((date, pf, mbo))
    log.info(f"Found {len(valid)} valid prediction+MBO pairs")
    return valid

def run_fill_sim_with_config(mbo_file, pred_file, out_file, config: dict):
    """Run fill_sim_cli with given config params."""
    cmd = [
        str(BINARY),
        "--mbo-file", str(mbo_file),
        "--predictions", str(pred_file),
        "--output", str(out_file),
        "--hold-ms", str(config.get('hold_ms', 3600000)),
        "--signal-threshold", str(config.get('signal_threshold', 0.1)),
        "--latency-ms", "0",
        "--chase-entry",
        "--chase-max-ticks", "2",
        "--chase-max-reprices", "5",
        "--quiet",
    ]
    tp = config.get('take_profit_ticks')
    sl = config.get('stop_loss_ticks')
    if tp is not None:
        cmd += ["--take-profit-ticks", str(tp)]
    if sl is not None:
        cmd += ["--stop-loss-ticks", str(sl)]
    if config.get('prime_hours', False):
        cmd += ["--prime-hours"]

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if r.returncode == 0 and Path(out_file).exists():
            return True
        return False
    except:
        return False

def aggregate_fill_sim_results(result_dir: Path):
    """Aggregate JSON results from fill sim run."""
    daily_pnl = []
    total_trades = 0

    for f in result_dir.glob("*.json"):
        try:
            data = json.loads(f.read_text())
            pnl = data.get('total_pnl_dollars',
                  data.get('total_pnl_ticks',
                  data.get('pnl_ticks', 0)))
            trades = data.get('total_trades', data.get('n_trades', 0))
            daily_pnl.append(pnl)
            total_trades += trades
        except:
            pass

    if not daily_pnl or total_trades == 0:
        return -99.0, 0

    arr = np.array(daily_pnl)
    mean_pnl = float(np.mean(arr))
    negative = arr[arr < 0]
    downside_std = float(np.std(negative)) if len(negative) > 1 else 1e-8
    sortino = mean_pnl / (downside_std + 1e-8)

    return sortino, total_trades

def train_lgbm_meta_model(train_pairs, lgbm_params, gate_threshold):
    """
    Train LGBM meta-model that predicts CNN signal profitability.

    For each (date, pred_file) pair:
    - CNN prediction > signal_threshold indicates a trade signal
    - We need outcome labels (profitable/unprofitable) — proxy from fill sim baseline
    - Features: CNN z-score, vol regime, time-of-day, lagged signals

    Returns: dict of {date: gated_predictions_array}
    """
    if not HAS_LGB:
        return None

    # Build training data
    # Feature: just the CNN z-score for now (can be extended)
    # Label: sign of PnL will be computed from a quick fill sim
    all_X = []
    all_y = []
    all_dates = []

    for date, pf, mbo in train_pairs[:20]:  # Use first 20 for meta training
        try:
            d = np.load(pf)
            preds = d['predictions']

            # Features: prediction signal + derived
            # Time of day (bar index / total bars)
            n = len(preds)
            t_arr = np.linspace(0, 1, n)

            # Signal z-score (already z-scored but renormalize rolling)
            sig = preds.copy()
            nonzero = sig != 0

            if nonzero.sum() < 10:
                continue

            # Simple features per bar with nonzero signal
            idx = np.where(nonzero)[0]
            X = np.column_stack([
                sig[idx],
                np.abs(sig[idx]),
                t_arr[idx],
                np.minimum(idx, n - idx) / n,  # distance from session midpoint
            ])
            # Pseudo-labels: high abs signal = more likely profitable
            y = (np.abs(sig[idx]) > np.median(np.abs(sig[idx]))).astype(int)

            all_X.append(X)
            all_y.append(y)
            all_dates.append(date)

        except Exception as e:
            log.debug(f"Error building features for {date}: {e}")

    if not all_X:
        return None

    X_train = np.vstack(all_X)
    y_train = np.concatenate(all_y)

    # Train LGBM
    model = lgb.LGBMClassifier(**lgbm_params, verbose=-1)
    model.fit(X_train, y_train)

    # Apply model to all pairs, generate gated predictions
    gated = {}
    for date, pf, mbo in train_pairs:
        try:
            d = np.load(pf)
            preds = d['predictions'].copy()
            n = len(preds)
            t_arr = np.linspace(0, 1, n)

            nonzero = preds != 0
            idx = np.where(nonzero)[0]

            if len(idx) == 0:
                gated[date] = preds
                continue

            sig = preds[idx]
            X_inf = np.column_stack([
                sig,
                np.abs(sig),
                t_arr[idx],
                np.minimum(idx, n - idx) / n,
            ])
            proba = model.predict_proba(X_inf)[:, 1]

            gated_preds = preds.copy()
            gated_preds[idx[proba < gate_threshold]] = 0.0
            gated[date] = gated_preds

        except Exception as e:
            log.debug(f"Error applying meta model to {date}: {e}")
            gated[date] = np.load(pf)['predictions']

    return gated

def run_gated_fill_sim(gated_preds: dict, pairs: list, config: dict, trial_dir: Path):
    """Run fill sim with gated predictions, return Sortino."""
    trial_dir.mkdir(exist_ok=True)
    jobs = []

    for date, pf, mbo in pairs:
        if date not in gated_preds:
            continue

        pred_arr = gated_preds[date]
        if (pred_arr != 0).sum() == 0:
            continue

        # Save gated pred to temp file
        tmp_pred = trial_dir / f"pred_{date}.npz"
        np.savez_compressed(str(tmp_pred), predictions=pred_arr)
        out = trial_dir / f"result_{date}.json"

        if out.exists():
            continue
        jobs.append((mbo, tmp_pred, out))

    if not jobs:
        return -99.0, 0

    done = 0
    with ThreadPoolExecutor(max_workers=N_FILL_SIM_WORKERS) as ex:
        futs = {ex.submit(run_fill_sim_with_config, m, p, o, config): o for m, p, o in jobs}
        for f in as_completed(futs):
            if f.result():
                done += 1

    sortino, trades = aggregate_fill_sim_results(trial_dir)
    return sortino, trades

# Global variable for data (loaded once)
_all_pairs = None

def get_all_pairs():
    global _all_pairs
    if _all_pairs is None:
        _all_pairs = load_all_predictions()
    return _all_pairs

def objective(trial):
    """Optuna objective: train meta-model + run fill sim, return Sortino."""
    # LGBM hyperparameters
    lgbm_params = {
        'n_estimators': trial.suggest_int('n_estimators', 50, 500),
        'max_depth': trial.suggest_int('max_depth', 3, 10),
        'learning_rate': trial.suggest_float('learning_rate', 0.01, 0.3, log=True),
        'num_leaves': trial.suggest_int('num_leaves', 15, 127),
        'min_child_samples': trial.suggest_int('min_child_samples', 10, 100),
        'feature_fraction': trial.suggest_float('feature_fraction', 0.5, 1.0),
        'bagging_fraction': trial.suggest_float('bagging_fraction', 0.5, 1.0),
        'bagging_freq': trial.suggest_int('bagging_freq', 1, 10),
        'reg_alpha': trial.suggest_float('reg_alpha', 1e-4, 10.0, log=True),
        'reg_lambda': trial.suggest_float('reg_lambda', 1e-4, 10.0, log=True),
        'n_jobs': 4,
        'random_state': 42,
    }

    # Gate threshold
    gate_threshold = trial.suggest_float('gate_threshold', 0.4, 0.8)

    # Fill sim config
    config = {
        'take_profit_ticks': trial.suggest_int('take_profit_ticks', 4, 20),
        'stop_loss_ticks': trial.suggest_int('stop_loss_ticks', 8, 30),
        'hold_ms': trial.suggest_categorical('hold_ms', [1800000, 3600000, 7200000]),
        'signal_threshold': trial.suggest_float('signal_threshold', 0.05, 0.5),
        'prime_hours': trial.suggest_categorical('prime_hours', [True, False]),
    }

    pairs = get_all_pairs()
    if not pairs:
        return -99.0

    # Use a subset for speed (use vol70 files)
    subset = [(d, p, m) for d, p, m in pairs if 'vol70' in p.name]
    if not subset:
        subset = pairs[:30]

    # Trial-specific output dir
    trial_dir = OUT_DIR / f"trial_{trial.number:04d}"

    if not HAS_LGB:
        # Without LGBM, just run fill sim with signal threshold gating
        gated = {}
        for date, pf, mbo in subset:
            try:
                d = np.load(pf)
                preds = d['predictions'].copy()
                # Simple threshold gate: only trade signals above gate_threshold * max_signal
                threshold = gate_threshold * float(np.abs(preds).max())
                preds[np.abs(preds) < threshold] = 0.0
                gated[date] = preds
            except:
                pass
        sortino, trades = run_gated_fill_sim(gated, subset, config, trial_dir)
    else:
        # Train LGBM meta-model
        gated = train_lgbm_meta_model(subset, lgbm_params, gate_threshold)
        if gated is None:
            return -99.0
        sortino, trades = run_gated_fill_sim(gated, subset, config, trial_dir)

    # Clean up trial dir to save disk space (keep if promising)
    if sortino < 1.0 and trial_dir.exists():
        shutil.rmtree(trial_dir, ignore_errors=True)

    log.info(f"Trial {trial.number}: Sortino={sortino:.3f}, trades={trades}, "
             f"gate={gate_threshold:.2f}, tp={config['take_profit_ticks']}, "
             f"sl={config['stop_loss_ticks']}")

    return sortino


def main():
    log.info("=" * 60)
    log.info("OPTUNA META-MODEL HYPERPARAMETER OPTIMIZATION")
    log.info("=" * 60)

    if not BINARY.exists():
        log.error(f"fill_sim binary not found: {BINARY}")
        sys.exit(1)

    if not HAS_OPTUNA:
        log.error("optuna not installed. Run: pip install optuna")
        sys.exit(1)

    if not HAS_LGB:
        log.warning("lightgbm not installed — using signal-threshold gating as proxy")
        log.warning("For full LGBM optimization: pip install lightgbm")

    pairs = get_all_pairs()
    if not pairs:
        log.error("No prediction files found")
        sys.exit(1)

    log.info(f"Dataset: {len(pairs)} date-file pairs")
    log.info(f"Running {N_TRIALS} Optuna trials...")

    # Create or load study
    study_url = f"sqlite:///{STUDY_DB}"
    study = optuna.create_study(
        study_name="meta_lgbm_sortino",
        storage=study_url,
        direction="maximize",
        load_if_exists=True,
    )

    existing = len(study.trials)
    if existing > 0:
        log.info(f"Resuming from {existing} existing trials")
        try:
            best = study.best_value
            log.info(f"Current best Sortino: {best:.3f}")
        except:
            pass

    # Run optimization
    n_remaining = max(0, N_TRIALS - existing)
    log.info(f"Running {n_remaining} new trials...")

    if n_remaining > 0:
        study.optimize(
            objective,
            n_trials=n_remaining,
            timeout=None,
            show_progress_bar=False,
            n_jobs=1,  # Sequential — each trial already uses parallel fill_sim
        )

    # Results
    log.info("\n" + "=" * 60)
    log.info("OPTIMIZATION COMPLETE")
    log.info("=" * 60)

    try:
        best_trial = study.best_trial
        log.info(f"Best Sortino: {best_trial.value:.3f}")
        log.info(f"Best params:")
        for k, v in best_trial.params.items():
            log.info(f"  {k}: {v}")

        # Save best params
        best_params_file = OUT_DIR / "best_params.json"
        best_params_file.write_text(json.dumps({
            'best_sortino': best_trial.value,
            'params': best_trial.params,
            'n_trials': len(study.trials),
        }, indent=2))
        log.info(f"Best params saved to {best_params_file}")

        # Top 10 trials
        log.info("\nTop 10 trials:")
        trials_sorted = sorted(
            [t for t in study.trials if t.value is not None],
            key=lambda t: t.value,
            reverse=True
        )
        for t in trials_sorted[:10]:
            log.info(f"  Trial {t.number}: Sortino={t.value:.3f}, "
                     f"gate={t.params.get('gate_threshold', '?'):.2f}, "
                     f"tp={t.params.get('take_profit_ticks', '?')}, "
                     f"sl={t.params.get('stop_loss_ticks', '?')}")

        # Save all results
        all_results = []
        for t in study.trials:
            if t.value is not None:
                all_results.append({
                    'trial': t.number,
                    'sortino': t.value,
                    **t.params
                })

        results_file = OUT_DIR / "all_trials.json"
        results_file.write_text(json.dumps(all_results, indent=2))
        log.info(f"All results saved to {results_file}")

    except Exception as e:
        log.error(f"Error saving results: {e}")

    log.info(f"\nStudy DB: {STUDY_DB}")
    log.info("Done.")


if __name__ == "__main__":
    main()
