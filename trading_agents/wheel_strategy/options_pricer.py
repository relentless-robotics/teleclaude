"""
Options pricing engine for wheel strategy.
Black-Scholes pricing, Greeks, IV solver, and optimal strike/DTE selection.
"""

import math
import numpy as np
from scipy.stats import norm
from scipy.optimize import brentq


def black_scholes(S, K, T, r, sigma, option_type="put"):
    """
    Black-Scholes option pricing.

    Args:
        S: Current stock price
        K: Strike price
        T: Time to expiration in years
        r: Risk-free interest rate (annual)
        sigma: Implied volatility (annual)
        option_type: "put" or "call"

    Returns:
        Option price
    """
    if T <= 0 or sigma <= 0:
        # At or past expiration
        if option_type == "put":
            return max(K - S, 0)
        else:
            return max(S - K, 0)

    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)

    if option_type == "call":
        price = S * norm.cdf(d1) - K * math.exp(-r * T) * norm.cdf(d2)
    else:  # put
        price = K * math.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1)

    return max(price, 0)


def greeks(S, K, T, r, sigma, option_type="put"):
    """
    Calculate option Greeks.

    Returns:
        dict with delta, gamma, theta, vega, rho
    """
    if T <= 0 or sigma <= 0:
        intrinsic = max(K - S, 0) if option_type == "put" else max(S - K, 0)
        return {
            "delta": -1.0 if (option_type == "put" and S < K) else (1.0 if (option_type == "call" and S > K) else 0.0),
            "gamma": 0.0,
            "theta": 0.0,
            "vega": 0.0,
            "rho": 0.0,
        }

    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)

    # Gamma (same for puts and calls)
    gamma = norm.pdf(d1) / (S * sigma * math.sqrt(T))

    # Vega (same for puts and calls, per 1% move in vol)
    vega = S * norm.pdf(d1) * math.sqrt(T) / 100

    if option_type == "call":
        delta = norm.cdf(d1)
        theta = (-(S * norm.pdf(d1) * sigma) / (2 * math.sqrt(T))
                 - r * K * math.exp(-r * T) * norm.cdf(d2)) / 365
        rho = K * T * math.exp(-r * T) * norm.cdf(d2) / 100
    else:  # put
        delta = norm.cdf(d1) - 1
        theta = (-(S * norm.pdf(d1) * sigma) / (2 * math.sqrt(T))
                 + r * K * math.exp(-r * T) * norm.cdf(-d2)) / 365
        rho = -K * T * math.exp(-r * T) * norm.cdf(-d2) / 100

    return {
        "delta": round(delta, 4),
        "gamma": round(gamma, 6),
        "theta": round(theta, 4),
        "vega": round(vega, 4),
        "rho": round(rho, 4),
    }


def implied_volatility(market_price, S, K, T, r, option_type="put",
                        tol=1e-6, max_iter=100):
    """
    Solve for implied volatility using Brent's method.

    Args:
        market_price: observed option price
        S, K, T, r: Black-Scholes parameters
        option_type: "put" or "call"

    Returns:
        Implied volatility (annual), or None if no solution
    """
    if T <= 0:
        return None

    intrinsic = max(K - S, 0) if option_type == "put" else max(S - K, 0)
    if market_price < intrinsic:
        return None

    def objective(sigma):
        return black_scholes(S, K, T, r, sigma, option_type) - market_price

    try:
        iv = brentq(objective, 0.001, 5.0, xtol=tol, maxiter=max_iter)
        return iv
    except (ValueError, RuntimeError):
        return None


def premium_analysis(S, K, T, r, sigma, option_type="put"):
    """
    Analyze premium for wheel strategy context.

    Returns:
        dict with premium details relevant to CSP/CC decisions.
    """
    premium = black_scholes(S, K, T, r, sigma, option_type)
    g = greeks(S, K, T, r, sigma, option_type)

    # Capital required
    if option_type == "put":
        capital = K * 100  # Cash to secure the put
        breakeven = K - premium
    else:
        capital = S * 100  # Cost of 100 shares (already owned in CC)
        breakeven = S + premium  # Effective sell price if called

    # Annualized return on capital
    days_to_exp = T * 365
    if days_to_exp > 0 and capital > 0:
        period_return = (premium * 100) / capital
        annualized_return = period_return * (365 / days_to_exp)
    else:
        period_return = 0
        annualized_return = 0

    return {
        "premium_per_share": round(premium, 2),
        "premium_per_contract": round(premium * 100, 2),
        "capital_required": round(capital, 2),
        "breakeven": round(breakeven, 2),
        "period_return_pct": round(period_return * 100, 2),
        "annualized_return_pct": round(annualized_return * 100, 2),
        "delta": g["delta"],
        "theta": g["theta"],
        "theta_per_contract": round(g["theta"] * 100, 2),
        "days_to_expiry": round(days_to_exp),
    }


