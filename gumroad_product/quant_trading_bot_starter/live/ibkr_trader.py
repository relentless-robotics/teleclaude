"""
Interactive Brokers Trading Integration
========================================
Full-featured trading via IB TWS/Gateway.
Supports stocks, options, futures, and forex.
"""

import os
import time
from typing import Dict, List, Optional, Callable, Any
from datetime import datetime, timedelta
from dataclasses import dataclass
from threading import Thread
import logging

try:
    from ib_insync import IB, Stock, Option, Future, Forex, Order
    from ib_insync import MarketOrder, LimitOrder, StopOrder, TrailingStopOrder
    from ib_insync import util
    IBKR_AVAILABLE = True
except ImportError:
    IBKR_AVAILABLE = False

import pandas as pd
import numpy as np

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class IBKRConfig:
    """IBKR connection configuration"""
    host: str = "127.0.0.1"
    port: int = 7497  # 7497 for paper, 7496 for live
    client_id: int = 1
    timeout: int = 20
    readonly: bool = False


class IBKRTrader:
    """
    Interactive Brokers Trading Client

    Features:
    - Stocks, options, futures, forex
    - Multiple order types
    - Real-time streaming data
    - Position and account management
    """

    def __init__(self, config: IBKRConfig = None):
        """
        Initialize IBKR trader.

        Args:
            config: IBKRConfig object
        """
        if not IBKR_AVAILABLE:
            raise ImportError(
                "ib_insync not installed. "
                "Install with: pip install ib_insync"
            )

        self.config = config or IBKRConfig()
        self.ib = IB()
        self.connected = False

        # Callbacks
        self.on_fill: Optional[Callable] = None
        self.on_error: Optional[Callable] = None
        self.on_position_change: Optional[Callable] = None

    def connect(self) -> bool:
        """Connect to TWS/Gateway"""
        try:
            self.ib.connect(
                host=self.config.host,
                port=self.config.port,
                clientId=self.config.client_id,
                timeout=self.config.timeout,
                readonly=self.config.readonly
            )
            self.connected = True
            logger.info(f"Connected to IBKR at {self.config.host}:{self.config.port}")

            # Setup event handlers
            self.ib.execDetailsEvent += self._on_exec_details
            self.ib.errorEvent += self._on_error

            return True
        except Exception as e:
            logger.error(f"Failed to connect to IBKR: {e}")
            return False

    def disconnect(self) -> None:
        """Disconnect from TWS/Gateway"""
        if self.connected:
            self.ib.disconnect()
            self.connected = False
            logger.info("Disconnected from IBKR")

    def _on_exec_details(self, trade, fill):
        """Handle execution details"""
        logger.info(f"Fill: {fill.contract.symbol} {fill.execution.shares} @ {fill.execution.price}")
        if self.on_fill:
            self.on_fill(trade, fill)

    def _on_error(self, reqId, errorCode, errorString, contract):
        """Handle errors"""
        if errorCode not in [2104, 2106, 2158]:  # Ignore common info messages
            logger.error(f"IBKR Error {errorCode}: {errorString}")
            if self.on_error:
                self.on_error(reqId, errorCode, errorString, contract)

    def get_account_summary(self) -> Dict:
        """Get account summary"""
        account_values = self.ib.accountSummary()
        summary = {}
        for av in account_values:
            summary[av.tag] = {
                'value': av.value,
                'currency': av.currency
            }
        return summary

    def get_portfolio(self) -> List[Dict]:
        """Get current portfolio positions"""
        portfolio = self.ib.portfolio()
        return [{
            'symbol': item.contract.symbol,
            'sec_type': item.contract.secType,
            'position': item.position,
            'market_price': item.marketPrice,
            'market_value': item.marketValue,
            'avg_cost': item.averageCost,
            'unrealized_pnl': item.unrealizedPNL,
            'realized_pnl': item.realizedPNL
        } for item in portfolio]

    def get_positions(self) -> Dict[str, Dict]:
        """Get positions as dict keyed by symbol"""
        portfolio = self.get_portfolio()
        return {
            item['symbol']: item
            for item in portfolio
            if item['position'] != 0
        }

    def create_stock_contract(self, symbol: str, exchange: str = "SMART",
                             currency: str = "USD") -> Any:
        """Create a stock contract"""
        contract = Stock(symbol, exchange, currency)
        self.ib.qualifyContracts(contract)
        return contract

    def create_option_contract(self, symbol: str, expiry: str, strike: float,
                              right: str, exchange: str = "SMART") -> Any:
        """
        Create an option contract.

        Args:
            symbol: Underlying symbol
            expiry: Expiration date (YYYYMMDD)
            strike: Strike price
            right: 'C' for call, 'P' for put
        """
        contract = Option(symbol, expiry, strike, right, exchange)
        self.ib.qualifyContracts(contract)
        return contract

    def create_future_contract(self, symbol: str, expiry: str,
                              exchange: str) -> Any:
        """Create a futures contract"""
        contract = Future(symbol, expiry, exchange)
        self.ib.qualifyContracts(contract)
        return contract

    def get_market_data(self, contract) -> Dict:
        """Get current market data for a contract"""
        self.ib.reqMktData(contract)
        self.ib.sleep(2)  # Wait for data
        ticker = self.ib.ticker(contract)

        return {
            'bid': ticker.bid,
            'ask': ticker.ask,
            'last': ticker.last,
            'volume': ticker.volume,
            'high': ticker.high,
            'low': ticker.low,
            'close': ticker.close
        }

    def get_historical_data(self, contract, duration: str = "1 Y",
                           bar_size: str = "1 day",
                           what_to_show: str = "TRADES") -> pd.DataFrame:
        """
        Get historical bar data.

        Args:
            contract: Contract object
            duration: '1 D', '1 W', '1 M', '1 Y'
            bar_size: '1 min', '5 mins', '1 hour', '1 day'
            what_to_show: 'TRADES', 'MIDPOINT', 'BID', 'ASK'
        """
        bars = self.ib.reqHistoricalData(
            contract,
            endDateTime='',
            durationStr=duration,
            barSizeSetting=bar_size,
            whatToShow=what_to_show,
            useRTH=True
        )

        df = util.df(bars)
        if df is not None and not df.empty:
            df.set_index('date', inplace=True)
            df.columns = df.columns.str.lower()

        return df

    def submit_market_order(self, contract, quantity: int, action: str) -> Any:
        """
        Submit a market order.

        Args:
            contract: Contract object
            quantity: Number of shares/contracts
            action: 'BUY' or 'SELL'
        """
        order = MarketOrder(action.upper(), quantity)
        trade = self.ib.placeOrder(contract, order)
        logger.info(f"Market order: {action} {quantity} {contract.symbol}")
        return trade

    def submit_limit_order(self, contract, quantity: int, action: str,
                          limit_price: float) -> Any:
        """Submit a limit order"""
        order = LimitOrder(action.upper(), quantity, limit_price)
        trade = self.ib.placeOrder(contract, order)
        logger.info(f"Limit order: {action} {quantity} {contract.symbol} @ {limit_price}")
        return trade

    def submit_stop_order(self, contract, quantity: int, action: str,
                         stop_price: float) -> Any:
        """Submit a stop order"""
        order = StopOrder(action.upper(), quantity, stop_price)
        trade = self.ib.placeOrder(contract, order)
        logger.info(f"Stop order: {action} {quantity} {contract.symbol} @ {stop_price}")
        return trade

    def submit_trailing_stop(self, contract, quantity: int, action: str,
                            trailing_percent: float = None,
                            trailing_amount: float = None) -> Any:
        """Submit a trailing stop order"""
        order = TrailingStopOrder(
            action.upper(),
            quantity,
            trailingPercent=trailing_percent,
            trailStopPrice=trailing_amount
        )
        trade = self.ib.placeOrder(contract, order)
        logger.info(f"Trailing stop: {action} {quantity} {contract.symbol}")
        return trade

    def submit_bracket_order(self, contract, quantity: int, action: str,
                            entry_price: float, take_profit: float,
                            stop_loss: float) -> List:
        """
        Submit a bracket order (entry + take profit + stop loss).

        Returns list of trades: [parent, take_profit, stop_loss]
        """
        bracket = self.ib.bracketOrder(
            action.upper(),
            quantity,
            entry_price,
            take_profit,
            stop_loss
        )

        trades = []
        for order in bracket:
            trade = self.ib.placeOrder(contract, order)
            trades.append(trade)

        logger.info(f"Bracket order: {action} {quantity} {contract.symbol}")
        return trades

    def cancel_order(self, trade) -> None:
        """Cancel an order"""
        self.ib.cancelOrder(trade.order)
        logger.info(f"Order cancelled: {trade.order.orderId}")

    def cancel_all_orders(self) -> None:
        """Cancel all open orders"""
        for trade in self.ib.openTrades():
            self.cancel_order(trade)
        logger.info("All orders cancelled")

    def close_position(self, symbol: str) -> Optional[Any]:
        """Close position for a symbol"""
        positions = self.get_positions()
        if symbol not in positions:
            logger.warning(f"No position found for {symbol}")
            return None

        pos = positions[symbol]
        contract = self.create_stock_contract(symbol)

        action = 'SELL' if pos['position'] > 0 else 'BUY'
        quantity = abs(int(pos['position']))

        return self.submit_market_order(contract, quantity, action)

    def close_all_positions(self) -> List:
        """Close all positions"""
        trades = []
        for symbol in self.get_positions():
            trade = self.close_position(symbol)
            if trade:
                trades.append(trade)
        return trades

    def get_open_orders(self) -> List[Dict]:
        """Get all open orders"""
        trades = self.ib.openTrades()
        return [{
            'order_id': trade.order.orderId,
            'symbol': trade.contract.symbol,
            'action': trade.order.action,
            'quantity': trade.order.totalQuantity,
            'order_type': trade.order.orderType,
            'status': trade.orderStatus.status,
            'filled': trade.orderStatus.filled,
            'remaining': trade.orderStatus.remaining
        } for trade in trades]

    def wait_for_fill(self, trade, timeout: int = 60) -> bool:
        """Wait for an order to fill"""
        start = time.time()
        while time.time() - start < timeout:
            self.ib.sleep(1)
            if trade.isDone():
                return True
        return False

    def run_event_loop(self) -> None:
        """Run the IB event loop (blocking)"""
        self.ib.run()


