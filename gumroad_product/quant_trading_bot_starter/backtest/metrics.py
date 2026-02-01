"""
Performance Metrics Module
==========================
Comprehensive trading performance metrics and analysis.
"""

import pandas as pd
import numpy as np
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
from scipy import stats


@dataclass
class PerformanceMetrics:
    """Container for all performance metrics"""
    # Returns
    total_return: float
    annual_return: float
    monthly_return: float

    # Risk-Adjusted
    sharpe_ratio: float
    sortino_ratio: float
    calmar_ratio: float
    information_ratio: float

    # Drawdowns
    max_drawdown: float
    avg_drawdown: float
    max_drawdown_duration: int  # in days
    recovery_factor: float

    # Win/Loss
    win_rate: float
    profit_factor: float
    avg_win: float
    avg_loss: float
    largest_win: float
    largest_loss: float
    avg_trade: float

    # Trade Statistics
    total_trades: int
    winning_trades: int
    losing_trades: int
    avg_holding_period: float

    # Statistical
    t_stat: float
    p_value: float
    skewness: float
    kurtosis: float

    # Vs Benchmark
    alpha: float
    beta: float
    correlation: float
    tracking_error: float

    # Additional
    volatility: float
    downside_deviation: float


def calculate_metrics(returns: pd.Series, equity_curve: pd.Series,
                     trades: List = None, benchmark_returns: pd.Series = None,
                     risk_free_rate: float = 0.02) -> PerformanceMetrics:
    """
    Calculate comprehensive performance metrics.

    Args:
        returns: Daily returns series
        equity_curve: Equity curve series
        trades: List of Trade objects
        benchmark_returns: Optional benchmark returns for comparison
        risk_free_rate: Annual risk-free rate

    Returns:
        PerformanceMetrics dataclass
    """
    # Clean returns
    returns = returns.dropna()
    n_days = len(returns)

    if n_days < 2:
        return _empty_metrics()

    # ===== RETURN METRICS =====
    total_return = (equity_curve.iloc[-1] / equity_curve.iloc[0]) - 1
    annual_return = (1 + total_return) ** (252 / n_days) - 1
    monthly_return = (1 + total_return) ** (21 / n_days) - 1

    # ===== VOLATILITY =====
    daily_vol = returns.std()
    volatility = daily_vol * np.sqrt(252)

    # Downside deviation (for Sortino)
    negative_returns = returns[returns < 0]
    downside_deviation = negative_returns.std() * np.sqrt(252) if len(negative_returns) > 0 else 0.001

    # ===== RISK-ADJUSTED METRICS =====
    # Sharpe Ratio
    excess_return = annual_return - risk_free_rate
    sharpe_ratio = excess_return / volatility if volatility > 0 else 0

    # Sortino Ratio
    sortino_ratio = excess_return / downside_deviation if downside_deviation > 0 else 0

    # ===== DRAWDOWN METRICS =====
    peak = equity_curve.cummax()
    drawdown = (equity_curve - peak) / peak

    max_drawdown = drawdown.min()
    avg_drawdown = drawdown[drawdown < 0].mean() if (drawdown < 0).any() else 0

    # Max drawdown duration
    is_underwater = drawdown < 0
    max_dd_duration = _max_consecutive_true(is_underwater)

    # Calmar Ratio
    calmar_ratio = annual_return / abs(max_drawdown) if max_drawdown != 0 else 0

    # Recovery Factor
    recovery_factor = total_return / abs(max_drawdown) if max_drawdown != 0 else 0

    # ===== TRADE METRICS =====
    if trades and len(trades) > 0:
        pnls = [t.pnl for t in trades]
        pnl_pcts = [t.pnl_pct for t in trades]

        wins = [p for p in pnls if p > 0]
        losses = [p for p in pnls if p < 0]

        total_trades = len(trades)
        winning_trades = len(wins)
        losing_trades = len(losses)

        win_rate = winning_trades / total_trades if total_trades > 0 else 0

        avg_win = np.mean(wins) if wins else 0
        avg_loss = np.mean(losses) if losses else 0

        largest_win = max(pnls) if pnls else 0
        largest_loss = min(pnls) if pnls else 0

        avg_trade = np.mean(pnls)

        # Profit Factor
        gross_profit = sum(wins) if wins else 0
        gross_loss = abs(sum(losses)) if losses else 0.001
        profit_factor = gross_profit / gross_loss if gross_loss > 0 else 0

        # Average holding period
        holding_periods = [t.holding_period for t in trades]
        avg_holding_period = np.mean(holding_periods) if holding_periods else 0

    else:
        total_trades = 0
        winning_trades = 0
        losing_trades = 0
        win_rate = 0
        profit_factor = 0
        avg_win = 0
        avg_loss = 0
        largest_win = 0
        largest_loss = 0
        avg_trade = 0
        avg_holding_period = 0

    # ===== STATISTICAL METRICS =====
    # T-stat and p-value for mean return
    if len(returns) > 2:
        t_stat, p_value = stats.ttest_1samp(returns, 0)
    else:
        t_stat, p_value = 0, 1

    skewness = returns.skew()
    kurtosis = returns.kurtosis()

    # ===== BENCHMARK COMPARISON =====
    if benchmark_returns is not None and len(benchmark_returns) > 0:
        # Align indices
        aligned = pd.concat([returns, benchmark_returns], axis=1, join='inner')
        if len(aligned) > 10:
            strat_ret = aligned.iloc[:, 0]
            bench_ret = aligned.iloc[:, 1]

            # Beta and Alpha
            covariance = strat_ret.cov(bench_ret)
            bench_var = bench_ret.var()
            beta = covariance / bench_var if bench_var > 0 else 1

            alpha = (strat_ret.mean() - beta * bench_ret.mean()) * 252

            # Correlation
            correlation = strat_ret.corr(bench_ret)

            # Information Ratio
            excess = strat_ret - bench_ret
            tracking_error = excess.std() * np.sqrt(252)
            information_ratio = (excess.mean() * 252) / tracking_error if tracking_error > 0 else 0
        else:
            alpha, beta, correlation = 0, 1, 0
            information_ratio, tracking_error = 0, 0
    else:
        alpha, beta, correlation = 0, 1, 0
        information_ratio, tracking_error = 0, 0

    return PerformanceMetrics(
        # Returns
        total_return=total_return,
        annual_return=annual_return,
        monthly_return=monthly_return,

        # Risk-Adjusted
        sharpe_ratio=sharpe_ratio,
        sortino_ratio=sortino_ratio,
        calmar_ratio=calmar_ratio,
        information_ratio=information_ratio,

        # Drawdowns
        max_drawdown=max_drawdown,
        avg_drawdown=avg_drawdown,
        max_drawdown_duration=max_dd_duration,
        recovery_factor=recovery_factor,

        # Win/Loss
        win_rate=win_rate,
        profit_factor=profit_factor,
        avg_win=avg_win,
        avg_loss=avg_loss,
        largest_win=largest_win,
        largest_loss=largest_loss,
        avg_trade=avg_trade,

        # Trade Statistics
        total_trades=total_trades,
        winning_trades=winning_trades,
        losing_trades=losing_trades,
        avg_holding_period=avg_holding_period,

        # Statistical
        t_stat=t_stat,
        p_value=p_value,
        skewness=skewness,
        kurtosis=kurtosis,

        # Vs Benchmark
        alpha=alpha,
        beta=beta,
        correlation=correlation,
        tracking_error=tracking_error,

        # Additional
        volatility=volatility,
        downside_deviation=downside_deviation
    )


