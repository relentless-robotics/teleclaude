#!/usr/bin/env python3
"""
Fix all P&L bugs in paper_trader.py and fast_scanner.py.
Run on Jupiter: python3 fix_pnl_bugs.py
"""
import re

def fix_paper_trader():
    path = "/home/jupiter/teleclaude/trading_agents/prediction_markets/paper_trader.py"
    with open(path) as f:
        code = f.read()
    original = code

    # BUG 1a: Fix entry fee formula in open_position
    # Old: fee = TAKER_FEE * entry_price * (1 - entry_price) * size_usdc
    # New: fee = TAKER_FEE * entry_price * (1 - entry_price) * contracts
    # But contracts is computed AFTER fee... so we need to reorder.
    # Actually, since fee = rate * p * (1-p) * (size/p) = rate * (1-p) * size,
    # we can simplify: fee = TAKER_FEE * (1 - entry_price) * size_usdc
    old_entry_fee = "fee = TAKER_FEE * entry_price * (1 - entry_price) * size_usdc"
    # But wait - in open_position, contracts is computed on the next line.
    # Let's use the simplified form: rate * (1-p) * size = rate * p * (1-p) * contracts
    # Actually: rate * p * (1-p) * contracts = rate * p * (1-p) * size/p = rate * (1-p) * size
    new_entry_fee = "fee = TAKER_FEE * (1 - entry_price) * size_usdc"

    # Find in open_position method
    code = code.replace(
        "        # Calculate fee (taker for market entry)\n        fee = TAKER_FEE * entry_price * (1 - entry_price) * size_usdc",
        "        # Calculate fee (taker for market entry)\n        # Polymarket fee = rate * p * (1-p) per contract; contracts = size/p\n        # So fee = rate * p * (1-p) * size/p = rate * (1-p) * size\n        fee = TAKER_FEE * (1 - entry_price) * size_usdc"
    )

    # BUG 1b: Fix stop_loss / take_profit for NO positions in open_position
    # Old: "stop_loss": entry_price * (1 - STOP_LOSS_PCT) if side == "YES" else entry_price * (1 + STOP_LOSS_PCT)
    # The YES case is correct (stop below entry). The NO case should also be below entry.
    # For NO: stop_loss triggers when NO price FALLS (loss), take_profit when it RISES (gain).
    old_sl = '''            "stop_loss": round(entry_price * (1 - STOP_LOSS_PCT), 4) if side == "YES" else round(entry_price * (1 + STOP_LOSS_PCT), 4),
            "take_profit": round(entry_price * (1 + TAKE_PROFIT_PCT), 4) if side == "YES" else round(entry_price * (1 - TAKE_PROFIT_PCT), 4),'''
    new_sl = '''            "stop_loss": round(entry_price * (1 - STOP_LOSS_PCT), 4),
            "take_profit": round(entry_price * (1 + TAKE_PROFIT_PCT), 4),'''
    code = code.replace(old_sl, new_sl)

    # BUG 1c: Fix exit fee in close_position
    # Old: exit_fee = TAKER_FEE * exit_price * (1 - exit_price) * abs(contracts * exit_price)
    # New: exit_fee = TAKER_FEE * (1 - exit_price) * abs(contracts * exit_price)
    # Wait, let me think again. contracts * exit_price = the USDC value of the position at exit.
    # fee = rate * p * (1-p) * contracts = rate * (1-p) * contracts * p = rate * (1-p) * exit_value
    # So: fee = TAKER_FEE * (1 - exit_price) * abs(contracts * exit_price)
    # OR equivalently: fee = TAKER_FEE * exit_price * (1 - exit_price) * contracts
    code = code.replace(
        "        # Exit fee (taker)\n        exit_fee = TAKER_FEE * exit_price * (1 - exit_price) * abs(contracts * exit_price)",
        "        # Exit fee (taker): rate * p * (1-p) per contract\n        exit_fee = TAKER_FEE * exit_price * (1 - exit_price) * abs(contracts)"
    )

    # BUG 1d: Fix stop-loss check direction for NO in check_exits
    # The current check_exits already converts current_price to NO space for NO positions
    # and then checks:
    #   YES: stop if current <= stop_loss, TP if current >= take_profit
    #   NO: stop if current >= stop_loss, TP if current <= take_profit
    # With the new stop_loss/take_profit values (both using same formula as YES):
    #   stop_loss = entry * (1 - SL_PCT) = below entry
    #   take_profit = entry * (1 + TP_PCT) = above entry
    # For NO in NO-space: loss = price drops, profit = price rises
    # So: stop when current <= stop_loss (price dropped), TP when current >= take_profit (price rose)
    # This is the SAME direction as YES. So we can simplify.
    old_check = """            # Check stop-loss
            if side == "YES" and current_price <= pos["stop_loss"]:
                self.state.close_position(slug, current_price, reason="stop_loss")
                continue
            elif side == "NO" and current_price >= pos["stop_loss"]:
                self.state.close_position(slug, current_price, reason="stop_loss")
                continue

            # Check take-profit
            if side == "YES" and current_price >= pos["take_profit"]:
                self.state.close_position(slug, current_price, reason="take_profit")
                continue
            elif side == "NO" and current_price <= pos["take_profit"]:
                self.state.close_position(slug, current_price, reason="take_profit")
                continue"""

    new_check = """            # Check stop-loss (price dropped below threshold)
            if current_price <= pos["stop_loss"]:
                self.state.close_position(slug, current_price, reason="stop_loss")
                continue

            # Check take-profit (price rose above threshold)
            if current_price >= pos["take_profit"]:
                self.state.close_position(slug, current_price, reason="take_profit")
                continue"""
    code = code.replace(old_check, new_check)

    if code == original:
        print("WARNING: paper_trader.py - no changes made!")
        return False

    with open(path, "w") as f:
        f.write(code)
    print(f"Fixed paper_trader.py ({len(original)} -> {len(code)} chars)")
    return True


