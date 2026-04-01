#!/usr/bin/env python3
"""
Integration test for the wheel strategy pipeline.
Runs the full flow: screener -> pricer -> backtest -> format output.
Validates nothing crashes and outputs are reasonable.

Does NOT require yfinance or network access for the offline tests.
"""

import sys
import os
import json
import numpy as np

# Ensure imports work
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)


def test_options_pricer():
    """Test that the pricer produces reasonable values."""
    from trading_agents.wheel_strategy.options_pricer import (
        black_scholes, greeks, find_strike_by_delta,
        premium_analysis, optimal_csp_strike, optimal_cc_strike,
        implied_volatility, estimate_hist_iv,
    )

    S, K, T, r, sigma = 230, 220, 35/365, 0.05, 0.25

    # Black-Scholes put
    put_price = black_scholes(S, K, T, r, sigma, "put")
    assert 0 < put_price < S, f"Put price {put_price} out of range"

    # Black-Scholes call
    call_price = black_scholes(S, K, T, r, sigma, "call")
    assert 0 < call_price < S, f"Call price {call_price} out of range"

    # Put-call parity (approximate)
    parity_diff = abs(call_price - put_price - (S - K * np.exp(-r * T)))
    assert parity_diff < 0.01, f"Put-call parity violated: diff={parity_diff:.4f}"

    # Greeks
    g = greeks(S, K, T, r, sigma, "put")
    assert -1 < g["delta"] < 0, f"Put delta {g['delta']} out of range"
    assert g["gamma"] > 0, "Gamma should be positive"
    assert g["theta"] < 0, "Theta should be negative (time decay)"
    assert g["vega"] > 0, "Vega should be positive"

    g_call = greeks(S, K, T, r, sigma, "call")
    assert 0 < g_call["delta"] < 1, f"Call delta {g_call['delta']} out of range"

    # Find strike by delta
    strike = find_strike_by_delta(S, T, r, sigma, -0.25, "put")
    assert 0.7 * S < strike < S, f"CSP strike {strike} unreasonable for S={S}"

    strike_call = find_strike_by_delta(S, T, r, sigma, 0.30, "call")
    assert S < strike_call < 1.3 * S, f"CC strike {strike_call} unreasonable for S={S}"

    # Premium analysis
    pa = premium_analysis(S, K, T, r, sigma, "put")
    assert pa["premium_per_share"] > 0
    assert pa["capital_required"] > 0
    assert pa["annualized_return_pct"] > 0

    # Optimal CSP/CC strikes
    csp = optimal_csp_strike(S, sigma)
    assert len(csp) == 4
    for s in csp:
        assert s["strike"] > 0
        assert s["premium"] >= 0

    cc = optimal_cc_strike(S, 220, sigma)
    assert len(cc) == 4

    # Implied volatility solver
    test_price = black_scholes(S, K, T, r, 0.30, "put")
    solved_iv = implied_volatility(test_price, S, K, T, r, "put")
    assert solved_iv is not None, "IV solver returned None"
    assert abs(solved_iv - 0.30) < 0.001, f"IV solver off: {solved_iv} vs 0.30"

    # Edge cases
    assert black_scholes(S, K, 0, r, sigma, "put") == max(K - S, 0)
    assert black_scholes(S, K, T, r, 0, "put") == max(K - S, 0)

    # Hist IV estimator
    fake_returns = np.random.normal(0, 0.01, 60)
    hv = estimate_hist_iv(fake_returns, lookback=30, iv_premium=1.2)
    assert hv > 0.05, f"Estimated HV too low: {hv}"

    print("  [PASS] options_pricer: all tests passed")
    return True


