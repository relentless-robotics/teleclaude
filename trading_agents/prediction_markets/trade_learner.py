#!/usr/bin/env python3
"""
Trade Outcome Learner for Polymarket Paper Trader.

Tracks closed trade outcomes with structured features, trains an ML model
(logistic regression + gradient boosted trees) to predict trade success
probability, and exports a score_trade() function for filtering.

Usage:
    from trade_learner import TradeLearner
    learner = TradeLearner()
    learner.log_trade(features_dict)
    prob = learner.score_trade(features_dict)
    learner.retrain()

    python -m trading_agents.prediction_markets.trade_learner --retrain
    python -m trading_agents.prediction_markets.trade_learner --report
    python -m trading_agents.prediction_markets.trade_learner --stats
"""

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional
import warnings

import numpy as np
import pandas as pd

logger = logging.getLogger("trade_learner")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

THIS_DIR = Path(__file__).resolve().parent
DATA_DIR = THIS_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

LEARNER_DIR = DATA_DIR / "learner"
LEARNER_DIR.mkdir(exist_ok=True)

# Files
TRADE_LOG_FILE = LEARNER_DIR / "closed_trades.jsonl"
MODEL_FILE = LEARNER_DIR / "trade_model.pkl"
REPORT_DIR = LEARNER_DIR / "reports"
REPORT_DIR.mkdir(exist_ok=True)

# Minimum trades before training
MIN_TRADES_FOR_TRAINING = 30

# Feature columns used by the model
FEATURE_COLS = [
    "edge_score",
    "entry_price",
    "hold_duration_hours",
    "volume_at_entry",
    "time_to_expiry_days",
    "price_volatility_24h",
    "book_depth",
    # Encoded categoricals
    "signal_type_mean_reversion",
    "signal_type_momentum",
    "signal_type_scalp",
    "signal_type_llm_mispricing",
    "signal_type_volume_anomaly",
    "signal_type_other",
    "category_politics",
    "category_sports",
    "category_crypto",
    "category_macro",
    "category_tech",
    "category_general",
    "side_YES",
]


# ---------------------------------------------------------------------------
# Feature Engineering
# ---------------------------------------------------------------------------

SIGNAL_TYPES = ["mean_reversion", "momentum", "scalp", "llm_mispricing", "volume_anomaly", "other"]
CATEGORIES = ["politics", "sports", "crypto", "macro", "tech", "general"]


def encode_features(raw: dict) -> dict:
    """Convert raw trade features to model-ready feature vector."""
    encoded = {
        "edge_score": float(raw.get("edge_score", 0)),
        "entry_price": float(raw.get("entry_price", 0.5)),
        "hold_duration_hours": float(raw.get("hold_duration_hours", 0)),
        "volume_at_entry": np.log1p(float(raw.get("volume_at_entry", 0))),
        "time_to_expiry_days": float(raw.get("time_to_expiry_days", 30)),
        "price_volatility_24h": float(raw.get("price_volatility_24h", 0)),
        "book_depth": np.log1p(float(raw.get("book_depth", 0))),
        "side_YES": 1.0 if raw.get("side", "YES") == "YES" else 0.0,
    }

    # One-hot encode signal_type
    sig = raw.get("signal_type", "other")
    if sig not in SIGNAL_TYPES:
        sig = "other"
    for s in SIGNAL_TYPES:
        encoded[f"signal_type_{s}"] = 1.0 if sig == s else 0.0

    # One-hot encode category
    cat = raw.get("market_category", "general")
    if cat not in CATEGORIES:
        cat = "general"
    for c in CATEGORIES:
        encoded[f"category_{c}"] = 1.0 if cat == c else 0.0

    return encoded


# ---------------------------------------------------------------------------
# Trade Learner
# ---------------------------------------------------------------------------

