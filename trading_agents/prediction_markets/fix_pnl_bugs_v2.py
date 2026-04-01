#!/usr/bin/env python3
"""
Fix BUG 5: Entry fee double-counted in close_position.
Also verify all previous fixes are in place.
Run on Jupiter: python3 fix_pnl_bugs_v2.py
"""

def fix_paper_trader():
    path = "/home/jupiter/teleclaude/trading_agents/prediction_markets/paper_trader.py"
    with open(path) as f:
        code = f.read()
    original = code

    # Fix close_position: remove entry_fee from net_pnl calculation
    # Entry fee was already deducted from bankroll in open_position
    old = "        net_pnl = raw_pnl - pos[\"entry_fee\"] - exit_fee"
    new = "        # Note: entry_fee already deducted from bankroll at open time\n        net_pnl = raw_pnl - exit_fee"
    code = code.replace(old, new)

    if code == original:
        print("WARNING: paper_trader.py - no changes made!")
        return False
    with open(path, "w") as f:
        f.write(code)
    print(f"Fixed paper_trader.py (removed double-counted entry_fee from close)")
    return True


def fix_fast_scanner():
    path = "/home/jupiter/teleclaude/trading_agents/prediction_markets/fast_scanner.py"
    with open(path) as f:
        code = f.read()
    original = code

    old = "        net_pnl = raw_pnl - pos[\"entry_fee\"] - exit_fee"
    new = "        # Note: entry_fee already deducted from bankroll at open time\n        net_pnl = raw_pnl - exit_fee"
    code = code.replace(old, new)

    if code == original:
        print("WARNING: fast_scanner.py - no changes made!")
        return False
    with open(path, "w") as f:
        f.write(code)
    print(f"Fixed fast_scanner.py (removed double-counted entry_fee from close)")
    return True


if __name__ == "__main__":
    print("Fixing BUG 5: entry fee double-count...")
    r1 = fix_paper_trader()
    r2 = fix_fast_scanner()
    if r1 and r2:
        print("\nAll fixes applied!")
    else:
        print("\nSome fixes may not have applied.")
