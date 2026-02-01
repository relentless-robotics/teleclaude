"""
Machine Learning Strategy
=========================
ML-based trading strategies using scikit-learn and XGBoost.
Includes feature engineering and walk-forward validation.
"""

import pandas as pd
import numpy as np
from typing import Dict, Any, List, Optional
from dataclasses import dataclass
import warnings
warnings.filterwarnings('ignore')

from .base_strategy import BaseStrategy

try:
    from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import TimeSeriesSplit
    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False

try:
    import xgboost as xgb
    XGBOOST_AVAILABLE = True
except ImportError:
    XGBOOST_AVAILABLE = False

try:
    import lightgbm as lgb
    LIGHTGBM_AVAILABLE = True
except ImportError:
    LIGHTGBM_AVAILABLE = False


@dataclass
class FeatureConfig:
    """Configuration for feature engineering"""
    returns_periods: List[int] = None
    volatility_periods: List[int] = None
    ma_periods: List[int] = None
    rsi_periods: List[int] = None
    include_volume: bool = True
    include_weekday: bool = True
    include_month: bool = True

    def __post_init__(self):
        self.returns_periods = self.returns_periods or [1, 5, 10, 20, 60]
        self.volatility_periods = self.volatility_periods or [10, 20, 60]
        self.ma_periods = self.ma_periods or [5, 10, 20, 50, 200]
        self.rsi_periods = self.rsi_periods or [14]


class FeatureEngineer:
    """Generate features for ML models"""

    def __init__(self, config: FeatureConfig = None):
        self.config = config or FeatureConfig()

    def calculate_rsi(self, prices: pd.Series, period: int = 14) -> pd.Series:
        """Calculate RSI"""
        delta = prices.diff()
        gain = delta.where(delta > 0, 0).rolling(period).mean()
        loss = -delta.where(delta < 0, 0).rolling(period).mean()
        rs = gain / (loss + 1e-10)
        return 100 - (100 / (1 + rs))

    def calculate_macd(self, prices: pd.Series) -> pd.DataFrame:
        """Calculate MACD indicator"""
        ema12 = prices.ewm(span=12, adjust=False).mean()
        ema26 = prices.ewm(span=26, adjust=False).mean()
        macd = ema12 - ema26
        signal = macd.ewm(span=9, adjust=False).mean()
        histogram = macd - signal

        return pd.DataFrame({
            'macd': macd,
            'macd_signal': signal,
            'macd_hist': histogram
        })

    def calculate_atr(self, data: pd.DataFrame, period: int = 14) -> pd.Series:
        """Calculate Average True Range"""
        high = data['high']
        low = data['low']
        close = data['close']

        tr1 = high - low
        tr2 = abs(high - close.shift())
        tr3 = abs(low - close.shift())

        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        return tr.rolling(period).mean()

    def generate_features(self, data: pd.DataFrame) -> pd.DataFrame:
        """Generate all features from OHLCV data"""
        df = data.copy()
        close = df['close']
        features = {}

        # Returns
        for period in self.config.returns_periods:
            features[f'return_{period}d'] = close.pct_change(period)

        # Volatility
        returns = close.pct_change()
        for period in self.config.volatility_periods:
            features[f'volatility_{period}d'] = returns.rolling(period).std() * np.sqrt(252)

        # Moving averages (price relative to MA)
        for period in self.config.ma_periods:
            ma = close.rolling(period).mean()
            features[f'price_to_ma_{period}'] = close / ma - 1

        # RSI
        for period in self.config.rsi_periods:
            features[f'rsi_{period}'] = self.calculate_rsi(close, period)

        # MACD
        macd_df = self.calculate_macd(close)
        features['macd'] = macd_df['macd']
        features['macd_signal'] = macd_df['macd_signal']
        features['macd_hist'] = macd_df['macd_hist']

        # ATR
        features['atr_14'] = self.calculate_atr(df, 14)
        features['atr_pct'] = features['atr_14'] / close

        # Volume features
        if self.config.include_volume and 'volume' in df.columns:
            volume = df['volume']
            features['volume_ma_ratio'] = volume / volume.rolling(20).mean()
            features['volume_std'] = volume.rolling(20).std() / volume.rolling(20).mean()

        # Momentum
        features['momentum_12m'] = close / close.shift(252) - 1
        features['momentum_6m'] = close / close.shift(126) - 1
        features['momentum_1m'] = close / close.shift(21) - 1

        # High/Low features
        features['high_52w'] = close / close.rolling(252).max()
        features['low_52w'] = close / close.rolling(252).min()

        # Calendar features
        if self.config.include_weekday:
            features['weekday'] = df.index.dayofweek
        if self.config.include_month:
            features['month'] = df.index.month

        feature_df = pd.DataFrame(features, index=df.index)
        return feature_df