class TradeLearner:
    """ML-based trade outcome predictor."""

    def __init__(self):
        self.model = None
        self.model_type = None
        self.metrics = {}
        self._load_model()

    def _load_model(self):
        """Load saved model if available."""
        if MODEL_FILE.exists():
            try:
                import joblib
                data = joblib.load(MODEL_FILE)
                self.model = data["model"]
                self.model_type = data.get("model_type", "unknown")
                self.metrics = data.get("metrics", {})
                logger.info(f"Loaded {self.model_type} model (AUC={self.metrics.get('cv_auc_mean', '?')})")
            except Exception as e:
                logger.warning(f"Failed to load model: {e}")
                self.model = None

    def log_trade(self, trade: dict):
        """
        Log a closed trade with structured features to JSONL.

        Expected fields:
            edge_score, signal_type, market_category, side,
            entry_price, exit_price, hold_duration_hours,
            volume_at_entry, time_to_expiry_days, price_volatility_24h,
            book_depth, outcome (win/loss), pnl_pct, slug, timestamp
        """
        record = {
            "slug": trade.get("slug", ""),
            "edge_score": trade.get("edge_score", 0),
            "signal_type": trade.get("signal_type", "unknown"),
            "market_category": trade.get("market_category", "general"),
            "side": trade.get("side", "YES"),
            "entry_price": trade.get("entry_price", 0),
            "exit_price": trade.get("exit_price", 0),
            "hold_duration_hours": trade.get("hold_duration_hours", 0),
            "volume_at_entry": trade.get("volume_at_entry", 0),
            "time_to_expiry_days": trade.get("time_to_expiry_days", 30),
            "price_volatility_24h": trade.get("price_volatility_24h", 0),
            "book_depth": trade.get("book_depth", 0),
            "outcome": trade.get("outcome", "loss"),
            "pnl_pct": trade.get("pnl_pct", 0),
            "timestamp": trade.get("timestamp", datetime.now(timezone.utc).isoformat()),
        }

        with open(TRADE_LOG_FILE, "a") as f:
            f.write(json.dumps(record, default=str) + "\n")

        logger.info(f"Logged trade: {record['slug']} -> {record['outcome']} ({record['pnl_pct']:+.1f}%)")

        # Auto-retrain if we have enough data
        count = self._count_trades()
        if count >= MIN_TRADES_FOR_TRAINING and count % 10 == 0:
            logger.info(f"Auto-retraining on {count} trades...")
            self.retrain()

    def _count_trades(self) -> int:
        if not TRADE_LOG_FILE.exists():
            return 0
        count = 0
        with open(TRADE_LOG_FILE) as f:
            for _ in f:
                count += 1
        return count

    def _load_trades(self) -> pd.DataFrame:
        """Load all logged trades into a DataFrame."""
        if not TRADE_LOG_FILE.exists():
            return pd.DataFrame()

        records = []
        with open(TRADE_LOG_FILE) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue

        if not records:
            return pd.DataFrame()

        return pd.DataFrame(records)

    def retrain(self) -> dict:
        """
        Retrain the ML model on all logged trades.

        Tries GradientBoostingClassifier first (better with enough data),
        falls back to LogisticRegression if < 50 samples.

        Returns metrics dict.
        """
        from sklearn.linear_model import LogisticRegression
        from sklearn.ensemble import GradientBoostingClassifier
        from sklearn.model_selection import cross_val_score, StratifiedKFold
        from sklearn.metrics import roc_auc_score, accuracy_score
        from sklearn.preprocessing import StandardScaler
        from sklearn.pipeline import Pipeline
        import joblib

        df = self._load_trades()
        if len(df) < MIN_TRADES_FOR_TRAINING:
            logger.warning(f"Only {len(df)} trades, need {MIN_TRADES_FOR_TRAINING} for training")
            return {"error": f"Need {MIN_TRADES_FOR_TRAINING} trades, have {len(df)}"}

        # Encode features
        feature_rows = []
        for _, row in df.iterrows():
            encoded = encode_features(row.to_dict())
            feature_rows.append(encoded)

        X = pd.DataFrame(feature_rows)[FEATURE_COLS]
        y = (df["outcome"] == "win").astype(int)

        # Handle NaN
        X = X.fillna(0)

        # Check class balance
        win_rate = y.mean()
        logger.info(f"Training on {len(X)} trades, win rate: {win_rate:.1%}")

        if win_rate == 0.0 or win_rate == 1.0:
            logger.warning("All trades same outcome, cannot train meaningful model")
            return {"error": "All trades have same outcome"}

        # Choose model based on sample size
        if len(X) < 50:
            model_type = "logistic_regression"
            base_model = LogisticRegression(
                C=1.0, max_iter=1000, class_weight="balanced", random_state=42
            )
        else:
            model_type = "gradient_boosting"
            base_model = GradientBoostingClassifier(
                n_estimators=100,
                max_depth=3,
                learning_rate=0.1,
                min_samples_leaf=5,
                subsample=0.8,
                random_state=42,
            )

        pipeline = Pipeline([
            ("scaler", StandardScaler()),
            ("model", base_model),
        ])

        # Cross-validation
        n_splits = min(5, max(2, len(X) // 10))
        cv = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            cv_scores = cross_val_score(pipeline, X, y, cv=cv, scoring="roc_auc")

        # Train final model on all data
        pipeline.fit(X, y)

        # Get predictions for metrics
        y_pred = pipeline.predict(X)
        y_prob = pipeline.predict_proba(X)[:, 1]

        # Feature importances
        fitted_model = pipeline.named_steps["model"]
        if hasattr(fitted_model, "feature_importances_"):
            importances = dict(zip(FEATURE_COLS, fitted_model.feature_importances_))
        elif hasattr(fitted_model, "coef_"):
            importances = dict(zip(FEATURE_COLS, abs(fitted_model.coef_[0])))
        else:
            importances = {}

        # Sort importances
        importances = dict(sorted(importances.items(), key=lambda x: x[1], reverse=True))

        metrics = {
            "model_type": model_type,
            "n_trades": len(X),
            "win_rate": round(float(win_rate), 4),
            "cv_auc_mean": round(float(cv_scores.mean()), 4),
            "cv_auc_std": round(float(cv_scores.std()), 4),
            "train_auc": round(float(roc_auc_score(y, y_prob)), 4),
            "train_accuracy": round(float(accuracy_score(y, y_pred)), 4),
            "feature_importances": {k: round(float(v), 4) for k, v in importances.items()},
            "trained_at": datetime.now(timezone.utc).isoformat(),
        }

        # Save model
        joblib.dump({
            "model": pipeline,
            "model_type": model_type,
            "metrics": metrics,
            "feature_cols": FEATURE_COLS,
        }, MODEL_FILE)

        self.model = pipeline
        self.model_type = model_type
        self.metrics = metrics

        logger.info(
            f"Model trained: {model_type} | "
            f"CV AUC: {metrics['cv_auc_mean']:.3f} +/- {metrics['cv_auc_std']:.3f} | "
            f"Accuracy: {metrics['train_accuracy']:.1%}"
        )

        # Save report
        self._save_report(metrics)

        return metrics

    def score_trade(self, features: dict) -> float:
        """
        Score a potential trade. Returns predicted win probability [0, 1].

        If no model is trained yet, returns 0.5 (neutral).
        """
        if self.model is None:
            return 0.5

        try:
            encoded = encode_features(features)
            X = pd.DataFrame([encoded])[FEATURE_COLS].fillna(0)
            prob = self.model.predict_proba(X)[0, 1]
            return round(float(prob), 4)
        except Exception as e:
            logger.warning(f"Score failed: {e}")
            return 0.5

    def _save_report(self, metrics: dict):
        """Save daily performance report."""
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        report_file = REPORT_DIR / f"model_report_{date_str}.json"
        with open(report_file, "w") as f:
            json.dump(metrics, f, indent=2, default=str)
        logger.info(f"Report saved: {report_file}")

    def get_stats(self) -> dict:
        """Get summary statistics of logged trades."""
        df = self._load_trades()
        if df.empty:
            return {"total_trades": 0}

        wins = (df["outcome"] == "win").sum()
        losses = (df["outcome"] == "loss").sum()
        total = len(df)

        stats = {
            "total_trades": total,
            "wins": int(wins),
            "losses": int(losses),
            "win_rate": round(float(wins / max(1, total)), 4),
            "avg_pnl_pct": round(float(df["pnl_pct"].mean()), 4),
            "median_pnl_pct": round(float(df["pnl_pct"].median()), 4),
            "avg_edge_score": round(float(df["edge_score"].mean()), 1),
            "avg_hold_hours": round(float(df["hold_duration_hours"].mean()), 1),
            "model_loaded": self.model is not None,
            "model_type": self.model_type,
        }

        # Per-signal-type stats
        if "signal_type" in df.columns:
            signal_stats = {}
            for sig, group in df.groupby("signal_type"):
                sig_wins = (group["outcome"] == "win").sum()
                signal_stats[sig] = {
                    "count": len(group),
                    "win_rate": round(float(sig_wins / max(1, len(group))), 4),
                    "avg_pnl_pct": round(float(group["pnl_pct"].mean()), 4),
                }
            stats["by_signal_type"] = signal_stats

        # Per-category stats
        if "market_category" in df.columns:
            cat_stats = {}
            for cat, group in df.groupby("market_category"):
                cat_wins = (group["outcome"] == "win").sum()
                cat_stats[cat] = {
                    "count": len(group),
                    "win_rate": round(float(cat_wins / max(1, len(group))), 4),
                    "avg_pnl_pct": round(float(group["pnl_pct"].mean()), 4),
                }
            stats["by_category"] = cat_stats

        return stats


# ---------------------------------------------------------------------------
# Helper: Extract features from a closed paper trade position
# ---------------------------------------------------------------------------

def extract_trade_features(position: dict, data_collector=None) -> dict:
    """
    Extract ML features from a closed paper trader position dict.

    Called by paper_trader.close_position() to auto-log trades.
    If data_collector is available, enriches with volume/volatility data.
    """
    slug = position.get("slug", "")
    entry_time_str = position.get("entry_time", "")
    exit_time_str = position.get("exit_time", "")

    # Calculate hold duration
    hold_hours = 0
    if entry_time_str and exit_time_str:
        try:
            entry_dt = datetime.fromisoformat(entry_time_str)
            exit_dt = datetime.fromisoformat(exit_time_str)
            hold_hours = (exit_dt - entry_dt).total_seconds() / 3600
        except Exception:
            pass

    # Market category from question
    question = position.get("question", slug)

    try:
        from edge_detector import categorize_market
    except ImportError:
        try:
            from .edge_detector import categorize_market
        except ImportError:
            def categorize_market(q):
                return "general"

    category = categorize_market(question)

    pnl = position.get("pnl", 0)
    pnl_pct = position.get("return_pct", 0)
    outcome = "win" if pnl > 0 else "loss"

    features = {
        "slug": slug,
        "edge_score": position.get("edge_score", 0),
        "signal_type": position.get("signal_type", "unknown"),
        "market_category": category,
        "side": position.get("side", "YES"),
        "entry_price": position.get("entry_price", 0),
        "exit_price": position.get("exit_price", 0),
        "hold_duration_hours": round(hold_hours, 2),
        "volume_at_entry": 0,
        "time_to_expiry_days": 30,
        "price_volatility_24h": 0,
        "book_depth": 0,
        "outcome": outcome,
        "pnl_pct": pnl_pct,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    # Enrich with data collector if available
    if data_collector is not None:
        try:
            features["volume_at_entry"] = data_collector.get_volume_24h(slug)
        except Exception:
            pass
        try:
            features["price_volatility_24h"] = data_collector.get_price_volatility(slug, hours=24)
        except Exception:
            pass
        try:
            features["book_depth"] = data_collector.get_book_depth(slug)
        except Exception:
            pass

    return features


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Polymarket Trade Learner")
    parser.add_argument("--retrain", action="store_true", help="Retrain model")
    parser.add_argument("--report", action="store_true", help="Show latest model report")
    parser.add_argument("--stats", action="store_true", help="Show trade statistics")
    parser.add_argument("--backfill", action="store_true",
                        help="Backfill from paper_trades.json closed trades")
    args = parser.parse_args()

    learner = TradeLearner()

    if args.backfill:
        state_file = DATA_DIR / "paper_trades.json"
        if state_file.exists():
            with open(state_file) as f:
                state = json.load(f)
            closed = state.get("closed_trades", [])
            logger.info(f"Backfilling {len(closed)} closed trades...")
            for pos in closed:
                features = extract_trade_features(pos)
                learner.log_trade(features)
            logger.info("Backfill complete.")
        else:
            logger.warning("No paper_trades.json found")
        return

    if args.retrain:
        metrics = learner.retrain()
        print(json.dumps(metrics, indent=2, default=str))
        return

    if args.stats:
        stats = learner.get_stats()
        print(json.dumps(stats, indent=2, default=str))
        return

    if args.report:
        reports = sorted(REPORT_DIR.glob("model_report_*.json"))
        if reports:
            with open(reports[-1]) as f:
                report = json.load(f)
            print(f"\nLatest Model Report ({reports[-1].name}):")
            print(json.dumps(report, indent=2, default=str))
        else:
            print("No reports yet. Train a model first with --retrain")
        return

    # Default: show stats
    stats = learner.get_stats()
    print(json.dumps(stats, indent=2, default=str))


if __name__ == "__main__":
    main()