def _max_consecutive_true(series: pd.Series) -> int:
    """Calculate maximum consecutive True values in a boolean series"""
    if not series.any():
        return 0

    # Convert to numpy for speed
    arr = series.values

    # Find runs of True
    runs = []
    count = 0
    for val in arr:
        if val:
            count += 1
        else:
            if count > 0:
                runs.append(count)
            count = 0
    if count > 0:
        runs.append(count)

    return max(runs) if runs else 0


def _empty_metrics() -> PerformanceMetrics:
    """Return empty metrics when data is insufficient"""
    return PerformanceMetrics(
        total_return=0, annual_return=0, monthly_return=0,
        sharpe_ratio=0, sortino_ratio=0, calmar_ratio=0, information_ratio=0,
        max_drawdown=0, avg_drawdown=0, max_drawdown_duration=0, recovery_factor=0,
        win_rate=0, profit_factor=0, avg_win=0, avg_loss=0,
        largest_win=0, largest_loss=0, avg_trade=0,
        total_trades=0, winning_trades=0, losing_trades=0, avg_holding_period=0,
        t_stat=0, p_value=1, skewness=0, kurtosis=0,
        alpha=0, beta=1, correlation=0, tracking_error=0,
        volatility=0, downside_deviation=0
    )


def rolling_metrics(returns: pd.Series, window: int = 252) -> pd.DataFrame:
    """
    Calculate rolling performance metrics.

    Useful for analyzing strategy consistency over time.
    """
    rolling_sharpe = (
        returns.rolling(window).mean() /
        returns.rolling(window).std() *
        np.sqrt(252)
    )

    rolling_vol = returns.rolling(window).std() * np.sqrt(252)

    # Rolling drawdown
    equity = (1 + returns).cumprod()
    rolling_max = equity.rolling(window, min_periods=1).max()
    rolling_dd = (equity - rolling_max) / rolling_max

    return pd.DataFrame({
        'rolling_sharpe': rolling_sharpe,
        'rolling_volatility': rolling_vol,
        'rolling_drawdown': rolling_dd,
        'rolling_return': returns.rolling(window).mean() * 252
    })


