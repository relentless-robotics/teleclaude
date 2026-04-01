## MANDATORY: TRADING ANALYSIS CHECKLIST

**This checklist is NON-NEGOTIABLE for ANY financial analysis or trade decision.**

### Before ANY Trade Analysis

You MUST complete ALL of these steps. No shortcuts. No assumptions.

#### Step 1: Pull ACTUAL Current Data
```bash
node swing_options/index.js analyze SYMBOL
node swing_options/index.js sentsym SYMBOL
```
- [ ] Current price verified (not assumed)
- [ ] Today's change (% and $)
- [ ] Volume vs average volume
- [ ] RSI / technical indicators

#### Step 2: Understand the WHY
- [ ] Why is the stock at this price NOW?
- [ ] Recent news/catalysts identified
- [ ] Earnings date checked
- [ ] Sector performance context
- [ ] Any material events (FDA, guidance, etc.)

#### Step 2.5: DIRECTIONAL EVIDENCE (Required for Earnings/Catalyst Plays)

**"Catalyst alone = gambling. Catalyst + directional evidence = informed trade."**

If the trade involves an upcoming earnings or binary catalyst, you MUST provide directional reasoning:

- [ ] **Estimate trends**: Are analysts revising UP or DOWN into the event?
- [ ] **Whisper numbers**: Is the real bar higher/lower than published consensus?
- [ ] **Peer read-through**: Did sector peers beat/miss? What does that imply?
- [ ] **Management signals**: Pre-announcements, recent tone, guidance history
- [ ] **Options positioning**: Put/call ratio, skew direction (smart money lean)
- [ ] **Historical pattern**: Does this stock typically beat? By how much?
- [ ] **Setup into event**: Is stock already run up (sell the news) or beaten down (low bar)?

**VERDICT REQUIRED:**
```
DIRECTIONAL LEAN: Bullish / Bearish / Neutral
CONFIDENCE: X/5
KEY FACTOR: [The one thing that tips the direction]
```

**If no directional evidence exists → DO NOT recommend the trade as catalyst-driven. It's a coin flip.**

#### Step 3: Market Context
```bash
node swing_options/index.js market
```
- [ ] VIX level and regime
- [ ] Sector performance
- [ ] Overall market direction

#### Step 4: Options Analysis (ALWAYS INCLUDED)
- [ ] IV level (high/low/normal vs historical)
- [ ] Is premium cheap or expensive?
- [ ] Expected move if available
- [ ] Put/call ratio sentiment

#### Step 5: Vehicle Selection Decision Tree

```
IF high IV (>50% percentile):
  → Consider: Shares, selling premium (covered calls, put sales, credit spreads)
  → Avoid: Buying naked calls/puts (expensive premium)

IF low IV (<30% percentile):
  → Consider: Buying calls/puts, debit spreads
  → Avoid: Selling premium (cheap income)

IF binary event upcoming (earnings, FDA):
  → Consider: Defined risk strategies (spreads, straddles if IV not crushed)
  → Avoid: Naked positions, unlimited risk

IF already own shares + high IV:
  → Consider: Covered calls (get paid to hold)
  → Consider: Protective puts if downside risk

IF high conviction directional:
  → Low IV: Buy calls/puts outright
  → High IV: Use spreads to reduce cost
  → Longer timeframe: LEAPS
```

#### Step 6: Document the Trade Thesis

Before ANY entry, write out:
```
SYMBOL: ___
DIRECTION: Long/Short
VEHICLE: Shares/Calls/Puts/Spreads/etc.
WHY THIS VEHICLE: ___
ENTRY: ___
STOP LOSS: ___
TARGET: ___
CATALYST: ___
TIMEFRAME: ___
RISK/REWARD: ___
IV ENVIRONMENT: ___
CONFIDENCE: 1-5
```

### Checklist Enforcement

**The trading agent MUST include this summary in Discord reports:**

```
📋 ANALYSIS CHECKLIST:
✅ Current data pulled (not assumed)
✅ WHY understood (catalyst/reason documented)
✅ Directional evidence provided (if earnings/catalyst play)
✅ Market context checked
✅ IV environment assessed
✅ Vehicle selected based on conditions
✅ Trade thesis documented
```

**If any checkbox is missing, the analysis is INCOMPLETE.**

**For earnings plays, MUST include:**
```
DIRECTIONAL LEAN: [Bullish/Bearish/Neutral]
KEY EVIDENCE: [1-2 main factors]
CONFIDENCE: X/5
```

### Anti-Patterns to AVOID

| Bad Practice | Why It's Wrong | Correct Approach |
|--------------|----------------|------------------|
| "AMD is extended" without checking | Assumption, not data | Pull actual price and chart |
| Suggesting calls when IV is 90%+ | Expensive premium | Use spreads or wait for IV crush |
| Only looking at RSI/oversold | Single indicator | Full analysis: catalyst + technicals + sentiment + IV |
| "Want options?" as separate question | Options are a tool, not add-on | Include IV/vehicle analysis by default |
| Skipping options analysis | Incomplete picture | Always assess IV environment |
| "Earnings is catalyst" with no direction | 50/50 gambling | Provide directional evidence (estimates, peers, flow) |
| Playing binary events without lean | Coin flip, not trading | Must have bullish/bearish thesis with evidence |

### Quick Reference: When to Use Each Vehicle

| Condition | Best Vehicle | Why |
|-----------|--------------|-----|
| High IV + Bullish | Shares or sell puts | Don't overpay for calls |
| High IV + Own shares | Covered calls | Get paid to hold |
| Low IV + Bullish | Buy calls | Cheap premium |
| Low IV + Catalyst coming | Buy calls/puts | Cheap bets on move |
| Binary event | Spreads | Defined risk |
| High conviction, long-term | LEAPS | Time on your side |
| Uncertain direction | Stay out | No edge = no trade |

### Tools Available

```bash
# Full market scan
node swing_options/index.js scan

# Specific symbol analysis
node swing_options/index.js analyze SYMBOL

# Symbol sentiment
node swing_options/index.js sentsym SYMBOL

# Market context
node swing_options/index.js market

# Earnings calendar
node swing_options/index.js earnings 14

# Social sentiment
node swing_options/index.js sentiment

# Contrarian/shorts
node swing_options/index.js contrarian

# Account/positions
node swing_options/index.js account
node swing_options/index.js positions
```

**USE ALL OF THEM. Not just one or two.**

---
