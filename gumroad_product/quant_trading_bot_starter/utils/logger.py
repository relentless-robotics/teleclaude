"""
Trading Logger
==============
Specialized logging for trading operations.
"""

import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional


def setup_logger(name: str = "trading", level: str = "INFO",
                log_file: Optional[str] = None) -> logging.Logger:
    """
    Set up a trading logger.

    Args:
        name: Logger name
        level: Logging level (DEBUG, INFO, WARNING, ERROR)
        log_file: Optional file path for logging

    Returns:
        Configured logger
    """
    logger = logging.getLogger(name)
    logger.setLevel(getattr(logging, level.upper()))

    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.DEBUG)
    console_format = logging.Formatter(
        '%(asctime)s | %(levelname)-8s | %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    console_handler.setFormatter(console_format)
    logger.addHandler(console_handler)

    # File handler
    if log_file:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(logging.DEBUG)
        file_format = logging.Formatter(
            '%(asctime)s | %(levelname)-8s | %(name)s | %(message)s'
        )
        file_handler.setFormatter(file_format)
        logger.addHandler(file_handler)

    return logger


class TradingLogger:
    """
    Trading-specific logger with trade logging capabilities.
    """

    def __init__(self, name: str = "trading", log_dir: str = "./logs"):
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)

        self.logger = setup_logger(
            name=name,
            log_file=str(self.log_dir / f"{name}_{datetime.now():%Y%m%d}.log")
        )

        # Trade log file
        self.trade_log_path = self.log_dir / f"trades_{datetime.now():%Y%m%d}.csv"
        self._init_trade_log()

    def _init_trade_log(self):
        """Initialize trade log CSV"""
        if not self.trade_log_path.exists():
            with open(self.trade_log_path, 'w') as f:
                f.write("timestamp,symbol,side,quantity,price,order_type,status\n")

    def info(self, message: str):
        self.logger.info(message)

    def warning(self, message: str):
        self.logger.warning(message)

    def error(self, message: str):
        self.logger.error(message)

    def debug(self, message: str):
        self.logger.debug(message)

    def log_trade(self, symbol: str, side: str, quantity: float,
                 price: float, order_type: str = "market",
                 status: str = "filled"):
        """Log a trade to both logger and CSV"""
        timestamp = datetime.now().isoformat()

        # Log message
        self.logger.info(f"TRADE: {side.upper()} {quantity} {symbol} @ ${price:.2f}")

        # Append to CSV
        with open(self.trade_log_path, 'a') as f:
            f.write(f"{timestamp},{symbol},{side},{quantity},{price},{order_type},{status}\n")

    def log_signal(self, symbol: str, signal: int, price: float):
        """Log a trading signal"""
        signal_str = "LONG" if signal > 0 else "SHORT" if signal < 0 else "FLAT"
        self.logger.info(f"SIGNAL: {symbol} -> {signal_str} @ ${price:.2f}")

    def log_portfolio(self, positions: dict, equity: float):
        """Log portfolio state"""
        self.logger.info(f"PORTFOLIO: Equity=${equity:,.2f}, Positions={len(positions)}")
        for symbol, pos in positions.items():
            self.logger.debug(f"  {symbol}: {pos}")


# Quick test
if __name__ == "__main__":
    logger = TradingLogger(name="test")
    logger.info("Trading system started")
    logger.log_signal("AAPL", 1, 150.50)
    logger.log_trade("AAPL", "buy", 100, 150.50)
    logger.log_portfolio({"AAPL": 100}, 100000)