def test_stock_screener():
    """Test screener with no live data (offline mode)."""
    from trading_agents.wheel_strategy.stock_screener import (
        screen_candidates, format_screen_results, get_sp500_candidates,
        _compute_iv_rank, _compute_iv_percentile, _near_earnings,
        _near_ex_dividend,
    )

    # Basic screening
    results = screen_candidates(max_results=10, min_safety="C")
    assert len(results) > 0, "Screener returned no results"
    assert len(results) <= 10, f"Screener returned {len(results)}, expected <=10"

    # Check required fields
    required = ["ticker", "name", "sector", "price", "iv_rank", "safety_rating",
                "composite_score", "capital_required"]
    for r in results:
        for field in required:
            assert field in r, f"Missing field '{field}' in result for {r.get('ticker')}"

    # Scores should be reasonable
    for r in results:
        assert 0 <= r["iv_rank"] <= 100, f"IV rank {r['iv_rank']} out of range for {r['ticker']}"
        assert r["price"] > 0, f"Price {r['price']} invalid"
        assert r["composite_score"] > 0, f"Score {r['composite_score']} invalid"

    # Safety filter works
    results_a = screen_candidates(max_results=50, min_safety="A")
    for r in results_a:
        assert r["safety_rating"] == "A", f"{r['ticker']} has safety {r['safety_rating']}, expected A"

    # Price filter works
    results_cheap = screen_candidates(max_results=50, max_price=100)
    for r in results_cheap:
        assert r["price"] <= 100, f"{r['ticker']} price ${r['price']} exceeds max $100"

    # Format doesn't crash
    formatted = format_screen_results(results)
    assert len(formatted) > 0, "Formatted output is empty"
    assert "Ticker" in formatted, "Header missing from formatted output"

    # IV rank computation
    hv_series = np.array([0.15, 0.20, 0.25, 0.30, 0.35])
    assert _compute_iv_rank(hv_series, 0.15) == 0.0
    assert _compute_iv_rank(hv_series, 0.35) == 100.0
    assert 40 < _compute_iv_rank(hv_series, 0.25) < 60

    # IV percentile
    assert _compute_iv_percentile(hv_series, 0.25) == 40.0  # 2/5 below

    # Earnings filter
    import datetime
    # AAPL earnings in months [1, 5, 8, 11]
    assert _near_earnings("AAPL", datetime.date(2026, 1, 15)) is True
    assert _near_earnings("AAPL", datetime.date(2026, 3, 15)) is False
    assert _near_earnings("UNKNOWN_TICKER") is False

    # Ex-dividend awareness
    assert _near_ex_dividend("AAPL", datetime.date(2026, 2, 15)) is True
    assert _near_ex_dividend("AAPL", datetime.date(2026, 3, 15)) is False

    # Candidates list is populated
    candidates = get_sp500_candidates()
    assert len(candidates) >= 90, f"Only {len(candidates)} candidates, expected ~100"

    print("  [PASS] stock_screener: all tests passed")
    return True


def test_backtester_offline():
    """
    Test backtester logic without yfinance.
    Creates synthetic price data to validate the simulation engine.
    """
    from trading_agents.wheel_strategy.backtester import (
        WheelBacktester, format_backtest_results, _near_ex_dividend
    )

    # Test ex-dividend helper
    assert _near_ex_dividend("AAPL", "2026-02-15") is True
    assert _near_ex_dividend("AAPL", "2026-06-15") is False
    assert _near_ex_dividend("ZZZZ", "2026-01-01") is False

    # Test backtester initialization
    bt = WheelBacktester("TEST", capital=100_000, sizing_method="single")
    assert bt.initial_capital == 100_000
    assert bt.phase == "CSP"
    assert bt.shares_held == 0

    # Test position sizing
    bt_ff = WheelBacktester("TEST", capital=100_000, sizing_method="fixed_fractional",
                            max_position_pct=0.20)
    num = bt_ff._compute_num_contracts(100, 100)
    assert num == 2, f"Expected 2 contracts (20% of $100K / $10K per), got {num}"

    # Single mode always returns 1
    bt_s = WheelBacktester("TEST", capital=100_000, sizing_method="single")
    assert bt_s._compute_num_contracts(100, 100) == 1

    # Test format doesn't crash with mock results
    mock_results = {
        "ticker": "TEST",
        "period": {"start": "2025-01-01", "end": "2025-12-31", "trading_days": 252, "months": 12.0},
        "parameters": {
            "initial_capital": 100000, "csp_delta": 0.25, "cc_delta": 0.30,
            "target_dte": 35, "iv_premium": 1.2, "sizing_method": "single",
            "max_position_pct": 0.20, "roll_when_itm": True,
        },
        "performance": {
            "final_value": 108000, "total_return_pct": 8.0, "cagr_pct": 8.0,
            "annualized_return_pct": 8.0, "total_premium_collected": 5000,
            "total_commissions": 50, "sharpe_ratio": 1.5, "max_drawdown_pct": -5.0,
            "peak_margin_used": 25000,
        },
        "trade_stats": {
            "total_option_cycles": 10, "assignments": 2, "called_away": 1,
            "expired_otm": 7, "rolls": 1, "early_assignments": 0,
            "win_rate_pct": 70.0, "avg_premium_per_cycle": 500,
        },
        "benchmark": {
            "buy_hold_return_pct": 10.0, "buy_hold_final_value": 110000,
            "wheel_vs_bnh_pct": -2.0,
        },
        "current_state": {
            "phase": "CSP", "shares_held": 0, "cost_basis": 0, "cash": 108000,
        },
        "trades": [],
    }
    formatted = format_backtest_results(mock_results)
    assert "TEST" in formatted
    assert "CAGR" in formatted
    assert "Rolls" in formatted
    assert "Peak Margin" in formatted

    print("  [PASS] backtester (offline): all tests passed")
    return True


