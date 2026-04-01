"""
Wheel Strategy Risk Profiles — 3-tier configuration system.

Defines SAFE, STANDARD, and AGGRESSIVE profiles that control:
- Delta targets for CSPs and CCs
- DTE range
- Early close threshold
- Ticker universe
- Position limits and portfolio risk caps
- Yield targets
- Per-ticker optimal CC parameters (from weekly_cc_sweep results)

Usage:
    from risk_profiles import RISK_PROFILES, get_profile, get_ticker_cc_params
    profile = get_profile('aggressive')
    cc_params = get_ticker_cc_params('PLTR', 'standard')
"""

RISK_PROFILES = {
    'safe': {
        'name': 'SAFE',
        'description': 'Conservative blue-chip income. Minimize assignment risk.',

        # Delta targets
        'csp_delta_min': 0.15,
        'csp_delta_max': 0.20,
        'csp_delta_target': 0.175,  # midpoint for scanning
        'cc_delta_min': 0.20,
        'cc_delta_max': 0.25,
        'cc_delta_target': 0.225,

        # DTE
        'dte_min': 30,
        'dte_max': 45,
        'target_dte': 37,  # midpoint
        'cc_dte': 10,      # safe uses longer CC DTE
        'cc_roll_strategy': 'let_expire',

        # Early close
        'early_close_pct': 0.50,  # Close at 50% profit

        # Ticker universe — stable blue chips only
        'tickers': [
            'BAC', 'C', 'JPM', 'KO', 'PEP',
            'JNJ', 'PG', 'XOM', 'CVX', 'WMT',
        ],

        # Position limits
        'max_positions': 5,
        'max_position_pct': 0.25,        # 25% max per position
        'max_portfolio_risk_pct': 0.15,   # 15% of capital at risk
        'max_per_sector': 2,
        'cash_reserve_pct': 0.10,         # 10% cash reserve

        # Yield targets
        'target_weekly_yield_min': 0.005,  # 0.5%
        'target_weekly_yield_max': 0.012,  # 1.2%

        # Scoring weights (for score_candidate)
        'scoring_weights': {
            'yield_efficiency': 1.5,
            'yield_bonus': 1.0,
            'delta_score': 4.0,    # Heavily weight delta safety
            'spread_score': 2.5,   # Liquidity matters more
        },

        # IV penalty thresholds
        'iv_danger_threshold': 80,   # Avoid high IV stocks
        'iv_warning_threshold': 60,

        # Sizing
        'iv_high_contracts_cap': 1,     # Max 1 contract on high IV
        'iv_medium_contracts_cap': 2,
    },

    'standard': {
        'name': 'STANDARD',
        'description': 'Balanced risk/reward. Sweep-optimized CC params (d=0.30, 7DTE, 75% EC).',

        # Delta targets
        'csp_delta_min': 0.25,
        'csp_delta_max': 0.30,
        'csp_delta_target': 0.275,
        # CC params updated from weekly_cc_sweep best overall config
        'cc_delta_min': 0.25,
        'cc_delta_max': 0.35,
        'cc_delta_target': 0.30,   # sweep: delta 0.30 best Sharpe

        # DTE — sweep found 7DTE optimal for CCs
        'dte_min': 7,
        'dte_max': 30,
        'target_dte': 14,          # CSP DTE stays moderate
        'cc_dte': 7,               # CC DTE from sweep
        'cc_roll_strategy': 'let_expire',  # sweep: let_expire best

        # Early close — sweep found 75% optimal
        'early_close_pct': 0.75,   # updated from 0.50 per sweep

        # Ticker universe — balanced mix
        'tickers': [
            'DAL', 'BAC', 'C', 'AAL', 'HOOD', 'F', 'PLTR', 'AMD',
            'SOFI', 'NIO', 'JPM', 'KO', 'PEP', 'JNJ', 'PG', 'XOM',
            'CVX', 'WMT', 'INTC', 'T',
        ],

        # Position limits
        'max_positions': 7,
        'max_position_pct': 0.30,
        'max_portfolio_risk_pct': 0.25,
        'max_per_sector': 2,
        'cash_reserve_pct': 0.05,

        # Yield targets
        'target_weekly_yield_min': 0.010,  # 1.0%
        'target_weekly_yield_max': 0.020,  # 2.0%

        # Scoring weights
        'scoring_weights': {
            'yield_efficiency': 3.0,
            'yield_bonus': 2.0,
            'delta_score': 1.5,
            'spread_score': 1.5,
        },

        # IV thresholds
        'iv_danger_threshold': 150,
        'iv_warning_threshold': 100,

        # Sizing
        'iv_high_contracts_cap': 2,
        'iv_medium_contracts_cap': 3,
    },

    'aggressive': {
        'name': 'AGGRESSIVE',
        'description': 'High premium, weekly expirations, sweep-optimized for max return.',

        # Delta targets — sweep: higher deltas = more premium, more assignment
        'csp_delta_min': 0.35,
        'csp_delta_max': 0.45,
        'csp_delta_target': 0.40,
        # CC params: aggressive uses higher delta from sweep high-return configs
        'cc_delta_min': 0.35,
        'cc_delta_max': 0.50,
        'cc_delta_target': 0.40,   # sweep: d=0.40 high return configs

        # DTE — sweep: 7DTE optimal, aggressive can go shorter
        'dte_min': 5,
        'dte_max': 14,
        'target_dte': 7,
        'cc_dte': 7,               # sweep optimal
        'cc_roll_strategy': 'let_expire',

        # Early close — sweep: 75% optimal across all configs
        'early_close_pct': 0.75,

        # Ticker universe — high IV growth/meme stocks
        'tickers': [
            'HOOD', 'PLTR', 'AMD', 'SOFI', 'NIO', 'MARA', 'RIOT',
            'COIN', 'TSLA', 'NVDA', 'GME', 'AMC',
        ],

        # Position limits
        'max_positions': 10,
        'max_position_pct': 0.20,         # Smaller per position since more volatile
        'max_portfolio_risk_pct': 0.40,
        'max_per_sector': 3,
        'cash_reserve_pct': 0.03,

        # Yield targets
        'target_weekly_yield_min': 0.015,  # 1.5%
        'target_weekly_yield_max': 0.035,  # 3.5%

        # Scoring weights
        'scoring_weights': {
            'yield_efficiency': 4.0,   # Maximize yield
            'yield_bonus': 2.5,
            'delta_score': 0.5,        # Don't penalize high delta
            'spread_score': 1.0,
        },

        # IV thresholds — more permissive
        'iv_danger_threshold': 200,
        'iv_warning_threshold': 150,

        # Sizing — allow more contracts even on high IV
        'iv_high_contracts_cap': 3,
        'iv_medium_contracts_cap': 5,
    },
}

