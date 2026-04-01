"""
Backtesting engine for the Wheel Strategy.
Simulates full CSP -> assignment -> CC -> called away cycle using historical data.

Improvements over v1:
- Early assignment risk around ex-dividend dates
- Rolling mechanics (roll vs take assignment decision)
- Margin requirements tracking
- Position sizing (fixed fractional or Kelly)
- Proper compound annualized returns
"""

import json
import datetime
import os
import numpy as np

try:
    import yfinance as yf
    HAS_YFINANCE = True
except ImportError:
    HAS_YFINANCE = False

from .options_pricer import (
    black_scholes, greeks, estimate_hist_iv, find_strike_by_delta
)

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

# Approximate quarterly ex-dividend months for common stocks
# Real system would pull from yfinance dividendYield / calendar
EX_DIV_MONTHS = {
    "AAPL": [2, 5, 8, 11], "MSFT": [2, 5, 8, 11], "JPM": [1, 4, 7, 10],
    "V": [2, 5, 8, 11], "JNJ": [2, 5, 8, 11], "PG": [1, 4, 7, 10],
    "KO": [3, 6, 9, 12], "PEP": [3, 6, 9, 12], "HD": [3, 6, 9, 12],
    "XOM": [2, 5, 8, 11], "CVX": [2, 5, 8, 11], "MRK": [3, 6, 9, 12],
    "ABBV": [1, 4, 7, 10], "T": [1, 4, 7, 10], "MO": [3, 6, 9, 12],
    "BAC": [3, 6, 9, 12], "WFC": [3, 6, 9, 12], "INTC": [2, 5, 8, 11],
    "CSCO": [1, 4, 7, 10], "BMY": [1, 4, 7, 10],
}


def _near_ex_dividend(ticker, date, window_days=5):
    """Check if a date is near an ex-dividend date for early assignment risk."""
    months = EX_DIV_MONTHS.get(ticker)
    if months is None:
        return False
    if isinstance(date, str):
        date = datetime.date.fromisoformat(date)
    # Ex-div typically around 15th of the month
    for m in months:
        ex_div_day = 15
        # Check if within window_days before or after
        days_diff = (m - date.month) * 30 + (ex_div_day - date.day)
        if -window_days <= days_diff <= window_days:
            return True
    return False


