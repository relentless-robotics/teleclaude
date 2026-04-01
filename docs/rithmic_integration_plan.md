# Rithmic R|Protocol API Integration Plan

*Last updated: 2026-03-15*

## 1. Architecture Overview

Rithmic's R|Protocol API uses **WebSocket + Google Protocol Buffers** for all communication. Functionality is split across separate **Plants**, each requiring its own WebSocket connection and login:

| Plant | Purpose | Template IDs |
|-------|---------|-------------|
| **Ticker Plant** | Market data: BBO (151), trades (150), DOM (152), **MBO/DepthByOrder (318)** | 100-399 range |
| **Order Plant** | Order routing: submit (300), modify (302), cancel (304), notifications (350) | 300-399 range |
| **PnL Plant** | Account P&L and position tracking (450) | 400-499 range |
| **History Plant** | Historical bar replay | tick/time bar IDs |
| **Repository Plant** | Agreements, self-certification | misc |

**Key template IDs for MBO:**
- `312` = RequestDepthByOrderUpdates (subscribe/unsubscribe)
- `313` = ResponseDepthByOrderUpdates (ack)
- `318` = DepthByOrder (individual MBO events)
- `319` = DepthByOrderEndEvent (marks end of a batch)

---

## 2. Rithmic MBO vs Databento MBO: Field Mapping

### 2.1 Core Data Comparison

| Concept | Databento DBN MBO | Rithmic DepthByOrder (template 318) | Translation Needed |
|---------|-------------------|--------------------------------------|-------------------|
| **Action/Event Type** | `action`: u8 ASCII (A=Add, C=Cancel, M=Modify, T=Trade, F=Fill, R=Reset) | `update_type`: enum (1=NEW, 2=CHANGE, 3=DELETE) | YES - see mapping below |
| **Side** | `side`: u8 ASCII (B=Bid/66, A=Ask/65, N=None/78) | `transaction_type`: enum (1=BUY, 2=SELL) | YES - BUY->B, SELL->A |
| **Price** | `price`: i64 fixed-point (value * 1e-9 = USD) | `depth_price`: double (USD float, e.g. 5225.25) | YES - multiply by 1e9 and cast to int |
| **Size** | `size`: u32 (lots) | `depth_size`: int32 (lots) | Direct (same meaning) |
| **Order ID** | `order_id`: u64 (exchange-assigned) | `exchange_order_id`: string | YES - parse string to int, or use priority |
| **Order Priority** | Implicit in order_id / sequence | `depth_order_priority`: uint64 (queue position) | Rithmic provides explicit priority |
| **Flags** | `flags`: u8 (bit flags from DBN) | N/A | Set to 0 for Rithmic events |
| **Sequence** | `sequence`: u32 (exchange sequence) | `sequence_number`: uint64 | Direct (both monotonic) |
| **Timestamp** | `ts_event`: u64 nanoseconds since Unix epoch | `ssboe` + `usecs` (+ optional `source_nsecs`) | YES - see timestamp section |
| **Instrument ID** | `instrument_id`: u32 (Databento-specific, e.g. ESH6=42140878) | N/A (symbol string instead) | Assign our own constant |
| **Previous Price** | N/A | `prev_depth_price`: double (for CHANGE events) | Extra info - useful for modify tracking |

### 2.2 Action Code Mapping (Rithmic -> Databento/MboEvent)

```python
RITHMIC_TO_MBO_ACTION = {
    1: ord('A'),   # NEW    -> Add (65)
    2: ord('M'),   # CHANGE -> Modify (77)
    3: ord('C'),   # DELETE -> Cancel (67)
}
```

**Critical difference:** Rithmic's DepthByOrder does NOT emit Trade events (action=T). Trades come via the separate **LastTrade** message (template 150). The existing `rithmic_feed.py` already handles this by mapping template 150 to action='T'.

### 2.3 Side Code Mapping

```python
RITHMIC_TO_MBO_SIDE = {
    1: ord('B'),   # BUY  -> Bid (66)
    2: ord('A'),   # SELL -> Ask (65)
}
```

### 2.4 Timestamp Conversion

