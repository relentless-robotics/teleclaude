#!/usr/bin/env python3
"""
Wheel Strategy Full Automation Pipeline.

Orchestrates the complete weekly wheel cycle: portfolio optimization,
order execution, daily monitoring, assignment handling, and Friday
expiry management. Designed to be called by the JS scheduler agent.

CLI Modes:
    python automation.py --morning       Monday morning: optimize + submit CSPs
    python automation.py --daily         Daily monitoring: fills, assignments, early close
    python automation.py --friday        Friday expiry management
    python automation.py --weekly-report Weekly P&L summary
    python automation.py --status        Current state overview
"""

import argparse
import json
import os
import sys
import traceback
from datetime import datetime, date, timedelta
from pathlib import Path

# ── Path setup ────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / 'data'
DATA_DIR.mkdir(parents=True, exist_ok=True)

AUTOMATION_STATE_FILE = DATA_DIR / 'wheel_automation_state.json'

sys.path.insert(0, str(SCRIPT_DIR))
from paper_executor import (
    AlpacaPaperClient, WheelPaperExecutor, build_occ_symbol,
    parse_occ_symbol, log_trade, load_positions, save_positions,
)
from portfolio_optimizer import PortfolioOptimizer, format_portfolio_discord
from alpaca_options import AlpacaOptionsClient

# ── Load .env ─────────────────────────────────────────────────────────────────
ENV_FILE = SCRIPT_DIR.parents[1] / '.env'
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            v = v.strip().strip("'\"")
            if k.strip() not in os.environ:
                os.environ[k.strip()] = v


# ── Automation State ──────────────────────────────────────────────────────────

