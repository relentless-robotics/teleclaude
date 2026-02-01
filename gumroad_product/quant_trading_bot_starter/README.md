# Python Quant Trading Bot Starter Kit

A professional, production-ready algorithmic trading framework for Python developers. Build, backtest, and deploy trading strategies with confidence.

## What's Included

```
quant_trading_bot_starter/
├── strategies/
│   ├── base_strategy.py      # Abstract base class for all strategies
│   ├── momentum.py           # Momentum/trend following strategy
│   ├── mean_reversion.py     # Mean reversion with Bollinger Bands
│   └── ml_strategy.py        # Machine learning-based predictions
├── risk/
│   ├── position_sizer.py     # Kelly criterion, fixed fractional, volatility targeting
│   └── risk_manager.py       # Stop losses, drawdown limits, exposure controls
├── backtest/
│   ├── engine.py             # High-performance backtesting engine
│   └── metrics.py            # Sharpe, Sortino, max drawdown, win rate
├── data/
│   ├── fetcher.py            # Yahoo Finance, Alpha Vantage, custom sources
│   └── preprocessing.py      # OHLCV cleaning, feature engineering
├── live/
│   ├── alpaca_trader.py      # Alpaca API integration (commission-free)
│   └── ibkr_trader.py        # Interactive Brokers TWS connector
├── utils/
│   ├── logger.py             # Trading-specific logging
│   └── config.py             # Configuration management
├── examples/
│   ├── simple_momentum.py    # Quick start example
│   ├── pairs_trading.py      # Statistical arbitrage example
│   └── portfolio_rebalance.py # Multi-asset allocation
├── requirements.txt
└── config.yaml               # Your settings
```

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Run backtest
python -m examples.simple_momentum

# Paper trade with Alpaca
python -m live.alpaca_trader --paper
```

## Features

### Professional Strategy Framework
- Abstract base class ensures consistent strategy implementation
- Built-in event handling (on_bar, on_fill, on_start, on_end)
- Easy parameter optimization with grid search

### Risk Management
- Position sizing: Kelly Criterion, Fixed Fractional, Volatility Targeting
- Stop losses: Fixed, Trailing, ATR-based
- Portfolio-level: Max drawdown limits, correlation controls, exposure caps

### Backtesting Engine
- Vectorized operations for speed (1M+ bars/second)
- Realistic fills with slippage modeling
- Transaction cost modeling
- Walk-forward optimization support

### Live Trading Ready
- Alpaca integration (stocks, commission-free)
- IBKR template (stocks, options, futures)
- Paper trading mode for testing
- Webhook support for alerts

## Example Strategy

```python
from strategies.base_strategy import BaseStrategy
import pandas as pd

class MyStrategy(BaseStrategy):
    def __init__(self, fast_period=10, slow_period=30):
        super().__init__()
        self.fast_period = fast_period
        self.slow_period = slow_period

    def generate_signals(self, data: pd.DataFrame) -> pd.Series:
        fast_ma = data['close'].rolling(self.fast_period).mean()
        slow_ma = data['close'].rolling(self.slow_period).mean()

        signals = pd.Series(0, index=data.index)
        signals[fast_ma > slow_ma] = 1   # Long
        signals[fast_ma < slow_ma] = -1  # Short

        return signals
```

## Configuration

Edit `config.yaml`:

```yaml
data:
  source: "yahoo"  # yahoo, alphavantage, csv
  symbols: ["AAPL", "MSFT", "GOOGL"]
  start_date: "2020-01-01"
  end_date: "2024-01-01"

backtest:
  initial_capital: 100000
  commission: 0.001  # 0.1%
  slippage: 0.0005   # 0.05%

risk:
  max_position_size: 0.1      # 10% per position
  max_drawdown: 0.15          # 15% max drawdown
  stop_loss: 0.02             # 2% stop loss

live:
  broker: "alpaca"
  paper: true
  api_key: "YOUR_KEY"
  api_secret: "YOUR_SECRET"
```

## Performance Metrics

The backtest engine calculates:
- **Returns**: Total, Annual, Monthly
- **Risk-Adjusted**: Sharpe Ratio, Sortino Ratio, Calmar Ratio
- **Drawdowns**: Max Drawdown, Average Drawdown, Recovery Time
- **Win/Loss**: Win Rate, Profit Factor, Average Win/Loss
- **Statistical**: T-Stat, P-Value, Information Ratio

## Support

Questions? Email: relentlessrobotics@gmail.com

## License

Personal/Commercial use permitted. No redistribution.

---

Built with years of quantitative trading experience. Start building profitable strategies today.
