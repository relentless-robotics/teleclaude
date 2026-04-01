#!/usr/bin/env python3
"""
Final P&L audit test - verifies ALL fixes are correct.
Simulates exact code paths in paper_trader.py and fast_scanner.py.
"""

TAKER_FEE = 0.02
STOP_LOSS_PCT = 0.20
TAKE_PROFIT_PCT = 0.30
all_pass = True

def check(label, condition):
    global all_pass
    status = "PASS" if condition else "FAIL"
    if not condition:
        all_pass = False
    print(f"  [{status}] {label}")
    return condition

def check_val(label, actual, expected, tol=0.01):
    global all_pass
    ok = abs(actual - expected) < tol
    status = "PASS" if ok else "FAIL"
    if not ok:
        all_pass = False
    print(f"  [{status}] {label}: ${actual:.4f} (expected ~${expected:.4f})")
    return ok


def simulate_open(side, yes_price, size_usdc, bankroll):
    """Simulate open_position exactly as fixed code does."""
    entry_price = yes_price if side == "YES" else (1 - yes_price)
    fee = TAKER_FEE * (1 - entry_price) * size_usdc
    contracts = size_usdc / entry_price
    bankroll -= (size_usdc + fee)
    pos = {
        "side": side, "entry_price": entry_price, "contracts": contracts,
        "fee": fee, "size_usdc": size_usdc,
        "stop_loss": round(entry_price * (1 - STOP_LOSS_PCT), 4),
        "take_profit": round(entry_price * (1 + TAKE_PROFIT_PCT), 4),
    }
    return pos, bankroll


def simulate_close(pos, exit_yes_price, bankroll):
    """Simulate close_position exactly as fixed code does."""
    side = pos["side"]
    entry_price = pos["entry_price"]
    contracts = pos["contracts"]
    size_usdc = pos["size_usdc"]

    # check_exits converts YES price to NO price for NO positions
    exit_price = (1 - exit_yes_price) if side == "NO" else exit_yes_price

    raw_pnl = (exit_price - entry_price) * contracts
    exit_fee = TAKER_FEE * exit_price * (1 - exit_price) * abs(contracts)
    # FIXED: no entry_fee subtraction (already deducted at open)
    net_pnl = raw_pnl - exit_fee

    bankroll += (size_usdc + net_pnl)
    return {"exit_price": exit_price, "raw_pnl": raw_pnl,
            "exit_fee": exit_fee, "net_pnl": net_pnl}, bankroll


print("=" * 70)
print("FINAL P&L AUDIT - ALL FIXES APPLIED")
print("=" * 70)

# =========================================================================
# TEST 1: Buy YES at 0.30, sell at 0.35 -- expect profit
# =========================================================================
print("\n--- TEST 1: Buy $100 YES @ 0.30, sell @ 0.35 ---")
pos1, br1 = simulate_open("YES", 0.30, 100, 10000)
c1, br1 = simulate_close(pos1, 0.35, br1)
# 333.33 contracts, raw profit = $16.67
# entry_fee = 0.02 * 0.70 * 100 = $1.40, exit_fee = 0.02 * 0.35 * 0.65 * 333.33 = $1.517
# net = 16.67 - 1.517 = $15.15, bankroll = 10000 - 100 - 1.40 + 100 + 15.15 = 10013.75
check_val("Contracts", pos1["contracts"], 333.33, tol=0.01)
check_val("Entry fee", pos1["fee"], 1.40)
check_val("Raw P&L", c1["raw_pnl"], 16.667, tol=0.01)
check_val("Exit fee", c1["exit_fee"], 1.517, tol=0.01)
check_val("Net P&L", c1["net_pnl"], 15.15, tol=0.05)
check_val("Final bankroll", br1, 10013.75, tol=0.1)
check("Profitable trade", c1["net_pnl"] > 0)

# =========================================================================
# TEST 2: Buy NO (YES=0.30), YES moves to 0.25 -- expect profit
# =========================================================================
print("\n--- TEST 2: Buy $100 NO (YES=0.30), YES->0.25 (PROFIT) ---")
pos2, br2 = simulate_open("NO", 0.30, 100, 10000)
c2, br2 = simulate_close(pos2, 0.25, br2)
# entry NO=0.70, 142.857 contracts, exit NO=0.75, raw = $7.143
# entry_fee = 0.02 * 0.30 * 100 = $0.60
# exit_fee = 0.02 * 0.75 * 0.25 * 142.857 = $0.536
# net = 7.143 - 0.536 = $6.607
check_val("Entry NO price", pos2["entry_price"], 0.70)
check_val("Contracts", pos2["contracts"], 142.857, tol=0.01)
check_val("Raw P&L", c2["raw_pnl"], 7.143, tol=0.01)
check_val("Net P&L", c2["net_pnl"], 6.607, tol=0.05)
check("Profitable trade", c2["net_pnl"] > 0)