# Valid mode names
VALID_MODES = list(RISK_PROFILES.keys())


def get_profile(mode='standard'):
    """
    Get a risk profile by name.

    Args:
        mode: 'safe', 'standard', or 'aggressive'

    Returns:
        dict with all profile parameters

    Raises:
        ValueError if mode is not recognized
    """
    mode = mode.lower().strip()
    if mode not in RISK_PROFILES:
        raise ValueError(
            f"Unknown risk mode '{mode}'. Valid modes: {', '.join(VALID_MODES)}"
        )
    return RISK_PROFILES[mode]


def list_profiles():
    """Return a formatted summary of all risk profiles."""
    lines = ["Wheel Strategy Risk Profiles:", ""]
    for mode, p in RISK_PROFILES.items():
        lines.append(f"  {p['name']:12s} — {p['description']}")
        lines.append(f"    CSP delta: {p['csp_delta_min']:.2f}-{p['csp_delta_max']:.2f} | "
                     f"CC delta: {p['cc_delta_min']:.2f}-{p['cc_delta_max']:.2f} | "
                     f"DTE: {p['dte_min']}-{p['dte_max']}d")
        cc_dte = p.get('cc_dte', p['target_dte'])
        roll = p.get('cc_roll_strategy', 'let_expire')
        ec = p.get('early_close_pct', 0.50)
        lines.append(f"    CC DTE: {cc_dte}d | Early close: {ec*100:.0f}% | Roll: {roll}")
        lines.append(f"    Max positions: {p['max_positions']} | "
                     f"Portfolio risk: {p['max_portfolio_risk_pct']*100:.0f}% | "
                     f"Target: {p['target_weekly_yield_min']*100:.1f}-{p['target_weekly_yield_max']*100:.1f}%/wk")
        lines.append(f"    Tickers: {', '.join(p['tickers'][:6])}{'...' if len(p['tickers']) > 6 else ''}")
        lines.append("")
    return "\n".join(lines)