def monthly_returns_table(returns: pd.Series) -> pd.DataFrame:
    """
    Create monthly returns table (year x month format).
    """
    monthly = returns.resample('ME').apply(lambda x: (1 + x).prod() - 1)

    # Create year/month structure
    monthly_df = monthly.to_frame('return')
    monthly_df['year'] = monthly_df.index.year
    monthly_df['month'] = monthly_df.index.month

    # Pivot
    table = monthly_df.pivot(index='year', columns='month', values='return')
    table.columns = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

    # Add annual return
    annual = returns.resample('YE').apply(lambda x: (1 + x).prod() - 1)
    table['Annual'] = annual.values

    return table


def print_performance_report(metrics: PerformanceMetrics, name: str = "Strategy") -> None:
    """Print a formatted performance report"""
    print(f"\n{'='*60}")
    print(f" {name} Performance Report")
    print(f"{'='*60}")

    print(f"\n--- Returns ---")
    print(f"  Total Return:     {metrics.total_return:>10.2%}")
    print(f"  Annual Return:    {metrics.annual_return:>10.2%}")
    print(f"  Monthly Return:   {metrics.monthly_return:>10.2%}")

    print(f"\n--- Risk-Adjusted ---")
    print(f"  Sharpe Ratio:     {metrics.sharpe_ratio:>10.2f}")
    print(f"  Sortino Ratio:    {metrics.sortino_ratio:>10.2f}")
    print(f"  Calmar Ratio:     {metrics.calmar_ratio:>10.2f}")

    print(f"\n--- Risk ---")
    print(f"  Volatility:       {metrics.volatility:>10.2%}")
    print(f"  Max Drawdown:     {metrics.max_drawdown:>10.2%}")
    print(f"  Max DD Duration:  {metrics.max_drawdown_duration:>10} days")

    print(f"\n--- Trading ---")
    print(f"  Total Trades:     {metrics.total_trades:>10}")
    print(f"  Win Rate:         {metrics.win_rate:>10.2%}")
    print(f"  Profit Factor:    {metrics.profit_factor:>10.2f}")
    print(f"  Avg Holding:      {metrics.avg_holding_period:>10.1f} days")

    print(f"\n--- Statistical ---")
    print(f"  T-Statistic:      {metrics.t_stat:>10.2f}")
    print(f"  P-Value:          {metrics.p_value:>10.4f}")
    print(f"  Skewness:         {metrics.skewness:>10.2f}")
    print(f"  Kurtosis:         {metrics.kurtosis:>10.2f}")

    if metrics.alpha != 0 or metrics.beta != 1:
        print(f"\n--- Vs Benchmark ---")
        print(f"  Alpha:            {metrics.alpha:>10.2%}")
        print(f"  Beta:             {metrics.beta:>10.2f}")
        print(f"  Correlation:      {metrics.correlation:>10.2f}")
        print(f"  Info Ratio:       {metrics.information_ratio:>10.2f}")

    print(f"\n{'='*60}\n")


# Quick test
if __name__ == "__main__":
    # Generate sample returns
    np.random.seed(42)
    dates = pd.date_range('2020-01-01', '2024-01-01', freq='B')
    returns = pd.Series(np.random.randn(len(dates)) * 0.01 + 0.0003, index=dates)
    equity = 100000 * (1 + returns).cumprod()

    # Calculate metrics
    metrics = calculate_metrics(returns, equity)
    print_performance_report(metrics, "Sample Strategy")

    # Monthly returns table
    print("\nMonthly Returns Table:")
    table = monthly_returns_table(returns)
    print(table.to_string())