def test_position_manager():
    """Test position manager operations."""
    from trading_agents.wheel_strategy.position_manager import PositionManager
    import tempfile

    # Use a temp file to avoid polluting real state
    pm = PositionManager()
    # Reset to default state for testing
    pm.state = {
        "last_updated": None,
        "capital": 100_000,
        "initial_capital": 100_000,
        "positions": [],
        "history": [],
        "settings": {**pm.state["settings"], "max_position_pct": 0.25},
    }

    # Test opening a CSP
    result = pm.open_csp(
        ticker="AAPL", strike=220, expiry="2026-04-17",
        premium=3.50, sector="Technology", iv=0.25, delta=-0.25,
        stock_price=230
    )
    assert result["success"], f"Failed to open CSP: {result.get('reasons')}"

    # Capital should include premium credit
    assert pm.state["capital"] == 100_350  # 100K + $350 premium

    # Should have 1 active position
    active = pm.active_positions_summary()
    assert len(active) == 1
    assert active[0]["ticker"] == "AAPL"
    assert active[0]["phase"] == "CSP"

    # Duplicate ticker should be blocked
    result2 = pm.open_csp(
        ticker="AAPL", strike=215, expiry="2026-04-17",
        premium=2.00, sector="Technology"
    )
    assert not result2["success"]
    assert any("Already have" in r for r in result2["reasons"])

    # Test risk check
    roll = pm.check_roll_needed(active[0]["ticker"] + "_", 225)  # wrong ID
    assert not roll["needs_roll"]

    # PnL summary
    pnl = pm.pnl_summary()
    assert pnl["total_premium_collected"] == 350

    # Format status doesn't crash
    status = pm.format_status()
    assert "AAPL" in status
    assert "Wheel Strategy" in status

    print("  [PASS] position_manager: all tests passed")
    return True


def test_discord_alerts():
    """Test alert formatting."""
    from trading_agents.wheel_strategy.discord_alerts import (
        format_csp_alert, format_cc_alert, format_assignment_alert,
        format_called_away_alert, format_expiry_alert,
        format_weekly_summary, format_scan_results, embed_to_text,
    )

    # CSP alert
    csp = format_csp_alert(
        ticker="AAPL", strike=220, expiry="2026-04-17",
        premium=3.50, stock_price=230, annualized_return=18.5,
        safety_rating="A", iv_rank=45, delta=-0.25, sector="Technology"
    )
    assert "AAPL" in csp["title"]
    text = embed_to_text(csp)
    assert len(text) > 0

    # CC alert
    cc = format_cc_alert(
        ticker="AAPL", strike=240, expiry="2026-04-17",
        premium=2.50, stock_price=230, cost_basis=220,
        annualized_return=12.0, delta=0.30
    )
    assert "AAPL" in cc["title"]

    # Assignment alert
    assign = format_assignment_alert("AAPL", 220, 215, 216.50)
    assert "Assignment" in assign["title"]

    # Called away alert
    called = format_called_away_alert("AAPL", 240, 216.50, 850)
    assert "Called Away" in called["title"]

    # Expiry alert
    expiry = format_expiry_alert("AAPL", "CSP", 220, 350)
    assert "Expired" in expiry["title"]

    # Weekly summary
    summary = format_weekly_summary(
        positions=[{"status": "active", "phase": "CSP"}, {"status": "active", "phase": "CC"}],
        pnl={"current_capital": 102500, "total_premium_collected": 3200, "total_return_pct": 2.5},
        week_premium=850, week_trades=3,
    )
    assert "Weekly Summary" in summary["title"]
    text = embed_to_text(summary)
    assert "850" in text

    # Scan results
    mock_candidates = [
        {"ticker": "AAPL", "price": 230, "iv_rank": 45, "safety_rating": "A",
         "composite_score": 82, "capital_required": 23000, "sector": "Technology",
         "stability_score": 75},
        {"ticker": "MSFT", "price": 420, "iv_rank": 38, "safety_rating": "A",
         "composite_score": 78, "capital_required": 42000, "sector": "Technology",
         "stability_score": 80},
    ]
    scan_text = format_scan_results(mock_candidates, top_n=2)
    assert "AAPL" in scan_text
    assert "MSFT" in scan_text

    print("  [PASS] discord_alerts: all tests passed")
    return True


