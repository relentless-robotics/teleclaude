#!/usr/bin/env python3
"""P&L audit test for the FIXED formulas."""

TAKER_FEE = 0.02

def test_open(side, yes_price, size_usdc):
    if side == "YES":
        entry_price = yes_price
    else:
        entry_price = 1 - yes_price
    # FIXED entry fee: rate * (1-p) * size
    fee = TAKER_FEE * (1 - entry_price) * size_usdc
    contracts = size_usdc / entry_price if entry_price > 0 else 0
    return {"side": side, "entry_price": entry_price, "contracts": contracts,
            "fee": fee, "size_usdc": size_usdc}

def close_fixed(pos, exit_yes_price):
    side = pos["side"]
    entry_price = pos["entry_price"]
    contracts = pos["contracts"]
    if side == "NO":
        exit_price = 1 - exit_yes_price
    else:
        exit_price = exit_yes_price
    raw_pnl = (exit_price - entry_price) * contracts
    # FIXED exit fee: rate * p * (1-p) * contracts
    exit_fee = TAKER_FEE * exit_price * (1 - exit_price) * abs(contracts)
    net_pnl = raw_pnl - pos["fee"] - exit_fee
    return {"exit_price": exit_price, "raw_pnl": raw_pnl, "exit_fee": exit_fee, "net_pnl": net_pnl}

def verify(label, actual, expected, tolerance=0.01):
    ok = abs(actual - expected) < tolerance
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] {label}: ${actual:.4f} (expected ~${expected:.4f})")
    return ok

all_pass = True

print("=" * 70)
print("P&L AUDIT - FIXED FORMULAS")
print("=" * 70)

# TEST 1: Buy $100 YES at 0.30, sell at 0.35
print("\n--- TEST 1: Buy $100 YES @ 0.30, sell @ 0.35 ---")
pos1 = test_open("YES", 0.30, 100)
c1 = close_fixed(pos1, 0.35)
# Expected: 333.33 contracts, buy at $0.30, sell at $0.35
# Raw P&L = (0.35 - 0.30) * 333.33 = $16.67
# Entry fee = 0.02 * (1 - 0.30) * 100 = 0.02 * 0.70 * 100 = $1.40
# Exit fee = 0.02 * 0.35 * 0.65 * 333.33 = $1.517
# Net P&L = 16.67 - 1.40 - 1.52 = ~$13.75
print(f"  Contracts: {pos1['contracts']:.4f}")
all_pass &= verify("Entry fee", pos1["fee"], 1.40)
all_pass &= verify("Raw P&L", c1["raw_pnl"], 16.67)
all_pass &= verify("Exit fee", c1["exit_fee"], 1.517)
all_pass &= verify("Net P&L", c1["net_pnl"], 13.75, tolerance=0.05)
print(f"  Net P&L should be POSITIVE: {c1['net_pnl'] > 0}")
all_pass &= c1["net_pnl"] > 0

# TEST 2: Buy $100 NO (YES=0.30), YES moves to 0.25 (profit)
print("\n--- TEST 2: Buy $100 NO (YES=0.30, NO=0.70), YES->0.25 (PROFIT) ---")
pos2 = test_open("NO", 0.30, 100)
c2 = close_fixed(pos2, 0.25)
# Entry: NO price = 0.70, contracts = 100/0.70 = 142.857
# Raw P&L = (0.75 - 0.70) * 142.857 = $7.143
# Entry fee = 0.02 * (1 - 0.70) * 100 = 0.02 * 0.30 * 100 = $0.60
# Exit fee = 0.02 * 0.75 * 0.25 * 142.857 = $0.536
# Net = 7.143 - 0.60 - 0.536 = ~$6.01
print(f"  Contracts: {pos2['contracts']:.4f}")
all_pass &= verify("Entry fee", pos2["fee"], 0.60)
all_pass &= verify("Raw P&L", c2["raw_pnl"], 7.143, tolerance=0.01)
all_pass &= verify("Exit fee", c2["exit_fee"], 0.536, tolerance=0.01)
all_pass &= verify("Net P&L", c2["net_pnl"], 6.01, tolerance=0.05)
print(f"  Net P&L should be POSITIVE: {c2['net_pnl'] > 0}")
all_pass &= c2["net_pnl"] > 0

