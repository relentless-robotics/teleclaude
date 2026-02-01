"""
Backtesting Engine
==================
High-performance vectorized backtesting with realistic execution modeling.
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Callable, Any
from dataclasses import dataclass, field
from datetime import datetime
import warnings

from ..strategies.base_strategy import BaseStrategy
from ..risk.risk_manager import RiskManager, RiskLimits
from ..risk.position_sizer import PositionSizer, FixedFractionalSizer
from .metrics import calculate_metrics, PerformanceMetrics


@dataclass
class BacktestConfig:
    """Configuration for backtesting"""
    initial_capital: float = 100000
    commission: float = 0.001          # 0.1% per trade
    slippage: float = 0.0005           # 0.05% slippage
    margin_requirement: float = 0.5    # 50% margin for shorts
    fractional_shares: bool = True
    reinvest_dividends: bool = True

    # Risk settings
    risk_limits: RiskLimits = field(default_factory=RiskLimits)

    # Execution settings
    use_next_open: bool = True         # Execute at next bar's open
    allow_shorting: bool = True


@dataclass
class Trade:
    """Represents a completed trade"""
    symbol: str
    side: str
    entry_date: datetime
    exit_date: datetime
    entry_price: float
    exit_price: float
    quantity: float
    pnl: float
    pnl_pct: float
    commission: float
    holding_period: int


@dataclass
class BacktestResult:
    """Results from a backtest run"""
    # Equity data
    equity_curve: pd.Series
    returns: pd.Series
    positions: pd.DataFrame

    # Performance metrics
    metrics: PerformanceMetrics

    # Trade data
    trades: List[Trade]
    trade_log: pd.DataFrame

    # Analysis
    drawdown_series: pd.Series
    monthly_returns: pd.Series

    # Config used
    config: BacktestConfig
    strategy_name: str


class BacktestEngine:
    """
    Vectorized Backtesting Engine

    Fast backtesting with realistic execution modeling including:
    - Transaction costs (commission + slippage)
    - Position sizing integration
    - Risk management
    - Multiple execution models
    """

    def __init__(self, config: BacktestConfig = None):
        self.config = config or BacktestConfig()
        self.risk_manager = RiskManager(
            limits=self.config.risk_limits,
            initial_capital=self.config.initial_capital
        )

    def run(self, strategy: BaseStrategy, data: pd.DataFrame,
           position_sizer: PositionSizer = None,
           benchmark: pd.Series = None) -> BacktestResult:
        """
        Run backtest for a strategy.

        Args:
            strategy: Strategy to backtest
            data: DataFrame with OHLCV data
            position_sizer: Optional position sizing strategy
            benchmark: Optional benchmark returns for comparison

        Returns:
            BacktestResult with all performance data
        """
        # Validate data
        strategy.validate_data(data)
        data = strategy.preprocess_data(data)

        # Initialize
        position_sizer = position_sizer or FixedFractionalSizer()
        strategy.on_start(data)

        # Generate signals
        signals = strategy.generate_signals(data)

        # Run vectorized backtest
        equity_curve, positions, trades = self._run_vectorized(
            data, signals, position_sizer
        )

        # Calculate returns
        returns = equity_curve.pct_change().fillna(0)

        # Calculate drawdown
        peak = equity_curve.cummax()
        drawdown = (equity_curve - peak) / peak

        # Monthly returns
        monthly = returns.resample('ME').apply(lambda x: (1 + x).prod() - 1)

        # Calculate metrics
        metrics = calculate_metrics(
            returns=returns,
            equity_curve=equity_curve,
            trades=trades,
            benchmark_returns=benchmark
        )

        # Create trade log
        trade_log = pd.DataFrame([{
            'symbol': t.symbol,
            'side': t.side,
            'entry_date': t.entry_date,
            'exit_date': t.exit_date,
            'entry_price': t.entry_price,
            'exit_price': t.exit_price,
            'quantity': t.quantity,
            'pnl': t.pnl,
            'pnl_pct': t.pnl_pct,
            'holding_period': t.holding_period
        } for t in trades])

        # Cleanup
        strategy.on_end(data, {'metrics': metrics})

        return BacktestResult(
            equity_curve=equity_curve,
            returns=returns,
            positions=positions,
            metrics=metrics,
            trades=trades,
            trade_log=trade_log,
            drawdown_series=drawdown,
            monthly_returns=monthly,
            config=self.config,
            strategy_name=strategy.name
        )

    def _run_vectorized(self, data: pd.DataFrame, signals: pd.Series,
                       position_sizer: PositionSizer) -> tuple:
        """
        Vectorized backtest execution.

        Much faster than event-driven for simple strategies.
        """
        n = len(data)
        close = data['close'].values

        # Track state
        equity = np.zeros(n)
        equity[0] = self.config.initial_capital
        positions_held = np.zeros(n)
        cash = self.config.initial_capital
        shares = 0.0
        entry_price = 0.0
        entry_idx = 0

        trades = []
        position_history = []

        # Signal values
        sig = signals.values

        for i in range(1, n):
            current_price = close[i]
            prev_signal = sig[i-1] if i > 0 else 0
            curr_signal = sig[i]

            # Apply slippage
            execution_price = current_price * (1 + self.config.slippage * np.sign(curr_signal - prev_signal))

            # Position change?
            if curr_signal != prev_signal:
                # Close existing position
                if shares != 0:
                    # Calculate P&L
                    if shares > 0:  # Long
                        pnl = (execution_price - entry_price) * shares
                    else:  # Short
                        pnl = (entry_price - execution_price) * abs(shares)

                    # Commission
                    commission = abs(shares) * execution_price * self.config.commission

                    # Update cash
                    cash += shares * execution_price - commission

                    # Record trade
                    trades.append(Trade(
                        symbol='ASSET',
                        side='long' if shares > 0 else 'short',
                        entry_date=data.index[entry_idx],
                        exit_date=data.index[i],
                        entry_price=entry_price,
                        exit_price=execution_price,
                        quantity=abs(shares),
                        pnl=pnl - commission,
                        pnl_pct=(execution_price / entry_price - 1) * np.sign(shares),
                        commission=commission,
                        holding_period=i - entry_idx
                    ))

                    shares = 0

                # Open new position
                if curr_signal != 0:
                    # Calculate position size
                    size = position_sizer.calculate_size(
                        capital=cash,
                        price=execution_price,
                        signal_strength=abs(curr_signal)
                    )

                    if curr_signal > 0:  # Long
                        shares = size.shares if self.config.fractional_shares else int(size.shares)
                    elif curr_signal < 0 and self.config.allow_shorting:  # Short
                        shares = -size.shares if self.config.fractional_shares else -int(size.shares)

                    if shares != 0:
                        # Commission
                        commission = abs(shares) * execution_price * self.config.commission
                        cash -= abs(shares) * execution_price + commission
                        entry_price = execution_price
                        entry_idx = i

            # Update equity
            if shares > 0:
                equity[i] = cash + shares * current_price
            elif shares < 0:
                equity[i] = cash + shares * current_price  # Short P&L
            else:
                equity[i] = cash

            positions_held[i] = shares

            position_history.append({
                'date': data.index[i],
                'shares': shares,
                'cash': cash,
                'equity': equity[i]
            })

        # Convert to series/dataframe
        equity_series = pd.Series(equity, index=data.index)
        positions_df = pd.DataFrame(position_history).set_index('date')

        return equity_series, positions_df, trades

    def run_walk_forward(self, strategy: BaseStrategy, data: pd.DataFrame,
                        train_period: int = 252, test_period: int = 63,
                        position_sizer: PositionSizer = None) -> List[BacktestResult]:
        """
        Walk-forward optimization/testing.

        Trains on train_period bars, tests on test_period bars,
        then rolls forward.
        """
        results = []
        n = len(data)

        i = train_period
        while i + test_period <= n:
            # Training data
            train_data = data.iloc[i-train_period:i]

            # Test data
            test_data = data.iloc[i:i+test_period]

            # Optional: Re-optimize strategy parameters on train_data
            # strategy.optimize(train_data)

            # Run backtest on test period
            result = self.run(strategy, test_data, position_sizer)
            results.append(result)

            i += test_period

        return results

    def run_monte_carlo(self, strategy: BaseStrategy, data: pd.DataFrame,
                       n_simulations: int = 1000,
                       position_sizer: PositionSizer = None) -> Dict:
        """
        Monte Carlo simulation of strategy returns.

        Shuffles trade sequence to estimate distribution of outcomes.
        """
        # First run normal backtest
        base_result = self.run(strategy, data, position_sizer)

        if len(base_result.trades) < 10:
            warnings.warn("Not enough trades for meaningful Monte Carlo simulation")
            return {'base_result': base_result, 'simulations': []}

        # Get trade returns
        trade_returns = [t.pnl_pct for t in base_result.trades]

        simulation_results = []
        for _ in range(n_simulations):
            # Shuffle trade order
            shuffled = np.random.permutation(trade_returns)

            # Calculate equity curve
            equity = [self.config.initial_capital]
            for ret in shuffled:
                equity.append(equity[-1] * (1 + ret))

            equity = np.array(equity)
            final_equity = equity[-1]

            # Calculate metrics
            max_dd = np.min(equity / np.maximum.accumulate(equity) - 1)
            total_return = (final_equity / self.config.initial_capital) - 1

            simulation_results.append({
                'final_equity': final_equity,
                'total_return': total_return,
                'max_drawdown': max_dd
            })

        sim_df = pd.DataFrame(simulation_results)

        return {
            'base_result': base_result,
            'simulations': sim_df,
            'percentiles': {
                '5th': sim_df['total_return'].quantile(0.05),
                '25th': sim_df['total_return'].quantile(0.25),
                '50th': sim_df['total_return'].quantile(0.50),
                '75th': sim_df['total_return'].quantile(0.75),
                '95th': sim_df['total_return'].quantile(0.95)
            },
            'probability_of_profit': (sim_df['total_return'] > 0).mean()
        }


class MultiAssetBacktester:
    """
    Backtest strategies across multiple assets.
    """

    def __init__(self, config: BacktestConfig = None):
        self.config = config or BacktestConfig()
        self.engine = BacktestEngine(config)

    def run(self, strategy: BaseStrategy, data_dict: Dict[str, pd.DataFrame],
           weights: Dict[str, float] = None) -> BacktestResult:
        """
        Run backtest across multiple assets.

        Args:
            strategy: Strategy to apply to each asset
            data_dict: Dict mapping symbol to OHLCV DataFrame
            weights: Optional dict of target weights per symbol
        """
        if weights is None:
            # Equal weight
            weights = {sym: 1.0 / len(data_dict) for sym in data_dict}

        # Normalize weights
        total_weight = sum(weights.values())
        weights = {k: v / total_weight for k, v in weights.items()}

        # Run backtest for each asset
        all_returns = {}
        all_trades = []

        for symbol, data in data_dict.items():
            # Allocate capital based on weight
            asset_capital = self.config.initial_capital * weights.get(symbol, 0)
            if asset_capital <= 0:
                continue

            # Create config for this asset
            asset_config = BacktestConfig(
                initial_capital=asset_capital,
                commission=self.config.commission,
                slippage=self.config.slippage
            )

            asset_engine = BacktestEngine(asset_config)
            result = asset_engine.run(strategy, data)

            all_returns[symbol] = result.returns
            for t in result.trades:
                t.symbol = symbol
                all_trades.append(t)

        # Combine returns
        returns_df = pd.DataFrame(all_returns)
        # Weight returns
        weighted_returns = (returns_df * pd.Series(weights)).sum(axis=1)

        # Calculate combined equity curve
        equity_curve = self.config.initial_capital * (1 + weighted_returns).cumprod()

        # Calculate metrics
        metrics = calculate_metrics(
            returns=weighted_returns,
            equity_curve=equity_curve,
            trades=all_trades
        )

        return BacktestResult(
            equity_curve=equity_curve,
            returns=weighted_returns,
            positions=returns_df,
            metrics=metrics,
            trades=all_trades,
            trade_log=pd.DataFrame(),
            drawdown_series=(equity_curve / equity_curve.cummax() - 1),
            monthly_returns=weighted_returns.resample('ME').apply(lambda x: (1 + x).prod() - 1),
            config=self.config,
            strategy_name=strategy.name
        )


# Quick usage example
if __name__ == "__main__":
    import yfinance as yf
    from strategies.momentum import MomentumStrategy

    # Download data
    data = yf.download("AAPL", start="2020-01-01", end="2024-01-01")
    data.columns = data.columns.str.lower()

    # Create strategy and backtest
    strategy = MomentumStrategy(fast_period=10, slow_period=30)
    config = BacktestConfig(initial_capital=100000, commission=0.001)
    engine = BacktestEngine(config)

    result = engine.run(strategy, data)

    print(f"\n{'='*50}")
    print(f"Strategy: {result.strategy_name}")
    print(f"{'='*50}")
    print(f"Total Return: {result.metrics.total_return:.2%}")
    print(f"Annual Return: {result.metrics.annual_return:.2%}")
    print(f"Sharpe Ratio: {result.metrics.sharpe_ratio:.2f}")
    print(f"Max Drawdown: {result.metrics.max_drawdown:.2%}")
    print(f"Win Rate: {result.metrics.win_rate:.2%}")
    print(f"Total Trades: {result.metrics.total_trades}")
