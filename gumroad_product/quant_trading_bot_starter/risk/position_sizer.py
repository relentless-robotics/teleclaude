"""
Position Sizing Module
======================
Professional position sizing algorithms: Kelly Criterion, Fixed Fractional,
Volatility Targeting, and Risk Parity.
"""

import pandas as pd
import numpy as np
from typing import Dict, Optional, Tuple
from dataclasses import dataclass
from abc import ABC, abstractmethod


@dataclass
class PositionSize:
    """Result of position sizing calculation"""
    shares: float
    dollar_value: float
    weight: float  # Portfolio weight (0-1)
    risk_amount: float  # Dollar amount at risk
    position_type: str  # 'full', 'reduced', 'rejected'
    reason: str = ""


class PositionSizer(ABC):
    """Abstract base class for position sizing strategies"""

    @abstractmethod
    def calculate_size(self, capital: float, price: float,
                      signal_strength: float = 1.0,
                      **kwargs) -> PositionSize:
        """Calculate position size"""
        pass


class FixedFractionalSizer(PositionSizer):
    """
    Fixed Fractional Position Sizing

    Risks a fixed percentage of capital on each trade.
    Simple but effective for consistent risk management.
    """

    def __init__(self, fraction: float = 0.02, max_position: float = 0.10):
        """
        Args:
            fraction: Fraction of capital to risk per trade (default 2%)
            max_position: Maximum position size as fraction of capital (default 10%)
        """
        self.fraction = fraction
        self.max_position = max_position

    def calculate_size(self, capital: float, price: float,
                      signal_strength: float = 1.0,
                      stop_loss_pct: float = 0.02,
                      **kwargs) -> PositionSize:
        """
        Calculate position size based on fixed fraction of capital at risk.

        Args:
            capital: Available capital
            price: Current asset price
            signal_strength: Signal strength multiplier (0-1)
            stop_loss_pct: Stop loss percentage for risk calculation
        """
        # Risk amount
        risk_amount = capital * self.fraction * signal_strength

        # Position size from risk
        position_value = risk_amount / stop_loss_pct

        # Cap at max position
        max_value = capital * self.max_position
        if position_value > max_value:
            position_value = max_value
            position_type = 'reduced'
            reason = f"Capped at {self.max_position:.1%} max position"
        else:
            position_type = 'full'
            reason = ""

        shares = position_value / price
        weight = position_value / capital

        return PositionSize(
            shares=shares,
            dollar_value=position_value,
            weight=weight,
            risk_amount=risk_amount,
            position_type=position_type,
            reason=reason
        )


class KellyCriterion(PositionSizer):
    """
    Kelly Criterion Position Sizing

    Optimal position sizing based on win rate and win/loss ratio.
    Often used with fractional Kelly (e.g., half-Kelly) for reduced volatility.
    """

    def __init__(self, kelly_fraction: float = 0.25, max_position: float = 0.20,
                 min_trades: int = 30):
        """
        Args:
            kelly_fraction: Fraction of full Kelly to use (default 25% = quarter Kelly)
            max_position: Maximum position size as fraction of capital
            min_trades: Minimum trades required to calculate Kelly
        """
        self.kelly_fraction = kelly_fraction
        self.max_position = max_position
        self.min_trades = min_trades

        # Historical tracking
        self.wins = 0
        self.losses = 0
        self.total_win = 0.0
        self.total_loss = 0.0

    def update_stats(self, pnl: float) -> None:
        """Update win/loss statistics with new trade result"""
        if pnl > 0:
            self.wins += 1
            self.total_win += pnl
        else:
            self.losses += 1
            self.total_loss += abs(pnl)

    def calculate_kelly(self) -> Tuple[float, str]:
        """
        Calculate Kelly percentage.

        Kelly % = W - (1-W)/R
        Where:
            W = Win probability
            R = Win/Loss ratio (average win / average loss)
        """
        total_trades = self.wins + self.losses

        if total_trades < self.min_trades:
            return 0.02, f"Insufficient trades ({total_trades}/{self.min_trades})"

        win_rate = self.wins / total_trades

        if self.losses == 0:
            return self.max_position, "No losses recorded"

        avg_win = self.total_win / max(1, self.wins)
        avg_loss = self.total_loss / max(1, self.losses)
        win_loss_ratio = avg_win / avg_loss

        # Kelly formula
        kelly = win_rate - (1 - win_rate) / win_loss_ratio

        if kelly <= 0:
            return 0, f"Negative Kelly ({kelly:.2%}) - strategy not profitable"

        # Apply Kelly fraction
        adjusted_kelly = kelly * self.kelly_fraction

        return min(adjusted_kelly, self.max_position), ""

    def calculate_size(self, capital: float, price: float,
                      signal_strength: float = 1.0,
                      **kwargs) -> PositionSize:
        """Calculate position size using Kelly Criterion"""
        kelly_pct, reason = self.calculate_kelly()

        if kelly_pct <= 0:
            return PositionSize(
                shares=0,
                dollar_value=0,
                weight=0,
                risk_amount=0,
                position_type='rejected',
                reason=reason
            )

        position_value = capital * kelly_pct * signal_strength
        shares = position_value / price
        weight = position_value / capital

        return PositionSize(
            shares=shares,
            dollar_value=position_value,
            weight=weight,
            risk_amount=position_value * 0.02,  # Assume 2% stop
            position_type='full' if not reason else 'reduced',
            reason=reason
        )

    def get_statistics(self) -> Dict:
        """Return current Kelly statistics"""
        total = self.wins + self.losses
        return {
            'total_trades': total,
            'win_rate': self.wins / max(1, total),
            'avg_win': self.total_win / max(1, self.wins),
            'avg_loss': self.total_loss / max(1, self.losses),
            'kelly_pct': self.calculate_kelly()[0]
        }