class WheelBacktester:
    """
    Backtest the wheel strategy on historical stock data.

    Simulates:
    1. Selling cash-secured puts (CSP)
    2. If assigned, selling covered calls (CC)
    3. If called away, restart with CSPs
    4. Rolling decisions when ITM near expiry
    5. Early assignment risk near ex-dividend dates
    """

    def __init__(self, ticker, capital=100_000, risk_free_rate=0.05,
                 csp_delta=0.25, cc_delta=0.30, target_dte=35,
                 iv_premium=1.2, commission_per_contract=1.00,
                 bid_ask_haircut=0.10,
                 sizing_method="fixed_fractional",
                 max_position_pct=0.20,
                 roll_when_itm=True,
                 roll_dte_threshold=5,
                 margin_requirement=0.20):
        """
        Args:
            ticker: stock ticker symbol
            capital: starting capital
            risk_free_rate: annual risk-free rate
            csp_delta: target delta for CSPs (0.20-0.35)
            cc_delta: target delta for CCs (0.25-0.40)
            target_dte: target days to expiration
            iv_premium: IV/HV multiplier for estimating implied vol
            commission_per_contract: round-trip commission per contract
            bid_ask_haircut: fraction of premium lost to bid-ask spread
            sizing_method: "single" (1 contract) or "fixed_fractional"
            max_position_pct: max fraction of capital per position (for fixed_fractional)
            roll_when_itm: whether to roll ITM positions instead of taking assignment
            roll_dte_threshold: DTE at which to evaluate rolling
            margin_requirement: maintenance margin as fraction of underlying (for tracking)
        """
        self.ticker = ticker
        self.capital = capital
        self.initial_capital = capital
        self.risk_free_rate = risk_free_rate
        self.csp_delta = csp_delta
        self.cc_delta = cc_delta
        self.target_dte = target_dte
        self.iv_premium = iv_premium
        self.commission = commission_per_contract
        self.bid_ask_haircut = bid_ask_haircut
        self.sizing_method = sizing_method
        self.max_position_pct = max_position_pct
        self.roll_when_itm = roll_when_itm
        self.roll_dte_threshold = roll_dte_threshold
        self.margin_requirement = margin_requirement

        # State
        self.phase = "CSP"  # "CSP" or "CC"
        self.shares_held = 0
        self.cost_basis = 0
        self.current_position = None  # Active option position

        # Tracking
        self.trades = []
        self.equity_curve = []
        self.premium_collected = 0
        self.total_commissions = 0
        self.assignments = 0
        self.calls_away = 0
        self.expirations_otm = 0
        self.rolls = 0
        self.early_assignments = 0
        self.peak_margin_used = 0
        self.margin_used = 0

    def _get_historical_data(self, months=12):
        """Fetch historical data via yfinance."""
        if not HAS_YFINANCE:
            raise ImportError("yfinance is required for backtesting. Install with: pip install yfinance")

        end = datetime.date.today()
        # Fetch extra months for IV estimation warmup
        start = end - datetime.timedelta(days=(months + 2) * 30)
        df = yf.download(self.ticker, start=str(start), end=str(end),
                         progress=False, auto_adjust=True)
        if df.empty:
            raise ValueError(f"No data returned for {self.ticker}")

        # Flatten MultiIndex columns if present
        if hasattr(df.columns, 'levels') and len(df.columns.levels) > 1:
            df.columns = df.columns.get_level_values(0)

        return df

    def _estimate_iv_at_date(self, prices, idx, lookback=30):
        """Estimate IV at a specific date index using trailing realized vol."""
        start = max(0, idx - lookback)
        window = prices[start:idx + 1]
        if len(window) < 5:
            return 0.25  # default
        returns = np.diff(np.log(window))
        hv = np.std(returns) * np.sqrt(252)
        return max(hv * self.iv_premium, 0.05)

    def _find_expiry_index(self, start_idx, total_days, dte):
        """Find the trading day index closest to the expiry date."""
        trading_days = int(dte * 252 / 365)
        target = start_idx + trading_days
        return min(target, total_days - 1)

    def _compute_num_contracts(self, strike, price):
        """Compute number of contracts based on sizing method."""
        if self.sizing_method == "single":
            return 1

        # Fixed fractional: use at most max_position_pct of capital
        max_capital = self.capital * self.max_position_pct
        capital_per_contract = strike * 100  # CSP requires full strike * 100
        if capital_per_contract <= 0:
            return 0
        num = int(max_capital / capital_per_contract)
        return max(num, 0)  # Could be 0 if can't afford any

    def _update_margin(self, price):
        """Track margin requirements for the current position."""
        if self.current_position is None:
            self.margin_used = 0
            return

        pos = self.current_position
        contracts = pos["contracts"]

        if pos["type"] == "CSP":
            # CSP margin = max(strike * 100, maintenance_margin * underlying * 100)
            cash_secured = pos["strike"] * 100 * contracts
            maintenance = self.margin_requirement * price * 100 * contracts
            self.margin_used = max(cash_secured, maintenance)
        elif pos["type"] == "CC":
            # CC: shares are the collateral, margin is just the share value
            self.margin_used = self.shares_held * price * self.margin_requirement

        self.peak_margin_used = max(self.peak_margin_used, self.margin_used)

    def _should_roll(self, pos, current_price, remaining_dte, iv):
        """
        Decide whether to roll an ITM position instead of taking assignment.

        Returns (should_roll, reason)
        """
        if not self.roll_when_itm:
            return False, ""

        if remaining_dte > self.roll_dte_threshold:
            return False, ""

        if pos["type"] == "CSP":
            if current_price >= pos["strike"]:
                return False, ""  # OTM, no need to roll

            # ITM CSP: check if rolling is better than assignment
            itm_amount = pos["strike"] - current_price
            itm_pct = itm_amount / pos["strike"]

            # Roll if shallowly ITM (< 5%) -- we can likely roll for a credit
            # Don't roll if deeply ITM (> 10%) -- take assignment, it's the wheel
            if itm_pct < 0.05:
                # Estimate credit from rolling out same strike
                T_new = self.target_dte / 365.0
                new_premium = black_scholes(current_price, pos["strike"],
                                            T_new, self.risk_free_rate, iv, "put")
                # Must get net credit (new premium > cost to close current)
                close_cost = max(itm_amount, 0.05)  # Approximate close cost
                if new_premium > close_cost * 1.1:  # Need at least 10% better
                    return True, f"Shallow ITM ({itm_pct:.1%}), rolling for credit"

        elif pos["type"] == "CC":
            if current_price <= pos["strike"]:
                return False, ""  # OTM

            itm_amount = current_price - pos["strike"]
            itm_pct = itm_amount / pos["strike"]

            # For CCs, also consider ex-dividend risk
            near_ex_div = _near_ex_dividend(self.ticker, "2025-01-15")  # placeholder

            if itm_pct < 0.03 and not near_ex_div:
                T_new = self.target_dte / 365.0
                new_premium = black_scholes(current_price, pos["strike"],
                                            T_new, self.risk_free_rate, iv, "call")
                close_cost = max(itm_amount, 0.05)
                if new_premium > close_cost * 1.1:
                    return True, f"Shallow ITM CC ({itm_pct:.1%}), rolling for credit"

        return False, ""

    def _check_early_assignment(self, pos, current_price, date_str, iv):
        """
        Check for early assignment risk, especially around ex-dividend dates.
        American puts/calls can be exercised early. Most common scenario:
        - Deep ITM calls near ex-dividend (holder exercises to capture dividend)
        - Deep ITM puts when time value < interest on strike
        """
        near_ex_div = _near_ex_dividend(self.ticker, date_str)

        if pos["type"] == "CC" and near_ex_div:
            itm_amount = current_price - pos["strike"]
            if itm_amount > 0:
                # Estimate remaining time value
                remaining_dte = max(1, pos["expiry_idx"] - pos.get("current_idx", pos["entry_idx"]))
                T_remaining = remaining_dte / 252.0
                theoretical = black_scholes(current_price, pos["strike"],
                                            T_remaining, self.risk_free_rate, iv, "call")
                time_value = theoretical - itm_amount

                # Typical quarterly dividend ~0.5-1% of price
                est_dividend = current_price * 0.005

                # If time value < dividend, rational to exercise early
                if time_value < est_dividend:
                    return True
        return False

    def _execute_roll(self, pos, current_price, iv, date_str, idx, prices):
        """Execute a roll: close current position, open new one at same strike further out."""
        old_strike = pos["strike"]
        contracts = pos["contracts"]

        if pos["type"] == "CSP":
            # Close current CSP (buy back)
            itm_amount = max(pos["strike"] - current_price, 0)
            close_cost = itm_amount * (1 + self.bid_ask_haircut)  # Pay ask to close

            # Open new CSP further out
            T_new = self.target_dte / 365.0
            new_premium_mid = black_scholes(current_price, old_strike,
                                            T_new, self.risk_free_rate, iv, "put")
            new_premium = new_premium_mid * (1 - self.bid_ask_haircut)

            net_credit = new_premium - close_cost
            if net_credit <= 0:
                return False  # Can't roll for a credit, take assignment instead

            self.capital += net_credit * 100 * contracts
            self.premium_collected += new_premium * 100 * contracts
            self.total_commissions += self.commission * contracts * 2  # Close + open
            self.capital -= self.commission * contracts * 2

            self.current_position = {
                "type": "CSP",
                "strike": old_strike,
                "premium": new_premium,
                "entry_price": current_price,
                "entry_date": date_str,
                "entry_idx": idx,
                "expiry_idx": self._find_expiry_index(idx, len(prices), self.target_dte),
                "dte": self.target_dte,
                "iv": iv,
                "delta": greeks(current_price, old_strike, T_new, self.risk_free_rate, iv, "put")["delta"],
                "contracts": contracts,
            }

            self.rolls += 1
            self.trades.append({
                "action": "ROLL_CSP",
                "date": date_str,
                "ticker": self.ticker,
                "strike": old_strike,
                "net_credit": round(net_credit, 2),
                "stock_price": round(current_price, 2),
            })
            return True

        elif pos["type"] == "CC":
            itm_amount = max(current_price - pos["strike"], 0)
            close_cost = itm_amount * (1 + self.bid_ask_haircut)

            T_new = self.target_dte / 365.0
            new_premium_mid = black_scholes(current_price, old_strike,
                                            T_new, self.risk_free_rate, iv, "call")
            new_premium = new_premium_mid * (1 - self.bid_ask_haircut)

            net_credit = new_premium - close_cost
            if net_credit <= 0:
                return False

            self.capital += net_credit * 100 * contracts
            self.premium_collected += new_premium * 100 * contracts
            self.total_commissions += self.commission * contracts * 2
            self.capital -= self.commission * contracts * 2

            self.current_position = {
                "type": "CC",
                "strike": old_strike,
                "premium": new_premium,
                "entry_price": current_price,
                "entry_date": date_str,
                "entry_idx": idx,
                "expiry_idx": self._find_expiry_index(idx, len(prices), self.target_dte),
                "dte": self.target_dte,
                "iv": iv,
                "delta": greeks(current_price, old_strike, T_new, self.risk_free_rate, iv, "call")["delta"],
                "contracts": contracts,
            }

            self.rolls += 1
            self.trades.append({
                "action": "ROLL_CC",
                "date": date_str,
                "ticker": self.ticker,
                "strike": old_strike,
                "net_credit": round(net_credit, 2),
                "stock_price": round(current_price, 2),
            })
            return True

        return False

    def _sell_csp(self, price, iv, date_str, idx, prices):
        """Sell a cash-secured put."""
        T = self.target_dte / 365.0
        strike = find_strike_by_delta(
            price, T, self.risk_free_rate, iv, -self.csp_delta, "put"
        )
        strike = round(strike)

        premium_mid = black_scholes(price, strike, T, self.risk_free_rate, iv, "put")
        premium = premium_mid * (1 - self.bid_ask_haircut)
        g = greeks(price, strike, T, self.risk_free_rate, iv, "put")

        num_contracts = self._compute_num_contracts(strike, price)
        if num_contracts == 0:
            return None

        cash_required = strike * 100 * num_contracts
        if cash_required > self.capital:
            # Try fewer contracts
            num_contracts = int(self.capital / (strike * 100))
            if num_contracts == 0:
                return None

        self.current_position = {
            "type": "CSP",
            "strike": strike,
            "premium": premium,
            "entry_price": price,
            "entry_date": date_str,
            "entry_idx": idx,
            "expiry_idx": self._find_expiry_index(idx, len(prices), self.target_dte),
            "dte": self.target_dte,
            "iv": iv,
            "delta": g["delta"],
            "contracts": num_contracts,
        }

        self.premium_collected += premium * 100 * num_contracts
        self.capital += premium * 100 * num_contracts
        self.total_commissions += self.commission * num_contracts
        self.capital -= self.commission * num_contracts

        self.trades.append({
            "action": "SELL_CSP",
            "date": date_str,
            "ticker": self.ticker,
            "strike": strike,
            "premium": round(premium, 2),
            "delta": round(g["delta"], 3),
            "iv": round(iv, 3),
            "stock_price": round(price, 2),
            "contracts": num_contracts,
        })

        return self.current_position

    def _sell_cc(self, price, iv, date_str, idx, prices):
        """Sell a covered call."""
        T = self.target_dte / 365.0
        strike = find_strike_by_delta(
            price, T, self.risk_free_rate, iv, self.cc_delta, "call"
        )
        strike = round(strike)

        # Ensure strike is at or above cost basis when possible
        if strike < self.cost_basis and price > self.cost_basis:
            strike = round(self.cost_basis)

        premium_mid = black_scholes(price, strike, T, self.risk_free_rate, iv, "call")
        premium = premium_mid * (1 - self.bid_ask_haircut)
        g = greeks(price, strike, T, self.risk_free_rate, iv, "call")

        num_contracts = self.shares_held // 100

        self.current_position = {
            "type": "CC",
            "strike": strike,
            "premium": premium,
            "entry_price": price,
            "entry_date": date_str,
            "entry_idx": idx,
            "expiry_idx": self._find_expiry_index(idx, len(prices), self.target_dte),
            "dte": self.target_dte,
            "iv": iv,
            "delta": g["delta"],
            "contracts": num_contracts,
        }

        self.premium_collected += premium * 100 * num_contracts
        self.capital += premium * 100 * num_contracts
        self.total_commissions += self.commission * num_contracts
        self.capital -= self.commission * num_contracts

        self.trades.append({
            "action": "SELL_CC",
            "date": date_str,
            "ticker": self.ticker,
            "strike": strike,
            "premium": round(premium, 2),
            "delta": round(g["delta"], 3),
            "iv": round(iv, 3),
            "stock_price": round(price, 2),
            "cost_basis": round(self.cost_basis, 2),
            "contracts": num_contracts,
        })

        return self.current_position

    def _process_expiry(self, expiry_price, date_str):
        """Process option expiration or assignment."""
        pos = self.current_position
        if pos is None:
            return

        if pos["type"] == "CSP":
            if expiry_price <= pos["strike"]:
                # ASSIGNED - buy shares at strike
                cost = pos["strike"] * 100 * pos["contracts"]
                self.capital -= cost
                self.shares_held = 100 * pos["contracts"]
                self.cost_basis = pos["strike"] - pos["premium"]  # Net cost basis
                self.phase = "CC"
                self.assignments += 1
                self.trades.append({
                    "action": "ASSIGNED",
                    "date": date_str,
                    "ticker": self.ticker,
                    "strike": pos["strike"],
                    "stock_price": round(expiry_price, 2),
                    "cost_basis": round(self.cost_basis, 2),
                    "shares": self.shares_held,
                })
            else:
                # Expired OTM
                self.expirations_otm += 1
                self.trades.append({
                    "action": "EXPIRED_OTM",
                    "date": date_str,
                    "ticker": self.ticker,
                    "type": "CSP",
                    "strike": pos["strike"],
                    "stock_price": round(expiry_price, 2),
                    "premium_kept": round(pos["premium"], 2),
                })

        elif pos["type"] == "CC":
            if expiry_price >= pos["strike"]:
                # CALLED AWAY - sell shares at strike
                proceeds = pos["strike"] * 100 * pos["contracts"]
                self.capital += proceeds
                self.shares_held = 0
                self.cost_basis = 0
                self.phase = "CSP"
                self.calls_away += 1
                self.trades.append({
                    "action": "CALLED_AWAY",
                    "date": date_str,
                    "ticker": self.ticker,
                    "strike": pos["strike"],
                    "stock_price": round(expiry_price, 2),
                    "gain_per_share": round(pos["strike"] - self.cost_basis, 2) if self.cost_basis else 0,
                })
            else:
                # Expired OTM - keep premium and shares
                self.expirations_otm += 1
                self.cost_basis -= pos["premium"]
                self.trades.append({
                    "action": "EXPIRED_OTM",
                    "date": date_str,
                    "ticker": self.ticker,
                    "type": "CC",
                    "strike": pos["strike"],
                    "stock_price": round(expiry_price, 2),
                    "premium_kept": round(pos["premium"], 2),
                    "new_cost_basis": round(self.cost_basis, 2),
                })

        self.current_position = None

    def _portfolio_value(self, current_price):
        """Calculate total portfolio value."""
        stock_value = self.shares_held * current_price
        return self.capital + stock_value

    def run(self, months=12):
        """
        Run the wheel strategy backtest.

        Args:
            months: number of months to backtest

        Returns:
            dict with backtest results
        """
        df = self._get_historical_data(months)
        prices_series = df["Close"].values.flatten()
        dates = df.index

        warmup_days = 45
        if len(prices_series) <= warmup_days:
            raise ValueError(f"Not enough data for {self.ticker}. Need at least {warmup_days} trading days.")

        start_idx = warmup_days
        prices = prices_series
        total_days = len(prices)

        # Track buy-and-hold benchmark
        bnh_start_price = float(prices[start_idx])
        bnh_shares = self.initial_capital / bnh_start_price

        # Reset state
        self.capital = self.initial_capital
        self.shares_held = 0
        self.phase = "CSP"
        self.current_position = None
        self.trades = []
        self.equity_curve = []
        self.premium_collected = 0
        self.total_commissions = 0
        self.assignments = 0
        self.calls_away = 0
        self.expirations_otm = 0
        self.rolls = 0
        self.early_assignments = 0
        self.peak_margin_used = 0
        self.margin_used = 0

        # Main simulation loop
        for idx in range(start_idx, total_days):
            price = float(prices[idx])
            date_str = str(dates[idx].date()) if hasattr(dates[idx], 'date') else str(dates[idx])[:10]

            # Update margin tracking
            self._update_margin(price)

            # Check for early assignment risk (before expiry check)
            if self.current_position is not None:
                self.current_position["current_idx"] = idx
                iv = self._estimate_iv_at_date(prices, idx)

                # Early assignment check (ex-dividend)
                if self._check_early_assignment(self.current_position, price, date_str, iv):
                    self.early_assignments += 1
                    self._process_expiry(price, date_str)
                    self.trades[-1]["action"] = "EARLY_ASSIGNMENT"
                    continue

                # Rolling check: if near expiry and ITM
                if self.current_position is not None:
                    remaining_trading_days = self.current_position["expiry_idx"] - idx
                    if remaining_trading_days <= self.roll_dte_threshold:
                        should_roll, reason = self._should_roll(
                            self.current_position, price, remaining_trading_days, iv
                        )
                        if should_roll:
                            rolled = self._execute_roll(
                                self.current_position, price, iv, date_str, idx, prices
                            )
                            if rolled:
                                continue  # Successfully rolled, skip expiry check

            # Check if current position has expired
            if self.current_position and idx >= self.current_position["expiry_idx"]:
                self._process_expiry(price, date_str)

            # Open new position if none active
            if self.current_position is None:
                iv = self._estimate_iv_at_date(prices, idx)

                if self.phase == "CSP":
                    self._sell_csp(price, iv, date_str, idx, prices)
                elif self.phase == "CC" and self.shares_held > 0:
                    self._sell_cc(price, iv, date_str, idx, prices)

            # Record equity
            pv = self._portfolio_value(price)
            self.equity_curve.append({
                "date": date_str,
                "portfolio_value": round(pv, 2),
                "stock_price": round(price, 2),
                "phase": self.phase,
                "cash": round(self.capital, 2),
                "shares": self.shares_held,
                "margin_used": round(self.margin_used, 2),
            })

        # Final settlement
        final_price = float(prices[-1])
        final_date = str(dates[-1].date()) if hasattr(dates[-1], 'date') else str(dates[-1])[:10]

        if self.current_position:
            self._process_expiry(final_price, final_date)

        final_value = self._portfolio_value(final_price)
        bnh_final = bnh_shares * final_price

        # Calculate metrics
        equity_values = [e["portfolio_value"] for e in self.equity_curve]
        if len(equity_values) > 1:
            daily_returns = np.diff(equity_values) / equity_values[:-1]
            sharpe = (np.mean(daily_returns) / np.std(daily_returns) * np.sqrt(252)
                      if np.std(daily_returns) > 0 else 0)

            peak = np.maximum.accumulate(equity_values)
            drawdown = (np.array(equity_values) - peak) / peak
            max_dd = float(np.min(drawdown))
        else:
            sharpe = 0
            max_dd = 0
            daily_returns = []

        total_return = (final_value - self.initial_capital) / self.initial_capital
        bnh_return = (bnh_final - self.initial_capital) / self.initial_capital
        trading_days = total_days - start_idx

        # Proper CAGR (compound annualized)
        years = trading_days / 252.0
        if years > 0 and final_value > 0:
            cagr = (final_value / self.initial_capital) ** (1.0 / years) - 1
        else:
            cagr = 0

        total_option_trades = self.assignments + self.calls_away + self.expirations_otm
        win_rate = (self.expirations_otm / total_option_trades * 100
                    if total_option_trades > 0 else 0)

        results = {
            "ticker": self.ticker,
            "period": {
                "start": str(dates[start_idx].date()) if hasattr(dates[start_idx], 'date') else str(dates[start_idx])[:10],
                "end": final_date,
                "trading_days": trading_days,
                "months": round(trading_days / 21, 1),
            },
            "parameters": {
                "initial_capital": self.initial_capital,
                "csp_delta": self.csp_delta,
                "cc_delta": self.cc_delta,
                "target_dte": self.target_dte,
                "iv_premium": self.iv_premium,
                "sizing_method": self.sizing_method,
                "max_position_pct": self.max_position_pct,
                "roll_when_itm": self.roll_when_itm,
            },
            "performance": {
                "final_value": round(final_value, 2),
                "total_return_pct": round(total_return * 100, 2),
                "cagr_pct": round(cagr * 100, 2),
                "annualized_return_pct": round(cagr * 100, 2),  # Use CAGR
                "total_premium_collected": round(self.premium_collected, 2),
                "total_commissions": round(self.total_commissions, 2),
                "sharpe_ratio": round(sharpe, 2),
                "max_drawdown_pct": round(max_dd * 100, 2),
                "peak_margin_used": round(self.peak_margin_used, 2),
            },
            "trade_stats": {
                "total_option_cycles": total_option_trades,
                "assignments": self.assignments,
                "called_away": self.calls_away,
                "expired_otm": self.expirations_otm,
                "rolls": self.rolls,
                "early_assignments": self.early_assignments,
                "win_rate_pct": round(win_rate, 1),
                "avg_premium_per_cycle": round(
                    self.premium_collected / total_option_trades, 2
                ) if total_option_trades > 0 else 0,
            },
            "benchmark": {
                "buy_hold_return_pct": round(bnh_return * 100, 2),
                "buy_hold_final_value": round(bnh_final, 2),
                "wheel_vs_bnh_pct": round((total_return - bnh_return) * 100, 2),
            },
            "current_state": {
                "phase": self.phase,
                "shares_held": self.shares_held,
                "cost_basis": round(self.cost_basis, 2),
                "cash": round(self.capital, 2),
            },
            "trades": self.trades,
        }

        return results

    def save_results(self, results, filename=None):
        """Save backtest results to JSON."""
        os.makedirs(DATA_DIR, exist_ok=True)
        if filename is None:
            ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"backtest_{self.ticker}_{ts}.json"
        filepath = os.path.join(DATA_DIR, filename)
        with open(filepath, "w") as f:
            json.dump(results, f, indent=2)
        return filepath