class MLStrategy(BaseStrategy):
    """
    Machine Learning Trading Strategy

    Uses XGBoost/LightGBM/RandomForest to predict future returns.
    Includes walk-forward training and feature importance analysis.
    """

    def __init__(self, model_type: str = 'xgboost',
                 train_window: int = 252,
                 prediction_horizon: int = 5,
                 retrain_frequency: int = 21,
                 threshold: float = 0.5):
        super().__init__(name="MLStrategy")
        self.model_type = model_type
        self.train_window = train_window
        self.prediction_horizon = prediction_horizon
        self.retrain_frequency = retrain_frequency
        self.threshold = threshold

        self.model = None
        self.scaler = StandardScaler() if SKLEARN_AVAILABLE else None
        self.feature_engineer = FeatureEngineer()
        self.feature_importance = None

    def _create_model(self):
        """Create ML model based on model_type"""
        if self.model_type == 'xgboost' and XGBOOST_AVAILABLE:
            return xgb.XGBClassifier(
                n_estimators=100,
                max_depth=5,
                learning_rate=0.1,
                objective='binary:logistic',
                random_state=42,
                use_label_encoder=False,
                eval_metric='logloss'
            )
        elif self.model_type == 'lightgbm' and LIGHTGBM_AVAILABLE:
            return lgb.LGBMClassifier(
                n_estimators=100,
                max_depth=5,
                learning_rate=0.1,
                random_state=42,
                verbose=-1
            )
        elif SKLEARN_AVAILABLE:
            return RandomForestClassifier(
                n_estimators=100,
                max_depth=5,
                random_state=42
            )
        else:
            raise ImportError("No ML library available. Install scikit-learn, xgboost, or lightgbm")

    def _create_target(self, prices: pd.Series) -> pd.Series:
        """Create binary classification target (1 if price goes up, 0 otherwise)"""
        future_return = prices.shift(-self.prediction_horizon) / prices - 1
        target = (future_return > 0).astype(int)
        return target

    def _train_model(self, features: pd.DataFrame, target: pd.Series) -> None:
        """Train the ML model"""
        # Remove NaN
        mask = ~(features.isna().any(axis=1) | target.isna())
        X = features[mask]
        y = target[mask]

        if len(X) < 100:
            return

        # Scale features
        X_scaled = self.scaler.fit_transform(X)

        # Train model
        self.model = self._create_model()
        self.model.fit(X_scaled, y)

        # Store feature importance
        if hasattr(self.model, 'feature_importances_'):
            self.feature_importance = pd.Series(
                self.model.feature_importances_,
                index=features.columns
            ).sort_values(ascending=False)

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        """Generate ML-based trading signals"""
        if not SKLEARN_AVAILABLE:
            raise ImportError("scikit-learn is required for ML strategies")

        # Generate features
        features = self.feature_engineer.generate_features(data)
        target = self._create_target(data['close'])

        signals = pd.Series(0, index=data.index)

        # Walk-forward training
        for i in range(self.train_window, len(data), self.retrain_frequency):
            # Training data
            train_start = max(0, i - self.train_window)
            train_features = features.iloc[train_start:i]
            train_target = target.iloc[train_start:i]

            # Train model
            self._train_model(train_features, train_target)

            if self.model is None:
                continue

            # Generate predictions for next period
            pred_end = min(i + self.retrain_frequency, len(data))
            pred_features = features.iloc[i:pred_end]

            if len(pred_features) == 0:
                continue

            # Handle NaN in prediction features
            pred_features_clean = pred_features.fillna(0)
            X_pred = self.scaler.transform(pred_features_clean)

            # Predict
            probabilities = self.model.predict_proba(X_pred)[:, 1]

            # Generate signals based on probability threshold
            for j, prob in enumerate(probabilities):
                idx = i + j
                if idx < len(signals):
                    if prob > self.threshold + 0.1:
                        signals.iloc[idx] = 1  # Strong long signal
                    elif prob < self.threshold - 0.1:
                        signals.iloc[idx] = -1  # Short signal
                    else:
                        signals.iloc[idx] = 0  # No signal

        return signals

    def get_feature_importance(self) -> Optional[pd.Series]:
        """Return feature importance from the last trained model"""
        return self.feature_importance

    def get_parameters(self) -> Dict[str, Any]:
        return {
            'model_type': self.model_type,
            'train_window': self.train_window,
            'prediction_horizon': self.prediction_horizon,
            'retrain_frequency': self.retrain_frequency,
            'threshold': self.threshold
        }