**Rithmic timestamps** use a split format across multiple fields:
- `ssboe`: Seconds Since Beginning Of Epoch (int32, Unix seconds)
- `usecs`: Microseconds component (int32, 0-999999)
- `source_ssboe` + `source_usecs` + `source_nsecs`: Exchange source timestamp (when available)

**Databento timestamps** use a single `ts_event`: uint64 nanoseconds since Unix epoch.

**Conversion:**
```python
def rithmic_to_ns(ssboe: int, usecs: int, nsecs: int = 0) -> int:
    """Convert Rithmic split timestamp to nanoseconds since epoch."""
    return (ssboe * 1_000_000_000) + (usecs * 1_000) + nsecs

def rithmic_source_to_ns(source_ssboe: int, source_usecs: int, source_nsecs: int = 0) -> int:
    """Convert Rithmic source (exchange) timestamp to ns. Use this for latency measurement."""
    return (source_ssboe * 1_000_000_000) + (source_usecs * 1_000) + source_nsecs
```

**Precision comparison:**
- Databento: nanosecond precision from exchange (CME MDP3 provides ns)
- Rithmic `ssboe+usecs`: microsecond precision from Rithmic's receipt
- Rithmic `source_ssboe+source_usecs+source_nsecs`: nanosecond precision from exchange (when available)

**Recommendation:** Use `source_ssboe + source_usecs + source_nsecs` when available (closest to exchange time). Fall back to `ssboe + usecs` otherwise.

---

## 3. Current Code Status & Gaps

### 3.1 What We Already Have (C:\Users\Footb\Documents\Github\Lvl3Quant\live_trading\)

| File | Status | Notes |
|------|--------|-------|
| `broker/rithmic_proto.py` | COMPLETE | Pure-Python protobuf encoder/decoder. Handles login, orders, market data subscribe, heartbeat, framing. |
| `broker/rithmic_feed.py` | **PARTIAL** | Handles BBO (151), trades (150), DOM (152). Does NOT handle true MBO DepthByOrder (318). |
| `broker/rithmic_broker.py` | COMPLETE | Full order plant adapter: place/modify/cancel, fill handling, reconnection, kill switch. |
| `broker/rithmic_config.py` | COMPLETE | Config with AMP/TopstepX presets, env var support, paper/live modes. |
| `feed/mbo_event.py` | COMPLETE | MboEvent dataclass matching Rust struct exactly. |
| `feed/feed_handler.py` | COMPLETE | Databento LiveFeedHandler and ReplayFeedHandler. |
| `book/book_builder.py` | COMPLETE | Consumes MboEvent, builds 100ms (20,4) tensors. |
| `book/order_book.py` | COMPLETE | Full order book reconstruction from MBO events. |
| `data/mbo_recorder.py` | COMPLETE | Records live data to NPZ (matches training format). |

### 3.2 Critical Gap: True MBO Not Implemented in RithmicFeed

**`rithmic_feed.py` currently maps BBO+trade+DOM to MboEvent**, but this is NOT true MBO data:
- BBO (template 151) = only top-of-book, no individual orders
- DOM (template 152) = aggregated price-level depth, no order IDs
- DepthByOrder (template 318) = TRUE MBO with individual order events

**The existing feed works for BBO+trade signals but CANNOT replicate the training data quality.** Training uses Databento MBO with per-order events. The live pipeline must also use per-order events (template 318) to match.

### 3.3 What Needs to Be Built

1. **MBO decoder in `rithmic_proto.py`**: Add template 318 (DepthByOrder) field constants and parsing
2. **MBO subscription in `rithmic_feed.py`**: Subscribe via template 312 instead of/alongside template 100
3. **MBO -> MboEvent translation**: Convert DepthByOrder messages to MboEvent with correct field mapping
4. **Batch handling**: DepthByOrder messages are batched (multiple updates per message via `repeated` fields), terminated by DepthByOrderEndEvent (template 319)
5. **Sequence tracking**: Use `sequence_number` for gap detection

---

## 4. Rithmic DepthByOrder Message Structure (from proto)

