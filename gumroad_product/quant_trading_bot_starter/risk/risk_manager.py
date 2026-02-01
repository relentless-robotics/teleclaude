"""
Risk Manager Module
===================
Portfolio-level risk management: drawdown limits, exposure controls,
stop losses, and correlation monitoring.
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum


class RiskAction(Enum):
    """Actions the risk manager can take"""
    ALLOW = "allow"
    REDUCE = "reduce"
    REJECT = "reject"
    CLOSE_ALL = "close_all"
    HALT_TRADING = "halt_trading"


@dataclass
class RiskLimits:
    """Risk management parameters"""
    # Position Limits
    max_position_size: float = 0.10          # 10% max per position
    max_sector_exposure: float = 0.30        # 30% max per sector
    max_correlation: float = 0.70            # Max correlation between positions
    max_positions: int = 20                  # Maximum number of positions

    # Portfolio Limits
    max_drawdown: float = 0.15               # 15% max drawdown
    max_daily_loss: float = 0.03             # 3% max daily loss
    max_leverage: float = 1.0                # No leverage by default
    min_cash_reserve: float = 0.05           # 5% cash reserve

    # Stop Loss Settings
    stop_loss_type: str = "atr"              # fixed, trailing, atr
    stop_loss_pct: float = 0.02              # 2% fixed stop
    trailing_stop_pct: float = 0.05          # 5% trailing stop
    atr_stop_multiplier: float = 2.0         # 2x ATR stop

    # Trade Limits
    max_trades_per_day: int = 10             # Maximum daily trades
    min_holding_period: int = 1              # Minimum days to hold

    # Cooldown
    drawdown_cooldown_days: int = 5          # Days to wait after max drawdown


@dataclass
class Position:
    """Represents an open position"""
    symbol: str
    quantity: float
    entry_price: float
    entry_date: datetime
    current_price: float
    side: str  # 'long' or 'short'
    sector: str = "unknown"
    stop_loss: float = None
    peak_price: float = None
    metadata: Dict = field(default_factory=dict)

    def __post_init__(self):
        if self.peak_price is None:
            self.peak_price = self.entry_price

    @property
    def market_value(self) -> float:
        return abs(self.quantity) * self.current_price

    @property
    def unrealized_pnl(self) -> float:
        if self.side == 'long':
            return (self.current_price - self.entry_price) * self.quantity
        else:
            return (self.entry_price - self.current_price) * abs(self.quantity)

    @property
    def unrealized_pnl_pct(self) -> float:
        if self.side == 'long':
            return (self.current_price / self.entry_price) - 1
        else:
            return (self.entry_price / self.current_price) - 1


@dataclass
class RiskCheckResult:
    """Result of a risk check"""
    action: RiskAction
    reason: str
    details: Dict = field(default_factory=dict)


class RiskManager:
    """
    Portfolio Risk Manager

    Monitors and enforces risk limits across the portfolio.
    """

    def __init__(self, limits: RiskLimits = None, initial_capital: float = 100000):
        self.limits = limits or RiskLimits()
        self.initial_capital = initial_capital
        self.current_capital = initial_capital

        # State tracking
        self.positions: Dict[str, Position] = {}
        self.equity_history: List[Tuple[datetime, float]] = []
        self.peak_equity = initial_capital
        self.trade_history: List[Dict] = []
        self.daily_trades = 0
        self.last_trade_date = None
        self.is_halted = False
        self.halt_reason = ""
        self.cooldown_until = None

    def update_equity(self, timestamp: datetime, equity: float) -> None:
        """Update equity tracking"""
        self.equity_history.append((timestamp, equity))
        self.current_capital = equity

        if equity > self.peak_equity:
            self.peak_equity = equity

    def get_current_drawdown(self) -> float:
        """Calculate current drawdown from peak"""
        if self.peak_equity == 0:
            return 0
        return (self.peak_equity - self.current_capital) / self.peak_equity

    def get_daily_pnl(self) -> float:
        """Get today's P&L"""
        if len(self.equity_history) < 2:
            return 0

        today = datetime.now().date()
        today_equity = self.current_capital

        # Find yesterday's close
        for ts, eq in reversed(self.equity_history[:-1]):
            if ts.date() < today:
                return (today_equity - eq) / eq

        return 0

    def check_drawdown_limits(self) -> RiskCheckResult:
        """Check if drawdown limits are breached"""
        current_dd = self.get_current_drawdown()

        if current_dd >= self.limits.max_drawdown:
            self.is_halted = True
            self.halt_reason = f"Max drawdown breached: {current_dd:.1%}"
            self.cooldown_until = datetime.now() + timedelta(days=self.limits.drawdown_cooldown_days)

            return RiskCheckResult(
                action=RiskAction.HALT_TRADING,
                reason=self.halt_reason,
                details={'current_drawdown': current_dd, 'limit': self.limits.max_drawdown}
            )

        if current_dd >= self.limits.max_drawdown * 0.8:
            return RiskCheckResult(
                action=RiskAction.REDUCE,
                reason=f"Approaching max drawdown: {current_dd:.1%}",
                details={'current_drawdown': current_dd}
            )

        return RiskCheckResult(action=RiskAction.ALLOW, reason="")

    def check_daily_loss_limit(self) -> RiskCheckResult:
        """Check daily loss limit"""
        daily_pnl = self.get_daily_pnl()

        if daily_pnl <= -self.limits.max_daily_loss:
            return RiskCheckResult(
                action=RiskAction.HALT_TRADING,
                reason=f"Daily loss limit breached: {daily_pnl:.1%}",
                details={'daily_pnl': daily_pnl}
            )

        return RiskCheckResult(action=RiskAction.ALLOW, reason="")

    def check_position_limits(self, symbol: str, proposed_value: float) -> RiskCheckResult:
        """Check if a new position would breach limits"""
        # Position size limit
        position_weight = proposed_value / self.current_capital

        if position_weight > self.limits.max_position_size:
            return RiskCheckResult(
                action=RiskAction.REDUCE,
                reason=f"Position size {position_weight:.1%} exceeds limit {self.limits.max_position_size:.1%}",
                details={'proposed_weight': position_weight, 'max_weight': self.limits.max_position_size}
            )

        # Number of positions
        if len(self.positions) >= self.limits.max_positions and symbol not in self.positions:
            return RiskCheckResult(
                action=RiskAction.REJECT,
                reason=f"Max positions ({self.limits.max_positions}) reached",
                details={'current_positions': len(self.positions)}
            )

        return RiskCheckResult(action=RiskAction.ALLOW, reason="")

    def check_sector_exposure(self, sector: str, proposed_value: float) -> RiskCheckResult:
        """Check sector exposure limits"""
        # Current sector exposure
        sector_exposure = sum(
            pos.market_value for pos in self.positions.values()
            if pos.sector == sector
        )

        total_exposure = (sector_exposure + proposed_value) / self.current_capital

        if total_exposure > self.limits.max_sector_exposure:
            return RiskCheckResult(
                action=RiskAction.REDUCE,
                reason=f"Sector {sector} exposure {total_exposure:.1%} exceeds limit",
                details={'current_exposure': sector_exposure / self.current_capital,
                        'proposed_total': total_exposure}
            )

        return RiskCheckResult(action=RiskAction.ALLOW, reason="")

    def check_correlation(self, symbol: str, returns: pd.Series,
                         portfolio_returns: pd.DataFrame) -> RiskCheckResult:
        """Check correlation with existing positions"""
        if portfolio_returns.empty or len(self.positions) == 0:
            return RiskCheckResult(action=RiskAction.ALLOW, reason="")

        # Calculate correlation with existing positions
        correlations = {}
        for col in portfolio_returns.columns:
            if col in self.positions:
                corr = returns.corr(portfolio_returns[col])
                correlations[col] = corr

        max_corr = max(correlations.values()) if correlations else 0

        if max_corr > self.limits.max_correlation:
            highest_corr_symbol = max(correlations, key=correlations.get)
            return RiskCheckResult(
                action=RiskAction.REDUCE,
                reason=f"High correlation ({max_corr:.2f}) with {highest_corr_symbol}",
                details={'correlations': correlations}
            )

        return RiskCheckResult(action=RiskAction.ALLOW, reason="")

    def check_leverage(self) -> RiskCheckResult:
        """Check portfolio leverage"""
        total_exposure = sum(pos.market_value for pos in self.positions.values())
        leverage = total_exposure / self.current_capital

        if leverage > self.limits.max_leverage:
            return RiskCheckResult(
                action=RiskAction.REDUCE,
                reason=f"Leverage {leverage:.2f}x exceeds limit {self.limits.max_leverage}x",
                details={'current_leverage': leverage}
            )

        return RiskCheckResult(action=RiskAction.ALLOW, reason="")

    def check_trade_frequency(self) -> RiskCheckResult:
        """Check if trade frequency limits are reached"""
        today = datetime.now().date()

        # Reset daily counter if new day
        if self.last_trade_date != today:
            self.daily_trades = 0
            self.last_trade_date = today

        if self.daily_trades >= self.limits.max_trades_per_day:
            return RiskCheckResult(
                action=RiskAction.REJECT,
                reason=f"Daily trade limit ({self.limits.max_trades_per_day}) reached",
                details={'trades_today': self.daily_trades}
            )

        return RiskCheckResult(action=RiskAction.ALLOW, reason="")

    def check_all(self, symbol: str, proposed_value: float,
                 sector: str = "unknown") -> RiskCheckResult:
        """
        Run all risk checks for a proposed trade.

        Returns the most restrictive action needed.
        """
        if self.is_halted:
            # Check if cooldown is over
            if self.cooldown_until and datetime.now() >= self.cooldown_until:
                self.is_halted = False
                self.halt_reason = ""
                self.cooldown_until = None
            else:
                return RiskCheckResult(
                    action=RiskAction.HALT_TRADING,
                    reason=self.halt_reason
                )

        checks = [
            self.check_drawdown_limits(),
            self.check_daily_loss_limit(),
            self.check_position_limits(symbol, proposed_value),
            self.check_sector_exposure(sector, proposed_value),
            self.check_leverage(),
            self.check_trade_frequency(),
        ]

        # Return most restrictive action
        priority = {
            RiskAction.HALT_TRADING: 5,
            RiskAction.CLOSE_ALL: 4,
            RiskAction.REJECT: 3,
            RiskAction.REDUCE: 2,
            RiskAction.ALLOW: 1
        }

        most_restrictive = max(checks, key=lambda x: priority[x.action])
        return most_restrictive

    def calculate_stop_loss(self, entry_price: float, side: str,
                           atr: float = None) -> float:
        """Calculate stop loss price"""
        if self.limits.stop_loss_type == 'fixed':
            if side == 'long':
                return entry_price * (1 - self.limits.stop_loss_pct)
            else:
                return entry_price * (1 + self.limits.stop_loss_pct)

        elif self.limits.stop_loss_type == 'atr' and atr is not None:
            stop_distance = atr * self.limits.atr_stop_multiplier
            if side == 'long':
                return entry_price - stop_distance
            else:
                return entry_price + stop_distance

        else:  # Default to fixed
            if side == 'long':
                return entry_price * (1 - self.limits.stop_loss_pct)
            else:
                return entry_price * (1 + self.limits.stop_loss_pct)

    def update_trailing_stop(self, position: Position) -> float:
        """Update trailing stop for a position"""
        if position.side == 'long':
            # Update peak
            position.peak_price = max(position.peak_price, position.current_price)
            # Trailing stop
            new_stop = position.peak_price * (1 - self.limits.trailing_stop_pct)
            # Only move stop up
            if position.stop_loss:
                return max(new_stop, position.stop_loss)
            return new_stop
        else:
            # Short position
            position.peak_price = min(position.peak_price, position.current_price)
            new_stop = position.peak_price * (1 + self.limits.trailing_stop_pct)
            if position.stop_loss:
                return min(new_stop, position.stop_loss)
            return new_stop

    def check_stop_losses(self) -> List[str]:
        """Check all positions for stop loss triggers"""
        triggered = []

        for symbol, pos in self.positions.items():
            if pos.stop_loss is None:
                continue

            if pos.side == 'long' and pos.current_price <= pos.stop_loss:
                triggered.append(symbol)
            elif pos.side == 'short' and pos.current_price >= pos.stop_loss:
                triggered.append(symbol)

        return triggered

    def add_position(self, symbol: str, quantity: float, price: float,
                    side: str = 'long', sector: str = 'unknown',
                    atr: float = None) -> None:
        """Add a new position"""
        stop_loss = self.calculate_stop_loss(price, side, atr)

        self.positions[symbol] = Position(
            symbol=symbol,
            quantity=quantity,
            entry_price=price,
            entry_date=datetime.now(),
            current_price=price,
            side=side,
            sector=sector,
            stop_loss=stop_loss
        )

        self.daily_trades += 1

    def update_position_price(self, symbol: str, price: float) -> None:
        """Update current price for a position"""
        if symbol in self.positions:
            self.positions[symbol].current_price = price

            # Update trailing stop if enabled
            if self.limits.stop_loss_type == 'trailing':
                self.positions[symbol].stop_loss = self.update_trailing_stop(
                    self.positions[symbol]
                )

    def close_position(self, symbol: str, price: float) -> Optional[Dict]:
        """Close a position and return trade result"""
        if symbol not in self.positions:
            return None

        pos = self.positions[symbol]
        pnl = pos.unrealized_pnl

        trade_result = {
            'symbol': symbol,
            'side': pos.side,
            'entry_price': pos.entry_price,
            'exit_price': price,
            'quantity': pos.quantity,
            'pnl': pnl,
            'pnl_pct': pos.unrealized_pnl_pct,
            'entry_date': pos.entry_date,
            'exit_date': datetime.now(),
            'holding_period': (datetime.now() - pos.entry_date).days
        }

        self.trade_history.append(trade_result)
        del self.positions[symbol]

        return trade_result

    def get_portfolio_summary(self) -> Dict:
        """Get current portfolio summary"""
        total_value = sum(pos.market_value for pos in self.positions.values())
        total_pnl = sum(pos.unrealized_pnl for pos in self.positions.values())

        # Sector breakdown
        sectors = {}
        for pos in self.positions.values():
            if pos.sector not in sectors:
                sectors[pos.sector] = 0
            sectors[pos.sector] += pos.market_value

        return {
            'num_positions': len(self.positions),
            'total_exposure': total_value,
            'exposure_pct': total_value / self.current_capital,
            'unrealized_pnl': total_pnl,
            'current_drawdown': self.get_current_drawdown(),
            'daily_pnl': self.get_daily_pnl(),
            'sector_exposure': {k: v / self.current_capital for k, v in sectors.items()},
            'is_halted': self.is_halted,
            'halt_reason': self.halt_reason
        }


# Quick usage example
if __name__ == "__main__":
    # Create risk manager with custom limits
    limits = RiskLimits(
        max_position_size=0.10,
        max_drawdown=0.15,
        max_daily_loss=0.03
    )

    rm = RiskManager(limits=limits, initial_capital=100000)

    # Check if we can open a new position
    result = rm.check_all("AAPL", 15000, sector="tech")
    print(f"Risk check result: {result.action.value} - {result.reason}")

    # Add position
    rm.add_position("AAPL", 100, 150.0, side='long', sector='tech')

    # Update price
    rm.update_position_price("AAPL", 145.0)

    # Check stop losses
    triggered = rm.check_stop_losses()
    print(f"Stop losses triggered: {triggered}")

    # Get portfolio summary
    summary = rm.get_portfolio_summary()
    print(f"Portfolio summary: {summary}")