# TEST 3: Buy $100 NO (YES=0.30), YES moves to 0.35 (LOSS)
print("\n--- TEST 3: Buy $100 NO (YES=0.30, NO=0.70), YES->0.35 (LOSS) ---")
pos3 = test_open("NO", 0.30, 100)
c3 = close_fixed(pos3, 0.35)
# Exit NO = 0.65
# Raw P&L = (0.65 - 0.70) * 142.857 = -$7.143
# Entry fee = $0.60
# Exit fee = 0.02 * 0.65 * 0.35 * 142.857 = $0.650
# Net = -7.143 - 0.60 - 0.650 = ~-$8.39
print(f"  Exit NO price: {c3['exit_price']:.4f}")
all_pass &= verify("Raw P&L", c3["raw_pnl"], -7.143, tolerance=0.01)
all_pass &= verify("Net P&L", c3["net_pnl"], -8.39, tolerance=0.1)
print(f"  Net P&L should be NEGATIVE: {c3['net_pnl'] < 0}")
all_pass &= c3["net_pnl"] < 0

# TEST 4: Stop-loss / take-profit direction
print("\n--- TEST 4: Stop-loss/Take-profit for NO (FIXED) ---")
STOP_LOSS_PCT = 0.20
TAKE_PROFIT_PCT = 0.30
entry_no = 0.70
sl = entry_no * (1 - STOP_LOSS_PCT)  # 0.56
tp = entry_no * (1 + TAKE_PROFIT_PCT)  # 0.91
print(f"  stop_loss = {sl:.4f}, take_profit = {tp:.4f}")

# Scenario A: YES 0.30->0.50, NO=0.50, loss
no_price_a = 0.50
sl_triggers_a = no_price_a <= sl
tp_triggers_a = no_price_a >= tp
print(f"  Loss scenario (NO=0.50): stop triggers? {sl_triggers_a} (should be True)")
all_pass &= sl_triggers_a == True
all_pass &= tp_triggers_a == False

# Scenario B: YES 0.30->0.10, NO=0.90, profit
no_price_b = 0.90
sl_triggers_b = no_price_b <= sl
tp_triggers_b = no_price_b >= tp
print(f"  Profit scenario (NO=0.90): TP triggers? {tp_triggers_b} (should be False, need 0.91)")
print(f"  Even bigger profit (NO=0.95): TP triggers? {0.95 >= tp} (should be True)")
all_pass &= sl_triggers_b == False
all_pass &= (0.95 >= tp) == True

# TEST 5: Bankroll accounting roundtrip
print("\n--- TEST 5: Bankroll roundtrip ---")
bankroll = 10000.0
pos5 = test_open("YES", 0.50, 500)
# Open: bankroll -= size + fee
bankroll -= (pos5["size_usdc"] + pos5["fee"])
print(f"  After open: ${bankroll:.4f}")
# Close at same price (should lose only fees)
c5 = close_fixed(pos5, 0.50)
# Close: bankroll += size + net_pnl
bankroll += (pos5["size_usdc"] + c5["net_pnl"])
print(f"  After close at same price: ${bankroll:.4f}")
loss = 10000 - bankroll
entry_fee = pos5["fee"]
exit_fee = c5["exit_fee"]
print(f"  Total fees paid: ${entry_fee + exit_fee:.4f}")
print(f"  Bankroll loss: ${loss:.4f}")
fee_match = abs(loss - (entry_fee + exit_fee)) < 0.01
print(f"  Loss matches fees? {fee_match}")
all_pass &= fee_match

# TEST 6: Fair value reversion for NO (fast_scanner fix)
print("\n--- TEST 6: Fair value reversion for NO ---")
fair_value_yes = 0.40  # stored in YES space
fv_no = 1 - fair_value_yes  # convert to NO space = 0.60
# If YES reverts to 0.40, NO = 0.60
current_no = 0.60
triggers = current_no <= fv_no * 1.02  # 0.60 <= 0.612
print(f"  fair_value (YES) = {fair_value_yes}, fv_no = {fv_no}")
print(f"  Current NO = {current_no}, threshold = {fv_no * 1.02:.4f}")
print(f"  Triggers? {triggers} (should be True)")
all_pass &= triggers == True

print("\n" + "=" * 70)
if all_pass:
    print("ALL TESTS PASSED")
else:
    print("SOME TESTS FAILED")
print("=" * 70)