```protobuf
message DepthByOrder {
    // template_id = 318

    enum TransactionType { BUY = 1; SELL = 2; }
    enum UpdateType { NEW = 1; CHANGE = 2; DELETE = 3; }

    required int32            template_id            = 154467;
    optional string           symbol                 = 110100;
    optional string           exchange               = 110101;
    optional uint64           sequence_number        = 112002;

    // REPEATED fields -- multiple order updates per message
    repeated UpdateType       update_type            = 110121;
    repeated TransactionType  transaction_type       = 153612;
    repeated double           depth_price            = 154405;
    repeated double           prev_depth_price       = 154906;
    repeated bool             prev_depth_price_flag  = 154930;
    repeated int32            depth_size             = 154406;
    repeated uint64           depth_order_priority   = 153613;
    repeated string           exchange_order_id      = 149238;

    // Timestamps
    optional int32            ssboe                  = 150100;
    optional int32            usecs                  = 150101;
    optional int32            source_ssboe           = 150400;
    optional int32            source_usecs           = 150401;
    optional int32            source_nsecs           = 150404;
    optional int32            jop_ssboe              = 150600;  // Rithmic JOP receipt
    optional int32            jop_nsecs              = 150604;
}
```

**Key detail:** The `repeated` fields mean a single DepthByOrder message can contain MULTIPLE order events (e.g., 3 adds at once). Each `repeated` list is parallel-indexed: `update_type[i]` corresponds to `transaction_type[i]`, `depth_price[i]`, etc.

---

## 5. Authentication & Connection Setup

### 5.1 AMP Futures Credentials

| Parameter | Paper Trading | Live Trading |
|-----------|--------------|--------------|
| `system_name` | "Rithmic Paper Trading" | "Rithmic 01" |
| `fcm_id` | "AMP" | "AMP" |
| `ib_id` | "AMP" | "AMP" |
| `server_url` | wss://rituz00100.rithmic.com:443 | Assigned by AMP on live setup |
| `username` | Your Rithmic login email | Same |
| `password` | Your Rithmic password | Same |
| `account_id` | Paper account ID (from AMP) | Live account ID |

**To get credentials:** Email tradedesk@ampfutures.com requesting R|API+ access. They will provision your account and provide paper trading credentials. For live, submit via Client Portal > Trade Desk > Live Trading Credentials Request.

**MBO data entitlement:** Requires CME Level 2 data subscription ($17/month through AMP). Must be explicitly enabled -- email AMP to confirm MBO/DepthByOrder is active on your feed.

### 5.2 Connection Flow

```
1. Open WebSocket to wss://rituz00100.rithmic.com:443
2. Send RequestLogin (template 10) with:
   - infra_type = TICKER_PLANT
   - system_name, user, password, fcm_id, ib_id
   - app_name = "Lvl3Quant", app_version = "1.0"
3. Receive ResponseLogin (template 11), verify rp_code = "0"
4. Send RequestDepthByOrderUpdates (template 312) with:
   - symbol = "ESM6" (front month)
   - exchange = "CME"
   - request = SUBSCRIBE (1)
5. Receive DepthByOrder (318) events continuously
6. Send heartbeat (template 18) every 30 seconds
```

### 5.3 Multiple Simultaneous Connections

Each plant needs a separate WebSocket. For our system:
- **Connection 1**: Ticker Plant (MBO data feed)
- **Connection 2**: Order Plant (order routing)
- **Connection 3**: PnL Plant (position tracking)

All three can use the same credentials but different `infra_type` in the login.

---

## 6. Python Libraries

### 6.1 Recommended: Our Own Implementation (rithmic_proto.py)

We already have a working pure-Python protobuf encoder/decoder. This is preferred because:
- Zero external dependencies beyond `websockets`
- Full control over field mapping and performance
- Already tested with AMP paper trading (BBO+trades work)
- Just needs MBO template 318 support added

### 6.2 Alternative: async-rithmic

```bash
pip install async-rithmic
```

- PyPI: https://pypi.org/project/async-rithmic/
- Docs: https://async-rithmic.readthedocs.io/
- Supports market data, orders, and L2 streaming
- However: may not expose raw DepthByOrder (MBO) directly
- Uses the official compiled .proto files (we have v0.89.0.0)