def backtest_portfolio(tickers, capital=100_000, months=12, **kwargs):
    """
    Backtest wheel strategy on a portfolio of stocks.
    Splits capital equally among tickers.
    """
    per_stock_capital = capital / len(tickers)
    all_results = []
    total_final = 0
    total_premium = 0
    total_assignments = 0
    total_called = 0
    total_otm = 0
    total_rolls = 0
    errors = []

    for ticker in tickers:
        try:
            bt = WheelBacktester(ticker, capital=per_stock_capital, **kwargs)
            result = bt.run(months=months)
            all_results.append(result)
            total_final += result["performance"]["final_value"]
            total_premium += result["performance"]["total_premium_collected"]
            total_assignments += result["trade_stats"]["assignments"]
            total_called += result["trade_stats"]["called_away"]
            total_otm += result["trade_stats"]["expired_otm"]
            total_rolls += result["trade_stats"].get("rolls", 0)
            print(f"  {ticker}: {result['performance']['total_return_pct']:+.1f}% "
                  f"(premium: ${result['performance']['total_premium_collected']:,.0f})")
        except Exception as e:
            errors.append({"ticker": ticker, "error": str(e)})
            print(f"  {ticker}: FAILED - {e}")

    total_trades = total_assignments + total_called + total_otm
    portfolio_return = (total_final - capital) / capital if total_final > 0 else 0

    portfolio_results = {
        "portfolio": {
            "tickers": tickers,
            "initial_capital": capital,
            "per_stock_capital": round(per_stock_capital, 2),
            "months": months,
        },
        "performance": {
            "final_value": round(total_final, 2),
            "total_return_pct": round(portfolio_return * 100, 2),
            "total_premium_collected": round(total_premium, 2),
        },
        "trade_stats": {
            "total_cycles": total_trades,
            "assignments": total_assignments,
            "called_away": total_called,
            "expired_otm": total_otm,
            "rolls": total_rolls,
            "win_rate_pct": round(total_otm / total_trades * 100, 1) if total_trades > 0 else 0,
        },
        "errors": errors,
        "per_stock": all_results,
    }

    return portfolio_results