class IBKRStrategyRunner:
    """
    Run a strategy live with IBKR.
    """

    def __init__(self, trader: IBKRTrader, strategy,
                 symbols: List[str], interval_seconds: int = 60):
        self.trader = trader
        self.strategy = strategy
        self.symbols = symbols
        self.interval = interval_seconds
        self.running = False
        self.contracts = {}

    def start(self):
        """Start the strategy runner in a thread"""
        self.running = True

        # Create contracts
        for symbol in self.symbols:
            self.contracts[symbol] = self.trader.create_stock_contract(symbol)

        # Start runner thread
        self.thread = Thread(target=self._run_loop)
        self.thread.start()
        logger.info(f"Started IBKR strategy runner for {self.symbols}")

    def _run_loop(self):
        """Main strategy loop"""
        while self.running:
            try:
                # Get account info
                summary = self.trader.get_account_summary()
                cash = float(summary.get('TotalCashValue', {}).get('value', 100000))

                # Get positions
                positions = self.trader.get_positions()

                # Process each symbol
                for symbol in self.symbols:
                    self._process_symbol(symbol, cash, positions)

                # Wait for next interval
                self.trader.ib.sleep(self.interval)

            except Exception as e:
                logger.error(f"Error in strategy loop: {e}")
                self.trader.ib.sleep(10)

    def _process_symbol(self, symbol: str, capital: float,
                       positions: Dict) -> None:
        """Process a single symbol"""
        contract = self.contracts[symbol]

        # Get historical data
        data = self.trader.get_historical_data(contract, "100 D", "1 day")
        if data is None or data.empty:
            return

        # Generate signal
        signals = self.strategy.generate_signals(data)
        current_signal = signals.iloc[-1]

        # Current position
        has_position = symbol in positions
        position_qty = positions[symbol]['position'] if has_position else 0

        # Execute based on signal
        price = self.trader.get_market_data(contract).get('last', data['close'].iloc[-1])

        if current_signal > 0 and position_qty <= 0:
            # Buy signal
            qty = int((capital * 0.1) / price)
            if qty > 0:
                # Close short if exists
                if position_qty < 0:
                    self.trader.submit_market_order(contract, abs(position_qty), 'BUY')
                # Open long
                self.trader.submit_market_order(contract, qty, 'BUY')
                logger.info(f"BUY: {symbol} qty={qty}")

        elif current_signal < 0 and position_qty >= 0:
            # Sell signal
            if position_qty > 0:
                self.trader.submit_market_order(contract, position_qty, 'SELL')
                logger.info(f"SELL: {symbol} qty={position_qty}")

    def stop(self):
        """Stop the strategy runner"""
        self.running = False
        if hasattr(self, 'thread'):
            self.thread.join(timeout=5)
        logger.info("IBKR strategy runner stopped")


# Example usage
if __name__ == "__main__":
    print("IBKR Trader Module")
    print("=" * 40)
    print("Requirements:")
    print("  1. TWS or IB Gateway running")
    print("  2. API connections enabled in TWS/Gateway")
    print("  3. Port 7497 (paper) or 7496 (live)")
    print()
    print("Usage:")
    print("  trader = IBKRTrader()")
    print("  trader.connect()")
    print("  contract = trader.create_stock_contract('AAPL')")
    print("  trader.submit_market_order(contract, 100, 'BUY')")