def load_automation_state():
    """Load the automation state from disk."""
    if AUTOMATION_STATE_FILE.exists():
        try:
            with open(AUTOMATION_STATE_FILE, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return _default_automation_state()


def save_automation_state(state):
    """Persist automation state to disk."""
    state['last_updated'] = datetime.now().isoformat()
    with open(AUTOMATION_STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)


def _default_automation_state():
    return {
        'last_updated': None,
        'last_morning_run': None,
        'last_daily_run': None,
        'last_friday_run': None,
        'last_weekly_report': None,
        'positions': [],
        'assignment_history': [],
        'weekly_pnl': [],
        'cumulative_premium_collected': 0.0,
        'cumulative_realized_pnl': 0.0,
        'cumulative_assignment_count': 0,
        'cumulative_expiry_count': 0,
        'week_start_equity': None,
        'week_start_date': None,
    }


# ── Discord Output Helpers ────────────────────────────────────────────────────

def discord_msg(title, lines, urgent=False):
    """Build a Discord message with code block formatting.
    Returns a string under 2000 chars.
    """
    prefix = '🚨 ' if urgent else ''
    header = f"{prefix}**{title}**"
    body = '\n'.join(lines)
    msg = f"{header}\n{body}"
    if len(msg) > 1950:
        msg = msg[:1950] + '\n...(truncated)'
    return msg


def format_position_table(positions):
    """Format positions into a compact code-block table."""
    if not positions:
        return '```\nNo active positions.\n```'
    lines = ['```']
    lines.append(f"{'Tkr':<6s} {'Phase':<4s} {'Strike':>7s} {'Exp':>10s} "
                 f"{'Cts':>3s} {'Prem':>7s} {'Status':<10s}")
    lines.append('-' * 55)
    for p in positions:
        ph = {'CSP': 'P', 'CC': 'C', 'CC_PENDING': 'A', 'COMPLETE': 'D'}.get(
            p.get('phase', ''), '?')
        lines.append(
            f"{p['ticker']:<6s} [{ph}]  "
            f"${p['strike']:>5.0f} {p['expiry']:>10s} "
            f"{p['contracts']:>3d} "
            f"${p.get('total_premium', 0):>5.0f} "
            f"{p.get('status', '?'):<10s}"
        )
    lines.append('```')
    return '\n'.join(lines)


# ── Core Automation Class ─────────────────────────────────────────────────────

class WheelAutomation:
    """
    Full automation pipeline for the wheel strategy.

    Coordinates portfolio_optimizer, paper_executor, and alpaca_options
    into a cohesive weekly cycle.
    """

    def __init__(self):
        self.client = AlpacaPaperClient()
        self.executor = WheelPaperExecutor(dry_run=False)
        self.auto_state = load_automation_state()

    def _save(self):
        save_automation_state(self.auto_state)
        self.executor.save()

    def _get_account_summary(self):
        """Get account equity, buying power, cash."""
        acct = self.client.get_account()
        return {
            'equity': float(acct.get('equity', 0)),
            'buying_power': float(acct.get('buying_power', 0)),
            'cash': float(acct.get('cash', 0)),
            'portfolio_value': float(acct.get('portfolio_value', 0)),
        }

    # ══════════════════════════════════════════════════════════════════════
    # MONDAY MORNING: Optimize + Submit
    # ══════════════════════════════════════════════════════════════════════

    def morning(self):
        """
        Monday morning routine:
        1. Check account status and buying power
        2. Run portfolio optimizer with fresh prices
        3. Review expiring/expired positions from last week
        4. Submit new CSP orders
        5. Return Discord summary
        """
        output_lines = []

        # 1. Account status
        try:
            acct = self._get_account_summary()
        except Exception as e:
            return discord_msg('Wheel Morning — ERROR', [
                f'Failed to connect to Alpaca: {e}'
            ], urgent=True)

        output_lines.append(
            f"Account: ${acct['equity']:,.0f} equity | "
            f"${acct['buying_power']:,.0f} buying power"
        )

        # Record week start equity if not set
        today_str = date.today().isoformat()
        if (not self.auto_state.get('week_start_date')
                or self.auto_state['week_start_date'] != today_str):
            self.auto_state['week_start_equity'] = acct['equity']
            self.auto_state['week_start_date'] = today_str

        # 2. Clean up expired/cancelled positions from last week
        cleanup_count = self._cleanup_expired_positions()
        if cleanup_count > 0:
            output_lines.append(f"Cleaned up {cleanup_count} expired/cancelled positions")

        # 3. Run portfolio optimizer
        output_lines.append('')
        output_lines.append('Running portfolio optimizer...')
        try:
            optimizer = PortfolioOptimizer(
                capital=acct['buying_power'],
                conservative=False,
            )
            result = optimizer.run(max_dte=14)
            if result:
                positions = result.get('positions', [])
                agg = result.get('aggregate', {})
                output_lines.append(
                    f"Found {agg.get('num_positions', 0)} positions | "
                    f"Premium: ${agg.get('total_premium', 0):,.0f} | "
                    f"Weekly yield: {agg.get('weekly_yield_on_deployed', 0):.2f}%"
                )
            else:
                output_lines.append('Optimizer returned no positions (market closed?)')
                self.auto_state['last_morning_run'] = datetime.now().isoformat()
                self._save()
                return discord_msg('Wheel Monday Morning', output_lines)
        except Exception as e:
            output_lines.append(f'Optimizer error: {e}')
            self.auto_state['last_morning_run'] = datetime.now().isoformat()
            self._save()
            return discord_msg('Wheel Monday Morning — Partial', output_lines)

        # 4. Submit CSP orders via executor
        output_lines.append('')
        output_lines.append('Submitting CSP orders...')
        try:
            exec_result = self.executor.execute()
            if exec_result:
                output_lines.append(
                    f"Submitted: {exec_result['submitted']} | "
                    f"Skipped: {exec_result['skipped']} | "
                    f"Errors: {exec_result['errors']} | "
                    f"Collateral: ${exec_result['collateral']:,.0f}"
                )
            # Sync our automation state with executor positions
            self._sync_positions_from_executor()
        except Exception as e:
            output_lines.append(f'Execution error: {e}')

        # 5. Portfolio summary (short Discord format)
        if result:
            discord_portfolio = format_portfolio_discord(result)
            # Append just the position list, not full header
            portfolio_lines = discord_portfolio.split('\n')
            # Take the code block portion
            in_code = False
            for line in portfolio_lines:
                if line.strip() == '```' and not in_code:
                    in_code = True
                    output_lines.append(line)
                elif line.strip() == '```' and in_code:
                    output_lines.append(line)
                    in_code = False
                elif in_code:
                    output_lines.append(line)

        self.auto_state['last_morning_run'] = datetime.now().isoformat()
        self._save()

        log_trade('MORNING_RUN', {
            'equity': acct['equity'],
            'buying_power': acct['buying_power'],
            'positions_submitted': exec_result['submitted'] if exec_result else 0,
        })

        return discord_msg('Wheel Monday Morning', output_lines)

    # ══════════════════════════════════════════════════════════════════════
    # DAILY MONITORING
    # ══════════════════════════════════════════════════════════════════════

    def daily(self):
        """
        Daily monitoring routine:
        1. Sync order statuses (check for fills)
        2. Check for assignments (stock appeared)
        3. For assigned stock: scan and sell covered call
        4. Check for early close opportunities (>50% profit)
        5. Alert on positions > 25% loss
        6. Return Discord summary
        """
        output_lines = []
        alerts_list = []

        # Account snapshot
        try:
            acct = self._get_account_summary()
            output_lines.append(
                f"Account: ${acct['equity']:,.0f} equity | "
                f"${acct['buying_power']:,.0f} BP"
            )
        except Exception as e:
            return discord_msg('Wheel Daily — ERROR', [
                f'Account check failed: {e}'
            ], urgent=True)

        # 1. Sync order statuses via executor
        output_lines.append('')
        try:
            actions = self.executor.monitor()
            if actions:
                output_lines.append(f'Actions detected: {len(actions)}')
                for a in actions:
                    action_type = a.get('action', '?')
                    ticker = a.get('ticker', '?')
                    detail = a.get('detail', '')

                    if action_type == 'ASSIGNMENT':
                        alerts_list.append(f'🔴 ASSIGNED: {ticker} — {detail}')
                        self.auto_state['cumulative_assignment_count'] += 1
                        self.auto_state['assignment_history'].append({
                            'date': date.today().isoformat(),
                            'ticker': ticker,
                            'detail': detail,
                        })
                    elif action_type == 'CALLED_AWAY':
                        alerts_list.append(f'🟢 CALLED AWAY: {ticker} — {detail}')
                    elif action_type == 'CC_SUBMITTED':
                        alerts_list.append(f'📝 CC SOLD: {ticker} — {detail}')
                    elif action_type == 'NEAR_EXPIRY':
                        alerts_list.append(f'⏰ EXPIRING: {ticker} — {detail}')
                    else:
                        output_lines.append(f'  [{action_type}] {ticker}: {detail}')
            else:
                output_lines.append('No actions needed.')
        except Exception as e:
            output_lines.append(f'Monitor error: {e}')

        # 2. Check for early close opportunities (>50% profit)
        # NOTE: Do NOT auto-close. Alert only — user decides whether to close
        # early or let theta continue working. Some positions worth holding.
        early_close_candidates = self._check_early_close()
        if early_close_candidates:
            output_lines.append('')
            output_lines.append(f'Early close candidates ({len(early_close_candidates)}):')
            for ec in early_close_candidates:
                pct = ec.get('profit_pct', 0)
                output_lines.append(
                    f"  {ec['ticker']} {ec['phase']} ${ec['strike']} "
                    f"— {pct:.0f}% profit captured"
                )
                if pct >= 50:
                    alerts_list.append(
                        f"EARLY CLOSE OPPORTUNITY: {ec['ticker']} at {pct:.0f}% profit — consider closing"
                    )

        # 3. Check for positions at >25% loss
        loss_alerts = self._check_loss_alerts()
        for la in loss_alerts:
            alerts_list.append(
                f"⚠️ LOSS ALERT: {la['ticker']} {la['phase']} "
                f"${la['strike']} — {la['loss_pct']:.0f}% loss (consider roll)"
            )

        # 4. Position summary
        self._sync_positions_from_executor()
        active = [p for p in self.executor.state.get('positions', [])
                  if p.get('status') not in ('cancelled', 'closed', 'emergency_closed')]
        if active:
            output_lines.append('')
            output_lines.append(format_position_table(active))

        # 5. Build alerts section
        if alerts_list:
            output_lines.append('')
            for alert in alerts_list:
                output_lines.append(alert)

        self.auto_state['last_daily_run'] = datetime.now().isoformat()
        self._save()

        return discord_msg('Wheel Daily Check', output_lines,
                           urgent=bool(alerts_list))

    # ══════════════════════════════════════════════════════════════════════
    # FRIDAY EXPIRY MANAGEMENT
    # ══════════════════════════════════════════════════════════════════════

    def friday(self):
        """
        Friday expiry management:
        1. Review positions expiring today
        2. Close ITM positions to avoid unwanted assignment (optional)
        3. Let OTM positions expire worthless (keep premium)
        4. Calculate weekly P&L
        5. Return Discord summary
        """
        output_lines = []
        today = date.today()

        try:
            acct = self._get_account_summary()
            output_lines.append(
                f"Account: ${acct['equity']:,.0f} equity | "
                f"${acct['buying_power']:,.0f} BP"
            )
        except Exception as e:
            return discord_msg('Wheel Friday — ERROR', [
                f'Account check failed: {e}'
            ], urgent=True)

        # 1. Sync all statuses first
        try:
            self.executor.monitor()
        except Exception:
            pass

        # 2. Find expiring positions
        expiring_today = []
        expiring_soon = []  # within 1 day
        for pos in self.executor.state.get('positions', []):
            if pos.get('status') in ('cancelled', 'closed', 'emergency_closed'):
                continue
            try:
                exp = date.fromisoformat(pos['expiry'])
            except (ValueError, KeyError):
                continue
            dte = (exp - today).days
            if dte == 0:
                expiring_today.append(pos)
            elif dte == 1:
                expiring_soon.append(pos)

        output_lines.append(
            f"\nExpiring today: {len(expiring_today)} | "
            f"Tomorrow: {len(expiring_soon)}"
        )

        # 3. Process expiring positions
        closed_itm = 0
        expired_otm = 0
        for pos in expiring_today:
            ticker = pos['ticker']
            strike = pos['strike']
            phase = pos.get('phase', 'CSP')

            # Get current price to determine ITM/OTM
            try:
                quote = self.client.get_latest_trade(ticker)
                current_price = float(quote.get('p', 0))
            except Exception:
                current_price = 0

            if current_price <= 0:
                output_lines.append(
                    f"  {ticker} ${strike} {phase} — cannot get price, letting expire"
                )
                continue

            itm = False
            if phase == 'CSP' and current_price < strike:
                itm = True
            elif phase == 'CC' and current_price > strike:
                itm = True

            if itm:
                # ITM — will be assigned. Log it and let assignment happen
                # (closing ITM options near expiry is usually worse than assignment)
                output_lines.append(
                    f"  ⚠️ {ticker} ${strike} {phase} — ITM (price=${current_price:.2f}). "
                    f"Will be assigned."
                )
                if phase == 'CSP':
                    pos['expected_assignment'] = True
                    output_lines.append(
                        f"    → Will receive {pos['contracts'] * 100} shares "
                        f"@ ${strike:.2f} (net basis: "
                        f"${strike - pos.get('fill_price', pos.get('limit_price', 0)):.2f})"
                    )
            else:
                # OTM — expires worthless, we keep the premium
                output_lines.append(
                    f"  ✅ {ticker} ${strike} {phase} — OTM (price=${current_price:.2f}). "
                    f"Expires worthless. Premium kept: ${pos.get('total_premium', 0):,.0f}"
                )
                expired_otm += 1
                self.auto_state['cumulative_expiry_count'] += 1

                # Mark as expired
                pos['status'] = 'expired'
                pos['expired_at'] = datetime.now().isoformat()
                pos['realized_pnl'] = pos.get('total_premium', 0)
                self.executor.state['total_realized_pnl'] += pos.get('total_premium', 0)
                self.executor.state['closed_positions'].append(pos.copy())
                self.auto_state['cumulative_realized_pnl'] += pos.get('total_premium', 0)

                log_trade('EXPIRED_OTM', {
                    'ticker': ticker,
                    'strike': strike,
                    'phase': phase,
                    'premium_kept': pos.get('total_premium', 0),
                })

        # Remove expired from active list
        self.executor.state['positions'] = [
            p for p in self.executor.state['positions']
            if p.get('status') not in ('expired', 'closed')
        ]

        # 4. Weekly P&L calculation
        week_pnl = self._calculate_weekly_pnl(acct)
        if week_pnl is not None:
            output_lines.append('')
            output_lines.append(f"**Weekly P&L: ${week_pnl:+,.2f}**")

            self.auto_state['weekly_pnl'].append({
                'week_ending': today.isoformat(),
                'pnl': week_pnl,
                'equity': acct['equity'],
                'expired_otm': expired_otm,
                'assigned': closed_itm,
            })
            # Keep last 52 weeks
            if len(self.auto_state['weekly_pnl']) > 52:
                self.auto_state['weekly_pnl'] = self.auto_state['weekly_pnl'][-52:]

        # 5. Summary
        output_lines.append('')
        output_lines.append(
            f"Cumulative: "
            f"${self.auto_state['cumulative_realized_pnl']:+,.0f} realized | "
            f"{self.auto_state['cumulative_assignment_count']} assignments | "
            f"{self.auto_state['cumulative_expiry_count']} expirations"
        )

        self.auto_state['last_friday_run'] = datetime.now().isoformat()
        self._save()

        return discord_msg('Wheel Friday Expiry', output_lines)

    # ══════════════════════════════════════════════════════════════════════
    # WEEKLY REPORT
    # ══════════════════════════════════════════════════════════════════════

    def weekly_report(self):
        """
        Generate comprehensive weekly P&L report.
        Designed to run Sunday evening before the new week.
        """
        output_lines = []

        try:
            acct = self._get_account_summary()
        except Exception as e:
            return discord_msg('Wheel Weekly Report — ERROR', [
                f'Account check failed: {e}'
            ], urgent=True)

        output_lines.append(
            f"Account: ${acct['equity']:,.0f} equity | "
            f"${acct['cash']:,.0f} cash"
        )

        # Weekly P&L history
        weekly_pnl = self.auto_state.get('weekly_pnl', [])
        if weekly_pnl:
            output_lines.append('')
            output_lines.append('**Recent Weekly P&L:**')
            output_lines.append('```')
            output_lines.append(f"{'Week Ending':<12s} {'P&L':>10s} {'Equity':>12s} "
                                f"{'Exp':>4s} {'Asgn':>4s}")
            output_lines.append('-' * 48)
            for w in weekly_pnl[-8:]:  # Last 8 weeks
                output_lines.append(
                    f"{w['week_ending']:<12s} "
                    f"${w['pnl']:>+9,.2f} "
                    f"${w.get('equity', 0):>10,.0f} "
                    f"{w.get('expired_otm', 0):>4d} "
                    f"{w.get('assigned', 0):>4d}"
                )
            total_pnl = sum(w['pnl'] for w in weekly_pnl)
            avg_pnl = total_pnl / len(weekly_pnl) if weekly_pnl else 0
            output_lines.append('-' * 48)
            output_lines.append(
                f"{'TOTAL':<12s} ${total_pnl:>+9,.2f}   "
                f"Avg: ${avg_pnl:>+7,.2f}/wk"
            )
            output_lines.append('```')

        # Cumulative stats
        output_lines.append('')
        output_lines.append('**Cumulative Stats:**')
        output_lines.append(
            f"Premium collected: "
            f"${self.auto_state.get('cumulative_premium_collected', 0):,.0f}"
        )
        output_lines.append(
            f"Realized P&L: "
            f"${self.auto_state.get('cumulative_realized_pnl', 0):+,.0f}"
        )
        output_lines.append(
            f"Assignments: {self.auto_state.get('cumulative_assignment_count', 0)} | "
            f"Expirations: {self.auto_state.get('cumulative_expiry_count', 0)}"
        )

        # Assignment history (last 5)
        assignments = self.auto_state.get('assignment_history', [])
        if assignments:
            output_lines.append('')
            output_lines.append('**Recent Assignments:**')
            for a in assignments[-5:]:
                output_lines.append(
                    f"  {a.get('date', '?')}: {a.get('ticker', '?')} — "
                    f"{a.get('detail', '')}"
                )

        # Active positions
        active = [p for p in self.executor.state.get('positions', [])
                  if p.get('status') not in ('cancelled', 'closed',
                                              'emergency_closed', 'expired')]
        if active:
            output_lines.append('')
            output_lines.append(f'**Active Positions ({len(active)}):**')
            output_lines.append(format_position_table(active))

        # Yield on account
        if weekly_pnl and acct['equity'] > 0:
            recent_4wk = weekly_pnl[-4:]
            avg_4wk = sum(w['pnl'] for w in recent_4wk) / len(recent_4wk)
            ann_yield = (avg_4wk / acct['equity']) * 52 * 100
            output_lines.append(
                f"4-wk avg yield: {avg_4wk / acct['equity'] * 100:.2f}%/wk "
                f"({ann_yield:.1f}% annualized)"
            )

        self.auto_state['last_weekly_report'] = datetime.now().isoformat()
        self._save()

        return discord_msg('Wheel Weekly Report', output_lines)

    # ══════════════════════════════════════════════════════════════════════
    # STATUS OVERVIEW
    # ══════════════════════════════════════════════════════════════════════

    def status(self):
        """Current state overview — quick snapshot."""
        output_lines = []

        # Account
        try:
            acct = self._get_account_summary()
            output_lines.append(
                f"Account: ${acct['equity']:,.0f} equity | "
                f"${acct['buying_power']:,.0f} BP | "
                f"${acct['cash']:,.0f} cash"
            )
        except Exception as e:
            output_lines.append(f'Account error: {e}')

        # Last run times
        output_lines.append('')
        output_lines.append('**Last Runs:**')
        for key, label in [
            ('last_morning_run', 'Morning'),
            ('last_daily_run', 'Daily'),
            ('last_friday_run', 'Friday'),
            ('last_weekly_report', 'Report'),
        ]:
            val = self.auto_state.get(key)
            if val:
                try:
                    dt = datetime.fromisoformat(val)
                    output_lines.append(f"  {label}: {dt.strftime('%m/%d %H:%M')}")
                except ValueError:
                    output_lines.append(f"  {label}: {val}")
            else:
                output_lines.append(f"  {label}: never")

        # Broker positions (from Alpaca directly)
        try:
            broker_positions = self.client.get_positions()
            if broker_positions:
                output_lines.append('')
                output_lines.append(f'**Broker Positions ({len(broker_positions)}):**')
                output_lines.append('```')
                for p in broker_positions:
                    sym = p.get('symbol', '?')
                    qty = p.get('qty', '?')
                    side = p.get('side', '?')
                    mkt_val = float(p.get('market_value', 0))
                    pnl = float(p.get('unrealized_pl', 0))
                    output_lines.append(
                        f"  {sym:<25s} {qty:>5s} {side:>5s} "
                        f"${mkt_val:>8,.0f} P&L:${pnl:>+7,.0f}"
                    )
                output_lines.append('```')
        except Exception:
            pass

        # Pending orders
        try:
            orders = self.client.get_orders(status='open')
            if orders:
                output_lines.append(f'Pending orders: {len(orders)}')
                for o in orders[:5]:
                    output_lines.append(
                        f"  {o.get('side', '?')} {o.get('qty', '?')}x "
                        f"{o.get('symbol', '?')} @ ${o.get('limit_price', '?')}"
                    )
        except Exception:
            pass

        # Tracked positions
        active = [p for p in self.executor.state.get('positions', [])
                  if p.get('status') not in ('cancelled', 'closed',
                                              'emergency_closed', 'expired')]
        if active:
            output_lines.append('')
            output_lines.append(f'**Tracked Positions ({len(active)}):**')
            output_lines.append(format_position_table(active))

        # Cumulative
        output_lines.append('')
        output_lines.append(
            f"Cumulative: "
            f"${self.auto_state.get('cumulative_realized_pnl', 0):+,.0f} realized | "
            f"{self.auto_state.get('cumulative_assignment_count', 0)} assignments | "
            f"{self.auto_state.get('cumulative_expiry_count', 0)} expirations"
        )

        return discord_msg('Wheel Status', output_lines)

    # ══════════════════════════════════════════════════════════════════════
    # Internal Helpers
    # ══════════════════════════════════════════════════════════════════════

    def _sync_positions_from_executor(self):
        """Sync automation state positions from executor state."""
        self.auto_state['positions'] = self.executor.state.get('positions', [])

    def _cleanup_expired_positions(self):
        """Remove cancelled/expired orders from active tracking."""
        before = len(self.executor.state.get('positions', []))
        self.executor.state['positions'] = [
            p for p in self.executor.state.get('positions', [])
            if p.get('status') not in ('cancelled', 'expired', 'closed',
                                        'emergency_closed')
            or (p.get('status') == 'cancelled'
                and p.get('order_status') not in ('canceled', 'cancelled',
                                                   'expired', 'rejected'))
        ]
        after = len(self.executor.state.get('positions', []))
        # Also clean positions with past expiry dates
        today = date.today()
        still_active = []
        cleaned = 0
        for p in self.executor.state.get('positions', []):
            try:
                exp = date.fromisoformat(p.get('expiry', '2099-01-01'))
                if exp < today and p.get('status') in ('pending', 'filled', 'active'):
                    # Expired position not yet cleaned up — mark and archive
                    p['status'] = 'expired'
                    p['expired_at'] = datetime.now().isoformat()
                    p['realized_pnl'] = p.get('total_premium', 0)
                    self.executor.state['closed_positions'].append(p.copy())
                    self.auto_state['cumulative_realized_pnl'] += p.get('total_premium', 0)
                    self.auto_state['cumulative_expiry_count'] += 1
                    cleaned += 1
                    log_trade('AUTO_CLEANUP_EXPIRED', {
                        'ticker': p.get('ticker'),
                        'strike': p.get('strike'),
                        'expiry': p.get('expiry'),
                    })
                    continue
            except (ValueError, KeyError):
                pass
            still_active.append(p)
        self.executor.state['positions'] = still_active
        return (before - after) + cleaned

    def _check_early_close(self):
        """
        Check for positions with >50% profit that should be closed early.
        Uses Alpaca positions to get current market value.
        """
        candidates = []
        try:
            broker_positions = self.client.get_positions()
        except Exception:
            return candidates

        # Build map of option positions from broker
        option_values = {}
        for bp in broker_positions:
            sym = bp.get('symbol', '')
            parsed = parse_occ_symbol(sym)
            if parsed:
                option_values[sym] = {
                    'market_value': abs(float(bp.get('market_value', 0))),
                    'avg_entry': float(bp.get('avg_entry_price', 0)),
                    'unrealized_pnl': float(bp.get('unrealized_pl', 0)),
                    'current_price': float(bp.get('current_price', 0)),
                }

        for pos in self.executor.state.get('positions', []):
            if pos.get('status') not in ('filled', 'active'):
                continue
            if pos.get('phase') not in ('CSP', 'CC'):
                continue

            symbol = pos.get('symbol', '')
            if symbol not in option_values:
                continue

            ov = option_values[symbol]
            fill_price = pos.get('fill_price', pos.get('limit_price', 0))
            current_price = ov['current_price']

            if fill_price <= 0:
                continue

            # For short options: profit = entry price - current price
            # (we sold at fill_price, can buy back at current_price)
            profit_per_contract = (fill_price - current_price) * 100
            max_profit = fill_price * 100  # Max profit if expires worthless
            if max_profit <= 0:
                continue

            profit_pct = (profit_per_contract / max_profit) * 100

            if profit_pct >= 40:  # Flag anything >40%, auto-close >50%
                candidates.append({
                    **pos,
                    'current_price': current_price,
                    'profit_pct': profit_pct,
                    'profit_per_contract': profit_per_contract,
                })

        return candidates

    def _close_position_early(self, pos):
        """Close a position early to lock in profit."""
        symbol = pos.get('symbol', '')
        contracts = pos.get('contracts', 1)
        current_price = pos.get('current_price', 0)

        if not symbol or current_price <= 0:
            return None

        try:
            # Buy to close
            order = self.client.submit_order(
                symbol=symbol,
                qty=contracts,
                side='buy',
                order_type='limit',
                time_in_force='day',
                limit_price=current_price * 1.05,  # Slight overpay for fill
            )

            # Update state
            for p in self.executor.state.get('positions', []):
                if p.get('symbol') == symbol:
                    p['status'] = 'closed'
                    p['closed_at'] = datetime.now().isoformat()
                    p['close_price'] = current_price
                    fill_price = p.get('fill_price', p.get('limit_price', 0))
                    realized = (fill_price - current_price) * 100 * contracts
                    p['realized_pnl'] = realized
                    self.executor.state['total_realized_pnl'] += realized
                    self.executor.state['closed_positions'].append(p.copy())
                    self.auto_state['cumulative_realized_pnl'] += realized
                    break

            # Remove from active
            self.executor.state['positions'] = [
                p for p in self.executor.state['positions']
                if p.get('symbol') != symbol or p.get('status') != 'closed'
            ]

            log_trade('EARLY_CLOSE', {
                'ticker': pos.get('ticker'),
                'symbol': symbol,
                'fill_price': pos.get('fill_price', 0),
                'close_price': current_price,
                'profit_pct': pos.get('profit_pct', 0),
                'contracts': contracts,
                'order_id': order.get('id', '?'),
            })

            return order

        except Exception as e:
            print(f'  Early close error for {symbol}: {e}')
            return None

    def _check_loss_alerts(self):
        """Check for positions with >25% loss (premium value increased)."""
        alerts = []
        try:
            broker_positions = self.client.get_positions()
        except Exception:
            return alerts

        option_values = {}
        for bp in broker_positions:
            sym = bp.get('symbol', '')
            parsed = parse_occ_symbol(sym)
            if parsed:
                option_values[sym] = {
                    'current_price': float(bp.get('current_price', 0)),
                    'unrealized_pnl': float(bp.get('unrealized_pl', 0)),
                }

        for pos in self.executor.state.get('positions', []):
            if pos.get('status') not in ('filled', 'active'):
                continue
            symbol = pos.get('symbol', '')
            if symbol not in option_values:
                continue

            ov = option_values[symbol]
            fill_price = pos.get('fill_price', pos.get('limit_price', 0))
            current_price = ov['current_price']

            if fill_price <= 0:
                continue

            # For short options: loss when current price > fill price
            # Loss percentage relative to collateral
            loss_per_contract = (current_price - fill_price) * 100
            collateral = pos.get('collateral', pos['strike'] * 100 * pos['contracts'])
            if collateral <= 0:
                continue

            loss_pct = (loss_per_contract * pos['contracts'] / collateral) * 100

            if loss_pct > 25:
                alerts.append({
                    'ticker': pos.get('ticker'),
                    'phase': pos.get('phase'),
                    'strike': pos.get('strike'),
                    'loss_pct': loss_pct,
                    'current_price': current_price,
                    'fill_price': fill_price,
                })

        return alerts

    def _calculate_weekly_pnl(self, acct):
        """Calculate P&L since week start."""
        start_equity = self.auto_state.get('week_start_equity')
        if start_equity is None:
            return None
        return acct['equity'] - start_equity


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Wheel Strategy Full Automation Pipeline'
    )
    parser.add_argument('--morning', action='store_true',
                        help='Monday morning: optimize + submit CSPs')
    parser.add_argument('--daily', action='store_true',
                        help='Daily monitoring: fills, assignments, early close')
    parser.add_argument('--friday', action='store_true',
                        help='Friday expiry management')
    parser.add_argument('--weekly-report', action='store_true',
                        help='Weekly P&L summary report')
    parser.add_argument('--status', action='store_true',
                        help='Current state overview')
    args = parser.parse_args()

    if not any([args.morning, args.daily, args.friday,
                args.weekly_report, args.status]):
        parser.print_help()
        print('\nChoose a mode: --morning, --daily, --friday, '
              '--weekly-report, or --status')
        sys.exit(1)

    try:
        automation = WheelAutomation()
    except Exception as e:
        print(json.dumps({
            'error': str(e),
            'traceback': traceback.format_exc(),
        }))
        sys.exit(1)

    if args.morning:
        result = automation.morning()
    elif args.daily:
        result = automation.daily()
    elif args.friday:
        result = automation.friday()
    elif args.weekly_report:
        result = automation.weekly_report()
    elif args.status:
        result = automation.status()
    else:
        result = None

    if result:
        # Print the Discord-formatted message to stdout.
        # The JS agent reads stdout and sends to Discord.
        print(result)


if __name__ == '__main__':
    main()