class VolatilityTargeting(PositionSizer):
    """
    Volatility Targeting Position Sizing

    Sizes positions to achieve a target portfolio volatility.
    Automatically reduces exposure in volatile markets.
    """

    def __init__(self, target_volatility: float = 0.15,
                 max_leverage: float = 2.0,
                 vol_lookback: int = 20):
        """
        Args:
            target_volatility: Target annualized volatility (default 15%)
            max_leverage: Maximum leverage allowed
            vol_lookback: Days for volatility calculation
        """
        self.target_volatility = target_volatility
        self.max_leverage = max_leverage
        self.vol_lookback = vol_lookback

    def calculate_volatility(self, returns: pd.Series) -> float:
        """Calculate annualized volatility"""
        if len(returns) < self.vol_lookback:
            return 0.20  # Default assumption

        recent_returns = returns.tail(self.vol_lookback)
        daily_vol = recent_returns.std()
        annual_vol = daily_vol * np.sqrt(252)

        return annual_vol

    def calculate_size(self, capital: float, price: float,
                      signal_strength: float = 1.0,
                      returns: pd.Series = None,
                      current_volatility: float = None,
                      **kwargs) -> PositionSize:
        """
        Calculate position size to achieve target volatility.

        Args:
            capital: Available capital
            price: Current asset price
            signal_strength: Signal strength multiplier
            returns: Historical returns series
            current_volatility: Pre-calculated volatility (optional)
        """
        # Get volatility
        if current_volatility is not None:
            vol = current_volatility
        elif returns is not None:
            vol = self.calculate_volatility(returns)
        else:
            vol = 0.20  # Default assumption

        # Avoid division by zero
        vol = max(vol, 0.01)

        # Calculate scalar
        vol_scalar = self.target_volatility / vol

        # Apply leverage limit
        vol_scalar = min(vol_scalar, self.max_leverage)

        # Position size
        position_value = capital * vol_scalar * signal_strength
        shares = position_value / price
        weight = vol_scalar * signal_strength

        position_type = 'full'
        reason = ""
        if vol_scalar >= self.max_leverage:
            position_type = 'reduced'
            reason = f"Leverage capped at {self.max_leverage}x"

        return PositionSize(
            shares=shares,
            dollar_value=position_value,
            weight=weight,
            risk_amount=position_value * (vol / np.sqrt(252)),  # Daily VaR approx
            position_type=position_type,
            reason=reason
        )