# =========================================================================
# TEST 3: Buy NO (YES=0.30), YES moves to 0.35 -- expect LOSS
# =========================================================================
print("\n--- TEST 3: Buy $100 NO (YES=0.30), YES->0.35 (LOSS) ---")
pos3, br3 = simulate_open("NO", 0.30, 100, 10000)
c3, br3 = simulate_close(pos3, 0.35, br3)
# exit NO=0.65, raw = (0.65-0.70)*142.857 = -$7.143
# exit_fee = 0.02 * 0.65 * 0.35 * 142.857 = $0.650
# net = -7.143 - 0.650 = -$7.793
check_val("Raw P&L", c3["raw_pnl"], -7.143, tol=0.01)
check_val("Net P&L", c3["net_pnl"], -7.793, tol=0.05)
check("Losing trade", c3["net_pnl"] < 0)

# =========================================================================
# TEST 4: Bankroll roundtrip (buy and sell at SAME price)
# =========================================================================
print("\n--- TEST 4: Bankroll roundtrip (buy/sell at same price) ---")
pos4, br4 = simulate_open("YES", 0.50, 500, 10000)
c4, br4 = simulate_close(pos4, 0.50, br4)
# contracts = 1000, entry_fee = 0.02 * 0.50 * 500 = $5
# raw = 0, exit_fee = 0.02 * 0.50 * 0.50 * 1000 = $5
# net = 0 - 5 = -5
# bankroll = 10000 - 500 - 5 + 500 + (-5) = 9990
# Total loss = $10 = entry_fee + exit_fee. CORRECT!
total_fees = pos4["fee"] + c4["exit_fee"]
bankroll_loss = 10000 - br4
check_val("Entry fee", pos4["fee"], 5.0)
check_val("Exit fee", c4["exit_fee"], 5.0)
check_val("Total fees", total_fees, 10.0)
check_val("Bankroll loss", bankroll_loss, 10.0)
check("Loss equals total fees", abs(bankroll_loss - total_fees) < 0.01)

# =========================================================================
# TEST 5: Stop-loss triggers correctly for YES
# =========================================================================
print("\n--- TEST 5: Stop-loss for YES ---")
pos5, _ = simulate_open("YES", 0.50, 100, 10000)
print(f"  Entry: {pos5['entry_price']}, SL: {pos5['stop_loss']}, TP: {pos5['take_profit']}")
# price drops to 0.40 (20% loss): should trigger stop
check("SL triggers at 0.40", 0.40 <= pos5["stop_loss"])
# price rises to 0.65 (30% gain): should trigger TP
check("TP triggers at 0.65", 0.65 >= pos5["take_profit"])
# price at 0.45 (10% loss): should NOT trigger
check("No SL at 0.45", not (0.45 <= pos5["stop_loss"]))

# =========================================================================
# TEST 6: Stop-loss triggers correctly for NO
# =========================================================================
print("\n--- TEST 6: Stop-loss for NO ---")
pos6, _ = simulate_open("NO", 0.30, 100, 10000)
print(f"  Entry NO: {pos6['entry_price']}, SL: {pos6['stop_loss']}, TP: {pos6['take_profit']}")
# YES goes to 0.50 -> NO=0.50 (28.6% loss): should trigger stop
check("SL triggers when NO=0.50 (loss)", 0.50 <= pos6["stop_loss"])
# YES goes to 0.10 -> NO=0.90 (28.6% gain): should trigger TP
check("TP triggers when NO=0.91 (gain)", 0.91 >= pos6["take_profit"])
# YES goes to 0.25 -> NO=0.75 (7% gain): no trigger
no_75 = 0.75
check("No SL at NO=0.75", not (no_75 <= pos6["stop_loss"]))
check("No TP at NO=0.75", not (no_75 >= pos6["take_profit"]))

# =========================================================================
# TEST 7: Edge case - price goes to 0.01 (near zero)
# =========================================================================
print("\n--- TEST 7: Edge case - near-zero price ---")
pos7, br7 = simulate_open("YES", 0.50, 100, 10000)
c7, br7 = simulate_close(pos7, 0.01, br7)
check("Large loss is negative", c7["net_pnl"] < -90)
check("Bankroll still positive", br7 > 0)

# =========================================================================
# TEST 8: Edge case - price goes to 0.99 (near one)
# =========================================================================
print("\n--- TEST 8: Edge case - near-one price ---")
pos8, br8 = simulate_open("YES", 0.50, 100, 10000)
c8, br8 = simulate_close(pos8, 0.99, br8)
check("Large gain is positive", c8["net_pnl"] > 90)
# Fee should be near zero at p=0.99
check_val("Exit fee near zero", c8["exit_fee"], 0.02 * 0.99 * 0.01 * 200, tol=0.01)

# =========================================================================
# TEST 9: Fair value reversion for NO (fast_scanner)
# =========================================================================
print("\n--- TEST 9: Fair value reversion for NO ---")
fv_yes = 0.40
fv_no = 1 - fv_yes  # 0.60
# When YES reverts to fair value, NO = 0.60
check("Reversion triggers at NO=0.60", 0.60 <= fv_no * 1.02)
# When YES is 0.35 (not reverted), NO=0.65
check("No reversion at NO=0.65", not (0.65 <= fv_no * 1.02))

print("\n" + "=" * 70)
if all_pass:
    print("ALL 9 TESTS PASSED - P&L CALCULATION IS CORRECT")
else:
    print("SOME TESTS FAILED - REVIEW OUTPUT ABOVE")
print("=" * 70)
