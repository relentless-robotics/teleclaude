"""
Alpaca Live Trading Integration
================================
Commission-free stock trading via Alpaca API.
Supports paper trading for testing.
"""

import os
import time
from typing import Dict, List, Optional, Callable
from datetime import datetime, timedelta
from dataclasses import dataclass
import logging

try:
    from alpaca.trading.client import TradingClient
    from alpaca.trading.requests import MarketOrderRequest, LimitOrderRequest, StopOrderRequest
    from alpaca.trading.enums import OrderSide, TimeInForce, OrderStatus
    from alpaca.data.historical import StockHistoricalDataClient
    from alpaca.data.requests import StockBarsRequest
    from alpaca.data.timeframe import TimeFrame
    ALPACA_AVAILABLE = True
except ImportError:
    ALPACA_AVAILABLE = False

import pandas as pd
import numpy as np

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class AlpacaConfig:
    """Alpaca configuration"""
    api_key: str
    api_secret: str
    paper: bool = True
    base_url: str = None

    def __post_init__(self):
        if self.base_url is None:
            self.base_url = (
                "https://paper-api.alpaca.markets" if self.paper
                else "https://api.alpaca.markets"
            )


class AlpacaTrader:
    """
    Alpaca Trading Client

    Features:
    - Market, limit, and stop orders
    - Position management
    - Real-time data streaming
    - Paper trading mode
    """

    def __init__(self, config: AlpacaConfig = None):
        """
        Initialize Alpaca trader.

        Args:
            config: AlpacaConfig object. If None, reads from environment.
        """
        if not ALPACA_AVAILABLE:
            raise ImportError(
                "alpaca-trade-api not installed. "
                "Install with: pip install alpaca-trade-api"
            )

        if config is None:
            config = AlpacaConfig(
                api_key=os.getenv('ALPACA_API_KEY', ''),
                api_secret=os.getenv('ALPACA_SECRET_KEY', ''),
                paper=os.getenv('ALPACA_PAPER', 'true').lower() == 'true'
            )

        self.config = config
        self.trading_client = TradingClient(
            api_key=config.api_key,
            secret_key=config.api_secret,
            paper=config.paper
        )
        self.data_client = StockHistoricalDataClient(
            api_key=config.api_key,
            secret_key=config.api_secret
        )

        # Callbacks
        self.on_fill: Optional[Callable] = None
        self.on_partial_fill: Optional[Callable] = None
        self.on_cancel: Optional[Callable] = None

        logger.info(f"Alpaca trader initialized (paper={config.paper})")

    def get_account(self) -> Dict:
        """Get account information"""
        account = self.trading_client.get_account()
        return {
            'equity': float(account.equity),
            'cash': float(account.cash),
            'buying_power': float(account.buying_power),
            'portfolio_value': float(account.portfolio_value),
            'pattern_day_trader': account.pattern_day_trader,
            'trading_blocked': account.trading_blocked,
            'account_blocked': account.account_blocked
        }

    def get_positions(self) -> Dict[str, Dict]:
        """Get all open positions"""
        positions = self.trading_client.get_all_positions()
        return {
            pos.symbol: {
                'qty': float(pos.qty),
                'avg_entry_price': float(pos.avg_entry_price),
                'market_value': float(pos.market_value),
                'unrealized_pl': float(pos.unrealized_pl),
                'unrealized_plpc': float(pos.unrealized_plpc),
                'side': pos.side.value
            }
            for pos in positions
        }

    def get_position(self, symbol: str) -> Optional[Dict]:
        """Get position for a specific symbol"""
        try:
            pos = self.trading_client.get_open_position(symbol)
            return {
                'qty': float(pos.qty),
                'avg_entry_price': float(pos.avg_entry_price),
                'market_value': float(pos.market_value),
                'unrealized_pl': float(pos.unrealized_pl),
                'side': pos.side.value
            }
        except Exception:
            return None

    def submit_market_order(self, symbol: str, qty: float, side: str,
                           time_in_force: str = 'day') -> str:
        """
        Submit a market order.

        Args:
            symbol: Stock symbol
            qty: Quantity (positive)
            side: 'buy' or 'sell'
            time_in_force: 'day', 'gtc', 'ioc', 'fok'

        Returns:
            Order ID
        """
        tif_map = {
            'day': TimeInForce.DAY,
            'gtc': TimeInForce.GTC,
            'ioc': TimeInForce.IOC,
            'fok': TimeInForce.FOK
        }

        order_data = MarketOrderRequest(
            symbol=symbol,
            qty=qty,
            side=OrderSide.BUY if side.lower() == 'buy' else OrderSide.SELL,
            time_in_force=tif_map.get(time_in_force, TimeInForce.DAY)
        )

        order = self.trading_client.submit_order(order_data)
        logger.info(f"Market order submitted: {side} {qty} {symbol} - ID: {order.id}")

        return str(order.id)

    def submit_limit_order(self, symbol: str, qty: float, side: str,
                          limit_price: float, time_in_force: str = 'day') -> str:
        """Submit a limit order"""
        tif_map = {
            'day': TimeInForce.DAY,
            'gtc': TimeInForce.GTC,
        }

        order_data = LimitOrderRequest(
            symbol=symbol,
            qty=qty,
            side=OrderSide.BUY if side.lower() == 'buy' else OrderSide.SELL,
            time_in_force=tif_map.get(time_in_force, TimeInForce.DAY),
            limit_price=limit_price
        )

        order = self.trading_client.submit_order(order_data)
        logger.info(f"Limit order submitted: {side} {qty} {symbol} @ {limit_price}")

        return str(order.id)

    def submit_stop_order(self, symbol: str, qty: float, side: str,
                         stop_price: float, time_in_force: str = 'day') -> str:
        """Submit a stop order"""
        order_data = StopOrderRequest(
            symbol=symbol,
            qty=qty,
            side=OrderSide.BUY if side.lower() == 'buy' else OrderSide.SELL,
            time_in_force=TimeInForce.GTC,
            stop_price=stop_price
        )

        order = self.trading_client.submit_order(order_data)
        logger.info(f"Stop order submitted: {side} {qty} {symbol} @ {stop_price}")

        return str(order.id)

    def cancel_order(self, order_id: str) -> bool:
        """Cancel an order"""
        try:
            self.trading_client.cancel_order_by_id(order_id)
            logger.info(f"Order cancelled: {order_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to cancel order {order_id}: {e}")
            return False

    def cancel_all_orders(self) -> int:
        """Cancel all open orders"""
        cancelled = self.trading_client.cancel_orders()
        logger.info(f"Cancelled {len(cancelled)} orders")
        return len(cancelled)

    def close_position(self, symbol: str) -> Optional[str]:
        """Close a position"""
        try:
            order = self.trading_client.close_position(symbol)
            logger.info(f"Position closed: {symbol}")
            return str(order.id)
        except Exception as e:
            logger.error(f"Failed to close position {symbol}: {e}")
            return None

    def close_all_positions(self) -> List[str]:
        """Close all positions"""
        orders = self.trading_client.close_all_positions()
        logger.info(f"Closed {len(orders)} positions")
        return [str(o.id) for o in orders]

    def get_order_status(self, order_id: str) -> Dict:
        """Get order status"""
        order = self.trading_client.get_order_by_id(order_id)
        return {
            'id': str(order.id),
            'symbol': order.symbol,
            'side': order.side.value,
            'qty': float(order.qty),
            'filled_qty': float(order.filled_qty) if order.filled_qty else 0,
            'status': order.status.value,
            'type': order.type.value,
            'created_at': order.created_at
        }

    def get_historical_data(self, symbol: str, start: datetime,
                           end: datetime = None, timeframe: str = '1Day') -> pd.DataFrame:
        """
        Get historical bar data.

        Args:
            symbol: Stock symbol
            start: Start datetime
            end: End datetime (default: now)
            timeframe: '1Min', '5Min', '15Min', '1Hour', '1Day'
        """
        tf_map = {
            '1Min': TimeFrame.Minute,
            '5Min': TimeFrame.Minute * 5,
            '15Min': TimeFrame.Minute * 15,
            '1Hour': TimeFrame.Hour,
            '1Day': TimeFrame.Day
        }

        request = StockBarsRequest(
            symbol_or_symbols=symbol,
            start=start,
            end=end or datetime.now(),
            timeframe=tf_map.get(timeframe, TimeFrame.Day)
        )

        bars = self.data_client.get_stock_bars(request)

        # Convert to DataFrame
        data = []
        for bar in bars[symbol]:
            data.append({
                'timestamp': bar.timestamp,
                'open': bar.open,
                'high': bar.high,
                'low': bar.low,
                'close': bar.close,
                'volume': bar.volume
            })

        df = pd.DataFrame(data)
        if not df.empty:
            df.set_index('timestamp', inplace=True)

        return df

    def is_market_open(self) -> bool:
        """Check if market is currently open"""
        clock = self.trading_client.get_clock()
        return clock.is_open

    def get_next_market_open(self) -> datetime:
        """Get next market open time"""
        clock = self.trading_client.get_clock()
        return clock.next_open

    def get_next_market_close(self) -> datetime:
        """Get next market close time"""
        clock = self.trading_client.get_clock()
        return clock.next_close