### 6.3 Alternative: pyrithmic

```bash
pip install git+https://github.com/jacksonwoody/pyrithmic.git#egg=pyrithmic
```

- GitHub: https://github.com/jacksonwoody/pyrithmic
- Lower-level, closer to raw protobuf
- Less maintained than async-rithmic

### 6.4 Rust Library (for reference)

- `rithmic-rs`: https://docs.rs/rithmic-rs
- Could be used in our Rust fill sim pipeline if needed

---

## 7. Latency Considerations

| Path | Estimated Latency | Notes |
|------|-------------------|-------|
| CME -> Rithmic (colo) | ~50-200 us | Rithmic has co-located servers |
| Rithmic -> AMP -> Us (WAN) | ~5-50 ms | Depends on geography and AMP's setup |
| Rithmic -> Us (R\|Diamond direct) | ~1-5 ms | Direct connection to Rithmic gateways (extra cost) |
| Databento -> Us (for comparison) | ~1-10 ms | Databento co-located at exchange |

**For our use case (30-minute hold time, ~130 trades/74 days):**
- Latency of 5-50ms is irrelevant -- our signal operates on 100ms bars
- The critical factor is data COMPLETENESS, not speed
- We need all individual order events (MBO), not just aggregated depth

**R|Diamond API** ($extra cost) provides ultra-low latency direct gateway access. NOT needed for our signal horizon.

---

## 8. Implementation Plan

### Phase 1: MBO Feed (Immediate)

1. **Add MBO constants to `rithmic_proto.py`:**
   - Template IDs: 312, 313, 318, 319
   - Field numbers from `depth_by_order.proto`
   - `build_depth_by_order_subscribe()` function
   - Decoder for repeated fields in template 318

2. **Extend `rithmic_feed.py`:**
   - Add `_decode_depth_by_order()` method
   - Handle batched events (repeated fields -> multiple MboEvents)
   - Convert: update_type -> action, transaction_type -> side, depth_price -> price_raw
   - Use exchange source timestamps when available

3. **Test with AMP paper:**
   - Subscribe to ESM6 MBO on paper system
   - Verify event rate (~2000-5000/sec during RTH for ES)
   - Compare BBO derived from MBO vs BBO from template 151 (should match)
   - Log to JSONL for offline analysis

### Phase 2: Validation (Before Paper Trading)

4. **Compare Rithmic MBO vs Databento MBO:**
   - Record one day of Rithmic MBO events
   - Compare against same day's Databento .dbn file
   - Verify: event counts within 5%, price levels match, sequence gaps < 0.1%
   - Check: are `exchange_order_id` consistent between providers?

5. **Run through book builder:**
   - Feed Rithmic MBO into `book_builder.py`
   - Compare output tensors against Databento-derived tensors for same period
   - IC correlation should be >0.95 between the two sources

### Phase 3: Paper Trading

6. **Integrate with live trading main loop:**
   - Switch `feed_handler` to use `RithmicFeed` with MBO mode
   - Verify BookBuilder produces valid tensors
   - Run CNN inference on live Rithmic data
   - Paper trade for 5+ days, compare signals to historical predictions

### Phase 4: MBO Data Recording

7. **Record Rithmic MBO for retraining:**
   - MboRecorder already saves NPZ in correct format
   - Verify Rithmic-sourced NPZ files work in training pipeline
   - Set up daily rsync to training servers

---

## 9. Known Issues & Gotchas

1. **MBO requires FCM association:** AMP must explicitly enable MBO (DepthByOrder) on your account. BBO+trades work by default, but MBO may require contacting AMP support. (Confirmed from Mar 11 testing: BBO+trades work, MBO needs FCM association.)

2. **No 4-byte length prefix in v2 protocol:** Starting from RProtocolAPI 0.81.0.0, the protocol server uses "version 2.0 payload format" which does NOT use the 4-byte message length prefix. Our `rithmic_proto.py` currently uses `frame()` and `unframe()` with 4-byte length prefix -- **this may need to be removed for newer servers.** Test by trying both with and without framing.