def find_strike_by_delta(S, T, r, sigma, target_delta, option_type="put",
                          tol=0.005):
    """
    Find the strike price that gives approximately the target delta.

    Args:
        S: stock price
        T: time to expiry (years)
        r: risk-free rate
        sigma: implied volatility
        target_delta: desired delta (negative for puts, positive for calls)
        option_type: "put" or "call"
        tol: delta tolerance

    Returns:
        Strike price closest to target delta
    """
    if option_type == "put":
        # For puts, delta is negative. Target should be negative.
        if target_delta > 0:
            target_delta = -target_delta

    # Search over a range of strikes
    low_k = S * 0.70
    high_k = S * 1.30
    best_k = S
    best_diff = float("inf")

    # Coarse search
    for k in np.linspace(low_k, high_k, 200):
        g = greeks(S, k, T, r, sigma, option_type)
        diff = abs(g["delta"] - target_delta)
        if diff < best_diff:
            best_diff = diff
            best_k = k

    # Round to nearest dollar (standard strikes)
    best_k = round(best_k)

    # Fine search around best strike
    for k in np.linspace(best_k - 5, best_k + 5, 100):
        k_rounded = round(k, 0)
        g = greeks(S, k_rounded, T, r, sigma, option_type)
        diff = abs(g["delta"] - target_delta)
        if diff < best_diff:
            best_diff = diff
            best_k = k_rounded

    return best_k


def optimal_csp_strike(S, sigma, r=0.05, dte=35):
    """
    Find optimal CSP strike for wheel strategy.
    Target: 0.20-0.35 delta puts, 30-45 DTE.

    Returns:
        dict with strike info for different delta targets
    """
    T = dte / 365.0
    results = []

    for target_delta in [0.20, 0.25, 0.30, 0.35]:
        strike = find_strike_by_delta(S, T, r, sigma, -target_delta, "put")
        analysis = premium_analysis(S, strike, T, r, sigma, "put")
        g = greeks(S, strike, T, r, sigma, "put")

        results.append({
            "target_delta": target_delta,
            "strike": strike,
            "actual_delta": abs(g["delta"]),
            "premium": analysis["premium_per_share"],
            "annualized_return_pct": analysis["annualized_return_pct"],
            "breakeven": analysis["breakeven"],
            "otm_pct": round((S - strike) / S * 100, 1),
        })

    return results


def optimal_cc_strike(S, cost_basis, sigma, r=0.05, dte=35):
    """
    Find optimal CC strike for wheel strategy.
    Target: 0.25-0.40 delta calls, ideally above cost basis.

    Returns:
        dict with strike info for different delta targets
    """
    T = dte / 365.0
    results = []

    for target_delta in [0.25, 0.30, 0.35, 0.40]:
        strike = find_strike_by_delta(S, T, r, sigma, target_delta, "call")
        analysis = premium_analysis(S, strike, T, r, sigma, "call")
        g = greeks(S, strike, T, r, sigma, "call")

        # Would being called away be profitable vs cost basis?
        gain_if_called = (strike - cost_basis + analysis["premium_per_share"])
        gain_pct = gain_if_called / cost_basis * 100 if cost_basis > 0 else 0

        results.append({
            "target_delta": target_delta,
            "strike": strike,
            "actual_delta": g["delta"],
            "premium": analysis["premium_per_share"],
            "annualized_return_pct": analysis["annualized_return_pct"],
            "above_cost_basis": strike >= cost_basis,
            "gain_if_called_pct": round(gain_pct, 2),
        })

    return results


def estimate_hist_iv(hist_returns, lookback=30, iv_premium=1.2):
    """
    Estimate implied volatility from historical returns.
    IV is typically higher than HV (volatility risk premium).

    Args:
        hist_returns: array of daily returns
        lookback: window for realized vol calculation
        iv_premium: IV/HV ratio (typically 1.1-1.3)

    Returns:
        Estimated IV (annual)
    """
    if len(hist_returns) < lookback:
        lookback = max(5, len(hist_returns))

    recent = hist_returns[-lookback:]
    hv = np.std(recent) * np.sqrt(252)
    iv = hv * iv_premium
    return max(iv, 0.05)  # Floor at 5% IV


if __name__ == "__main__":
    # Example: AAPL at $230
    S = 230
    sigma = 0.25
    r = 0.05

    print("=== CSP Strike Analysis (AAPL @ $230, IV=25%) ===\n")
    csp_strikes = optimal_csp_strike(S, sigma, r, dte=35)
    for s in csp_strikes:
        print(f"  Delta {s['target_delta']:.2f}: Strike ${s['strike']:.0f} "
              f"({s['otm_pct']:.1f}% OTM), Premium ${s['premium']:.2f}, "
              f"Ann. Return {s['annualized_return_pct']:.1f}%, "
              f"Breakeven ${s['breakeven']:.2f}")

    print(f"\n=== CC Strike Analysis (AAPL @ $230, cost basis $220) ===\n")
    cc_strikes = optimal_cc_strike(S, 220, sigma, r, dte=35)
    for s in cc_strikes:
        print(f"  Delta {s['target_delta']:.2f}: Strike ${s['strike']:.0f}, "
              f"Premium ${s['premium']:.2f}, "
              f"Ann. Return {s['annualized_return_pct']:.1f}%, "
              f"Above basis: {s['above_cost_basis']}, "
              f"Gain if called: {s['gain_if_called_pct']:.1f}%")