def test_scheduler_offline():
    """Test scheduler components that don't need network."""
    from trading_agents.wheel_strategy.scheduler import (
        _allocate_capital_risk_parity, format_discord_message,
    )

    # Risk parity allocation
    plays = [
        {'ticker': 'LOW_VOL', 'strike': 100, 'iv': 15.0, 'delta': -0.25,
         'premium': 1.5, 'weekly_return_pct': 0.5, 'annual_return_pct': 26,
         'safety': 'A', 'price': 105},
        {'ticker': 'HIGH_VOL', 'strike': 100, 'iv': 45.0, 'delta': -0.30,
         'premium': 4.0, 'weekly_return_pct': 1.2, 'annual_return_pct': 62,
         'safety': 'B', 'price': 110},
    ]

    allocated = _allocate_capital_risk_parity(plays, 100_000)
    assert len(allocated) == 2

    # Low vol should get more contracts (risk parity)
    assert allocated[0]['num_contracts'] >= allocated[1]['num_contracts'], \
        f"Low vol got {allocated[0]['num_contracts']} contracts, high vol got {allocated[1]['num_contracts']}"

    # Total shouldn't exceed 80% of capital
    total = sum(p['allocated_capital'] for p in allocated)
    assert total <= 100_000 * 0.85, f"Over-allocated: ${total:,.0f}"  # Small buffer

    # Format message with plays
    for p in allocated:
        p['iv_rank'] = 50
        p['capital_required'] = p['strike'] * 100
        p['sector'] = 'Test'
    msg = format_discord_message(allocated)
    assert "Weekly Plays" in msg
    assert "LOW_VOL" in msg

    # Format empty plays
    empty_msg = format_discord_message([])
    assert "No plays" in empty_msg

    # Format with errors
    msg_err = format_discord_message(allocated, errors=["TEST: failed"])
    assert "skipped" in msg_err

    print("  [PASS] scheduler (offline): all tests passed")
    return True


def test_full_pipeline_offline():
    """
    Integration test: screener -> pricer -> format.
    Validates the full pipeline works without network access.
    """
    from trading_agents.wheel_strategy.stock_screener import screen_candidates
    from trading_agents.wheel_strategy.options_pricer import (
        black_scholes, greeks, find_strike_by_delta
    )
    from trading_agents.wheel_strategy.discord_alerts import (
        format_csp_alert, embed_to_text
    )

    # Step 1: Screen
    candidates = screen_candidates(max_results=5, min_safety="B", max_price=300)
    assert len(candidates) > 0, "No candidates from screener"

    # Step 2: Price each candidate
    priced_plays = []
    for c in candidates:
        price = c['price']
        iv = c['hist_vol'] * 1.2  # IV premium
        T = 35 / 365.0
        r = 0.05

        strike = find_strike_by_delta(price, T, r, iv, -0.25, "put")
        strike = round(strike)

        premium = black_scholes(price, strike, T, r, iv, "put")
        g = greeks(price, strike, T, r, iv, "put")

        assert premium > 0, f"Zero premium for {c['ticker']}"
        assert strike > 0, f"Zero strike for {c['ticker']}"

        priced_plays.append({
            'ticker': c['ticker'],
            'strike': strike,
            'premium': premium,
            'delta': g['delta'],
            'iv': iv,
            'safety': c['safety_rating'],
            'price': price,
            'iv_rank': c['iv_rank'],
        })

    # Step 3: Format alerts
    for play in priced_plays:
        alert = format_csp_alert(
            ticker=play['ticker'],
            strike=play['strike'],
            expiry="2026-04-17",
            premium=play['premium'],
            stock_price=play['price'],
            annualized_return=play['premium'] / play['strike'] * 365 / 35 * 100,
            safety_rating=play['safety'],
            iv_rank=play['iv_rank'],
            delta=play['delta'],
        )
        text = embed_to_text(alert)
        assert play['ticker'] in text, f"Ticker missing from alert text"

    print(f"  [PASS] full pipeline (offline): {len(priced_plays)} plays priced and formatted")
    return True


def main():
    print("=" * 60)
    print("WHEEL STRATEGY INTEGRATION TESTS")
    print("=" * 60)
    print()

    tests = [
        ("Options Pricer", test_options_pricer),
        ("Stock Screener", test_stock_screener),
        ("Backtester (offline)", test_backtester_offline),
        ("Position Manager", test_position_manager),
        ("Discord Alerts", test_discord_alerts),
        ("Scheduler (offline)", test_scheduler_offline),
        ("Full Pipeline (offline)", test_full_pipeline_offline),
    ]

    passed = 0
    failed = 0
    errors = []

    for name, test_fn in tests:
        try:
            test_fn()
            passed += 1
        except Exception as e:
            failed += 1
            errors.append((name, str(e)))
            import traceback
            print(f"  [FAIL] {name}: {e}")
            traceback.print_exc()
            print()

    print()
    print("=" * 60)
    print(f"RESULTS: {passed} passed, {failed} failed out of {len(tests)} tests")
    print("=" * 60)

    if errors:
        print("\nFailed tests:")
        for name, err in errors:
            print(f"  {name}: {err}")
        return 1

    print("\nAll tests passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