def fix_fast_scanner():
    path = "/home/jupiter/teleclaude/trading_agents/prediction_markets/fast_scanner.py"
    with open(path) as f:
        code = f.read()
    original = code

    # BUG 2a: Fix entry fee in open_position
    old = "        fee = TAKER_FEE * entry_price * (1 - entry_price) * size_usdc"
    new = "        # Polymarket fee = rate * p * (1-p) per contract; contracts = size/p\n        # So fee = rate * (1-p) * size_usdc\n        fee = TAKER_FEE * (1 - entry_price) * size_usdc"
    code = code.replace(old, new, 1)

    # BUG 2b: Fix stop_loss / take_profit for NO in open_position
    old_sl = '''            "stop_loss": round(
                entry_price * (1 - STOP_LOSS_PCT) if side == "YES"
                else entry_price * (1 + STOP_LOSS_PCT), 4
            ),
            "take_profit": round(
                entry_price * (1 + TAKE_PROFIT_PCT) if side == "YES"
                else entry_price * (1 - TAKE_PROFIT_PCT), 4
            ),'''
    new_sl = '''            "stop_loss": round(entry_price * (1 - STOP_LOSS_PCT), 4),
            "take_profit": round(entry_price * (1 + TAKE_PROFIT_PCT), 4),'''
    code = code.replace(old_sl, new_sl)

    # BUG 2c: Fix exit fee in close_position
    old_exit = "        exit_fee = TAKER_FEE * exit_price * (1 - exit_price) * abs(contracts * exit_price)"
    new_exit = "        # Exit fee: rate * p * (1-p) per contract\n        exit_fee = TAKER_FEE * exit_price * (1 - exit_price) * abs(contracts)"
    code = code.replace(old_exit, new_exit)

    # BUG 2d: Fix stop-loss/take-profit checks in check_exits
    old_check = """            # Stop-loss
            if side == "YES" and current_price <= pos["stop_loss"]:
                self.state.close_position(slug, current_price, "stop_loss")
                continue
            elif side == "NO" and current_price >= pos["stop_loss"]:
                self.state.close_position(slug, current_price, "stop_loss")
                continue

            # Take-profit
            if side == "YES" and current_price >= pos["take_profit"]:
                self.state.close_position(slug, current_price, "take_profit")
                continue
            elif side == "NO" and current_price <= pos["take_profit"]:
                self.state.close_position(slug, current_price, "take_profit")
                continue"""
    new_check = """            # Stop-loss (price dropped below threshold - same for YES and NO in their own space)
            if current_price <= pos["stop_loss"]:
                self.state.close_position(slug, current_price, "stop_loss")
                continue

            # Take-profit (price rose above threshold)
            if current_price >= pos["take_profit"]:
                self.state.close_position(slug, current_price, "take_profit")
                continue"""
    code = code.replace(old_check, new_check)

    # BUG 2e: Fix fair value reversion exit for NO
    # The fair_value is in YES space but after conversion current_price is in NO space
    # Fix: convert fair_value to NO space for comparison
    old_fv = """            # Mean reversion exit: if price has reverted to fair value
            fair_value = pos.get("fair_value", pos["entry_price"])
            if side == "YES" and current_price >= fair_value * 0.98:
                self.state.close_position(slug, current_price, "fair_value_reversion")
            elif side == "NO" and current_price <= fair_value * 1.02:
                self.state.close_position(slug, current_price, "fair_value_reversion")"""
    new_fv = """            # Mean reversion exit: if price has reverted to fair value
            fair_value = pos.get("fair_value", pos["entry_price"])
            if side == "YES" and current_price >= fair_value * 0.98:
                self.state.close_position(slug, current_price, "fair_value_reversion")
            elif side == "NO":
                # fair_value is in YES space; convert to NO space for comparison
                fv_no = 1 - fair_value
                if current_price <= fv_no * 1.02:
                    self.state.close_position(slug, current_price, "fair_value_reversion")"""
    code = code.replace(old_fv, new_fv)

    if code == original:
        print("WARNING: fast_scanner.py - no changes made!")
        return False

    with open(path, "w") as f:
        f.write(code)
    print(f"Fixed fast_scanner.py ({len(original)} -> {len(code)} chars)")
    return True


if __name__ == "__main__":
    print("Fixing P&L bugs...")
    r1 = fix_paper_trader()
    r2 = fix_fast_scanner()
    if r1 and r2:
        print("\nAll fixes applied successfully!")
    else:
        print("\nSome fixes may not have applied - check warnings above.")