# ── Per-Ticker Optimal CC Parameters (from weekly_cc_sweep results) ──────────
#
# Best config per ticker by Sharpe, from sweep across
# [0.15-0.50 delta] x [3,5,7,10 DTE] x [50%,65%,75%,None EC] x [roll_down,roll_out,let_expire]
# These override the profile defaults when available.

PER_TICKER_CC_PARAMS = {
    # Tech — generally prefer lower CC delta to avoid capping upside
    'AAPL':  {'cc_delta': 0.25, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'MSFT':  {'cc_delta': 0.25, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'GOOGL': {'cc_delta': 0.25, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'META':  {'cc_delta': 0.25, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'AMZN':  {'cc_delta': 0.25, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'NVDA':  {'cc_delta': 0.20, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'AMD':   {'cc_delta': 0.30, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'INTC':  {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'PLTR':  {'cc_delta': 0.30, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},

    # Finance — slightly higher delta, less momentum
    'JPM':   {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'BAC':   {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'C':     {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'WFC':   {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'SOFI':  {'cc_delta': 0.30, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'HOOD':  {'cc_delta': 0.30, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},

    # Consumer / stable — higher delta OK, less upside risk
    'KO':    {'cc_delta': 0.40, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'PEP':   {'cc_delta': 0.40, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'PG':    {'cc_delta': 0.40, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'JNJ':   {'cc_delta': 0.40, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'WMT':   {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'T':     {'cc_delta': 0.40, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},

    # Energy — moderate delta
    'XOM':   {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'CVX':   {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'COP':   {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},

    # EV/Auto — lower delta, very volatile
    'TSLA':  {'cc_delta': 0.20, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'F':     {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'NIO':   {'cc_delta': 0.30, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'RIVN':  {'cc_delta': 0.30, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},

    # Airlines
    'DAL':   {'cc_delta': 0.30, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'AAL':   {'cc_delta': 0.30, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},

    # Crypto-adjacent — very high IV, lower delta to avoid assignment
    'COIN':  {'cc_delta': 0.25, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'MARA':  {'cc_delta': 0.25, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'RIOT':  {'cc_delta': 0.25, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},

    # REITs — stable, higher delta
    'O':     {'cc_delta': 0.40, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'AGNC':  {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
    'NLY':   {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},

    # Healthcare
    'PFE':   {'cc_delta': 0.35, 'cc_dte': 7,  'early_close': 0.75, 'roll': 'let_expire'},
}


def get_ticker_cc_params(ticker, mode='standard'):
    """
    Get CC parameters for a specific ticker, with per-ticker overrides
    from sweep results falling back to profile defaults.

    Args:
        ticker: stock symbol
        mode: risk profile name

    Returns:
        dict with 'cc_delta', 'cc_dte', 'early_close', 'roll'
    """
    profile = get_profile(mode)
    defaults = {
        'cc_delta': profile['cc_delta_target'],
        'cc_dte': profile.get('cc_dte', profile['target_dte']),
        'early_close': profile['early_close_pct'],
        'roll': profile.get('cc_roll_strategy', 'let_expire'),
    }

    ticker_params = PER_TICKER_CC_PARAMS.get(ticker.upper())
    if ticker_params is None:
        return defaults

    # Merge: per-ticker overrides profile defaults
    result = defaults.copy()
    result.update(ticker_params)

    # For aggressive mode, bump delta up slightly from per-ticker base
    if mode == 'aggressive':
        result['cc_delta'] = round(min(0.50, result['cc_delta'] + 0.05), 2)

    # For safe mode, reduce delta from per-ticker base
    if mode == 'safe':
        result['cc_delta'] = round(max(0.15, result['cc_delta'] - 0.10), 2)

    return result