class AlpacaStrategyRunner:
    """
    Run a strategy live with Alpaca.
    """

    def __init__(self, trader: AlpacaTrader, strategy,
                 symbols: List[str], interval_seconds: int = 60):
        self.trader = trader
        self.strategy = strategy
        self.symbols = symbols
        self.interval = interval_seconds
        self.running = False

    def run(self):
        """Start the strategy runner"""
        self.running = True
        logger.info(f"Starting strategy runner for {self.symbols}")

        while self.running:
            try:
                # Check if market is open
                if not self.trader.is_market_open():
                    logger.info("Market closed. Waiting...")
                    time.sleep(60)
                    continue

                # Get account info
                account = self.trader.get_account()
                capital = account['equity']

                # Get current positions
                positions = self.trader.get_positions()

                # Process each symbol
                for symbol in self.symbols:
                    self._process_symbol(symbol, capital, positions)

                # Wait for next interval
                time.sleep(self.interval)

            except KeyboardInterrupt:
                logger.info("Stopping strategy runner...")
                self.running = False
            except Exception as e:
                logger.error(f"Error in strategy runner: {e}")
                time.sleep(10)

    def _process_symbol(self, symbol: str, capital: float,
                       positions: Dict[str, Dict]) -> None:
        """Process a single symbol"""
        # Get recent data
        end = datetime.now()
        start = end - timedelta(days=100)
        data = self.trader.get_historical_data(symbol, start, end)

        if data.empty:
            return

        # Generate signal
        signals = self.strategy.generate_signals(data)
        current_signal = signals.iloc[-1]

        # Current position
        current_pos = positions.get(symbol)
        has_position = current_pos is not None

        # Execute based on signal
        if current_signal > 0 and not has_position:
            # Buy signal, no position -> open long
            qty = int((capital * 0.1) / data['close'].iloc[-1])
            if qty > 0:
                self.trader.submit_market_order(symbol, qty, 'buy')
                logger.info(f"BUY signal: {symbol} qty={qty}")

        elif current_signal < 0 and has_position and current_pos['side'] == 'long':
            # Sell signal, have long position -> close
            self.trader.close_position(symbol)
            logger.info(f"SELL signal: closing {symbol}")

        elif current_signal == 0 and has_position:
            # Flat signal, have position -> close
            self.trader.close_position(symbol)
            logger.info(f"FLAT signal: closing {symbol}")

    def stop(self):
        """Stop the strategy runner"""
        self.running = False


# Example usage
if __name__ == "__main__":
    # This requires valid API keys
    print("Alpaca Trader Module")
    print("=" * 40)
    print("Set environment variables:")
    print("  ALPACA_API_KEY=your_key")
    print("  ALPACA_SECRET_KEY=your_secret")
    print("  ALPACA_PAPER=true")
    print()
    print("Then use:")
    print("  trader = AlpacaTrader()")
    print("  account = trader.get_account()")
    print("  trader.submit_market_order('AAPL', 10, 'buy')")