3. **Repeated fields in protobuf:** DepthByOrder uses `repeated` fields (arrays). Our `decode_message()` already handles this correctly (returns `dict[field_num, list[value]]`).

4. **Price as double vs fixed-point:** Rithmic sends prices as `double` (IEEE 754 float64). Databento uses `int64` fixed-point (price * 1e9). Floating-point rounding can cause 1-tick discrepancies. Use `round()` when converting: `price_raw = int(round(depth_price * 1e9))`.

5. **Symbol naming:** Rithmic uses 3-4 char symbols (e.g., "ESM6"). Databento uses "ES.FUT" or instrument_id integers. Our code already handles this in `_get_front_month_symbol()`.

6. **Session rollover:** Rithmic may send a DepthByOrderEndEvent and clear the book at session boundaries (e.g., 17:00 ET daily maintenance). Handle action=RESET when this occurs.

7. **Aggregated vs unaggregated quotes:** During login, you can request `aggregated_quotes = false` to get unaggregated (raw) data. For MBO, this should always be false. Some gateways may aggregate by default.

---

## 10. Quick Reference: Template ID Table

| ID | Message | Direction | Plant |
|----|---------|-----------|-------|
| 10 | RequestLogin | Out | All |
| 11 | ResponseLogin | In | All |
| 12 | RequestLogout | Out | All |
| 13 | ResponseLogout | In | All |
| 18 | RequestHeartbeat | Out | All |
| 19 | ResponseHeartbeat | In | All |
| 100 | RequestMarketDataUpdate | Out | Ticker |
| 101 | ResponseMarketDataUpdate | In | Ticker |
| 150 | LastTrade | In | Ticker |
| 151 | BestBidOffer | In | Ticker |
| 152 | OrderBook (DOM) | In | Ticker |
| 300 | RequestNewOrder | Out | Order |
| 301 | ResponseNewOrder | In | Order |
| 302 | RequestModifyOrder | Out | Order |
| 303 | ResponseModifyOrder | In | Order |
| 304 | RequestCancelOrder | Out | Order |
| 305 | ResponseCancelOrder | In | Order |
| **312** | **RequestDepthByOrderUpdates** | **Out** | **Ticker** |
| **313** | **ResponseDepthByOrderUpdates** | **In** | **Ticker** |
| **318** | **DepthByOrder (MBO events)** | **In** | **Ticker** |
| **319** | **DepthByOrderEndEvent** | **In** | **Ticker** |
| 350 | ExchangeOrderNotification | In | Order |
| 400 | RequestPnlPositionUpdates | Out | PnL |
| 401 | ResponsePnlPositionUpdates | In | PnL |
| 450 | InstrumentPnlPositionUpdate | In | PnL |

---

## 11. File References

| File | Path | Purpose |
|------|------|---------|
| Rithmic proto definitions | `teleclaude-main/downloads/rithmic_api/0.89.0.0/proto/` | Official .proto files (v5.42) |
| Rithmic JS MBO test | `teleclaude-main/downloads/rithmic_api/0.89.0.0/samples/samples.js/test_mbo.js` | Working MBO subscribe example |
| Rithmic Python samples | `teleclaude-main/downloads/rithmic_api/0.89.0.0/samples/samples.py/` | Official Python examples |
| Our proto encoder | `Lvl3Quant/live_trading/broker/rithmic_proto.py` | Pure-Python protobuf implementation |
| Our Rithmic feed | `Lvl3Quant/live_trading/broker/rithmic_feed.py` | BBO+trade+DOM feed (needs MBO) |
| Our Rithmic broker | `Lvl3Quant/live_trading/broker/rithmic_broker.py` | Order plant adapter (complete) |
| Our Rithmic config | `Lvl3Quant/live_trading/broker/rithmic_config.py` | AMP/TopstepX presets |
| MboEvent definition | `Lvl3Quant/live_trading/feed/mbo_event.py` | Target data structure |
| Book builder | `Lvl3Quant/live_trading/book/book_builder.py` | Consumes MboEvent -> tensors |
| Data recorder | `Lvl3Quant/live_trading/data/mbo_recorder.py` | Saves NPZ for retraining |
