#!/usr/bin/env python3
"""P&L Calculation Audit Test Script for Polymarket paper traders."""

TAKER_FEE = 0.02

def test_open(side, yes_price, size_usdc):
    if side == "YES":
        entry_price = yes_price
    else:
        entry_price = 1 - yes_price
    fee = TAKER_FEE * entry_price * (1 - entry_price) * size_usdc
    contracts = size_usdc / entry_price if entry_price > 0 else 0
    return {"side": side, "entry_price": entry_price, "contracts": contracts,
            "fee": fee, "size_usdc": size_usdc}

def close_as_code(pos, exit_yes_price):
    side = pos["side"]
    entry_price = pos["entry_price"]
    contracts = pos["contracts"]
    if side == "NO":
        exit_price = 1 - exit_yes_price
    else:
        exit_price = exit_yes_price
    raw_pnl = (exit_price - entry_price) * contracts
    exit_fee = TAKER_FEE * exit_price * (1 - exit_price) * abs(contracts * exit_price)
    net_pnl = raw_pnl - pos["fee"] - exit_fee
    return {"exit_price": exit_price, "raw_pnl": raw_pnl, "exit_fee": exit_fee, "net_pnl": net_pnl}

def close_correct(pos, exit_yes_price):
    side = pos["side"]
    entry_price = pos["entry_price"]
    contracts = pos["contracts"]
    if side == "NO":
        exit_price = 1 - exit_yes_price
    else:
        exit_price = exit_yes_price
    raw_pnl = (exit_price - entry_price) * contracts
    exit_fee = TAKER_FEE * exit_price * (1 - exit_price) * contracts
    net_pnl = raw_pnl - pos["fee"] - exit_fee
    return {"exit_price": exit_price, "raw_pnl": raw_pnl, "exit_fee": exit_fee, "net_pnl": net_pnl}


print("=" * 70)
print("P&L CALCULATION AUDIT")
print("=" * 70)

# TEST 1: Buy YES at 0.30, sell at 0.35
print("\n--- TEST 1: Buy $100 YES @ 0.30, sell @ 0.35 ---")
pos1 = test_open("YES", 0.30, 100)
c1 = close_as_code(pos1, 0.35)
r1 = close_correct(pos1, 0.35)
print(f"  Contracts: {pos1['contracts']:.4f}")
print(f"  Entry fee: ${pos1['fee']:.4f}")
print(f"  Raw P&L: ${c1['raw_pnl']:.4f}")
print(f"  Exit fee CODE:    ${c1['exit_fee']:.6f}")
print(f"  Exit fee CORRECT: ${r1['exit_fee']:.6f}")
print(f"  Net P&L CODE:    ${c1['net_pnl']:.4f}")
print(f"  Net P&L CORRECT: ${r1['net_pnl']:.4f}")
print(f"  Fee diff: ${c1['net_pnl'] - r1['net_pnl']:.6f} (positive=code overstates profit)")

# TEST 2: Buy NO (YES=0.30), YES moves to 0.25 (profit)
print("\n--- TEST 2: Buy $100 NO (YES=0.30, NO=0.70), YES->0.25 (PROFIT) ---")
pos2 = test_open("NO", 0.30, 100)
c2 = close_as_code(pos2, 0.25)
r2 = close_correct(pos2, 0.25)
print(f"  Entry NO price: {pos2['entry_price']:.4f}")
print(f"  Contracts: {pos2['contracts']:.4f}")
print(f"  Exit NO price: {c2['exit_price']:.4f}")
print(f"  Raw P&L: ${c2['raw_pnl']:.4f}")
print(f"  Net P&L CODE:    ${c2['net_pnl']:.4f}")
print(f"  Net P&L CORRECT: ${r2['net_pnl']:.4f}")

# TEST 3: Buy NO (YES=0.30), YES moves to 0.35 (LOSS)
print("\n--- TEST 3: Buy $100 NO (YES=0.30, NO=0.70), YES->0.35 (LOSS) ---")
pos3 = test_open("NO", 0.30, 100)
c3 = close_as_code(pos3, 0.35)
r3 = close_correct(pos3, 0.35)
print(f"  Exit NO price: {c3['exit_price']:.4f}")
print(f"  Raw P&L: ${c3['raw_pnl']:.4f} (should be negative)")
print(f"  Net P&L CODE:    ${c3['net_pnl']:.4f}")
print(f"  Net P&L CORRECT: ${r3['net_pnl']:.4f}")

# TEST 4: Stop-loss direction for NO
print("\n--- TEST 4: Stop-loss/Take-profit for NO positions ---")
entry_no = 0.70
STOP_LOSS_PCT = 0.20
TAKE_PROFIT_PCT = 0.30

sl_code = entry_no * (1 + STOP_LOSS_PCT)
tp_code = entry_no * (1 - TAKE_PROFIT_PCT)