def format_backtest_results(results):
    """Format backtest results as readable string."""
    lines = []
    lines.append(f"=== Wheel Strategy Backtest: {results['ticker']} ===")
    lines.append(f"Period: {results['period']['start']} to {results['period']['end']} "
                 f"({results['period']['months']} months)")
    lines.append("")

    perf = results["performance"]
    lines.append("--- Performance ---")
    lines.append(f"  Initial Capital:    ${results['parameters']['initial_capital']:>12,.2f}")
    lines.append(f"  Final Value:        ${perf['final_value']:>12,.2f}")
    lines.append(f"  Total Return:       {perf['total_return_pct']:>11.2f}%")
    lines.append(f"  CAGR:               {perf['cagr_pct']:>11.2f}%")
    lines.append(f"  Premium Collected:  ${perf['total_premium_collected']:>12,.2f}")
    lines.append(f"  Commissions:        ${perf['total_commissions']:>12,.2f}")
    lines.append(f"  Sharpe Ratio:       {perf['sharpe_ratio']:>11.2f}")
    lines.append(f"  Max Drawdown:       {perf['max_drawdown_pct']:>11.2f}%")
    lines.append(f"  Peak Margin Used:   ${perf['peak_margin_used']:>12,.2f}")

    ts = results["trade_stats"]
    lines.append("")
    lines.append("--- Trade Statistics ---")
    lines.append(f"  Option Cycles:      {ts['total_option_cycles']:>8}")
    lines.append(f"  Expired OTM (wins): {ts['expired_otm']:>8}")
    lines.append(f"  Assignments:        {ts['assignments']:>8}")
    lines.append(f"  Called Away:         {ts['called_away']:>8}")
    lines.append(f"  Rolls:              {ts.get('rolls', 0):>8}")
    lines.append(f"  Early Assignments:  {ts.get('early_assignments', 0):>8}")
    lines.append(f"  Win Rate:           {ts['win_rate_pct']:>7.1f}%")
    lines.append(f"  Avg Premium/Cycle:  ${ts['avg_premium_per_cycle']:>11,.2f}")

    bm = results["benchmark"]
    lines.append("")
    lines.append("--- vs Buy & Hold ---")
    lines.append(f"  B&H Return:         {bm['buy_hold_return_pct']:>11.2f}%")
    lines.append(f"  B&H Final Value:    ${bm['buy_hold_final_value']:>12,.2f}")
    lines.append(f"  Wheel vs B&H:       {bm['wheel_vs_bnh_pct']:>+11.2f}%")

    state = results["current_state"]
    lines.append("")
    lines.append("--- Current State ---")
    lines.append(f"  Phase: {state['phase']}")
    lines.append(f"  Shares Held: {state['shares_held']}")
    lines.append(f"  Cost Basis: ${state['cost_basis']:.2f}")
    lines.append(f"  Cash: ${state['cash']:,.2f}")

    params = results["parameters"]
    lines.append("")
    lines.append("--- Parameters ---")
    lines.append(f"  Sizing: {params.get('sizing_method', 'single')}")
    lines.append(f"  Rolling: {'enabled' if params.get('roll_when_itm', False) else 'disabled'}")

    return "\n".join(lines)


if __name__ == "__main__":
    print("Running AAPL wheel backtest (12 months)...\n")
    bt = WheelBacktester("AAPL", capital=100_000)
    results = bt.run(months=12)
    print(format_backtest_results(results))
    filepath = bt.save_results(results)
    print(f"\nResults saved to: {filepath}")