class RiskParity(PositionSizer):
    """
    Risk Parity Position Sizing

    Allocates equal risk contribution across positions.
    Lower volatility assets get higher weights.
    """

    def __init__(self, target_portfolio_vol: float = 0.10,
                 vol_lookback: int = 60):
        """
        Args:
            target_portfolio_vol: Target portfolio volatility
            vol_lookback: Days for covariance calculation
        """
        self.target_portfolio_vol = target_portfolio_vol
        self.vol_lookback = vol_lookback

    def calculate_weights(self, returns_df: pd.DataFrame) -> pd.Series:
        """
        Calculate risk parity weights for multiple assets.

        Args:
            returns_df: DataFrame with returns for each asset (columns)

        Returns:
            Series with weight for each asset
        """
        # Calculate covariance matrix
        cov = returns_df.cov() * 252  # Annualized

        # Inverse volatility weighting (simple approximation)
        vols = np.sqrt(np.diag(cov))
        inv_vols = 1 / vols

        # Normalize
        weights = inv_vols / inv_vols.sum()

        # Scale to target volatility
        port_vol = np.sqrt(weights @ cov @ weights)
        scalar = self.target_portfolio_vol / port_vol

        return pd.Series(weights * scalar, index=returns_df.columns)

    def calculate_size(self, capital: float, price: float,
                      signal_strength: float = 1.0,
                      asset_weight: float = None,
                      **kwargs) -> PositionSize:
        """
        Calculate position size for a single asset given its weight.

        Args:
            capital: Total portfolio capital
            price: Asset price
            asset_weight: Pre-calculated weight from calculate_weights()
        """
        if asset_weight is None:
            asset_weight = 0.10  # Default equal weight for 10 assets

        position_value = capital * asset_weight * signal_strength
        shares = position_value / price

        return PositionSize(
            shares=shares,
            dollar_value=position_value,
            weight=asset_weight * signal_strength,
            risk_amount=position_value * 0.02,
            position_type='full',
            reason=""
        )


class ATRPositionSizer(PositionSizer):
    """
    ATR-Based Position Sizing

    Sizes positions based on Average True Range.
    Consistent dollar risk regardless of asset volatility.
    """

    def __init__(self, risk_per_trade: float = 0.01,
                 atr_multiplier: float = 2.0,
                 atr_period: int = 14,
                 max_position: float = 0.10):
        """
        Args:
            risk_per_trade: Fraction of capital to risk per trade
            atr_multiplier: Multiplier for ATR stop distance
            atr_period: Period for ATR calculation
            max_position: Maximum position as fraction of capital
        """
        self.risk_per_trade = risk_per_trade
        self.atr_multiplier = atr_multiplier
        self.atr_period = atr_period
        self.max_position = max_position

    def calculate_atr(self, data: pd.DataFrame) -> float:
        """Calculate current ATR"""
        high = data['high']
        low = data['low']
        close = data['close']

        tr1 = high - low
        tr2 = (high - close.shift()).abs()
        tr3 = (low - close.shift()).abs()

        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        atr = tr.rolling(self.atr_period).mean().iloc[-1]

        return atr

    def calculate_size(self, capital: float, price: float,
                      signal_strength: float = 1.0,
                      data: pd.DataFrame = None,
                      atr: float = None,
                      **kwargs) -> PositionSize:
        """
        Calculate position size based on ATR.

        Args:
            capital: Available capital
            price: Current price
            data: OHLC data for ATR calculation
            atr: Pre-calculated ATR (optional)
        """
        # Get ATR
        if atr is None and data is not None:
            atr = self.calculate_atr(data)
        elif atr is None:
            atr = price * 0.02  # Default 2% of price

        # Stop distance
        stop_distance = atr * self.atr_multiplier

        # Dollar risk
        risk_amount = capital * self.risk_per_trade * signal_strength

        # Position size
        shares = risk_amount / stop_distance
        position_value = shares * price

        # Cap position
        max_value = capital * self.max_position
        if position_value > max_value:
            shares = max_value / price
            position_value = max_value
            position_type = 'reduced'
            reason = f"Capped at {self.max_position:.1%}"
        else:
            position_type = 'full'
            reason = ""

        return PositionSize(
            shares=shares,
            dollar_value=position_value,
            weight=position_value / capital,
            risk_amount=risk_amount,
            position_type=position_type,
            reason=reason
        )


# Quick usage example
if __name__ == "__main__":
    capital = 100000
    price = 150.0

    # Fixed Fractional
    ff_sizer = FixedFractionalSizer(fraction=0.02, max_position=0.10)
    size = ff_sizer.calculate_size(capital, price, stop_loss_pct=0.02)
    print(f"Fixed Fractional: {size.shares:.0f} shares (${size.dollar_value:,.0f})")

    # Volatility Targeting
    vol_sizer = VolatilityTargeting(target_volatility=0.15)
    size = vol_sizer.calculate_size(capital, price, current_volatility=0.25)
    print(f"Vol Targeting: {size.shares:.0f} shares (${size.dollar_value:,.0f})")

    # Kelly (with sample stats)
    kelly_sizer = KellyCriterion(kelly_fraction=0.25)
    for _ in range(20):
        kelly_sizer.update_stats(100)  # wins
    for _ in range(10):
        kelly_sizer.update_stats(-50)  # losses
    size = kelly_sizer.calculate_size(capital, price)
    print(f"Kelly Criterion: {size.shares:.0f} shares (${size.dollar_value:,.0f})")
    print(f"Kelly stats: {kelly_sizer.get_statistics()}")