print(f"  NO entry: {entry_no}")
print(f"  Code stop_loss = {sl_code:.4f}, triggers when NO >= {sl_code:.4f}")
print(f"  Code take_profit = {tp_code:.4f}, triggers when NO <= {tp_code:.4f}")
print()
print(f"  Scenario A: YES 0.30->0.50 (BAD for NO, NO drops to 0.50)")
print(f"    Loss = {(0.50 - 0.70) / 0.70 * 100:.1f}%")
sl_a = 0.50 >= sl_code
tp_a = 0.50 <= tp_code
print(f"    Stop triggers? {sl_a} (NO >= {sl_code:.2f})")
print(f"    TP triggers? {tp_a} -- TAKE PROFIT TRIGGERS ON A 28.6% LOSS!")
print()
print(f"  Scenario B: YES 0.30->0.10 (GOOD for NO, NO rises to 0.90)")
print(f"    Gain = {(0.90 - 0.70) / 0.70 * 100:.1f}%")
sl_b = 0.90 >= sl_code
print(f"    Stop triggers? {sl_b} -- STOP TRIGGERS ON A 28.6% PROFIT!")
print()
print(f"  *** BUG: STOP-LOSS AND TAKE-PROFIT ARE SWAPPED FOR NO ***")
print(f"  Correct stop_loss  = entry*(1-SL) = {entry_no * (1 - STOP_LOSS_PCT):.4f}")
print(f"  Correct take_profit = entry*(1+TP) = {entry_no * (1 + TAKE_PROFIT_PCT):.4f}")

# TEST 5: Entry fee formula
print("\n--- TEST 5: Entry fee formula ---")
contracts_t5 = 100 / 0.30
per_contract_fee = 0.02 * 0.30 * 0.70
total_correct_fee = per_contract_fee * contracts_t5
code_fee = 0.02 * 0.30 * 0.70 * 100
print(f"  Contracts: {contracts_t5:.4f}")
print(f"  Per-contract fee: ${per_contract_fee:.6f}")
print(f"  Correct total (rate*p*(1-p)*contracts): ${total_correct_fee:.4f}")
print(f"  Code total (rate*p*(1-p)*size_usdc):    ${code_fee:.4f}")
print(f"  Ratio: {code_fee / total_correct_fee:.4f}")
print(f"  Code fee = correct_fee * price ({0.30})")
print(f"  This means fees are UNDERCHARGED by {(1 - code_fee / total_correct_fee) * 100:.0f}%")

# TEST 6: Exit fee formula
print("\n--- TEST 6: Exit fee formula ---")
contracts_t6 = 333.3333
exit_p = 0.35
correct_ef = 0.02 * exit_p * (1 - exit_p) * contracts_t6
code_ef = 0.02 * exit_p * (1 - exit_p) * abs(contracts_t6 * exit_p)
print(f"  Correct (rate*p*(1-p)*contracts): ${correct_ef:.4f}")
print(f"  Code (rate*p*(1-p)*|contracts*p|): ${code_ef:.4f}")
print(f"  Ratio: {code_ef / correct_ef:.4f}")
print(f"  Code exit fee = correct * exit_price ({exit_p})")

# TEST 7: Fair value reversion (fast_scanner)
print("\n--- TEST 7: Fair value reversion exit (fast_scanner) ---")
print(f"  fair_value stored = 0.40 (YES space)")
print(f"  For NO position, current_price converted to NO space")
print(f"  If YES = 0.40 (reverted to FV), NO = 0.60")
print(f"  Code checks: 0.60 <= 0.40 * 1.02 = 0.408? {0.60 <= 0.408}")
print(f"  Will NEVER trigger for NO positions!")
print(f"  *** BUG: Comparing NO-space price to YES-space fair_value ***")

print("\n" + "=" * 70)
print("SUMMARY OF BUGS")
print("=" * 70)
print("""
BUG 1 (CRITICAL): Stop-loss and take-profit SWAPPED for NO positions
  BOTH paper_trader.py AND fast_scanner.py
  - stop_loss = entry*(1+SL_PCT) triggers on PROFIT (price rising)
  - take_profit = entry*(1-TP_PCT) triggers on LOSS (price falling)
  FIX: For NO, stop_loss = entry*(1-SL_PCT), take_profit = entry*(1+TP_PCT)
  Same direction checks (>= for stop, <= for TP) then work correctly.

BUG 2 (MEDIUM): Exit fee uses |contracts * exit_price| instead of contracts
  exit_fee = rate * p * (1-p) * |contracts * p|  (code)
  exit_fee = rate * p * (1-p) * contracts         (correct)
  Effect: exit fees are scaled by exit_price (0.35x at p=0.35)
  Makes P&L slightly too optimistic.

BUG 3 (MEDIUM): Entry fee uses size_usdc instead of contracts
  fee = rate * p * (1-p) * size_usdc  (code)
  fee = rate * p * (1-p) * contracts  (correct)
  Since size_usdc = p * contracts, code = correct * price
  Effect: entry fees are scaled by entry_price (0.30x at p=0.30)
  NOTE: If Polymarket actually charges per-USDC-spent, code is right.
  Need to verify Polymarket fee docs.

BUG 4 (LOW): Fair value reversion broken for NO (fast_scanner only)
  Compares NO-space price against YES-space fair_value
  Will never trigger for NO positions.
""")