class EnsembleMLStrategy(BaseStrategy):
    """
    Ensemble of multiple ML models

    Combines predictions from XGBoost, LightGBM, and RandomForest.
    Uses voting or averaging for final prediction.
    """

    def __init__(self, train_window: int = 252,
                 prediction_horizon: int = 5,
                 voting: str = 'soft'):
        super().__init__(name="EnsembleMLStrategy")
        self.train_window = train_window
        self.prediction_horizon = prediction_horizon
        self.voting = voting

        self.models = []
        self.scalers = []
        self.feature_engineer = FeatureEngineer()

    def _create_models(self) -> List:
        """Create ensemble of different model types"""
        models = []

        if XGBOOST_AVAILABLE:
            models.append(('xgboost', xgb.XGBClassifier(
                n_estimators=100, max_depth=5, learning_rate=0.1,
                random_state=42, use_label_encoder=False, eval_metric='logloss'
            )))

        if LIGHTGBM_AVAILABLE:
            models.append(('lightgbm', lgb.LGBMClassifier(
                n_estimators=100, max_depth=5, learning_rate=0.1,
                random_state=42, verbose=-1
            )))

        if SKLEARN_AVAILABLE:
            models.append(('rf', RandomForestClassifier(
                n_estimators=100, max_depth=5, random_state=42
            )))
            models.append(('gb', GradientBoostingClassifier(
                n_estimators=100, max_depth=5, learning_rate=0.1, random_state=42
            )))

        return models

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        """Generate ensemble ML-based trading signals"""
        features = self.feature_engineer.generate_features(data)
        target = (data['close'].shift(-self.prediction_horizon) / data['close'] - 1 > 0).astype(int)

        signals = pd.Series(0, index=data.index)
        self.models = self._create_models()

        for i in range(self.train_window, len(data), 21):
            train_features = features.iloc[max(0, i-self.train_window):i]
            train_target = target.iloc[max(0, i-self.train_window):i]

            mask = ~(train_features.isna().any(axis=1) | train_target.isna())
            X_train = train_features[mask]
            y_train = train_target[mask]

            if len(X_train) < 100:
                continue

            scaler = StandardScaler()
            X_scaled = scaler.fit_transform(X_train)

            # Train all models
            predictions = []
            for name, model in self.models:
                try:
                    model.fit(X_scaled, y_train)

                    # Predict
                    pred_end = min(i + 21, len(data))
                    pred_features = features.iloc[i:pred_end].fillna(0)
                    X_pred = scaler.transform(pred_features)

                    if self.voting == 'soft':
                        probs = model.predict_proba(X_pred)[:, 1]
                        predictions.append(probs)
                    else:
                        preds = model.predict(X_pred)
                        predictions.append(preds)
                except Exception:
                    continue

            if not predictions:
                continue

            # Combine predictions
            if self.voting == 'soft':
                avg_prob = np.mean(predictions, axis=0)
                for j, prob in enumerate(avg_prob):
                    idx = i + j
                    if idx < len(signals):
                        if prob > 0.6:
                            signals.iloc[idx] = 1
                        elif prob < 0.4:
                            signals.iloc[idx] = -1
            else:
                # Hard voting
                votes = np.sum(predictions, axis=0)
                for j, vote in enumerate(votes):
                    idx = i + j
                    if idx < len(signals):
                        if vote > len(predictions) / 2:
                            signals.iloc[idx] = 1
                        elif vote < len(predictions) / 2:
                            signals.iloc[idx] = -1

        return signals

    def get_parameters(self) -> Dict[str, Any]:
        return {
            'train_window': self.train_window,
            'prediction_horizon': self.prediction_horizon,
            'voting': self.voting,
            'num_models': len(self.models)
        }


# Quick usage example
if __name__ == "__main__":
    import yfinance as yf

    # Download sample data
    data = yf.download("AAPL", start="2018-01-01", end="2024-01-01")
    data.columns = data.columns.str.lower()

    # Test ML strategy
    strategy = MLStrategy(model_type='xgboost', train_window=252)
    signals = strategy.generate_signals(data)

    print(f"Strategy: {strategy}")
    print(f"Signal distribution:\n{signals.value_counts()}")

    # Show feature importance
    importance = strategy.get_feature_importance()
    if importance is not None:
        print(f"\nTop 10 features:\n{importance.head(10)}")
