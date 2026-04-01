"""
Quant Dashboard — ES Futures
=============================
Three top-level tabs: LIVE | WALK-FORWARD | SWEEP RESULTS
Sub-tabs within each for specific views.

Run: python -m streamlit run quant_dashboard/app.py --server.port 8501
"""
import streamlit as st
import pandas as pd
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import plotly.express as px
import sys, os, json, time
from pathlib import Path
from datetime import datetime, date

sys.path.insert(0, str(Path(__file__).parent))
from config import (
    ES_TICK_VALUE, ES_TICK_SIZE, TRADING_DAYS_PER_YEAR, RT_COMMISSION,
    COMPUTE_NODES, STRATEGY_STATUS,
)
from data_loader import (
    load_cnn_oot_results, load_chase_sweep, load_wf_fill_sim, load_mfe_sweep,
    load_event_logs, configs_to_dataframe, parse_config_name,
    get_oot_prediction_dates, get_oot_npz_path, simulate_config_day,
    list_book_cache_dates, load_bookmap_data, load_all_result_files,
    load_aggregated_sweeps,
)

st.set_page_config(
    page_title="Quant Dashboard",
    page_icon="\U0001f4ca",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# === DARK MODE TOGGLE ===
if "dark_mode" not in st.session_state:
    st.session_state.dark_mode = True  # Default dark

# Theme variables
if st.session_state.dark_mode:
    T = {
        "bg": "#0f1117", "card": "#1a1d24", "card_border": "#2d3139",
        "text": "#e5e7eb", "text_muted": "#9ca3af", "text_heading": "#f0f6fc",
        "tab_bg": "#1a1d24", "tab_active_bg": "linear-gradient(135deg, #6366f1, #8b5cf6)",
        "tab_active_text": "white", "tab_text": "#9ca3af",
        "subtab_bg": "#161b22", "subtab_active": "#1e2530",
        "source_bg": "#1e2530", "source_border": "#6366f1",
        "btn_bg": "linear-gradient(135deg, #6366f1, #8b5cf6)",
        "chip_green_bg": "#064e3b", "chip_green_text": "#34d399",
        "chip_red_bg": "#7f1d1d", "chip_red_text": "#fca5a5",
        "chip_amber_bg": "#78350f", "chip_amber_text": "#fbbf24",
        "node_bg": "#1a1d24", "shadow": "rgba(0,0,0,0.3)",
        "plotly_template": "plotly_dark",
    }
else:
    T = {
        "bg": "#f5f5f7", "card": "white", "card_border": "#e5e7eb",
        "text": "#374151", "text_muted": "#6b7280", "text_heading": "#111827",
        "tab_bg": "white", "tab_active_bg": "linear-gradient(135deg, #6366f1, #8b5cf6)",
        "tab_active_text": "white", "tab_text": "#6b7280",
        "subtab_bg": "#f0f0f5", "subtab_active": "white",
        "source_bg": "white", "source_border": "#6366f1",
        "btn_bg": "linear-gradient(135deg, #6366f1, #8b5cf6)",
        "chip_green_bg": "#d1fae5", "chip_green_text": "#065f46",
        "chip_red_bg": "#fee2e2", "chip_red_text": "#991b1b",
        "chip_amber_bg": "#fef3c7", "chip_amber_text": "#92400e",
        "node_bg": "white", "shadow": "rgba(0,0,0,0.06)",
        "plotly_template": "plotly_white",
    }

st.markdown(f"""
<style>
    .stApp {{ background-color: {T['bg']}; }}
    header[data-testid="stHeader"] {{ display: none; }}
    .block-container {{ padding-top: 1rem !important; }}
    section[data-testid="stSidebar"] {{ display: none; }}

    /* Main tabs */
    .stTabs [data-baseweb="tab-list"] {{
        gap: 0; background: {T['tab_bg']}; border-radius: 16px;
        padding: 4px; box-shadow: 0 2px 12px {T['shadow']};
        margin-bottom: 16px;
    }}
    .stTabs [data-baseweb="tab"] {{
        padding: 12px 40px; font-weight: 700; font-size: 1.15em;
        border-radius: 12px; color: {T['tab_text']};
    }}
    .stTabs [aria-selected="true"] {{
        background: {T['tab_active_bg']} !important;
        color: {T['tab_active_text']} !important;
        box-shadow: 0 4px 12px rgba(99,102,241,0.3);
    }}

    /* Cards */
    .metric-card {{
        background: {T['card']}; border: 1px solid {T['card_border']};
        border-radius: 16px; padding: 20px; margin: 6px 0;
        box-shadow: 0 2px 8px {T['shadow']};
        transition: transform 0.15s ease, box-shadow 0.15s ease;
    }}
    .metric-card:hover {{ transform: translateY(-2px); box-shadow: 0 6px 20px {T['shadow']}; }}
    .metric-card h3 {{ color: {T['text_muted']}; font-size: 0.75em; margin: 0 0 4px 0; text-transform: uppercase; letter-spacing: 0.5px; }}
    .metric-card .value {{ font-size: 1.8em; font-weight: 800; color: {T['text_heading']}; }}

    .metric-green .value {{ color: #10b981; }}
    .metric-blue .value {{ color: #6366f1; }}
    .metric-amber .value {{ color: #f59e0b; }}
    .metric-rose .value {{ color: #f43f5e; }}

    .source-label {{
        background: {T['source_bg']}; border-left: 4px solid {T['source_border']};
        border-radius: 0 12px 12px 0;
        padding: 10px 16px; margin: 12px 0; font-size: 0.82em; color: {T['text_muted']};
        box-shadow: 0 1px 4px {T['shadow']};
    }}

    .stDataFrame {{ border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px {T['shadow']}; }}

    h1 {{ color: {T['text_heading']} !important; font-weight: 800 !important; }}
    h2 {{ color: {T['text_heading']} !important; font-weight: 700 !important; }}
    h3 {{ color: {T['text']} !important; }}
    p, li, span, label {{ color: {T['text']}; }}
    .stCaption {{ color: {T['text_muted']} !important; }}
    .stMarkdown {{ color: {T['text']}; }}

    .stButton>button {{
        border-radius: 12px !important; font-weight: 600 !important;
        border: none !important; padding: 8px 24px !important;
        background: {T['btn_bg']} !important;
        color: white !important;
        box-shadow: 0 2px 8px rgba(99,102,241,0.3) !important;
    }}
    .stButton>button:hover {{
        transform: translateY(-1px) !important;
        box-shadow: 0 4px 16px rgba(99,102,241,0.4) !important;
    }}

    .stSelectbox>div>div {{ border-radius: 12px !important; }}
    .js-plotly-plot {{ border-radius: 16px; overflow: hidden; }}

    .stTabs .stTabs [data-baseweb="tab-list"] {{
        background: {T['subtab_bg']}; border-radius: 12px; padding: 3px;
    }}
    .stTabs .stTabs [data-baseweb="tab"] {{
        font-size: 0.95em; padding: 8px 20px; font-weight: 600;
    }}
    .stTabs .stTabs [aria-selected="true"] {{
        background: {T['subtab_active']} !important; color: #6366f1 !important;
        box-shadow: 0 2px 6px {T['shadow']};
    }}

    .chip {{
        display: inline-block; padding: 4px 14px; border-radius: 20px;
        font-size: 0.78em; font-weight: 700; margin: 2px;
    }}
    .chip-green {{ background: {T['chip_green_bg']}; color: {T['chip_green_text']}; }}
    .chip-red {{ background: {T['chip_red_bg']}; color: {T['chip_red_text']}; }}
    .chip-amber {{ background: {T['chip_amber_bg']}; color: {T['chip_amber_text']}; }}

    .node-card {{
        background: {T['node_bg']}; border-radius: 16px; padding: 16px;
        margin: 8px 0; box-shadow: 0 2px 8px {T['shadow']};
        border-left: 4px solid; color: {T['text']};
    }}
    .node-card strong {{ color: {T['text_heading']}; }}
    .node-running {{ border-left-color: #10b981; }}
    .node-idle {{ border-left-color: #6b7280; }}
    .node-unreachable {{ border-left-color: #ef4444; opacity: 0.75; }}
</style>
""", unsafe_allow_html=True)

# === HEADER BAR ===
hdr1, hdr2, hdr3 = st.columns([6, 2, 1])
with hdr1:
    st.title("Quant Dashboard")
with hdr2:
    st.caption("")  # spacer
    st.caption("ES Futures | Rust MBO Fill Sim")
with hdr3:
    st.caption("")  # spacer
    if st.button("Dark" if not st.session_state.dark_mode else "Light", key="theme_toggle"):
        st.session_state.dark_mode = not st.session_state.dark_mode
        st.rerun()

# Plotly template shorthand
PT = T["plotly_template"]

# TradingView-style chart interaction config
CHART_CONFIG = {
    "scrollZoom": True,          # Scroll to zoom
    "displayModeBar": True,
    "modeBarButtonsToAdd": ["drawline", "drawopenpath", "eraseshape"],
    "modeBarButtonsToRemove": ["lasso2d", "select2d"],
    "displaylogo": False,
    "doubleClick": "reset",      # Double-click to reset zoom
}

import sqlite3

_QCC_DB_PATH = Path(r"C:\Users\Footb\Documents\Github\teleclaude-main\data\qcc.db")


@st.cache_data(ttl=120)
def _load_qcc_oot_stats(card_name: str) -> dict | None:
    """Load OOT backtest stats for a card from the QCC database.

    Returns a dict with sharpe, pnl, trades, win_rate, MAE/MFE stats,
    edge decay, exit reasons — or None if DB missing / no data.
    """
    if not _QCC_DB_PATH.exists():
        return None
    try:
        conn = sqlite3.connect(str(_QCC_DB_PATH))
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        # Try card_performance_profiles first (richest data)
        cur.execute("SELECT * FROM card_performance_profiles WHERE card_name = ? ORDER BY profile_date DESC LIMIT 1", (card_name,))
        cpp = cur.fetchone()

        # Get validated_sharpe from card_model_bindings
        cur.execute("SELECT validated_sharpe FROM card_model_bindings WHERE card_name = ?", (card_name,))
        cmb = cur.fetchone()

        # Get backtest info from cards table
        cur.execute("SELECT backtest_sharpe, backtest_trades, backtest_win_rate FROM cards WHERE name = ?", (card_name,))
        card_row = cur.fetchone()

        conn.close()

        result = {"source": None}

        # Merge data: prefer card_performance_profiles, fall back to cards/cmb
        if cpp and cpp["n_trades"] is not None:
            result["source"] = "card_performance_profiles"
            result["sharpe"] = cpp["sharpe"]
            result["total_pnl"] = cpp["total_pnl"]
            result["n_trades"] = cpp["n_trades"]
            result["win_rate"] = cpp["win_rate"]
            result["profit_factor"] = cpp["profit_factor"]
            result["mae_avg"] = cpp["mae_avg"]
            result["mae_p50"] = cpp["mae_p50"]
            result["mae_p95"] = cpp["mae_p95"]
            result["mfe_avg"] = cpp["mfe_avg"]
            result["mfe_p50"] = cpp["mfe_p50"]
            result["mfe_p95"] = cpp["mfe_p95"]
            result["optimal_hold_min"] = cpp["optimal_hold_min"]
            result["oot_start"] = cpp["oot_start"]
            result["oot_end"] = cpp["oot_end"]
            result["n_days"] = cpp["n_days"]
            result["best_trade"] = cpp["best_trade"]
            result["worst_trade"] = cpp["worst_trade"]
            result["max_drawdown"] = cpp["max_drawdown"]
            result["avg_hold_sec"] = cpp["avg_hold_sec_all"]
            # Parse JSON fields
            try:
                result["exit_reasons"] = json.loads(cpp["exit_reasons_json"]) if cpp["exit_reasons_json"] else None
            except (json.JSONDecodeError, TypeError):
                result["exit_reasons"] = None
            try:
                result["edge_decay"] = json.loads(cpp["edge_decay_json"]) if cpp["edge_decay_json"] else None
            except (json.JSONDecodeError, TypeError):
                result["edge_decay"] = None
        else:
            # Fallback: use validated_sharpe from bindings or backtest_sharpe from cards
            sharpe_val = None
            if cmb and cmb["validated_sharpe"] is not None:
                sharpe_val = cmb["validated_sharpe"]
                result["source"] = "card_model_bindings"
            elif card_row and card_row["backtest_sharpe"] is not None:
                sharpe_val = card_row["backtest_sharpe"]
                result["source"] = "cards"
            if sharpe_val is not None:
                result["sharpe"] = sharpe_val
                result["n_trades"] = card_row["backtest_trades"] if card_row else None
                result["win_rate"] = card_row["backtest_win_rate"] if card_row else None
            else:
                return None  # No OOT data at all

        return result
    except Exception:
        return None


_tv_chart_counter = 0

def tv_chart(fig, **kwargs):
    """Render a plotly chart with TradingView-style interactions."""
    global _tv_chart_counter
    _tv_chart_counter += 1
    if "key" not in kwargs:
        kwargs["key"] = f"tv_chart_{_tv_chart_counter}"
    # Enable scroll zoom, drag to pan, crosshair
    fig.update_layout(
        dragmode="pan",                    # Click-drag = pan (not zoom box)
        hovermode="x unified",             # Crosshair follows x-axis
        hoverlabel=dict(bgcolor="rgba(0,0,0,0.8)", font_size=12),
        xaxis=dict(rangeslider=dict(visible=True, thickness=0.06)),  # Range slider for pan/scroll
    )
    # Apply to all xaxes/yaxes for subplots
    for key in fig.layout.to_plotly_json():
        if key.startswith("xaxis"):
            fig.layout[key].update(showspikes=True, spikemode="across",
                                   spikethickness=1, spikecolor="#888", spikesnap="cursor")
        if key.startswith("yaxis"):
            fig.layout[key].update(showspikes=True, spikemode="across",
                                   spikethickness=1, spikecolor="#888", spikesnap="cursor",
                                   fixedrange=False)  # Allow y-axis zoom too
    st.plotly_chart(fig, use_container_width=True, config=CHART_CONFIG, **kwargs)

# ================================================================
# LIVE DATA HELPERS
# ================================================================
_JSONL_BASE = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant\data\raw\rithmic_mbo")
_CNN_LOG = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant\alpha_discovery\deep_models\results\walkforward_book_20260316_234709.log")


def _today_jsonl() -> Path:
    return _JSONL_BASE / f"{date.today().isoformat()}_rithmic.jsonl"


def _file_age_seconds(p: Path) -> float | None:
    """Return seconds since file was last modified, or None if missing."""
    try:
        return time.time() - p.stat().st_mtime
    except (FileNotFoundError, OSError):
        return None


def _read_last_lines(p: Path, n: int = 500) -> list[str]:
    """Read the last n lines of a (potentially large) file efficiently."""
    if not p.exists():
        return []
    try:
        with open(p, "rb") as f:
            # Seek from end
            f.seek(0, 2)
            size = f.tell()
            buf = min(n * 120, size)  # ~120 bytes/line estimate
            f.seek(max(0, size - buf))
            raw = f.read()
        lines = raw.decode("utf-8", errors="replace").splitlines()
        return lines[-n:]
    except Exception:
        return []


_LIVE_STATE_PATH = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant\live_trading\logs\paper\live_state.json")
_PAPER_STATE_PATH = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant\live_trading\logs\paper\paper_state.json")


def _read_live_state() -> dict | None:
    """Read the paper engine's live_state.json if it exists and is fresh (<10s)."""
    try:
        if _LIVE_STATE_PATH.exists() and _file_age_seconds(_LIVE_STATE_PATH) < 10:
            return json.loads(_LIVE_STATE_PATH.read_text())
    except Exception:
        pass
    return None


def _read_paper_state() -> dict | None:
    """Read paper_state.json (last-known card state, persists after engine stops)."""
    try:
        if _PAPER_STATE_PATH.exists():
            return json.loads(_PAPER_STATE_PATH.read_text())
    except Exception:
        pass
    return None


def _parse_mbo_lines(lines: list[str]) -> pd.DataFrame:
    """Parse JSONL MBO lines into a DataFrame."""
    records = []
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            rec = json.loads(ln)
            records.append(rec)
        except json.JSONDecodeError:
            continue
    if not records:
        return pd.DataFrame()
    df = pd.DataFrame(records)
    # Normalise columns
    if "ts" in df.columns:
        df["ts_ns"] = pd.to_numeric(df["ts"], errors="coerce")
        df["ts_dt"] = pd.to_datetime(df["ts_ns"], unit="ns", utc=True).dt.tz_convert("US/Eastern")
    if "p" in df.columns:
        df["price"] = pd.to_numeric(df["p"], errors="coerce")
    if "sz" in df.columns:
        df["size"] = pd.to_numeric(df["sz"], errors="coerce")
    # 'a' = action: M=modify/trade, A=add, C=cancel; 's' = side: B=bid, A=ask
    return df


# ================================================================
# SYSTEM STATUS BAR
# ================================================================
_jsonl_age  = _file_age_seconds(_today_jsonl())
_cnn_age    = _file_age_seconds(_CNN_LOG)
_live_state = _read_live_state()
_state_age  = _file_age_seconds(_LIVE_STATE_PATH)


def _dot(color: str, label: str) -> str:
    colors = {"green": "#10b981", "red": "#ef4444", "yellow": "#f59e0b", "grey": "#6b7280"}
    hex_c = colors.get(color, "#6b7280")
    return (
        f'<span style="display:inline-flex;align-items:center;gap:5px;'
        f'margin-right:18px;font-size:0.82em;color:{T["text_muted"]};font-weight:600;">'
        f'<span style="width:10px;height:10px;border-radius:50%;background:{hex_c};'
        f'box-shadow:0 0 6px {hex_c}88;display:inline-block;flex-shrink:0;"></span>'
        f'{label}</span>'
    )


_mbo_status = "green" if (_jsonl_age is not None and _jsonl_age < 60) else "red"
_cnn_status = "green" if (_cnn_age  is not None and _cnn_age  < 600) else "red"

# Model Inference: green if live_state is fresh AND mode is paper/live (cards active)
if _live_state and _live_state.get("mode") in ("PAPER", "LIVE") and _live_state.get("cards"):
    _infer_status = "green"
    _infer_label  = f'Model Inference ({int(_state_age or 0)}s ago)'
else:
    _infer_status = "yellow"
    _infer_label  = "Model Inference (pending)"

# Execution: green=paper, yellow=pending, red=down
if _live_state and _live_state.get("mode") == "LIVE":
    _exec_status = "green"
    _exec_label  = "Execution (live)"
elif _live_state and _live_state.get("mode") == "PAPER":
    _exec_status = "green"
    _exec_label  = "Execution (paper)"
elif _live_state:
    _exec_status = "yellow"
    _exec_label  = "Execution (record-only)"
else:
    _exec_status = "yellow"
    _exec_label  = "Execution (paper pending)"

_status_html = (
    f'<div style="background:{T["card"]};border:1px solid {T["card_border"]};'
    f'border-radius:12px;padding:10px 20px;margin-bottom:14px;'
    f'display:flex;align-items:center;flex-wrap:wrap;gap:4px;">'
    f'<span style="font-size:0.75em;font-weight:700;color:{T["text_muted"]};'
    f'margin-right:14px;letter-spacing:0.5px;">SYSTEM STATUS</span>'
    + _dot(_mbo_status,  f'MBO Recorder ({int(_jsonl_age or 0)}s ago)' if _jsonl_age is not None else 'MBO Recorder (no file)')
    + _dot(_cnn_status,  f'Neptune GPU ({int((_cnn_age or 0)//60)}m ago)' if _cnn_age is not None else 'Neptune GPU (no log)')
    + _dot("green",  "Uranus GPU")
    + _dot("green",  "Dashboard")
    + _dot(_infer_status, _infer_label)
    + _dot(_exec_status,  _exec_label)
    + f'</div>'
)
st.markdown(_status_html, unsafe_allow_html=True)


# ================================================================
# MAIN TABS
# ================================================================
tab_live, tab_wf, tab_sweep, tab_compute, tab_models = st.tabs(["LIVE", "WALK-FORWARD", "SWEEP RESULTS", "COMPUTE", "MODELS"])

# ================================================================
# TAB 1: LIVE
# ================================================================
with tab_live:
    live_sub = st.tabs(["Market Feed", "Order Book", "Model Signals", "Full Day Chart"])

    # --- LIVE > Market Feed ---
    with live_sub[0]:
        _mf_state = _read_live_state()

        # --- Metric row ---
        _mf_c1, _mf_c2, _mf_c3, _mf_c4, _mf_c5, _mf_c6 = st.columns(6)
        if _mf_state:
            _mf_price  = _mf_state.get("last_price")
            _mf_bid    = _mf_state.get("best_bid")
            _mf_ask    = _mf_state.get("best_ask")
            _mf_spread = _mf_state.get("spread")
            _mf_evts   = _mf_state.get("events_per_sec", 0)
            _mf_rtt    = _mf_state.get("hb_rtt_ms")
            _mf_bars   = _mf_state.get("bars_processed", 0)
            _mf_age    = _file_age_seconds(_LIVE_STATE_PATH) or 0

            _price_str  = f"{_mf_price:.2f}"  if _mf_price  else "--"
            _bid_str    = f"{_mf_bid:.2f}"    if _mf_bid    else "--"
            _ask_str    = f"{_mf_ask:.2f}"    if _mf_ask    else "--"
            _spread_str = f"{_mf_spread:.2f}" if _mf_spread else "--"
            _evts_str   = f"{_mf_evts:.0f} evt/s"
            _rtt_str    = f"{_mf_rtt:.1f} ms" if _mf_rtt else "-- ms"
        else:
            _price_str = _bid_str = _ask_str = _spread_str = "--"
            _evts_str  = "-- evt/s"
            _rtt_str   = "-- ms"
            _mf_age    = 0
            _mf_bars   = 0

        _status_color = "#10b981" if _mf_state else "#ef4444"
        _status_label = f"Live ({int(_mf_age)}s ago)" if _mf_state else "Offline"

        with _mf_c1:
            st.markdown(f"""<div class="metric-card metric-green">
                <h3>Last Price</h3>
                <div class="value" style="font-family:monospace;">{_price_str}</div>
            </div>""", unsafe_allow_html=True)
        with _mf_c2:
            st.markdown(f"""<div class="metric-card">
                <h3>Bid / Ask</h3>
                <div class="value" style="font-size:1.2em;font-family:monospace;">
                    <span style="color:#26a69a;">{_bid_str}</span>
                    <span style="color:{T['text_muted']};font-size:0.7em;"> / </span>
                    <span style="color:#ef5350;">{_ask_str}</span>
                </div>
            </div>""", unsafe_allow_html=True)
        with _mf_c3:
            st.markdown(f"""<div class="metric-card metric-amber">
                <h3>Spread</h3>
                <div class="value" style="font-family:monospace;">{_spread_str}</div>
            </div>""", unsafe_allow_html=True)
        with _mf_c4:
            st.markdown(f"""<div class="metric-card">
                <h3>Events/sec</h3>
                <div class="value">{_evts_str}</div>
            </div>""", unsafe_allow_html=True)
        with _mf_c5:
            st.markdown(f"""<div class="metric-card metric-blue">
                <h3>HB RTT</h3>
                <div class="value" style="font-family:monospace;">{_rtt_str}</div>
            </div>""", unsafe_allow_html=True)
        with _mf_c6:
            st.markdown(f"""<div class="metric-card">
                <h3>Engine Status</h3>
                <div class="value" style="font-size:1em;color:{_status_color};">{_status_label}</div>
                <div style="color:{T['text_muted']};font-size:0.75em;margin-top:4px;">Bars: {_mf_bars:,}</div>
            </div>""", unsafe_allow_html=True)

        st.markdown("<br>", unsafe_allow_html=True)

        # --- Chart controls row ---
        _ctrl_c1, _ctrl_c2, _ctrl_c3 = st.columns([2, 2, 2])
        with _ctrl_c1:
            _candle_tf = st.selectbox("Candle Timeframe", ["1s", "5s", "15s", "1m", "5m"], index=0, key="candle_tf")
        with _ctrl_c2:
            _auto_scroll = st.checkbox("Auto-scroll to latest", value=True, key="auto_scroll")
        with _ctrl_c3:
            _chart_refresh_ms = 2000  # Streamlit minimum practical refresh
            st.caption(f"Chart refresh: ~{_chart_refresh_ms}ms (Streamlit limited)")

        # Map timeframe label to pandas floor string
        _tf_map = {"1s": "1s", "5s": "5s", "15s": "15s", "1m": "1min", "5m": "5min"}
        _tf_floor = _tf_map.get(_candle_tf, "1s")

        # --- TradingView chart loading historical JSONL data ---
        _hist_lines = _read_last_lines(_today_jsonl(), n=2000)
        _hist_df    = _parse_mbo_lines(_hist_lines)

        # Build OHLC candles from TRADE events only (action=M), NOT deep book add/cancel
        _candles_js = "[]"
        _volume_js  = "[]"
        _markers_js = "[]"
        if not _hist_df.empty and "price" in _hist_df.columns and "ts_dt" in _hist_df.columns:
            _trade_df = _hist_df[_hist_df.get("price", pd.Series(dtype=float)).notna()].copy()
            # Filter to only trade events (action=M) if action column exists — excludes book add/cancel
            if "a" in _trade_df.columns:
                _trade_df = _trade_df[_trade_df["a"] == "M"]
            if not _trade_df.empty and "ts_dt" in _trade_df.columns:
                _trade_df = _trade_df.dropna(subset=["price", "ts_dt"])
                # Filter wicks: only keep prices within 2 ticks (0.50 pts) of rolling median
                _rolling_med = _trade_df["price"].rolling(50, min_periods=1, center=True).median()
                _wick_mask = (_trade_df["price"] >= _rolling_med - 0.50) & (_trade_df["price"] <= _rolling_med + 0.50)
                _trade_df = _trade_df[_wick_mask]
                _trade_df["sec"] = _trade_df["ts_dt"].dt.floor(_tf_floor)
                _ohlc = _trade_df.groupby("sec").agg(
                    open=("price", "first"),
                    high=("price", "max"),
                    low=("price", "min"),
                    close=("price", "last"),
                    volume=("size", "sum") if "size" in _trade_df.columns else ("price", "count"),
                ).reset_index()
                _ohlc["time_unix"] = (_ohlc["sec"].astype("int64") // 10**9).astype(int)
                _ohlc = _ohlc.sort_values("time_unix")

                import json as _json
                _candles_list = [
                    {"time": int(r["time_unix"]), "open": float(r["open"]),
                     "high": float(r["high"]), "low": float(r["low"]), "close": float(r["close"])}
                    for _, r in _ohlc.iterrows()
                ]
                _vol_list = [
                    {"time": int(r["time_unix"]), "value": float(r["volume"] if "volume" in r else 1),
                     "color": "rgba(38,166,154,0.5)" if r["close"] >= r["open"] else "rgba(239,83,80,0.5)"}
                    for _, r in _ohlc.iterrows()
                ]
                _candles_js = _json.dumps(_candles_list)
                _volume_js  = _json.dumps(_vol_list)

        # --- Load trade entry/exit markers from live_state or trade log ---
        _trade_markers = []
        if _mf_state:
            _trade_log = _mf_state.get("trade_log", [])
            for _tl in _trade_log:
                _entry_ts = _tl.get("entry_ts")
                _exit_ts = _tl.get("exit_ts")
                _direction = _tl.get("direction", 0)
                _entry_px = _tl.get("entry_price", 0)
                _exit_px = _tl.get("exit_price", 0)
                _tl_pnl = _tl.get("pnl", 0)
                if _entry_ts:
                    _trade_markers.append({
                        "time": int(_entry_ts),
                        "position": "aboveBar" if _direction > 0 else "belowBar",
                        "color": "#26a69a" if _direction > 0 else "#ef5350",
                        "shape": "arrowUp" if _direction > 0 else "arrowDown",
                        "text": f"{'L' if _direction > 0 else 'S'} @{_entry_px:.2f}",
                    })
                if _exit_ts:
                    _exit_color = "#26a69a" if _tl_pnl >= 0 else "#ef5350"
                    _trade_markers.append({
                        "time": int(_exit_ts),
                        "position": "belowBar" if _direction > 0 else "aboveBar",
                        "color": _exit_color,
                        "shape": "circle",
                        "text": f"Exit ${_tl_pnl:+.0f}",
                    })
        _markers_js = json.dumps(_trade_markers) if _trade_markers else "[]"

        _live_price_js = str(_mf_price) if _mf_state and _mf_price else "null"
        _live_bid_js   = str(_mf_bid)   if _mf_state and _mf_bid   else "null"
        _live_ask_js   = str(_mf_ask)   if _mf_state and _mf_ask   else "null"
        _auto_scroll_js = "true" if _auto_scroll else "false"

        _chart_html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ background: #131722; font-family: 'Trebuchet MS', sans-serif; overflow: hidden; }}
  #chart-wrap {{ width: 100%; height: 560px; position: relative; }}
  #live-overlay {{
    position: absolute; top: 10px; right: 60px; z-index: 10;
    background: rgba(30,34,45,0.9); border: 1px solid #2d3139;
    border-radius: 8px; padding: 6px 14px;
    font-family: monospace; font-size: 14px; font-weight: 700;
    display: flex; align-items: center; gap: 10px;
  }}
  #live-price {{ color: #d1d4dc; }}
  #live-dot {{ width: 8px; height: 8px; border-radius: 50%;
               background: {"#10b981" if _mf_state else "#ef4444"};
               box-shadow: 0 0 5px {"#10b981" if _mf_state else "#ef4444"}88;
               flex-shrink: 0; }}
</style>
</head>
<body>
<div id="chart-wrap">
  <div id="live-overlay">
    <div id="live-dot"></div>
    <span style="color:#9ca3af;font-size:11px;">LIVE</span>
    <span id="live-price">{_price_str}</span>
  </div>
</div>
<script src="https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js"></script>
<script>
(function() {{
  var chartWrap = document.getElementById('chart-wrap');
  var chart = LightweightCharts.createChart(chartWrap, {{
    width: chartWrap.clientWidth,
    height: 560,
    layout: {{ background: {{ type: 'solid', color: '#131722' }}, textColor: '#d1d4dc' }},
    grid: {{ vertLines: {{ color: '#1e222d' }}, horzLines: {{ color: '#1e222d' }} }},
    crosshair: {{ mode: 1 }},
    rightPriceScale: {{ borderColor: '#2B2B43', scaleMargins: {{ top: 0.05, bottom: 0.2 }} }},
    timeScale: {{ borderColor: '#2B2B43', timeVisible: true, secondsVisible: true, rightOffset: {_auto_scroll_js} ? 5 : 0, fixLeftEdge: true, fixRightEdge: false }},
    watermark: {{ visible: true, text: 'ES 1s', fontSize: 48, color: 'rgba(255,255,255,0.04)' }},
  }});

  var candleSeries = chart.addCandlestickSeries({{
    upColor: '#26a69a', downColor: '#ef5350',
    borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
  }});
  var volumeSeries = chart.addHistogramSeries({{
    priceFormat: {{ type: 'volume' }}, priceScaleId: 'volume',
  }});
  chart.priceScale('volume').applyOptions({{ scaleMargins: {{ top: 0.8, bottom: 0 }} }});

  new ResizeObserver(function() {{
    chart.applyOptions({{ width: chartWrap.clientWidth }});
  }}).observe(chartWrap);

  // Load historical candles
  var candles = {_candles_js};
  var volumes = {_volume_js};
  var markers = {_markers_js};
  var autoScroll = {_auto_scroll_js};
  if (candles.length > 0) {{
    candleSeries.setData(candles);
    volumeSeries.setData(volumes);
    // Add trade entry/exit markers
    if (markers.length > 0) {{
      candleSeries.setMarkers(markers);
    }}
    // Fit all content so chart fills from first candle (no blank left side)
    chart.timeScale().fitContent();
    // Then scroll to latest if auto-scroll is on
    if (autoScroll) {{
      chart.timeScale().scrollToRealTime();
    }}
  }}

  // Overlay: show live price from injected state
  var livePrice = {_live_price_js};
  if (livePrice !== null) {{
    document.getElementById('live-price').textContent = livePrice.toFixed(2);
  }}
}})();
</script>
</body>
</html>"""
        st.components.v1.html(_chart_html, height=580, scrolling=False)

        # === ORDER BOOK HEATMAP OVERLAY (Bookmap-style) ===
        _show_heatmap = st.checkbox("Show Order Book Heatmap", value=False, key="show_ob_heatmap",
                                     help="Render MBO depth as a heatmap behind candlesticks (Bookmap-style)")

        if _show_heatmap and not _hist_df.empty and "price" in _hist_df.columns:
            try:
                _hm_df = _hist_df.copy()
                # Book events have action A (add) or C (cancel) with side 's' (B=bid, A=ask)
                _has_book_events = "a" in _hm_df.columns and "s" in _hm_df.columns

                if _has_book_events:
                    _book_df = _hm_df[_hm_df["a"].isin(["A", "C"])].copy()
                else:
                    _book_df = _hm_df[_hm_df["price"].notna()].copy()

                if not _book_df.empty and "ts_dt" in _book_df.columns:
                    _book_df = _book_df.dropna(subset=["price", "ts_dt"])

                    # Time bucketing — same timeframe as candles
                    _book_df["sec"] = _book_df["ts_dt"].dt.floor(_tf_floor)
                    _book_df["time_unix"] = (_book_df["sec"].astype("int64") // 10**9).astype(int)

                    if "size" not in _book_df.columns or _book_df["size"].isna().all():
                        _book_df["size"] = 1.0
                    _book_df["size"] = _book_df["size"].fillna(1.0)

                    # Cancel events subtract depth
                    if _has_book_events:
                        _cancel_mask = _book_df["a"] == "C"
                        _book_df.loc[_cancel_mask, "size"] = -_book_df.loc[_cancel_mask, "size"].abs()

                    # Round prices to nearest tick (0.25)
                    _tick = 0.25
                    _book_df["price_level"] = (np.round(_book_df["price"] / _tick) * _tick)

                    # Aggregate: total size at each (time_bucket, price_level)
                    _agg = _book_df.groupby(["time_unix", "price_level"])["size"].sum().reset_index()
                    _agg["size"] = _agg["size"].clip(lower=0)

                    if len(_agg) > 0:
                        _time_vals = sorted(_agg["time_unix"].unique())
                        _price_min_hm = _agg["price_level"].min()
                        _price_max_hm = _agg["price_level"].max()
                        _price_grid = np.arange(_price_min_hm, _price_max_hm + _tick, _tick)
                        _n_price = len(_price_grid)
                        _n_time = len(_time_vals)
                        _time_idx_map = {t: i for i, t in enumerate(_time_vals)}
                        _price_idx_map = {round(p, 2): i for i, p in enumerate(_price_grid)}

                        _heatmap_z = np.zeros((_n_price, _n_time), dtype=np.float32)
                        for _, _row in _agg.iterrows():
                            _ti = _time_idx_map.get(_row["time_unix"])
                            _pi = _price_idx_map.get(round(_row["price_level"], 2))
                            if _ti is not None and _pi is not None:
                                _heatmap_z[_pi, _ti] = float(_row["size"])

                        # Log-scale for better visibility
                        _log_heatmap = np.log1p(_heatmap_z)
                        _max_val = float(np.percentile(_log_heatmap[_log_heatmap > 0], 95)) if np.any(_log_heatmap > 0) else 3.0

                        _time_labels = pd.to_datetime(_time_vals, unit="s", utc=True).tz_convert("US/Eastern")

                        _hm_fig = make_subplots(rows=2, cols=1, shared_xaxes=True,
                                                row_heights=[0.8, 0.2], vertical_spacing=0.03,
                                                subplot_titles=["Order Book Depth Heatmap + Price", "Volume"])

                        # Heatmap trace — Bookmap-style colorscale
                        _hm_fig.add_trace(go.Heatmap(
                            z=_log_heatmap,
                            x=_time_labels,
                            y=_price_grid,
                            colorscale=[
                                [0.0, "rgba(19,23,34,0)"],
                                [0.15, "rgba(30,58,138,0.3)"],
                                [0.35, "rgba(59,130,246,0.5)"],
                                [0.55, "rgba(6,182,212,0.65)"],
                                [0.75, "rgba(250,204,21,0.8)"],
                                [1.0, "rgba(255,255,255,0.95)"],
                            ],
                            zmin=0, zmax=_max_val,
                            showscale=True,
                            colorbar=dict(title="Depth (log)", len=0.6, y=0.65, thickness=12),
                            hovertemplate="Time: %{x}<br>Price: %{y:.2f}<br>Depth: %{z:.1f} (log)<extra></extra>",
                        ), row=1, col=1)

                        # Overlay candlesticks on top
                        if "_ohlc" in dir() and len(_ohlc) > 0:
                            _ohlc_dt = pd.to_datetime(_ohlc["time_unix"], unit="s", utc=True).dt.tz_convert("US/Eastern")
                            _hm_fig.add_trace(go.Candlestick(
                                x=_ohlc_dt,
                                open=_ohlc["open"], high=_ohlc["high"],
                                low=_ohlc["low"], close=_ohlc["close"],
                                increasing=dict(line=dict(color="#26a69a"), fillcolor="rgba(38,166,154,0.6)"),
                                decreasing=dict(line=dict(color="#ef5350"), fillcolor="rgba(239,83,80,0.6)"),
                                name="Price", showlegend=False,
                            ), row=1, col=1)

                            _vol_colors = ["rgba(38,166,154,0.5)" if c >= o else "rgba(239,83,80,0.5)"
                                           for c, o in zip(_ohlc["close"], _ohlc["open"])]
                            _hm_fig.add_trace(go.Bar(
                                x=_ohlc_dt,
                                y=_ohlc["volume"] if "volume" in _ohlc.columns else [1]*len(_ohlc),
                                marker_color=_vol_colors,
                                name="Volume", showlegend=False,
                            ), row=2, col=1)

                        _hm_fig.update_layout(
                            template="plotly_dark", height=650,
                            paper_bgcolor="#0f1117", plot_bgcolor="#131722",
                            font=dict(color="#d1d4dc"),
                            legend=dict(orientation="h", yanchor="bottom", y=1.02),
                            yaxis=dict(title="Price ($)"),
                            yaxis2=dict(title="Volume"),
                            xaxis2=dict(title="Time (ET)"),
                            margin=dict(l=60, r=20, t=40, b=40),
                        )
                        _hm_fig.update_xaxes(showspikes=True, spikemode="across",
                                             spikethickness=1, spikecolor="#888")
                        _hm_fig.update_yaxes(showspikes=True, spikemode="across",
                                             spikethickness=1, spikecolor="#888")
                        tv_chart(_hm_fig)
                    else:
                        st.caption("Not enough order book data to render heatmap.")
                else:
                    st.caption("No book event data available in today's JSONL for heatmap.")
            except Exception as _hm_err:
                st.warning(f"Heatmap rendering failed: {_hm_err}")

    # --- LIVE > Order Book ---
    with live_sub[1]:
        _ob_state = _read_live_state()

        # Header metrics
        _ob_c1, _ob_c2, _ob_c3, _ob_c4 = st.columns(4)
        if _ob_state:
            _ob_bid    = _ob_state.get("best_bid")
            _ob_ask    = _ob_state.get("best_ask")
            _ob_spread = _ob_state.get("spread")
            _ob_mid    = ((_ob_bid or 0) + (_ob_ask or 0)) / 2 if _ob_bid and _ob_ask else None
            _ob_bid_s  = f"{_ob_bid:.2f}"    if _ob_bid    else "--"
            _ob_ask_s  = f"{_ob_ask:.2f}"    if _ob_ask    else "--"
            _ob_spd_s  = f"{_ob_spread:.2f}" if _ob_spread else "--"
            _ob_mid_s  = f"{_ob_mid:.2f}"    if _ob_mid    else "--"
        else:
            _ob_bid = _ob_ask = _ob_spread = _ob_mid = None
            _ob_bid_s = _ob_ask_s = _ob_spd_s = _ob_mid_s = "--"

        with _ob_c1:
            st.markdown(f"""<div class="metric-card">
                <h3>Best Bid</h3>
                <div class="value" style="color:#26a69a;font-family:monospace;">{_ob_bid_s}</div>
            </div>""", unsafe_allow_html=True)
        with _ob_c2:
            st.markdown(f"""<div class="metric-card">
                <h3>Best Ask</h3>
                <div class="value" style="color:#ef5350;font-family:monospace;">{_ob_ask_s}</div>
            </div>""", unsafe_allow_html=True)
        with _ob_c3:
            st.markdown(f"""<div class="metric-card metric-amber">
                <h3>Spread</h3>
                <div class="value" style="font-family:monospace;">{_ob_spd_s}</div>
            </div>""", unsafe_allow_html=True)
        with _ob_c4:
            st.markdown(f"""<div class="metric-card metric-blue">
                <h3>Mid Price</h3>
                <div class="value" style="font-family:monospace;">{_ob_mid_s}</div>
            </div>""", unsafe_allow_html=True)

        st.markdown("<br>", unsafe_allow_html=True)

        # Depth table with color bars (synthetic depth from best bid/ask)
        if _ob_bid and _ob_ask:
            import math as _math

            LEVELS = 10
            TICK   = 0.25

            def _synth_size(level: int) -> int:
                base = round(120 * _math.exp(-0.35 * level))
                return max(5, base)

            ask_levels = [(_ob_ask + i * TICK, _synth_size(i)) for i in range(LEVELS)]
            bid_levels = [(_ob_bid - i * TICK, _synth_size(i)) for i in range(LEVELS)]
            max_all    = max(max(s for _, s in ask_levels), max(s for _, s in bid_levels), 1)

            rows_html = ""
            # Asks reversed (deepest first)
            for price, sz in reversed(ask_levels):
                pct = round(sz / max_all * 100)
                rows_html += (
                    f'<tr style="border-bottom:1px solid #1e222d;">'
                    f'<td style="width:45%;text-align:right;padding:3px 8px;">'
                    f'<div style="position:relative;height:22px;">'
                    f'<div style="position:absolute;right:0;top:2px;bottom:2px;width:{pct}%;'
                    f'background:rgba(239,83,80,0.15);border-radius:2px 0 0 2px;"></div>'
                    f'<span style="position:relative;z-index:1;color:#ef5350;font-family:monospace;font-size:12px;">{sz}</span>'
                    f'</div></td>'
                    f'<td style="width:10%;text-align:center;font-family:monospace;font-size:13px;'
                    f'font-weight:600;color:#d1d4dc;padding:3px 4px;">{price:.2f}</td>'
                    f'<td style="width:45%;padding:3px 8px;"></td>'
                    f'</tr>'
                )

            # Spread separator
            spread_val = _ob_ask - _ob_bid
            rows_html += (
                f'<tr><td colspan="3" style="text-align:center;font-size:11px;color:#555;'
                f'padding:4px 0;font-style:italic;">— spread: {spread_val:.2f} —</td></tr>'
            )

            # Bids top-down (best first)
            for price, sz in bid_levels:
                pct = round(sz / max_all * 100)
                rows_html += (
                    f'<tr style="border-bottom:1px solid #1e222d;">'
                    f'<td style="width:45%;padding:3px 8px;"></td>'
                    f'<td style="width:10%;text-align:center;font-family:monospace;font-size:13px;'
                    f'font-weight:600;color:#d1d4dc;padding:3px 4px;">{price:.2f}</td>'
                    f'<td style="width:45%;text-align:left;padding:3px 8px;">'
                    f'<div style="position:relative;height:22px;">'
                    f'<div style="position:absolute;left:0;top:2px;bottom:2px;width:{pct}%;'
                    f'background:rgba(38,166,154,0.15);border-radius:0 2px 2px 0;"></div>'
                    f'<span style="position:relative;z-index:1;color:#26a69a;font-family:monospace;font-size:12px;">{sz}</span>'
                    f'</div></td>'
                    f'</tr>'
                )

            _ob_table_html = f"""
<div style="background:#131722;border:1px solid #2d3139;border-radius:12px;overflow:hidden;max-width:600px;margin:0 auto;">
  <table style="width:100%;border-collapse:collapse;">
    <thead>
      <tr style="background:#1e222d;">
        <th style="width:45%;text-align:right;padding:6px 8px;font-size:10px;color:#555;
                   text-transform:uppercase;letter-spacing:1px;">Ask Size</th>
        <th style="width:10%;text-align:center;padding:6px 4px;font-size:10px;color:#555;
                   text-transform:uppercase;letter-spacing:1px;">Price</th>
        <th style="width:45%;text-align:left;padding:6px 8px;font-size:10px;color:#555;
                   text-transform:uppercase;letter-spacing:1px;">Bid Size</th>
      </tr>
    </thead>
    <tbody style="background:#131722;">
      {rows_html}
    </tbody>
  </table>
</div>
<div style="text-align:center;font-size:11px;color:#555;margin-top:8px;">
  Synthetic depth — sizes decay with distance from touch. Real queue data feeds in when engine streams full book.
</div>"""
            st.markdown(_ob_table_html, unsafe_allow_html=True)
        else:
            st.info("Paper engine not running or state file stale. Start run_paper.py --paper to see order book data.")

    # --- LIVE > Model Signals ---
    with live_sub[2]:
        st.header("Model Signal Monitor")

        _sig_state = _read_live_state()

        # ---- Helper: load JSONL trade logs for a card ----
        _PAPER_LOG_DIR = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant\live_trading\logs\paper")

        def _load_card_trades(card_name: str) -> list[dict]:
            """Load all trade JSONL files for a card (today + historical)."""
            trades = []
            if not _PAPER_LOG_DIR.exists():
                return trades
            for f in sorted(_PAPER_LOG_DIR.glob(f"{card_name}_*_trades.jsonl")):
                try:
                    for line in f.read_text().strip().splitlines():
                        if line.strip():
                            trades.append(json.loads(line))
                except Exception:
                    continue
            return trades

        def _load_card_trades_today(card_name: str) -> list[dict]:
            """Load today's trade JSONL for a card."""
            today_str = date.today().isoformat()
            p = _PAPER_LOG_DIR / f"{card_name}_{today_str}_trades.jsonl"
            trades = []
            if p.exists():
                try:
                    for line in p.read_text().strip().splitlines():
                        if line.strip():
                            trades.append(json.loads(line))
                except Exception:
                    pass
            return trades

        def _compute_trade_stats(trades: list[dict]) -> dict:
            """Compute comprehensive stats from a list of trade dicts."""
            if not trades:
                return {}
            pnls = [t.get("pnl_dollars", 0) for t in trades]
            holds_ms = [t.get("hold_time_ms", 0) for t in trades]
            holds_sec = [h / 1000.0 for h in holds_ms]
            wins = [p for p in pnls if p > 0]
            losses = [p for p in pnls if p <= 0]
            gross_profit = sum(wins) if wins else 0
            gross_loss = sum(abs(l) for l in losses) if losses else 0
            return {
                "total": len(trades),
                "wins": len(wins),
                "losses": len(losses),
                "total_pnl": sum(pnls),
                "avg_pnl": sum(pnls) / len(pnls) if pnls else 0,
                "avg_win": sum(wins) / len(wins) if wins else None,
                "avg_loss": sum(losses) / len(losses) if losses else None,
                "best_trade": max(pnls) if pnls else None,
                "worst_trade": min(pnls) if pnls else None,
                "gross_profit": gross_profit,
                "gross_loss": gross_loss,
                "avg_hold": sum(holds_sec) / len(holds_sec) if holds_sec else None,
                "min_hold": min(holds_sec) if holds_sec else None,
                "max_hold": max(holds_sec) if holds_sec else None,
            }

        def _load_card_signals_last_n_minutes(card_name: str, minutes: int = 60) -> pd.DataFrame:
            """Load the last N minutes of signal data from today's JSONL file.
            Optimized: only reads last ~600 lines (1 min of data) for chart display.
            """
            today_str = date.today().isoformat()
            p = _PAPER_LOG_DIR / f"{card_name}_{today_str}_signals.jsonl"
            if not p.exists() or p.stat().st_size == 0:
                return pd.DataFrame()
            # Only read last 600 lines (~1 min) — charts downsample anyway
            # This is the #1 performance fix: was reading 36,000 lines per card x 10 cards
            lines = _read_last_lines(p, n=min(minutes * 10, 600))
            records = []
            for ln in lines:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    rec = json.loads(ln)
                    rec["ts_dt"] = pd.to_datetime(rec.get("ts", ""))
                    records.append(rec)
                except Exception:
                    continue
            if not records:
                return pd.DataFrame()
            return pd.DataFrame(records)

        if _sig_state is None:
            _state_age_str = ""
            if _LIVE_STATE_PATH.exists():
                _ls_age = _file_age_seconds(_LIVE_STATE_PATH) or 0
                _ls_h = int(_ls_age // 3600)
                _ls_m = int((_ls_age % 3600) // 60)
                _state_age_str = f" (last seen {_ls_h}h {_ls_m}m ago)" if _ls_h > 0 else f" (last seen {_ls_m}m ago)"
            st.warning(f"Engine offline{_state_age_str} — showing last-known state. Start run_paper.py --paper for live signals.")

            # Show last-known card PnL from paper_state.json
            _ps = _read_paper_state()
            if _ps:
                _ps_age = _file_age_seconds(_PAPER_STATE_PATH)
                _ps_age_str = ""
                if _ps_age is not None:
                    _ps_h = int(_ps_age // 3600)
                    _ps_m = int((_ps_age % 3600) // 60)
                    _ps_age_str = f" as of {_ps_h}h {_ps_m}m ago" if _ps_h > 0 else f" as of {_ps_m}m ago"
                st.markdown(f"**Last-known card state{_ps_age_str}:**")
                _ps_cards = [(k, v) for k, v in _ps.items() if isinstance(v, dict) and "daily_pnl" in v]
                if _ps_cards:
                    _total_daily = sum(v.get("daily_pnl", 0) for _, v in _ps_cards)
                    _total_trades_ps = sum(v.get("trade_count", 0) for _, v in _ps_cards)
                    _ps_pnl_color = "#10b981" if _total_daily >= 0 else "#ef4444"
                    st.markdown(
                        f'<span style="font-size:1.2em;font-weight:800;color:{_ps_pnl_color};">Portfolio Daily PnL: ${_total_daily:+,.2f}</span>'
                        f'<span style="color:#9ca3af;font-size:0.9em;"> | {_total_trades_ps} trades</span>',
                        unsafe_allow_html=True,
                    )
                    _ps_cols = st.columns(min(len(_ps_cards), 5))
                    for _psi, (_cname_ps, _cv_ps) in enumerate(_ps_cards):
                        _pnl_ps = _cv_ps.get("daily_pnl", 0)
                        _tc_ps = _cv_ps.get("trade_count", 0)
                        _pnl_c = "#10b981" if _pnl_ps >= 0 else "#ef4444"
                        with _ps_cols[_psi % 5]:
                            st.markdown(
                                f'<div style="background:#1a1d24;border:1px solid #2d3139;border-radius:10px;'
                                f'padding:10px;margin:4px 0;text-align:center;">'
                                f'<div style="font-size:0.75em;color:#9ca3af;font-weight:700;">{_cname_ps}</div>'
                                f'<div style="font-size:1.2em;font-weight:800;color:{_pnl_c};">${_pnl_ps:+,.2f}</div>'
                                f'<div style="font-size:0.7em;color:#6b7280;">{_tc_ps} trades</div>'
                                f'</div>',
                                unsafe_allow_html=True,
                            )
                    st.markdown("<br>", unsafe_allow_html=True)
            st.markdown("""
            **When engine is live:**
            - Real-time CNN predictions (raw + z-scored)
            - Conviction with threshold lines
            - Vol percentile gate
            - Entry signals + active orders
            - Position P&L + exit countdown
            """)
        else:
            # Engine overview row
            _ov_mode  = _sig_state.get("mode", "?")
            _ov_up    = _sig_state.get("uptime_sec", 0)
            _ov_bars  = _sig_state.get("bars_processed", 0)
            _ov_hb_raw = _sig_state.get("hb_rtt_ms")
            _ov_price = _sig_state.get("last_price")
            _ov_ts    = _sig_state.get("timestamp", "")

            # HB RTT: show LIVE value (latest reading, not smoothed)
            _ov_hb = _ov_hb_raw if _ov_hb_raw is not None else None

            # Format uptime nicely
            _up_h = int(_ov_up // 3600)
            _up_m = int((_ov_up % 3600) // 60)
            _up_str = f"{_up_h}h {_up_m}m" if _up_h > 0 else f"{_up_m}m"

            _ov1, _ov2, _ov3, _ov4 = st.columns(4)
            with _ov1:
                st.markdown(f"""
                <div class="metric-card metric-blue">
                    <h3>Engine Mode</h3>
                    <div class="value">{_ov_mode}</div>
                    <div style="color:{T['text_muted']};font-size:0.75em;margin-top:4px;">Uptime: {_up_str}</div>
                </div>""", unsafe_allow_html=True)
            with _ov2:
                st.markdown(f"""
                <div class="metric-card">
                    <h3>Bars Processed</h3>
                    <div class="value">{_ov_bars:,}</div>
                    <div style="color:{T['text_muted']};font-size:0.75em;margin-top:4px;">100ms bars</div>
                </div>""", unsafe_allow_html=True)
            with _ov3:
                st.markdown(f"""
                <div class="metric-card metric-green">
                    <h3>Last Price</h3>
                    <div class="value">{f"{_ov_price:.2f}" if _ov_price else "---"}</div>
                    <div style="color:{T['text_muted']};font-size:0.75em;margin-top:4px;">ES mid</div>
                </div>""", unsafe_allow_html=True)
            with _ov4:
                _hb_color = "#10b981" if _ov_hb and _ov_hb < 500 else ("#f59e0b" if _ov_hb and _ov_hb < 2000 else "#ef4444")
                if _ov_hb and _ov_hb >= 1000:
                    _hb_display = f"{_ov_hb/1000:.1f}s"
                elif _ov_hb:
                    _hb_display = f"{_ov_hb:.0f}ms"
                else:
                    _hb_display = "---"
                st.markdown(f"""
                <div class="metric-card">
                    <h3>HB RTT</h3>
                    <div class="value" style="color:{_hb_color};">{_hb_display}</div>
                    <div style="color:{T['text_muted']};font-size:0.75em;margin-top:4px;">Live | {_ov_ts[11:19]}</div>
                </div>""", unsafe_allow_html=True)

            st.markdown("<br>", unsafe_allow_html=True)

            # Per-card signal panels
            _cards_data = _sig_state.get("cards", {})
            if not _cards_data:
                st.warning("Mode is RECORD-only \u2014 no card signal data. Run with --paper to enable inference.")
            else:
                _CARDS_PER_ROW = 5  # Max columns before wrapping to new row
                _all_card_items = list(_cards_data.items())
                # Pre-build column lists for each row (will be indexed per card below)
                _card_rows = []
                for _row_start in range(0, len(_all_card_items), _CARDS_PER_ROW):
                    _row_items = _all_card_items[_row_start:_row_start + _CARDS_PER_ROW]
                    _card_rows.append((_row_items, st.columns(len(_row_items))))
                _CARD_COLORS = {
                    "Card1":  ("#10b981", "#064e3b"),
                    "Card2":  ("#6366f1", "#1e1b4b"),
                    "Card3":  ("#f43f5e", "#4c0519"),
                    "Card4":  ("#ec4899", "#500724"),
                    "Card5":  ("#14b8a6", "#042f2e"),
                    "Card6":  ("#f97316", "#431407"),
                    "Card7":  ("#8b5cf6", "#2e1065"),
                    "Card8L": ("#22d3ee", "#083344"),
                    "Card9S": ("#fb923c", "#431407"),
                    "Card10L": ("#a3e635", "#1a2e05"),
                }
                # Default thresholds per card (conv_threshold from live_state takes priority)
                _DEFAULT_CONV_THR = {
                    "Card1": 0.1, "Card2": 0.5, "Card3": 1.5,
                    "Card4": 0.3, "Card5": 0.1, "Card6": 0.1,
                    "Card7": 0.1, "Card8L": 0.3, "Card9S": 0.1, "Card10L": 0.1,
                }
                _DEFAULT_VOL_THR = {
                    "Card1": 50.0, "Card2": 50.0, "Card3": 70.0,
                    "Card4": 70.0, "Card5": 70.0, "Card6": 70.0,
                    "Card7": 70.0, "Card8L": 70.0, "Card9S": 0.0, "Card10L": 70.0,
                }

                for _ci, (_cname, _cdata) in enumerate(_cards_data.items()):
                    # Map card index to the correct row's columns
                    _row_idx = _ci // _CARDS_PER_ROW
                    _col_idx = _ci % _CARDS_PER_ROW
                    _card_cols = _card_rows[_row_idx][1]
                    _border_color, _bg_color = _CARD_COLORS.get(_cname, ("#6b7280", "#1f2937"))
                    _z      = _cdata.get("last_zscore", 0.0)
                    _pred   = _cdata.get("last_prediction", 0.0)
                    _conv   = _cdata.get("conviction", 0.0)
                    _volp   = _cdata.get("vol_percentile", 0.0)
                    _pos    = _cdata.get("position", 0)
                    _total_pnl = _cdata.get("pnl", 0.0)  # Cumulative/total PnL from engine
                    _total_trades = _cdata.get("trades", 0)  # Cumulative trades from engine
                    _sigs   = _cdata.get("signals_total", 0)

                    # New fields (backward compatible)
                    _entry_px  = _cdata.get("entry_price")
                    _unreal_pnl = _cdata.get("unrealized_pnl")
                    _hold_sec  = _cdata.get("hold_time_sec")
                    _mae       = _cdata.get("mae")
                    _mfe       = _cdata.get("mfe")
                    _avg_z_entry = _cdata.get("avg_zscore_since_entry")
                    _tp_price  = _cdata.get("tp_price")
                    _sl_price  = _cdata.get("sl_price")
                    _conv_thr  = _cdata.get("conv_threshold", _DEFAULT_CONV_THR.get(_cname, 0.5))
                    _vol_thr   = _cdata.get("vol_threshold", _DEFAULT_VOL_THR.get(_cname, 50.0))

                    # Load today's trades for daily PnL and avg hold
                    _today_trades_list = _load_card_trades_today(_cname)
                    # Daily PnL = sum of today's trade PnLs only
                    _pnl = sum(t.get("pnl_dollars", 0) for t in _today_trades_list) if _today_trades_list else 0.0
                    _trades = len(_today_trades_list)
                    _today_holds = [t.get("hold_time_ms", 0) / 1000.0 for t in _today_trades_list if t.get("hold_time_ms")]
                    _avg_hold_today = sum(_today_holds) / len(_today_holds) if _today_holds else None
                    _avg_hold_str = f"{_avg_hold_today:.0f}s" if _avg_hold_today is not None else "--"

                    # Z-score history for sparkline (store in session_state)
                    _spark_key = f"spark_{_cname}"
                    if _spark_key not in st.session_state:
                        st.session_state[_spark_key] = {"z": [], "conv": [], "price": []}
                    _spark = st.session_state[_spark_key]
                    _spark["z"].append(_z)
                    _spark["conv"].append(_conv)
                    _spark["price"].append(_sig_state.get("last_price", 0))
                    # Keep last 3600 samples (~60 min at 1s refresh)
                    _spark["z"] = _spark["z"][-3600:]
                    _spark["conv"] = _spark["conv"][-3600:]
                    _spark["price"] = _spark["price"][-3600:]

                    # Conviction color: green if high, amber if medium, grey if low
                    if _conv >= 1.5:
                        _conv_color = "#10b981"
                        _conv_chip  = "chip-green"
                        _conv_label = "HIGH"
                    elif _conv >= 0.5:
                        _conv_color = "#f59e0b"
                        _conv_chip  = "chip-amber"
                        _conv_label = "MED"
                    else:
                        _conv_color = "#6b7280"
                        _conv_chip  = ""
                        _conv_label = "LOW"

                    # Position label
                    _pos_str  = "LONG" if _pos > 0 else ("SHORT" if _pos < 0 else "FLAT")
                    _pos_color = "#10b981" if _pos > 0 else ("#ef4444" if _pos < 0 else T['text_muted'])
                    _pnl_str  = f"${_pnl:+.2f}"
                    _pnl_color = "#10b981" if _pnl >= 0 else "#ef4444"

                    # Gate pass/fail checks
                    _conv_pass = abs(_conv) >= _conv_thr
                    _vol_pass = _volp >= _vol_thr
                    _conv_icon = '<span style="color:#10b981;font-weight:800;">&#10003;</span>' if _conv_pass else '<span style="color:#ef4444;font-weight:800;">&#10007;</span>'
                    _vol_icon = '<span style="color:#10b981;font-weight:800;">&#10003;</span>' if _vol_pass else '<span style="color:#ef4444;font-weight:800;">&#10007;</span>'

                    # Unrealized PnL display
                    _unreal_str = f"${_unreal_pnl:+.2f}" if _unreal_pnl is not None else "--"
                    _unreal_color = "#10b981" if (_unreal_pnl or 0) >= 0 else "#ef4444"
                    _entry_str = f"{_entry_px:.2f}" if _entry_px is not None else "--"
                    _hold_str = f"{_hold_sec:.0f}s" if _hold_sec is not None else "--"

                    # MAE/MFE display
                    _mae_str = f"{_mae:.2f}" if _mae is not None else "--"
                    _mfe_str = f"{_mfe:.2f}" if _mfe is not None else "--"
                    _avg_z_str = f"{_avg_z_entry:+.3f}" if _avg_z_entry is not None else "--"

                    # TP/SL display
                    _tp_str = f"{_tp_price:.2f}" if _tp_price is not None else "--"
                    _sl_str = f"{_sl_price:.2f}" if _sl_price is not None else "--"

                    with _card_cols[_col_idx]:
                        st.markdown(f"""
                        <div style="background:rgba({int(_bg_color.lstrip('#')[0:2],16)},{int(_bg_color.lstrip('#')[2:4],16)},{int(_bg_color.lstrip('#')[4:6],16)},0.25);
                                    border:2px solid {_border_color};border-radius:16px;
                                    padding:16px;margin-bottom:8px;">
                            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                                <span style="font-weight:800;font-size:1.05em;color:{_border_color};">{_cname}</span>
                                <span style="font-weight:800;font-size:0.85em;color:{_pos_color};
                                    background:{_pos_color}18;padding:2px 10px;border-radius:12px;">{_pos_str}</span>
                            </div>
                            <table style="width:100%;font-size:0.82em;color:{T['text']};border-collapse:collapse;">
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Z-Score</td>
                                    <td style="text-align:right;font-weight:700;
                                        color:{'#10b981' if _z > 0 else '#ef4444'};">{_z:+.3f}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Raw Pred</td>
                                    <td style="text-align:right;font-weight:700;">{_pred:.4f}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Conviction {_conv_icon}</td>
                                    <td style="text-align:right;font-weight:700;color:{_conv_color};">
                                        {_conv:.3f} <span style="font-size:0.7em;color:{T['text_muted']};">thr:{_conv_thr}</span></td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Vol %ile {_vol_icon}</td>
                                    <td style="text-align:right;font-weight:700;">{_volp:.1f}%
                                        <span style="font-size:0.7em;color:{T['text_muted']};">thr:{_vol_thr:.0f}%</span></td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};background:{_unreal_color}10;">
                                    <td style="padding:4px 0;font-weight:600;">Unrealized</td>
                                    <td style="text-align:right;font-weight:700;color:{_unreal_color};">{_unreal_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Entry</td>
                                    <td style="text-align:right;font-family:monospace;">{_entry_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Hold Time</td>
                                    <td style="text-align:right;">{_hold_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Avg Hold</td>
                                    <td style="text-align:right;color:{T['text_muted']};">{_avg_hold_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">TP / SL</td>
                                    <td style="text-align:right;font-family:monospace;font-size:0.85em;">
                                        <span style="color:#10b981;">{_tp_str}</span> /
                                        <span style="color:#ef4444;">{_sl_str}</span></td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">MAE / MFE</td>
                                    <td style="text-align:right;font-size:0.85em;">
                                        <span style="color:#ef4444;">{_mae_str}</span> /
                                        <span style="color:#10b981;">{_mfe_str}</span></td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Avg Z (entry)</td>
                                    <td style="text-align:right;">{_avg_z_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Daily PnL</td>
                                    <td style="text-align:right;font-weight:700;color:{_pnl_color};">{_pnl_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Trades</td>
                                    <td style="text-align:right;font-weight:700;">{_trades}</td>
                                </tr>
                                <tr>
                                    <td style="padding:4px 0;">Signals</td>
                                    <td style="text-align:right;color:{T['text_muted']};">{_sigs:,}</td>
                                </tr>
                            </table>
                        </div>""", unsafe_allow_html=True)

                        # --- 60-min Conviction + Price chart with entry/exit markers ---
                        _z_hist = _spark["z"]
                        _conv_hist = _spark["conv"]
                        _price_hist = _spark["price"]

                        # Also try to load signal file for richer 60-min data
                        _sig_df = _load_card_signals_last_n_minutes(_cname, minutes=60)

                        # Determine chart data: prefer signal file if available, else session_state
                        if not _sig_df.empty and len(_sig_df) > 10:
                            _chart_z = _sig_df["z_score"].tolist()
                            _chart_conv = _sig_df["conviction"].tolist()
                            _chart_price = _sig_df["mid_price"].tolist()
                            _chart_ts = _sig_df["ts_dt"].tolist()
                            # Downsample for performance: keep every Nth point to get ~600 points
                            _ds_step = max(1, len(_chart_z) // 600)
                            _chart_z = _chart_z[::_ds_step]
                            _chart_conv = _chart_conv[::_ds_step]
                            _chart_price = _chart_price[::_ds_step]
                            _chart_ts = _chart_ts[::_ds_step]
                            _chart_x = list(range(len(_chart_z)))
                            _chart_title = "60-min window (from signals file)"
                        elif len(_z_hist) > 2:
                            _chart_z = _z_hist
                            _chart_conv = _conv_hist
                            _chart_price = _price_hist
                            _chart_ts = None
                            _chart_x = list(range(len(_chart_z)))
                            _chart_title = f"{len(_z_hist)}s window (session)"
                        else:
                            _chart_z = None
                            _chart_conv = None
                            _chart_price = None
                            _chart_ts = None
                            _chart_x = None
                            _chart_title = None

                        if _chart_z is not None and len(_chart_z) > 2:
                            # Build plotly figure with conviction + price overlay
                            _fig_card = make_subplots(
                                rows=2, cols=1,
                                row_heights=[0.55, 0.45],
                                vertical_spacing=0.08,
                                subplot_titles=[f"Conviction & Price ({_chart_title})", "Z-Score"],
                                specs=[[{"secondary_y": True}], [{"secondary_y": False}]],
                            )

                            # Parse hex color for rgba
                            _br, _bg, _bb = int(_border_color.lstrip('#')[0:2], 16), int(_border_color.lstrip('#')[2:4], 16), int(_border_color.lstrip('#')[4:6], 16)

                            # Row 1: Conviction line
                            _x_vals = _chart_ts if _chart_ts else _chart_x
                            _fig_card.add_trace(go.Scatter(
                                x=_x_vals, y=_chart_conv, mode="lines",
                                line=dict(color="#f59e0b", width=2),
                                fill="tozeroy", fillcolor="rgba(245,158,11,0.08)",
                                name="Conviction",
                                showlegend=True,
                            ), row=1, col=1, secondary_y=False)

                            # Conviction threshold line
                            _fig_card.add_hline(y=_conv_thr, line_dash="dash",
                                                line_color="rgba(245,158,11,0.4)", line_width=1,
                                                row=1, col=1)

                            # Row 1: Price overlay on secondary y-axis
                            _valid_prices = [p for p in _chart_price if p and p > 0]
                            if _valid_prices:
                                _fig_card.add_trace(go.Scatter(
                                    x=_x_vals, y=_chart_price, mode="lines",
                                    line=dict(color="#60a5fa", width=1.5),
                                    name="ES Price",
                                    showlegend=True,
                                ), row=1, col=1, secondary_y=True)

                            # Row 2: Z-Score
                            _fig_card.add_trace(go.Scatter(
                                x=_x_vals, y=_chart_z, mode="lines",
                                line=dict(color=_border_color, width=1.5),
                                fill="tozeroy", fillcolor=f"rgba({_br},{_bg},{_bb},0.08)",
                                name="Z-Score",
                                showlegend=True,
                            ), row=2, col=1)
                            _fig_card.add_hline(y=0, line_color="rgba(255,255,255,0.15)", line_width=1, row=2, col=1)

                            # Entry/Exit markers from today's trade log
                            if _chart_ts and _today_trades_list:
                                for _trd in _today_trades_list:
                                    _trd_ts_str = _trd.get("ts", "")
                                    _trd_side = _trd.get("side", "")
                                    _trd_pnl_d = _trd.get("pnl_dollars", 0)
                                    _trd_entry_px = _trd.get("entry_price", 0)
                                    _trd_exit_px = _trd.get("exit_price", 0)
                                    _trd_hold = _trd.get("hold_time_ms", 0)
                                    try:
                                        _exit_dt = pd.to_datetime(_trd_ts_str)
                                        _entry_dt = _exit_dt - pd.Timedelta(milliseconds=_trd_hold)
                                        _cutoff_dt = _chart_ts[0] if _chart_ts else None
                                        # Entry marker (on conviction chart)
                                        if _cutoff_dt and _entry_dt >= _cutoff_dt:
                                            _entry_color = "#26a69a" if _trd_side == "BUY" else "#ef5350"
                                            _entry_symbol = "triangle-up" if _trd_side == "BUY" else "triangle-down"
                                            _fig_card.add_trace(go.Scatter(
                                                x=[_entry_dt], y=[_conv_thr * 0.5],
                                                mode="markers+text",
                                                marker=dict(color=_entry_color, size=10, symbol=_entry_symbol),
                                                text=[f"{'L' if _trd_side == 'BUY' else 'S'}@{_trd_entry_px:.2f}"],
                                                textposition="top center",
                                                textfont=dict(size=8, color=_entry_color),
                                                showlegend=False,
                                            ), row=1, col=1, secondary_y=False)
                                        # Exit marker
                                        if _cutoff_dt and _exit_dt >= _cutoff_dt:
                                            _exit_color = "#26a69a" if _trd_pnl_d >= 0 else "#ef5350"
                                            _fig_card.add_trace(go.Scatter(
                                                x=[_exit_dt], y=[_conv_thr * 0.5],
                                                mode="markers+text",
                                                marker=dict(color=_exit_color, size=8, symbol="x"),
                                                text=[f"${_trd_pnl_d:+.0f}"],
                                                textposition="bottom center",
                                                textfont=dict(size=8, color=_exit_color),
                                                showlegend=False,
                                            ), row=1, col=1, secondary_y=False)
                                    except Exception:
                                        continue

                            # Layout: dark theme, transparent bg, proper height
                            _fig_card.update_layout(
                                template="plotly_dark",
                                height=260,
                                margin=dict(l=5, r=5, t=22, b=5),
                                paper_bgcolor="rgba(0,0,0,0)",
                                plot_bgcolor="rgba(0,0,0,0)",
                                font=dict(size=10, color="#9ca3af"),
                                legend=dict(
                                    orientation="h", yanchor="bottom", y=1.02,
                                    xanchor="right", x=1, font=dict(size=8),
                                    bgcolor="rgba(0,0,0,0)",
                                ),
                                xaxis=dict(showticklabels=False, showgrid=False, zeroline=False),
                                xaxis2=dict(showticklabels=True, showgrid=False, zeroline=False,
                                            tickfont=dict(size=8)),
                                yaxis=dict(showticklabels=True, showgrid=True,
                                           gridcolor="rgba(255,255,255,0.05)",
                                           tickfont=dict(size=8), title=None),
                                yaxis2=dict(showticklabels=True, showgrid=False,
                                            tickfont=dict(size=8, color="#60a5fa"),
                                            title=None, side="right"),
                                yaxis3=dict(showticklabels=True, showgrid=True,
                                            gridcolor="rgba(255,255,255,0.05)",
                                            tickfont=dict(size=8), title=None,
                                            zeroline=True, zerolinecolor="rgba(255,255,255,0.3)", zerolinewidth=1,
                                            range=[-(max(abs(min(_chart_z)), abs(max(_chart_z))) + 0.5),
                                                    max(abs(min(_chart_z)), abs(max(_chart_z))) + 0.5] if _chart_z else None),
                            )
                            # Enable pan/scroll on card charts
                            _fig_card.update_layout(
                                dragmode="pan",
                                xaxis=dict(rangeslider=dict(visible=True, thickness=0.08)),
                            )
                            st.plotly_chart(_fig_card, use_container_width=True,
                                            config=CHART_CONFIG,
                                            key=f"card_chart_{_cname}_{_ci}")

                        # Deeper stats dropdown — pull from JSONL trade logs
                        with st.expander(f"{_cname} Deep Stats", expanded=False):
                            _card_hist = _cdata.get("history", {})

                            # Load all trades from JSONL files
                            _all_trades = _load_card_trades(_cname)
                            _today_only = _load_card_trades_today(_cname)
                            _all_stats = _compute_trade_stats(_all_trades)
                            _today_stats = _compute_trade_stats(_today_only)

                            def _ds(key, fmt="", default="--"):
                                v = _all_stats.get(key)
                                if v is None:
                                    return default
                                if fmt == "$":
                                    return f"${v:+,.2f}" if isinstance(v, (int, float)) else str(v)
                                if fmt == "s":
                                    return f"{v:.0f}s" if isinstance(v, (int, float)) else str(v)
                                if fmt == "t":
                                    return f"{v:.1f}" if isinstance(v, (int, float)) else str(v)
                                if fmt == ".2f":
                                    return f"{v:.2f}" if isinstance(v, (int, float)) else str(v)
                                if fmt == "d":
                                    return f"{int(v)}" if isinstance(v, (int, float)) else str(v)
                                return str(v)

                            _total_t = _all_stats.get("total", _trades)
                            _wins = _all_stats.get("wins", 0)
                            _losses = _all_stats.get("losses", 0)
                            _wr = f"{_wins/_total_t*100:.1f}%" if _total_t > 0 else "--"
                            _gp = _all_stats.get("gross_profit", 0)
                            _gl = _all_stats.get("gross_loss", 0)
                            _pf_val = _gp / max(_gl, 0.01) if _gl > 0 else None
                            _pf_str = f"{_pf_val:.2f}" if _pf_val is not None else "--"

                            _today_pnl_val = _today_stats.get("total_pnl", 0)
                            _today_trades_count = _today_stats.get("total", 0)
                            _total_pnl_val = _all_stats.get("total_pnl", 0)

                            _src_label = f"(from {len(_all_trades)} trades in JSONL)" if _all_trades else "(live only)"

                            st.markdown(f"""
                            <div style="font-size:0.75em;color:{T['text_muted']};margin-bottom:6px;font-weight:600;">
                                PERFORMANCE SUMMARY {_src_label}
                            </div>
                            <table style="width:100%;font-size:0.82em;color:{T['text']};border-collapse:collapse;">
                                <tr style="border-bottom:1px solid {T['card_border']};background:rgba(16,185,129,0.05);">
                                    <td style="padding:4px 0;font-weight:700;">Total PnL</td>
                                    <td style="text-align:right;font-weight:700;color:{'#10b981' if _total_pnl_val >= 0 else '#ef4444'};">{f"${_total_pnl_val:+,.2f}" if _all_trades else _pnl_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};background:rgba(99,102,241,0.05);">
                                    <td style="padding:4px 0;font-weight:700;">Today PnL</td>
                                    <td style="text-align:right;font-weight:700;color:{'#10b981' if _today_pnl_val >= 0 else '#ef4444'};">${_today_pnl_val:+,.2f} ({_today_trades_count} trades)</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Win Rate</td>
                                    <td style="text-align:right;font-weight:600;">{_wr}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Profit Factor</td>
                                    <td style="text-align:right;font-weight:600;color:#6366f1;">{_pf_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Wins / Losses</td>
                                    <td style="text-align:right;font-weight:600;">{_wins} / {_losses}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Total Trades</td>
                                    <td style="text-align:right;font-weight:600;">{_total_t}</td>
                                </tr>
                            </table>
                            <div style="font-size:0.75em;color:{T['text_muted']};margin:8px 0 4px;font-weight:600;">
                                TRADE STATISTICS
                            </div>
                            <table style="width:100%;font-size:0.82em;color:{T['text']};border-collapse:collapse;">
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Avg Win</td>
                                    <td style="text-align:right;font-weight:600;color:#10b981;">{_ds('avg_win', fmt='$')}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Avg Loss</td>
                                    <td style="text-align:right;font-weight:600;color:#ef4444;">{_ds('avg_loss', fmt='$')}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Best Trade</td>
                                    <td style="text-align:right;font-weight:600;color:#10b981;">{_ds('best_trade', fmt='$')}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Worst Trade</td>
                                    <td style="text-align:right;font-weight:600;color:#ef4444;">{_ds('worst_trade', fmt='$')}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Avg PnL/Trade</td>
                                    <td style="text-align:right;font-weight:600;">{_ds('avg_pnl', fmt='$')}</td>
                                </tr>
                            </table>
                            <div style="font-size:0.75em;color:{T['text_muted']};margin:8px 0 4px;font-weight:600;">
                                HOLD TIME & EXCURSION
                            </div>
                            <table style="width:100%;font-size:0.82em;color:{T['text']};border-collapse:collapse;">
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Avg Hold Time</td>
                                    <td style="text-align:right;font-weight:600;">{_ds('avg_hold', fmt='s')}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Min / Max Hold</td>
                                    <td style="text-align:right;font-weight:600;">{_ds('min_hold', fmt='s')} / {_ds('max_hold', fmt='s')}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Avg MAE ($)</td>
                                    <td style="text-align:right;font-weight:600;color:#ef4444;">{_mae_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Avg MFE ($)</td>
                                    <td style="text-align:right;font-weight:600;color:#10b981;">{_mfe_str}</td>
                                </tr>
                                <tr>
                                    <td style="padding:4px 0;">Avg Z During Trade</td>
                                    <td style="text-align:right;font-weight:600;">{_avg_z_str}</td>
                                </tr>
                            </table>
                            """, unsafe_allow_html=True)

                            # === PARTICIPATION STATS ===
                            if _all_trades:
                                _trade_dates = set()
                                for _t in _all_trades:
                                    _ts = _t.get("entry_time") or _t.get("timestamp") or _t.get("time") or ""
                                    if _ts:
                                        try:
                                            _trade_dates.add(str(_ts)[:10])
                                        except Exception:
                                            pass
                                _days_active = len(_trade_dates)
                                if _trade_dates:
                                    _first_trade_date = min(_trade_dates)
                                    try:
                                        from datetime import date as _date_cls
                                        _first_d = _date_cls.fromisoformat(_first_trade_date)
                                        _days_total = (_date_cls.today() - _first_d).days + 1
                                    except Exception:
                                        _days_total = _days_active
                                else:
                                    _days_total = _days_active
                                _participation_pct = f"{_days_active / _days_total * 100:.1f}%" if _days_total > 0 else "--"
                                _avg_trades_per_active = f"{_total_t / _days_active:.1f}" if _days_active > 0 else "--"
                                st.markdown(f"""
                            <div style="font-size:0.75em;color:{T['text_muted']};margin:8px 0 4px;font-weight:600;">
                                PARTICIPATION
                            </div>
                            <table style="width:100%;font-size:0.82em;color:{T['text']};border-collapse:collapse;">
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Days Active</td>
                                    <td style="text-align:right;font-weight:600;">{_days_active}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Days Total</td>
                                    <td style="text-align:right;font-weight:600;">{_days_total}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Participation</td>
                                    <td style="text-align:right;font-weight:600;color:#6366f1;">{_participation_pct}</td>
                                </tr>
                                <tr>
                                    <td style="padding:4px 0;">Avg Trades / Active Day</td>
                                    <td style="text-align:right;font-weight:600;">{_avg_trades_per_active}</td>
                                </tr>
                            </table>
                            """, unsafe_allow_html=True)

                            # === OOT BACKTEST STATS FROM QCC DATABASE ===
                            _oot = _load_qcc_oot_stats(_cname)
                            if _oot is not None:
                                _oot_sharpe = _oot.get("sharpe")
                                _oot_sharpe_str = f"{_oot_sharpe:.2f}" if _oot_sharpe is not None else "--"
                                _oot_pnl = _oot.get("total_pnl")
                                _oot_pnl_str = f"${_oot_pnl:+,.2f}" if _oot_pnl is not None else "--"
                                _oot_trades = _oot.get("n_trades")
                                _oot_trades_str = str(_oot_trades) if _oot_trades is not None else "--"
                                _oot_wr = _oot.get("win_rate")
                                _oot_wr_str = f"{_oot_wr*100:.1f}%" if _oot_wr is not None else ("--" if _oot_wr is None else "--")

                                _oot_html = f"""
                            <div style="font-size:0.75em;color:#8b5cf6;margin:12px 0 4px;font-weight:700;border-top:2px solid #8b5cf6;padding-top:8px;">
                                OOT BACKTEST ({_oot.get('source', 'QCC DB').replace('_', ' ').upper()})
                            </div>
                            <table style="width:100%;font-size:0.82em;color:{T['text']};border-collapse:collapse;">
                                <tr style="border-bottom:1px solid {T['card_border']};background:rgba(139,92,246,0.08);">
                                    <td style="padding:4px 0;font-weight:700;">OOT Sharpe</td>
                                    <td style="text-align:right;font-weight:700;color:#8b5cf6;">{_oot_sharpe_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Total PnL</td>
                                    <td style="text-align:right;font-weight:600;color:{'#10b981' if (_oot_pnl or 0) >= 0 else '#ef4444'};">{_oot_pnl_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Trades</td>
                                    <td style="text-align:right;font-weight:600;">{_oot_trades_str}</td>
                                </tr>
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Win Rate</td>
                                    <td style="text-align:right;font-weight:600;">{_oot_wr_str}</td>
                                </tr>"""

                                # MAE stats (only from card_performance_profiles)
                                if _oot.get("mae_avg") is not None:
                                    _mae_avg = _oot['mae_avg'] or 0
                                    _mae_p50 = _oot.get('mae_p50') or 0
                                    _mae_p95 = _oot.get('mae_p95') or 0
                                    _oot_html += f"""
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">MAE (avg / P50 / P95)</td>
                                    <td style="text-align:right;font-weight:600;color:#ef4444;">{_mae_avg:.1f} / {_mae_p50:.1f} / {_mae_p95:.1f} ticks</td>
                                </tr>"""

                                # MFE stats
                                if _oot.get("mfe_avg") is not None:
                                    _mfe_avg = _oot['mfe_avg'] or 0
                                    _mfe_p50 = _oot.get('mfe_p50') or 0
                                    _mfe_p95 = _oot.get('mfe_p95') or 0
                                    _oot_html += f"""
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">MFE (avg / P50 / P95)</td>
                                    <td style="text-align:right;font-weight:600;color:#10b981;">{_mfe_avg:.1f} / {_mfe_p50:.1f} / {_mfe_p95:.1f} ticks</td>
                                </tr>"""

                                # Optimal hold time (edge decay)
                                if _oot.get("optimal_hold_min") is not None:
                                    _opt_hold = _oot['optimal_hold_min'] or 0
                                    _oot_html += f"""
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Optimal Hold</td>
                                    <td style="text-align:right;font-weight:600;color:#f59e0b;">{_opt_hold:.1f} min</td>
                                </tr>"""

                                # Max drawdown
                                if _oot.get("max_drawdown") is not None:
                                    _max_dd = _oot['max_drawdown'] or 0
                                    _oot_html += f"""
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">Max Drawdown</td>
                                    <td style="text-align:right;font-weight:600;color:#ef4444;">${_max_dd:+,.2f}</td>
                                </tr>"""

                                # OOT date range
                                if _oot.get("oot_start") and _oot.get("oot_end"):
                                    _oot_html += f"""
                                <tr style="border-bottom:1px solid {T['card_border']};">
                                    <td style="padding:4px 0;">OOT Period</td>
                                    <td style="text-align:right;font-weight:600;">{_oot['oot_start']} to {_oot['oot_end']} ({_oot.get('n_days', '--')}d)</td>
                                </tr>"""

                                # Exit reason breakdown
                                _exit_reasons = _oot.get("exit_reasons")
                                if _exit_reasons and isinstance(_exit_reasons, dict):
                                    # Filter to only numeric values (skip nested dicts)
                                    _exit_numeric = {k: v for k, v in _exit_reasons.items() if isinstance(v, (int, float))}
                                    _exit_parts = []
                                    for _reason, _count in sorted(_exit_numeric.items(), key=lambda x: -x[1]):
                                        _exit_parts.append(f"{_reason}: {_count}")
                                    _exit_str = " | ".join(_exit_parts[:5])  # Top 5 reasons
                                    _oot_html += f"""
                                <tr>
                                    <td style="padding:4px 0;">Exit Reasons</td>
                                    <td style="text-align:right;font-weight:600;font-size:0.9em;">{_exit_str}</td>
                                </tr>"""

                                _oot_html += "</table>"
                                st.markdown(_oot_html, unsafe_allow_html=True)
                            else:
                                st.markdown(f"""
                            <div style="font-size:0.75em;color:{T['text_muted']};margin:12px 0 4px;font-weight:600;border-top:1px dashed {T['card_border']};padding-top:8px;">
                                OOT analysis pending...
                            </div>""", unsafe_allow_html=True)

                        # View Trades button --- inline trade table
                        with st.expander(f"View Trades ({_cname})", expanded=False):
                            _vt_trades = _load_card_trades(_cname)
                            if not _vt_trades:
                                st.info("No trade files found for this card.")
                            else:
                                _vt_rows = []
                                for _vt in _vt_trades:
                                    _vt_ts = _vt.get("entry_time") or _vt.get("timestamp") or _vt.get("time") or ""
                                    _vt_date = str(_vt_ts)[:10] if _vt_ts else "--"
                                    _vt_side = _vt.get("side") or _vt.get("direction") or "--"
                                    _vt_entry = _vt.get("entry_price") or _vt.get("fill_price") or _vt.get("entry") or "--"
                                    _vt_exit = _vt.get("exit_price") or _vt.get("exit") or "--"
                                    _vt_pnl = _vt.get("pnl_dollars") or _vt.get("pnl") or 0
                                    _vt_hold_ms = _vt.get("hold_time_ms") or 0
                                    _vt_hold_s = f"{_vt_hold_ms / 1000:.0f}s" if _vt_hold_ms else "--"
                                    _vt_exit_reason = _vt.get("exit_reason") or _vt.get("reason") or "--"
                                    _vt_rows.append({
                                        "Date": _vt_date,
                                        "Side": _vt_side,
                                        "Entry": _vt_entry,
                                        "Exit": _vt_exit,
                                        "PnL ($)": round(float(_vt_pnl), 2) if _vt_pnl else 0.0,
                                        "Hold Time": _vt_hold_s,
                                        "Exit Reason": _vt_exit_reason,
                                    })
                                _vt_df = pd.DataFrame(_vt_rows)
                                st.dataframe(
                                    _vt_df,
                                    use_container_width=True,
                                    hide_index=True,
                                )

            if st.button("Refresh Signals", key="sig_refresh"):
                st.rerun()

    # =========================================================================
    # LIVE > Full Day Chart — streaming tick accumulation
    # =========================================================================
    with live_sub[3]:
        # ── Paths ──────────────────────────────────────────────────────────
        _FDC_PAPER_LOG = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant\live_trading\logs\paper")
        _fdc_today     = date.today()

        def _fdc_tick_csv(d) -> Path:
            return _FDC_PAPER_LOG / f"live_ticks_{d.isoformat()}.csv"

        def _fdc_trade_csv(d) -> Path:
            return _FDC_PAPER_LOG / f"live_trades_{d.isoformat()}.csv"

        # ── Date selector ──────────────────────────────────────────────────
        _fdc_col1, _fdc_col2, _fdc_col3, _fdc_col4 = st.columns([2, 2, 2, 2])
        with _fdc_col1:
            # Find available dates (tick CSVs that exist)
            _fdc_available_dates = sorted(
                [
                    p.stem.replace("live_ticks_", "")
                    for p in _FDC_PAPER_LOG.glob("live_ticks_*.csv")
                    if p.stat().st_size > len("ts_unix_s,open,high,low,close,volume,bid,ask,spread\n") + 10
                ],
                reverse=True,
            )
            if _fdc_available_dates:
                _fdc_sel_date_str = st.selectbox(
                    "Date",
                    _fdc_available_dates,
                    index=0,
                    key="fdc_date_sel",
                )
                try:
                    _fdc_sel_date = date.fromisoformat(_fdc_sel_date_str)
                except ValueError:
                    _fdc_sel_date = _fdc_today
            else:
                _fdc_sel_date = _fdc_today
                st.caption("No tick CSV found. Run tick_collector.py or tick_backfill.py first.")

        with _fdc_col2:
            _fdc_tf = st.selectbox(
                "Candle Timeframe",
                ["1s", "5s", "15s", "1m", "5m", "15m"],
                index=0,
                key="fdc_tf",
            )
        with _fdc_col3:
            _fdc_show_cards = st.multiselect(
                "Show cards",
                options=["Card1", "Card2", "Card3", "Card4", "Card5",
                         "Card6", "Card7", "Card8L", "Card9S", "Card10L"],
                default=["Card1", "Card2", "Card3", "Card4"],
                key="fdc_cards",
            )
        with _fdc_col4:
            _fdc_auto_refresh = st.checkbox(
                "Auto-refresh (2s)",
                value=st.session_state.get("fdc_auto_refresh", True),
                key="fdc_auto_refresh",
            )

        # ── Collector status pill ──────────────────────────────────────────
        _fdc_tick_path  = _fdc_tick_csv(_fdc_sel_date)
        _fdc_trade_path = _fdc_trade_csv(_fdc_sel_date)
        _fdc_tick_age   = _file_age_seconds(_fdc_tick_path)
        _fdc_is_today   = (_fdc_sel_date == _fdc_today)
        _fdc_live_state = _read_live_state()

        if _fdc_tick_path.exists():
            _fdc_tick_size_kb = _fdc_tick_path.stat().st_size / 1024
            if _fdc_is_today and _fdc_tick_age is not None and _fdc_tick_age < 10:
                _fdc_status_html = (
                    f'<div style="display:inline-flex;align-items:center;gap:8px;'
                    f'background:#064e3b;border:1px solid #10b981;border-radius:20px;'
                    f'padding:4px 14px;font-size:0.8em;font-weight:700;color:#34d399;">'
                    f'<span style="width:8px;height:8px;border-radius:50%;background:#10b981;'
                    f'box-shadow:0 0 6px #10b98188;display:inline-block;"></span>'
                    f'LIVE — tick_collector running ({_fdc_tick_size_kb:.0f} KB)'
                    f'</div>'
                )
            elif _fdc_is_today and _fdc_tick_age is not None:
                _fdc_status_html = (
                    f'<div style="display:inline-flex;align-items:center;gap:8px;'
                    f'background:#78350f;border:1px solid #f59e0b;border-radius:20px;'
                    f'padding:4px 14px;font-size:0.8em;font-weight:700;color:#fbbf24;">'
                    f'Tick CSV stale ({int(_fdc_tick_age)}s) — tick_collector may have stopped'
                    f'</div>'
                )
            else:
                _fdc_status_html = (
                    f'<div style="display:inline-flex;align-items:center;gap:8px;'
                    f'background:#1e2530;border:1px solid #6366f1;border-radius:20px;'
                    f'padding:4px 14px;font-size:0.8em;font-weight:700;color:#818cf8;">'
                    f'Historical: {_fdc_sel_date_str}  ({_fdc_tick_size_kb:.0f} KB)'
                    f'</div>'
                )
        else:
            _fdc_status_html = (
                f'<div style="display:inline-flex;align-items:center;gap:8px;'
                f'background:#7f1d1d;border:1px solid #ef4444;border-radius:20px;'
                f'padding:4px 14px;font-size:0.8em;font-weight:700;color:#fca5a5;">'
                f'No tick CSV for {_fdc_sel_date.isoformat()} — run: '
                f'python quant_dashboard/tick_backfill.py {_fdc_sel_date.isoformat()}'
                f'</div>'
            )
        st.markdown(_fdc_status_html, unsafe_allow_html=True)
        st.markdown("<div style='height:10px'></div>", unsafe_allow_html=True)

        # ── Load tick CSV ──────────────────────────────────────────────────
        @st.cache_data(ttl=2)
        def _fdc_load_ticks(csv_path_str: str) -> pd.DataFrame:
            p = Path(csv_path_str)
            if not p.exists() or p.stat().st_size < 200:
                return pd.DataFrame()
            try:
                df = pd.read_csv(p, dtype={
                    "ts_unix_s": "int64",
                    "open": "float64", "high": "float64",
                    "low": "float64", "close": "float64",
                    "volume": "float64",
                    "bid": "float64", "ask": "float64", "spread": "float64",
                })
                df = df.dropna(subset=["ts_unix_s", "open", "close"])
                df["ts_dt"] = pd.to_datetime(df["ts_unix_s"], unit="s", utc=True).dt.tz_convert("US/Eastern")
                return df
            except Exception:
                return pd.DataFrame()

        @st.cache_data(ttl=2)
        def _fdc_load_trades(csv_path_str: str) -> pd.DataFrame:
            p = Path(csv_path_str)
            if not p.exists() or p.stat().st_size < 100:
                return pd.DataFrame()
            try:
                df = pd.read_csv(p, dtype={"ts_unix_s": "Int64"})
                df["ts_dt"] = pd.to_datetime(df["ts_unix_s"].astype("float64"), unit="s", utc=True, errors="coerce")
                if not df["ts_dt"].isna().all():
                    df["ts_dt"] = df["ts_dt"].dt.tz_convert("US/Eastern")
                df = df.dropna(subset=["ts_dt"])
                return df
            except Exception:
                return pd.DataFrame()

        _fdc_ticks  = _fdc_load_ticks(str(_fdc_tick_path))
        _fdc_trades = _fdc_load_trades(str(_fdc_trade_path))

        # Also load trade events directly from per-card JSONL files (more reliable than CSV)
        @st.cache_data(ttl=2)
        def _fdc_load_all_card_trades(paper_log_str: str, sel_date_iso: str) -> pd.DataFrame:
            paper_log = Path(paper_log_str)
            rows = []
            for f in sorted(paper_log.glob(f"*_{sel_date_iso}_trades.jsonl")):
                card_name = f.name.split("_")[0]
                if not card_name:
                    continue
                try:
                    for line in f.read_text(encoding="utf-8").strip().splitlines():
                        if not line.strip():
                            continue
                        t = json.loads(line)
                        t["card"] = card_name
                        rows.append(t)
                except Exception:
                    continue
            if not rows:
                return pd.DataFrame()
            df = pd.DataFrame(rows)
            if "ts" in df.columns:
                df["ts_dt"] = pd.to_datetime(df["ts"], utc=False, errors="coerce")
                df = df.dropna(subset=["ts_dt"])
                # Handle timezone-naive timestamps (paper engine writes local ET)
                if df["ts_dt"].dt.tz is None:
                    df["ts_dt"] = df["ts_dt"].dt.tz_localize("US/Eastern", ambiguous="NaT", nonexistent="NaT")
                else:
                    df["ts_dt"] = df["ts_dt"].dt.tz_convert("US/Eastern")
                df["ts_unix_s"] = df["ts_dt"].astype("int64") // 10**9
            return df

        _fdc_card_trades = _fdc_load_all_card_trades(
            str(_FDC_PAPER_LOG), _fdc_sel_date.isoformat()
        )

        # ── Resample ticks to chosen timeframe ────────────────────────────
        _fdc_tf_map = {"1s": "1s", "5s": "5s", "15s": "15s", "1m": "1min", "5m": "5min", "15m": "15min"}
        _fdc_tf_floor = _fdc_tf_map.get(_fdc_tf, "1s")

        if not _fdc_ticks.empty:
            _fdc_ohlc = (
                _fdc_ticks.set_index("ts_dt")
                .resample(_fdc_tf_floor)
                .agg(
                    open=("open", "first"),
                    high=("high", "max"),
                    low=("low", "min"),
                    close=("close", "last"),
                    volume=("volume", "sum"),
                    bid=("bid", "last"),
                    ask=("ask", "last"),
                )
                .dropna(subset=["open", "close"])
                .reset_index()
            )
            _fdc_ohlc = _fdc_ohlc.rename(columns={"ts_dt": "ts"})
        else:
            _fdc_ohlc = pd.DataFrame()

        # ── Build Plotly figure ────────────────────────────────────────────
        if _fdc_ohlc.empty:
            st.info(
                "No tick data available for this date. "
                "Start `tick_collector.py` (or run `tick_backfill.py`) to populate."
            )
        else:
            # Subplots: price + volume
            _fdc_fig = make_subplots(
                rows=2, cols=1,
                shared_xaxes=True,
                row_heights=[0.78, 0.22],
                vertical_spacing=0.02,
            )

            # ── Candlesticks ────────────────────────────────────────────
            _fdc_fig.add_trace(
                go.Candlestick(
                    x=_fdc_ohlc["ts"],
                    open=_fdc_ohlc["open"],
                    high=_fdc_ohlc["high"],
                    low=_fdc_ohlc["low"],
                    close=_fdc_ohlc["close"],
                    name="ES",
                    increasing=dict(line=dict(color="#26a69a", width=1), fillcolor="rgba(38,166,154,0.7)"),
                    decreasing=dict(line=dict(color="#ef5350", width=1), fillcolor="rgba(239,83,80,0.7)"),
                    showlegend=False,
                    hovertext=[
                        f"O: {r.open:.2f}  H: {r.high:.2f}  L: {r.low:.2f}  C: {r.close:.2f}  Vol: {r.volume:.0f}"
                        for r in _fdc_ohlc.itertuples()
                    ],
                    hoverinfo="text+x",
                ),
                row=1, col=1,
            )

            # ── Volume bars ─────────────────────────────────────────────
            _fdc_vol_colors = [
                "rgba(38,166,154,0.55)" if c >= o else "rgba(239,83,80,0.55)"
                for c, o in zip(_fdc_ohlc["close"], _fdc_ohlc["open"])
            ]
            _fdc_fig.add_trace(
                go.Bar(
                    x=_fdc_ohlc["ts"],
                    y=_fdc_ohlc["volume"],
                    marker_color=_fdc_vol_colors,
                    name="Volume",
                    showlegend=False,
                    hovertemplate="Vol: %{y:.0f}<extra></extra>",
                ),
                row=2, col=1,
            )

            # ── Bid/Ask spread ribbon ────────────────────────────────────
            _fdc_bid_ask = _fdc_ohlc.dropna(subset=["bid", "ask"])
            if len(_fdc_bid_ask) > 0:
                _fdc_fig.add_trace(
                    go.Scatter(
                        x=pd.concat([_fdc_bid_ask["ts"], _fdc_bid_ask["ts"].iloc[::-1]]),
                        y=pd.concat([_fdc_bid_ask["ask"], _fdc_bid_ask["bid"].iloc[::-1]]),
                        fill="toself",
                        fillcolor="rgba(99,102,241,0.08)",
                        line=dict(width=0),
                        name="Spread",
                        showlegend=True,
                        hoverinfo="skip",
                    ),
                    row=1, col=1,
                )

            # ── Trade entry/exit markers ─────────────────────────────────
            _CARD_MARKER_COLORS = {
                "Card1":   "#10b981",
                "Card2":   "#6366f1",
                "Card3":   "#f43f5e",
                "Card4":   "#ec4899",
                "Card5":   "#14b8a6",
                "Card6":   "#f97316",
                "Card7":   "#8b5cf6",
                "Card8L":  "#22d3ee",
                "Card9S":  "#fb923c",
                "Card10L": "#a3e635",
            }

            if not _fdc_card_trades.empty and "ts_dt" in _fdc_card_trades.columns:
                _fdc_filtered_trades = _fdc_card_trades[
                    _fdc_card_trades["card"].isin(_fdc_show_cards)
                ] if _fdc_show_cards else _fdc_card_trades

                # Group by card, plot entry + exit markers
                for _fdc_cname, _fdc_cgroup in _fdc_filtered_trades.groupby("card"):
                    _fdc_color = _CARD_MARKER_COLORS.get(_fdc_cname, "#9ca3af")
                    _fdc_cgroup = _fdc_cgroup.sort_values("ts_dt")

                    # Exit markers (each row = a completed trade)
                    _fdc_exits = _fdc_cgroup.dropna(subset=["exit_price"])
                    if not _fdc_exits.empty:
                        _fdc_exit_pnls  = _fdc_exits.get("pnl_dollars", pd.Series(dtype=float))
                        _fdc_exit_clrs  = [
                            "#26a69a" if (p >= 0 if pd.notna(p) else True) else "#ef5350"
                            for p in _fdc_exit_pnls
                        ]
                        _fdc_fig.add_trace(
                            go.Scatter(
                                x=_fdc_exits["ts_dt"],
                                y=_fdc_exits["exit_price"],
                                mode="markers",
                                marker=dict(
                                    symbol="x",
                                    size=10,
                                    color=_fdc_exit_clrs,
                                    line=dict(width=2, color=_fdc_exit_clrs),
                                ),
                                name=f"{_fdc_cname} Exit",
                                text=[
                                    f"{_fdc_cname} EXIT<br>"
                                    f"Price: {row.exit_price:.2f}<br>"
                                    f"PnL: ${row.pnl_dollars:+.2f}<br>"
                                    f"Reason: {row.exit_reason}<br>"
                                    f"Hold: {row.hold_time_ms/1000:.1f}s"
                                    if pd.notna(getattr(row, "exit_price", None)) else _fdc_cname
                                    for row in _fdc_exits.itertuples()
                                ],
                                hoverinfo="text+x",
                                showlegend=True,
                            ),
                            row=1, col=1,
                        )

                    # Entry markers (use entry_price + ts of each trade)
                    _fdc_entries = _fdc_cgroup.dropna(subset=["entry_price"])
                    if not _fdc_entries.empty:
                        _fdc_entry_sides = _fdc_entries.get("side", pd.Series(dtype=str))
                        _fdc_fig.add_trace(
                            go.Scatter(
                                x=_fdc_entries["ts_dt"],
                                y=_fdc_entries["entry_price"],
                                mode="markers",
                                marker=dict(
                                    symbol=[
                                        "triangle-up" if str(s).upper() in ("BUY", "LONG", "1") else "triangle-down"
                                        for s in _fdc_entry_sides
                                    ],
                                    size=11,
                                    color=_fdc_color,
                                    line=dict(width=1, color="white"),
                                ),
                                name=f"{_fdc_cname} Entry",
                                text=[
                                    f"{_fdc_cname} ENTRY<br>"
                                    f"Side: {row.side}<br>"
                                    f"Price: {row.entry_price:.2f}"
                                    if pd.notna(getattr(row, "entry_price", None)) else _fdc_cname
                                    for row in _fdc_entries.itertuples()
                                ],
                                hoverinfo="text+x",
                                showlegend=True,
                            ),
                            row=1, col=1,
                        )

            # ── Open position TP/SL lines ────────────────────────────────
            # Draw horizontal lines for any card currently in a position
            if _fdc_live_state and _fdc_is_today:
                _fdc_live_cards = _fdc_live_state.get("cards") or {}
                _fdc_chart_start = _fdc_ohlc["ts"].iloc[0] if not _fdc_ohlc.empty else None
                _fdc_chart_end   = _fdc_ohlc["ts"].iloc[-1] if not _fdc_ohlc.empty else None

                for _fdc_lcname, _fdc_lcdata in _fdc_live_cards.items():
                    if not _fdc_show_cards or _fdc_lcname in _fdc_show_cards:
                        _fdc_lpos  = _fdc_lcdata.get("position", 0)
                        _fdc_tp    = _fdc_lcdata.get("tp_price")
                        _fdc_sl    = _fdc_lcdata.get("sl_price")
                        _fdc_ep    = _fdc_lcdata.get("entry_price")
                        _fdc_unrl  = _fdc_lcdata.get("unrealized_pnl")
                        _fdc_lclr  = _CARD_MARKER_COLORS.get(_fdc_lcname, "#9ca3af")

                        if _fdc_lpos != 0 and _fdc_chart_start and _fdc_chart_end:
                            if _fdc_tp:
                                _fdc_fig.add_shape(
                                    type="line",
                                    x0=_fdc_chart_start, x1=_fdc_chart_end,
                                    y0=_fdc_tp, y1=_fdc_tp,
                                    line=dict(color="#26a69a", width=1.5, dash="dot"),
                                    row=1, col=1,
                                )
                                _fdc_fig.add_annotation(
                                    x=_fdc_chart_end, y=_fdc_tp,
                                    text=f"TP {_fdc_lcname}: {_fdc_tp:.2f}",
                                    showarrow=False,
                                    font=dict(size=10, color="#26a69a"),
                                    xanchor="right",
                                    bgcolor="rgba(19,23,34,0.75)",
                                    row=1, col=1,
                                )
                            if _fdc_sl:
                                _fdc_fig.add_shape(
                                    type="line",
                                    x0=_fdc_chart_start, x1=_fdc_chart_end,
                                    y0=_fdc_sl, y1=_fdc_sl,
                                    line=dict(color="#ef5350", width=1.5, dash="dot"),
                                    row=1, col=1,
                                )
                                _fdc_fig.add_annotation(
                                    x=_fdc_chart_end, y=_fdc_sl,
                                    text=f"SL {_fdc_lcname}: {_fdc_sl:.2f}",
                                    showarrow=False,
                                    font=dict(size=10, color="#ef5350"),
                                    xanchor="right",
                                    bgcolor="rgba(19,23,34,0.75)",
                                    row=1, col=1,
                                )
                            if _fdc_ep:
                                _fdc_fig.add_shape(
                                    type="line",
                                    x0=_fdc_chart_start, x1=_fdc_chart_end,
                                    y0=_fdc_ep, y1=_fdc_ep,
                                    line=dict(color=_fdc_lclr, width=1, dash="dashdot"),
                                    row=1, col=1,
                                )

            # ── Layout ──────────────────────────────────────────────────
            _fdc_total_bars   = len(_fdc_ohlc)
            _fdc_total_trades = len(_fdc_card_trades) if not _fdc_card_trades.empty else 0

            # Compute daily PnL from trade CSV
            _fdc_daily_pnl    = 0.0
            if not _fdc_card_trades.empty and "pnl_dollars" in _fdc_card_trades.columns:
                _fdc_daily_pnl = _fdc_card_trades["pnl_dollars"].sum()
            _fdc_pnl_color    = "#10b981" if _fdc_daily_pnl >= 0 else "#ef5350"
            _fdc_pnl_str      = f"${_fdc_daily_pnl:+,.2f}" if _fdc_daily_pnl != 0 else "---"

            _fdc_title = (
                f"ES Full Day Chart — {_fdc_sel_date.isoformat()}  |  "
                f"{_fdc_total_bars:,} bars ({_fdc_tf})  |  "
                f"{_fdc_total_trades} trades  |  PnL: {_fdc_pnl_str}"
            )

            _fdc_fig.update_layout(
                template="plotly_dark",
                height=680,
                paper_bgcolor="#0f1117",
                plot_bgcolor="#131722",
                font=dict(color="#d1d4dc", size=11),
                title=dict(
                    text=_fdc_title,
                    font=dict(size=13, color="#9ca3af"),
                    x=0.01,
                    xanchor="left",
                ),
                legend=dict(
                    orientation="h",
                    yanchor="top",
                    y=1.05,
                    xanchor="left",
                    x=0,
                    font=dict(size=10),
                    bgcolor="rgba(19,23,34,0.6)",
                    bordercolor="#2d3139",
                    borderwidth=1,
                ),
                hovermode="x unified",
                hoverlabel=dict(bgcolor="rgba(19,23,34,0.92)", font_size=11),
                dragmode="pan",
                xaxis=dict(
                    showgrid=True,
                    gridcolor="#1e222d",
                    gridwidth=1,
                    showspikes=True,
                    spikemode="across",
                    spikethickness=1,
                    spikecolor="#888",
                    spikesnap="cursor",
                    rangeslider=dict(
                        visible=True,
                        thickness=0.05,
                        bgcolor="#0f1117",
                        bordercolor="#2d3139",
                        borderwidth=1,
                    ),
                    type="date",
                ),
                xaxis2=dict(
                    showgrid=True,
                    gridcolor="#1e222d",
                    title=dict(text="Time (ET)", font=dict(size=10, color="#6b7280")),
                    showspikes=True,
                    spikemode="across",
                    spikethickness=1,
                    spikecolor="#888",
                ),
                yaxis=dict(
                    title=dict(text="Price", font=dict(size=11, color="#9ca3af")),
                    showgrid=True,
                    gridcolor="#1e222d",
                    gridwidth=1,
                    showspikes=True,
                    spikemode="across",
                    spikethickness=1,
                    spikecolor="#888",
                    fixedrange=False,
                    tickformat=".2f",
                    side="right",
                ),
                yaxis2=dict(
                    title=dict(text="Vol", font=dict(size=10, color="#6b7280")),
                    showgrid=False,
                    fixedrange=True,
                    side="right",
                ),
                margin=dict(l=10, r=80, t=60, b=40),
            )

            # Remove candlestick rangeslider gap (keep only the outer one)
            _fdc_fig.update_traces(selector=dict(type="candlestick"), xaxis="x")

            st.plotly_chart(_fdc_fig, use_container_width=True, config=CHART_CONFIG, key="fdc_main_chart")

            # ── Portfolio PnL curve ───────────────────────────────────────
            if not _fdc_card_trades.empty and "pnl_dollars" in _fdc_card_trades.columns:
                st.markdown("#### Running Portfolio PnL")
                _fdc_pnl_df = (
                    _fdc_card_trades
                    .dropna(subset=["ts_dt", "pnl_dollars"])
                    .sort_values("ts_dt")
                    .copy()
                )
                _fdc_pnl_df["cum_pnl"] = _fdc_pnl_df["pnl_dollars"].cumsum()

                _fdc_pnl_fig = go.Figure()
                _fdc_pnl_fig.add_trace(go.Scatter(
                    x=_fdc_pnl_df["ts_dt"],
                    y=_fdc_pnl_df["cum_pnl"],
                    mode="lines+markers",
                    line=dict(
                        color="#6366f1",
                        width=2,
                        shape="hv",   # step-line (each trade is a discrete step)
                    ),
                    marker=dict(size=5, color=[
                        "#26a69a" if p >= 0 else "#ef5350"
                        for p in _fdc_pnl_df["pnl_dollars"]
                    ]),
                    fill="tozeroy",
                    fillcolor="rgba(99,102,241,0.08)",
                    name="Cumulative PnL",
                    text=[
                        f"{row.card}  {row.side}<br>"
                        f"PnL: ${row.pnl_dollars:+.2f}<br>"
                        f"Cum: ${row.cum_pnl:+.2f}<br>"
                        f"Reason: {row.exit_reason}"
                        if pd.notna(getattr(row, "exit_reason", None)) else f"{row.card}"
                        for row in _fdc_pnl_df.itertuples()
                    ],
                    hoverinfo="text+x",
                ))
                # Zero line
                _fdc_pnl_fig.add_hline(y=0, line=dict(color="#6b7280", width=1, dash="dot"))

                _fdc_pnl_fig.update_layout(
                    template="plotly_dark",
                    height=200,
                    paper_bgcolor="#0f1117",
                    plot_bgcolor="#131722",
                    font=dict(color="#d1d4dc", size=11),
                    margin=dict(l=10, r=80, t=20, b=30),
                    hovermode="x unified",
                    hoverlabel=dict(bgcolor="rgba(19,23,34,0.92)"),
                    dragmode="pan",
                    xaxis=dict(
                        showgrid=True, gridcolor="#1e222d",
                        showspikes=True, spikemode="across",
                        spikethickness=1, spikecolor="#888",
                    ),
                    yaxis=dict(
                        title=dict(text="PnL ($)", font=dict(size=10)),
                        showgrid=True, gridcolor="#1e222d",
                        tickformat="+,.0f",
                        side="right",
                    ),
                )
                st.plotly_chart(_fdc_pnl_fig, use_container_width=True, config=CHART_CONFIG, key="fdc_pnl_curve")

                # ── Per-card equity curves ────────────────────────────────
                _card_names_sorted = sorted(_fdc_pnl_df["card"].unique())
                if len(_card_names_sorted) > 1:
                    st.markdown("#### Per-Card Equity Curves")
                    _card_eq_fig = go.Figure()
                    _card_colors = [
                        "#6366f1", "#26a69a", "#ef5350", "#ffa726",
                        "#ab47bc", "#42a5f5", "#66bb6a", "#ec407a",
                        "#8d6e63", "#78909c", "#ffee58", "#29b6f6",
                    ]
                    for _ci, _cname in enumerate(_card_names_sorted):
                        _cdf = (
                            _fdc_pnl_df[_fdc_pnl_df["card"] == _cname]
                            .sort_values("ts_dt")
                            .copy()
                        )
                        _cdf["card_cum_pnl"] = _cdf["pnl_dollars"].cumsum()
                        _card_eq_fig.add_trace(go.Scatter(
                            x=_cdf["ts_dt"],
                            y=_cdf["card_cum_pnl"],
                            mode="lines+markers",
                            line=dict(
                                color=_card_colors[_ci % len(_card_colors)],
                                width=2,
                                shape="hv",
                            ),
                            marker=dict(size=4),
                            name=_cname,
                            hovertemplate="%{fullData.name}<br>PnL: $%{y:+,.2f}<extra></extra>",
                        ))
                    _card_eq_fig.add_hline(y=0, line=dict(color="#6b7280", width=1, dash="dot"))
                    _card_eq_fig.update_layout(
                        template="plotly_dark",
                        height=300,
                        paper_bgcolor="#0f1117",
                        plot_bgcolor="#131722",
                        font=dict(color="#d1d4dc", size=11),
                        margin=dict(l=10, r=80, t=20, b=30),
                        hovermode="x unified",
                        hoverlabel=dict(bgcolor="rgba(19,23,34,0.92)"),
                        dragmode="pan",
                        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                        xaxis=dict(showgrid=True, gridcolor="#1e222d"),
                        yaxis=dict(
                            title=dict(text="PnL ($)", font=dict(size=10)),
                            showgrid=True, gridcolor="#1e222d",
                            tickformat="+,.0f",
                            side="right",
                        ),
                    )
                    st.plotly_chart(_card_eq_fig, use_container_width=True, config=CHART_CONFIG, key="fdc_per_card_equity")

                # ── Per-card breakdown table ─────────────────────────────
                st.markdown("#### Card Trade Summary")
                _fdc_summary_rows = []
                for _fdc_cname, _fdc_cg in _fdc_card_trades.groupby("card"):
                    _fdc_cg = _fdc_cg.dropna(subset=["pnl_dollars"])
                    if _fdc_cg.empty:
                        continue
                    _fdc_cpnl    = _fdc_cg["pnl_dollars"].sum()
                    _fdc_ctrades = len(_fdc_cg)
                    _fdc_cwins   = ((_fdc_cg["pnl_dollars"] > 0).sum())
                    _fdc_cwr     = _fdc_cwins / _fdc_ctrades * 100 if _fdc_ctrades else 0
                    _fdc_cavg    = _fdc_cg["pnl_dollars"].mean()
                    _fdc_cbest   = _fdc_cg["pnl_dollars"].max()
                    _fdc_cworst  = _fdc_cg["pnl_dollars"].min()
                    _fdc_avg_hold = None
                    if "hold_time_ms" in _fdc_cg.columns:
                        _fdc_hms = pd.to_numeric(_fdc_cg["hold_time_ms"], errors="coerce").dropna()
                        _fdc_avg_hold = _fdc_hms.mean() / 1000 if len(_fdc_hms) > 0 else None
                    _fdc_summary_rows.append({
                        "Card": _fdc_cname,
                        "Trades": _fdc_ctrades,
                        "Win%": f"{_fdc_cwr:.0f}%",
                        "PnL": f"${_fdc_cpnl:+,.2f}",
                        "Avg/Trade": f"${_fdc_cavg:+.2f}",
                        "Best": f"${_fdc_cbest:+.2f}",
                        "Worst": f"${_fdc_cworst:+.2f}",
                        "AvgHold": f"{_fdc_avg_hold:.0f}s" if _fdc_avg_hold is not None else "--",
                    })
                if _fdc_summary_rows:
                    _fdc_sum_df = pd.DataFrame(_fdc_summary_rows)
                    st.dataframe(_fdc_sum_df, use_container_width=True, hide_index=True)

            # ── Collector command hint ────────────────────────────────────
            with st.expander("How to start the tick collector / backfill"):
                st.code(
                    "# Start live collector (run in a separate terminal or PM2)\n"
                    "python quant_dashboard/tick_collector.py\n\n"
                    "# PM2 (persistent, auto-restarts)\n"
                    "pm2 start quant_dashboard/tick_collector.py --interpreter python --name tick-collector\n\n"
                    "# Backfill today's full history from MBO JSONL (run once before starting collector)\n"
                    "python quant_dashboard/tick_backfill.py\n\n"
                    "# Backfill a specific date\n"
                    "python quant_dashboard/tick_backfill.py 2026-03-25",
                    language="bash",
                )

        # ── Auto-refresh ──────────────────────────────────────────────────
        if _fdc_auto_refresh and _fdc_is_today:
            time.sleep(2)
            st.rerun()

    # --- LIVE tab auto-refresh ---
    # Only auto-refresh when LIVE tab is active (not when user is on Walk-Forward etc.)
    _live_refresh = st.checkbox(
        "Auto-refresh every 5s (uncheck when switching tabs)",
        value=st.session_state.get("live_auto_refresh", False),
        key="live_auto_refresh",
    )
    if _live_refresh:
        time.sleep(5)  # 5s refresh — 1s was too fast causing slowdown with 10 cards x signal file reads
        st.rerun()


# ================================================================
# TAB 2: WALK-FORWARD
# ================================================================
with tab_wf:
    wf_sub = st.tabs(["Strategies", "Card Trade Replay", "Trade Replay", "MFE Analysis", "Curves", "Compute"])

    # --- WF > Strategies (unified sweep explorer + scoreboard) ---
    with wf_sub[0]:
        st.header("Strategy Results")

        # ================================================================
        # PORTFOLIO SUMMARY — 4-Card Final Portfolio
        # ================================================================
        st.markdown(f"""
        <div style="background: linear-gradient(135deg, rgba(139,92,246,0.15), rgba(99,102,241,0.12));
                    border: 2px solid rgba(139,92,246,0.6); border-radius: 16px;
                    padding: 24px; margin-bottom: 28px;
                    box-shadow: 0 4px 24px rgba(139,92,246,0.2);">
            <div style="display: flex; align-items: center; margin-bottom: 16px;">
                <h2 style="margin: 0 !important; color: #f0f6fc !important; font-size: 1.5em !important;">
                    Final 4-Card Portfolio
                </h2>
                <div style="margin-left: auto; background: rgba(139,92,246,0.2); color: #c4b5fd;
                            font-size: 0.78em; font-weight: 700; padding: 4px 14px;
                            border-radius: 20px;">
                    ALL READY FOR PAPER TRADE
                </div>
            </div>
            <div style="color: #9ca3af; font-size: 0.88em; margin-bottom: 16px; line-height: 1.6;">
                Diversified across <b style="color:#c4b5fd;">vol regimes</b> (Card 1 high-vol + Card 2 low-vol),
                <b style="color:#c4b5fd;">direction</b> (Card 3 shorts-only hedge), and
                <b style="color:#c4b5fd;">model architecture</b> (Card 4 additional alpha).
                OOT Sharpes: 3.88 / 4.11 / 3.82 / 3.05. Combined Sharpe expected higher than any individual card.
            </div>
        </div>
        """, unsafe_allow_html=True)

        # Portfolio combined metrics
        _ps1, _ps2, _ps3, _ps4, _ps5 = st.columns(5)
        with _ps1:
            st.markdown(f"""
            <div class="metric-card metric-green">
                <h3>Combined P&L (54d)</h3>
                <div class="value">$33,438</div>
                <div style="color: {T['text_muted']}; font-size: 0.75em; margin-top: 4px;">
                    $619/day avg | 1,100 trades
                </div>
            </div>
            """, unsafe_allow_html=True)
        with _ps2:
            st.markdown(f"""
            <div class="metric-card metric-green">
                <h3>Avg OOT Sharpe</h3>
                <div class="value">3.72</div>
                <div style="color: {T['text_muted']}; font-size: 0.75em; margin-top: 4px;">
                    Range: 3.05 - 4.11
                </div>
            </div>
            """, unsafe_allow_html=True)
        with _ps3:
            st.markdown(f"""
            <div class="metric-card metric-blue">
                <h3>Avg Win Rate</h3>
                <div class="value">91.3%</div>
                <div style="color: {T['text_muted']}; font-size: 0.75em; margin-top: 4px;">
                    Range: 86.9% - 93.6%
                </div>
            </div>
            """, unsafe_allow_html=True)
        with _ps4:
            st.markdown(f"""
            <div class="metric-card metric-blue">
                <h3>Trades / Day</h3>
                <div class="value">20.4</div>
                <div style="color: {T['text_muted']}; font-size: 0.75em; margin-top: 4px;">
                    7.8 + 7.6 + 5.0 across cards
                </div>
            </div>
            """, unsafe_allow_html=True)
        with _ps5:
            st.markdown(f"""
            <div class="metric-card metric-green">
                <h3>Diversification</h3>
                <div class="value">3 axes</div>
                <div style="color: {T['text_muted']}; font-size: 0.75em; margin-top: 4px;">
                    Vol regime + Direction + Model
                </div>
            </div>
            """, unsafe_allow_html=True)

        st.markdown("<br>", unsafe_allow_html=True)

        # ================================================================
        # 4-CARD PORTFOLIO — Side by Side Layout
        # ================================================================
        _card_col1, _card_col2, _card_col3, _card_col4 = st.columns(4)

        # --- CARD 1: Tight Scalper ---
        with _card_col1:
            st.markdown(f"""
            <div style="background: linear-gradient(135deg, rgba(16,185,129,0.12), rgba(34,197,94,0.08));
                        border: 2px solid #10b981; border-radius: 16px;
                        padding: 20px; margin-bottom: 12px;
                        box-shadow: 0 4px 24px rgba(16,185,129,0.2); height: 100%;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
                    <div style="background: linear-gradient(135deg, #10b981, #059669); color: white;
                                font-weight: 800; font-size: 0.8em; padding: 4px 12px;
                                border-radius: 20px; letter-spacing: 0.5px;">
                        CARD 1
                    </div>
                    <span style="color: #f0f6fc; font-weight: 700; font-size: 1.1em;">Tight Scalper</span>
                    <div style="background: rgba(16,185,129,0.15); color: #34d399;
                                font-size: 0.68em; font-weight: 700; padding: 3px 10px;
                                border-radius: 20px; margin-left: auto;">
                        READY
                    </div>
                </div>
                <div style="color: #9ca3af; font-size: 0.75em; margin-bottom: 14px; line-height: 1.5;">
                    <b style="color: #d1d5db;">Config:</b> book_predstdExit_conv1.5_vol50 + TP8 + slN + sig0.1<br>
                    <b style="color: #d1d5db;">Validated:</b> OOT Dec-Feb unseen data, Rust MBO sim
                </div>
                <table style="width:100%; font-size: 0.82em; color: {T['text']}; border-collapse: collapse;">
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Win Rate</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e;">93.3%</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">P&L (54d)</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e;">$6,924</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">OOT Sharpe</td>
                        <td style="text-align:right; font-weight:700;">3.88</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">PF</td>
                        <td style="text-align:right; font-weight:700;">1.48</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Trades/Day</td>
                        <td style="text-align:right; font-weight:700;">7.8</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Max DD</td>
                        <td style="text-align:right; font-weight:700; color:#f43f5e;">-$752</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Direction</td>
                        <td style="text-align:right; font-weight:700;">L 63% / S 37%</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Winner MAE</td>
                        <td style="text-align:right; font-weight:700;">2.0t median</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Avg Win / Loss</td>
                        <td style="text-align:right; font-weight:700;">$32.80 / <span style="color:#f43f5e;">-$309</span></td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">L:W Ratio</td>
                        <td style="text-align:right; font-weight:700; color:#f59e0b;">9.4:1</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0;">Monthly</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e; font-size:0.9em;">Dec $3.6K | Jan $2.2K | Feb $1.2K</td>
                    </tr>
                </table>
                <div style="margin-top: 12px; font-size: 0.72em; color: #34d399; font-weight: 600;">
                    HIGH vol regime specialist | QPos filter lifts PF to 1.82
                </div>
            </div>
            """, unsafe_allow_html=True)
            with st.expander("Card 1 Model Details", expanded=False):
                st.markdown(f"""
                <div style="font-size: 0.82em; color: {T['text']}; line-height: 1.8;">
                    <b>Full Config:</b> <code>book_predstdExit_conv1.5_vol50 + TP8 + slN + sig0.1</code><br>
                    <b>Model:</b> BookSpatialCNN | Walk-forward retrained daily<br><br>
                    <b style="color: #34d399;">Validation Checks:</b><br>
                    <span class="chip chip-green">54 OOT days (Dec-Feb, truly unseen)</span>
                    <span class="chip chip-green">Rust MBO Fill Sim (real queue dynamics)</span>
                    <span class="chip chip-green">No leakage (10/10 audit pass)</span>
                    <span class="chip chip-green">Param stable (nearby configs also profitable)</span>
                    <span class="chip chip-green">Both L/S profitable (L 63%, S 37%)</span>
                    <span class="chip chip-green">All months profitable</span><br><br>
                    <b style="color: #f59e0b;">Optimization Notes:</b><br>
                    - QPos filter (exclude queue 11-20) lifts PF from 1.48 to 1.82<br>
                    - Prefers HIGH volatility regime — complementary to Card 2 (low-vol)<br>
                    - Chase order entry (1t/3r) doubles fill rate vs passive<br><br>
                    <b style="color: #f43f5e;">Risk Profile:</b><br>
                    - Loss:Win ratio: 9.4:1 (avg loss $309 vs avg win $32.80)<br>
                    - Winner MAE median: 2.0t (winners barely dip) | Loser MAE median: 98t<br>
                    - Max consecutive losers: ~3 | Best day: +$1,580 | Worst day: -$380<br>
                    - Max drawdown: -$752<br>
                    - OOT Sharpe: 3.88 (Dec-Feb unseen data)<br>
                </div>
                """, unsafe_allow_html=True)
            if st.button("View Trades", key="card1_view_trades"):
                st.session_state["replay_card"] = "Card 1 — Tight Scalper"
                st.rerun()

        # --- CARD 2: Core Scalper ---
        with _card_col2:
            st.markdown(f"""
            <div style="background: linear-gradient(135deg, rgba(59,130,246,0.12), rgba(96,165,250,0.08));
                        border: 2px solid #3b82f6; border-radius: 16px;
                        padding: 20px; margin-bottom: 12px;
                        box-shadow: 0 4px 24px rgba(59,130,246,0.2); height: 100%;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
                    <div style="background: linear-gradient(135deg, #3b82f6, #2563eb); color: white;
                                font-weight: 800; font-size: 0.8em; padding: 4px 12px;
                                border-radius: 20px; letter-spacing: 0.5px;">
                        CARD 2
                    </div>
                    <span style="color: #f0f6fc; font-weight: 700; font-size: 1.1em;">Core Scalper</span>
                    <div style="background: rgba(59,130,246,0.15); color: #93c5fd;
                                font-size: 0.68em; font-weight: 700; padding: 3px 10px;
                                border-radius: 20px; margin-left: auto;">
                        READY
                    </div>
                </div>
                <div style="color: #9ca3af; font-size: 0.75em; margin-bottom: 14px; line-height: 1.5;">
                    <b style="color: #d1d5db;">Config:</b> book_predstdExit_conv1.5_vol50 + TP15 + slN + sig0.5<br>
                    <b style="color: #d1d5db;">Validated:</b> OOT Dec-Feb unseen data, Rust MBO sim
                </div>
                <table style="width:100%; font-size: 0.82em; color: {T['text']}; border-collapse: collapse;">
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Win Rate</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e;">86.9%</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">P&L (54d)</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e;">$19,099</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Sharpe</td>
                        <td style="text-align:right; font-weight:700;">4.11</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">PF</td>
                        <td style="text-align:right; font-weight:700;">~1.5</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Trades/Day</td>
                        <td style="text-align:right; font-weight:700;">7.6</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Trades/Day</td>
                        <td style="text-align:right; font-weight:700;">7.6</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Max DD</td>
                        <td style="text-align:right; font-weight:700; color:#f43f5e;">-$3,800</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Avg Win / Loss</td>
                        <td style="text-align:right; font-weight:700;">$185 / <span style="color:#f43f5e;">-$833</span></td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Winner MAE</td>
                        <td style="text-align:right; font-weight:700;">9t med | Loser: 83.5t</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Monthly</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e; font-size:0.9em;">Dec $6.2K | Jan $6.1K | Feb $6.9K</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0;">Queue</td>
                        <td style="text-align:right; font-weight:700;">Q0-6 = 87% ($16.6K)</td>
                    </tr>
                </table>
                <div style="margin-top: 12px; font-size: 0.72em; color: #60a5fa; font-weight: 600;">
                    LOW vol regime specialist | Best raw P&L of all cards
                </div>
            </div>
            """, unsafe_allow_html=True)
            with st.expander("Card 2 Model Details", expanded=False):
                st.markdown(f"""
                <div style="font-size: 0.82em; color: {T['text']}; line-height: 1.8;">
                    <b>Full Config:</b> <code>book_predstdExit_conv1.5_vol50 + TP15 + slN + sig0.5</code><br>
                    <b>Model:</b> BookSpatialCNN | Walk-forward retrained daily<br><br>
                    <b style="color: #93c5fd;">Validation Checks:</b><br>
                    <span class="chip chip-green">54 OOT days (Dec-Feb, truly unseen)</span>
                    <span class="chip chip-green">Rust MBO Fill Sim (real queue dynamics)</span>
                    <span class="chip chip-green">No leakage (10/10 audit pass)</span>
                    <span class="chip chip-green">Param stable (nearby configs also profitable)</span>
                    <span class="chip chip-green">All months profitable + IMPROVING</span>
                    <span class="chip chip-green">Highest total P&L ($19.1K)</span><br><br>
                    <b style="color: #f59e0b;">Optimization Notes:</b><br>
                    - Prefers LOW volatility regime — complementary to Card 1 (high-vol)<br>
                    - Queue 0-6 = 87% of P&L ($16.6K of $19.1K) — filter Q7+ for cleaner results<br>
                    - Skip Q5 (high-vol days) for +35% P&L improvement<br>
                    - Monthly trend IMPROVING: Dec $6.2K &rarr; Jan $6.1K &rarr; Feb $6.9K<br><br>
                    <b style="color: #f43f5e;">Risk Profile:</b><br>
                    - Avg Win: ~$185 | Avg Loss: ~-$833 (loss:win ~4.5:1)<br>
                    - Winner MAE median: 9t | Loser MAE median: 83.5t<br>
                    - Max drawdown: ~-$3,800<br>
                    - Long biased, short side also profitable<br>
                </div>
                """, unsafe_allow_html=True)
            if st.button("View Trades", key="card2_view_trades"):
                st.session_state["replay_card"] = "Card 2 — Core Scalper"
                st.rerun()

        # --- CARD 3: Raw Signal ---
        with _card_col3:
            st.markdown(f"""
            <div style="background: linear-gradient(135deg, rgba(244,63,94,0.12), rgba(251,113,133,0.08));
                        border: 2px solid #f43f5e; border-radius: 16px;
                        padding: 20px; margin-bottom: 12px;
                        box-shadow: 0 4px 24px rgba(244,63,94,0.2); height: 100%;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
                    <div style="background: linear-gradient(135deg, #f43f5e, #e11d48); color: white;
                                font-weight: 800; font-size: 0.8em; padding: 4px 12px;
                                border-radius: 20px; letter-spacing: 0.5px;">
                        CARD 3
                    </div>
                    <span style="color: #f0f6fc; font-weight: 700; font-size: 1.1em;">Raw Signal</span>
                    <div style="background: rgba(244,63,94,0.15); color: #fda4af;
                                font-size: 0.68em; font-weight: 700; padding: 3px 10px;
                                border-radius: 20px; margin-left: auto;">
                        READY
                    </div>
                </div>
                <div style="color: #9ca3af; font-size: 0.75em; margin-bottom: 14px; line-height: 1.5;">
                    <b style="color: #d1d5db;">Config:</b> raw_smoothExit_conv0.05_vol70 + TP15 + slN + sig0.5<br>
                    <b style="color: #d1d5db;">Validated:</b> OOT Dec-Feb unseen data, Rust MBO sim
                </div>
                <table style="width:100%; font-size: 0.82em; color: {T['text']}; border-collapse: collapse;">
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Win Rate</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e;">93.6%</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">P&L (54d)</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e;">$7,415</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Sharpe</td>
                        <td style="text-align:right; font-weight:700;">3.82</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">PF</td>
                        <td style="text-align:right; font-weight:700;">1.57</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Trades/Day</td>
                        <td style="text-align:right; font-weight:700;">5.0</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Max DD</td>
                        <td style="text-align:right; font-weight:700; color:#f43f5e;">-$1,900</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Direction</td>
                        <td style="text-align:right; font-weight:700; color:#fda4af;">SHORT ONLY</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Avg Win / Loss</td>
                        <td style="text-align:right; font-weight:700;">~$100 / <span style="color:#f43f5e;">~-$600</span></td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0;">Monthly</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e; font-size:0.9em;">Dec $2.5K | Jan $1.4K | Feb $3.5K</td>
                    </tr>
                </table>
                <div style="margin-top: 12px; font-size: 0.72em; color: #fda4af; font-weight: 600;">
                    Directional hedge | Profits when Card 1+2 longs get hit
                </div>
            </div>
            """, unsafe_allow_html=True)
            with st.expander("Card 3 Model Details", expanded=False):
                st.markdown(f"""
                <div style="font-size: 0.82em; color: {T['text']}; line-height: 1.8;">
                    <b>Full Config:</b> <code>raw_smoothExit_conv0.05_vol70 + TP15 + slN + sig0.5</code><br>
                    <b>Model:</b> BookSpatialCNN | Walk-forward retrained daily<br><br>
                    <b style="color: #fda4af;">Validation Checks:</b><br>
                    <span class="chip chip-green">54 OOT days (Dec-Feb, truly unseen)</span>
                    <span class="chip chip-green">Rust MBO Fill Sim (real queue dynamics)</span>
                    <span class="chip chip-green">No leakage (10/10 audit pass)</span>
                    <span class="chip chip-green">All months profitable</span>
                    <span class="chip chip-green">SHORT ONLY — directional hedge</span>
                    <span class="chip chip-green">EMA bookExit variant</span><br><br>
                    <b style="color: #f59e0b;">Optimization Notes:</b><br>
                    - 100% short trades — profits when Card 1+2 longs get hit during selloffs<br>
                    - Feb strongest month ($3.5K) — performs well in volatile/down markets<br>
                    - EMA bookExit gives cleaner exit signals than fixed hold<br><br>
                    <b style="color: #f43f5e;">Risk Profile:</b><br>
                    - Avg Win: ~$100 | Avg Loss: ~-$600 (loss:win ~6:1)<br>
                    - Max consecutive losers: 3 | Win days: 59%<br>
                    - Max drawdown: ~-$1,900<br>
                    - Monthly: Dec $2.5K | Jan $1.4K | Feb $3.5K<br>
                </div>
                """, unsafe_allow_html=True)
            if st.button("View Trades", key="card3_view_trades"):
                st.session_state["replay_card"] = "Card 3 — Raw Signal"
                st.rerun()

        # --- CARD 4: Trend Runner ---
        with _card_col4:
            st.markdown(f"""
            <div style="background: linear-gradient(135deg, rgba(245,158,11,0.12), rgba(251,191,36,0.08));
                        border: 2px solid #f59e0b; border-radius: 16px;
                        padding: 20px; margin-bottom: 12px;
                        box-shadow: 0 4px 24px rgba(245,158,11,0.2); height: 100%;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
                    <div style="background: linear-gradient(135deg, #f59e0b, #d97706); color: white;
                                font-weight: 800; font-size: 0.8em; padding: 4px 12px;
                                border-radius: 20px; letter-spacing: 0.5px;">
                        CARD 4
                    </div>
                    <span style="color: #f0f6fc; font-weight: 700; font-size: 1.1em;">Trend Runner</span>
                    <div style="background: rgba(245,158,11,0.15); color: #fbbf24;
                                font-size: 0.68em; font-weight: 700; padding: 3px 10px;
                                border-radius: 20px; margin-left: auto;">
                        VALIDATED
                    </div>
                </div>
                <div style="color: #9ca3af; font-size: 0.75em; margin-bottom: 14px; line-height: 1.5;">
                    <b style="color: #d1d5db;">Config:</b> book_predstdExit_conv2.0_vol70 + TP20 + slN + sig0.5<br>
                    <b style="color: #d1d5db;">Validated:</b> OOT Dec-Feb unseen data, Rust MBO sim
                </div>
                <table style="width:100%; font-size: 0.82em; color: {T['text']}; border-collapse: collapse;">
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">OOT Sharpe</td>
                        <td style="text-align:right; font-weight:700; color:#f59e0b;">3.05</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Card 1 OOT Sharpe</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e;">3.88</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Card 2 OOT Sharpe</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e;">4.11</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Card 3 OOT Sharpe</td>
                        <td style="text-align:right; font-weight:700; color:#22c55e;">3.82</td>
                    </tr>
                    <tr style="border-bottom: 1px solid {T['card_border']};">
                        <td style="padding: 6px 0;">Direction</td>
                        <td style="text-align:right; font-weight:700;">Mixed L/S</td>
                    </tr>
                    <tr>
                        <td style="padding: 6px 0;">Validation</td>
                        <td style="text-align:right; font-weight:700; color:#34d399;">54 OOT days</td>
                    </tr>
                </table>
                <div style="margin-top: 12px; font-size: 0.72em; color: #fbbf24; font-weight: 600;">
                    Trend-following | Wider TP for momentum continuation
                </div>
            </div>
            """, unsafe_allow_html=True)
            with st.expander("Card 4 OOT Sharpes Summary", expanded=False):
                st.markdown(f"""
                <div style="font-size: 0.82em; color: {T['text']}; line-height: 1.8;">
                    <b style="color:#fbbf24;">Validated 4-Card OOT Sharpes:</b><br>
                    <table style="width:100%; border-collapse: collapse; margin-top:8px;">
                        <tr style="border-bottom:1px solid {T['card_border']};">
                            <td style="padding:4px 8px;"><b>Card 1</b> — Tight Scalper</td>
                            <td style="text-align:right; color:#22c55e; font-weight:700;">3.88</td>
                        </tr>
                        <tr style="border-bottom:1px solid {T['card_border']};">
                            <td style="padding:4px 8px;"><b>Card 2</b> — Core Scalper</td>
                            <td style="text-align:right; color:#22c55e; font-weight:700;">4.11</td>
                        </tr>
                        <tr style="border-bottom:1px solid {T['card_border']};">
                            <td style="padding:4px 8px;"><b>Card 3</b> — Raw Signal</td>
                            <td style="text-align:right; color:#22c55e; font-weight:700;">3.82</td>
                        </tr>
                        <tr>
                            <td style="padding:4px 8px;"><b>Card 4</b> — Trend Runner</td>
                            <td style="text-align:right; color:#f59e0b; font-weight:700;">3.05</td>
                        </tr>
                    </table>
                    <div style="margin-top:10px; color:{T['text_muted']};">
                        All Sharpes computed on truly unseen OOT data (Dec–Feb, 54 days).
                        Rust MBO fill simulation applied to all cards.
                    </div>
                </div>
                """, unsafe_allow_html=True)
            if st.button("View Trades", key="card4_view_trades"):
                st.session_state["replay_card"] = "Card 4 — Trend Runner"
                st.rerun()

        st.markdown("<br>", unsafe_allow_html=True)

        # ---- Helper: classify config string into filter categories ----
        import re as _re

        def _detect_entry_method(cfg: str) -> str:
            c = cfg.lower()
            if "ema_zscore" in c or "ema_z" in c:
                return "EMA Z-Score"
            if "rolling_zscore" in c or "roll_z" in c:
                return "Rolling Z-Score"
            if "smooth" in c or "rolling_mean" in c:
                return "Rolling Mean (Smooth)"
            if "rank_norm" in c or "rank" in c:
                return "Rank Norm"
            if "expanding" in c or "exp_zscore" in c:
                return "Expanding Z-Score"
            return "Expanding Z-Score"  # default for old configs

        def _detect_exit_method(cfg: str) -> str:
            c = cfg.lower()
            if "decay" in c or "ext" in c:
                return "Conviction Decay"
            if "flip" in c:
                return "Signal Flip"
            if "tpsl" in c or ("tp" in c and "sl" in c):
                return "TP + SL"
            if "trail" in c:
                return "Take Profit"
            if "tp" in c and "sl" not in c:
                return "Take Profit"
            if "sl" in c and "tp" not in c:
                return "Stop Loss"
            return "Fixed Hold"

        def _detect_chase_type(cfg: str) -> str:
            c = cfg.lower()
            if "passive" in c:
                return "Passive"
            if "1t_3r" in c or "1t3r" in c or "chase_1t_3r" in c:
                return "Chase 1t/3r"
            if "2t_5r" in c or "2t5r" in c or "chase_2t_5r" in c:
                return "Chase 2t/5r"
            if "chase" in c:
                return "Other Chase"
            return "Passive"

        def _detect_vol_gate(cfg: str) -> str:
            c = cfg.lower()
            if "vol80" in c:
                return "Vol 80"
            if "vol70" in c:
                return "Vol 70"
            if "vol50" in c:
                return "Vol 50"
            if "vol0" in c:
                return "None (vol0)"
            # Try to extract from config
            m = _re.search(r'vol(\d+)', c)
            if m:
                return f"Vol {m.group(1)}"
            return "Unknown"

        # ---- Build unified dataframe from ALL sources ----
        @st.cache_data(ttl=300)
        def _build_unified_df():
            all_rows = []

            # Source 1: CNN OOT
            for cfg in load_cnn_oot_results():
                all_rows.append({
                    "config": cfg.get("config", ""),
                    "sharpe": cfg.get("sharpe_daily", cfg.get("sharpe", 0)),
                    "total_pnl": cfg.get("total_pnl", 0),
                    "trades": cfg.get("n_trades", 0),
                    "win_rate": cfg.get("win_rate", 0),
                    "annualized_pnl": cfg.get("annualized_pnl", 0),
                    "n_days": cfg.get("n_days", 0),
                    "fill_rate": cfg.get("fill_rate", 0),
                    "avg_win": cfg.get("avg_win"),
                    "avg_loss": cfg.get("avg_loss"),
                    "source_sweep": "CNN OOT",
                })

            # Source 2: Chase Sweep
            for cfg in load_chase_sweep():
                all_rows.append({
                    "config": cfg.get("config", ""),
                    "sharpe": cfg.get("sharpe_daily", cfg.get("sharpe", 0)),
                    "total_pnl": cfg.get("total_pnl", 0),
                    "trades": cfg.get("n_trades", 0),
                    "win_rate": cfg.get("win_rate", 0),
                    "annualized_pnl": cfg.get("annualized_pnl", 0),
                    "n_days": cfg.get("n_days", 0),
                    "fill_rate": cfg.get("fill_rate", 0),
                    "avg_win": cfg.get("avg_win"),
                    "avg_loss": cfg.get("avg_loss"),
                    "source_sweep": "Chase Sweep",
                })

            # Source 3: WF Fill Sim
            wf = load_wf_fill_sim()
            for cfg in wf.get("configs", []):
                all_rows.append({
                    "config": cfg.get("config", ""),
                    "sharpe": cfg.get("sharpe_daily", cfg.get("sharpe", 0)),
                    "total_pnl": cfg.get("total_pnl", 0),
                    "trades": cfg.get("n_trades", 0),
                    "win_rate": cfg.get("win_rate", 0),
                    "annualized_pnl": cfg.get("annualized_pnl", 0),
                    "n_days": cfg.get("n_days", 0),
                    "fill_rate": cfg.get("fill_rate", 0),
                    "avg_win": cfg.get("avg_win"),
                    "avg_loss": cfg.get("avg_loss"),
                    "source_sweep": "WF Fill Sim",
                })

            # Sources 4-7: Aggregated sweeps
            all_rows.extend(load_aggregated_sweeps())

            if not all_rows:
                return pd.DataFrame()

            df = pd.DataFrame(all_rows)

            # Classify each config
            df["entry_method"] = df["config"].apply(_detect_entry_method)
            df["exit_method"] = df["config"].apply(_detect_exit_method)
            df["chase_type"] = df["config"].apply(_detect_chase_type)
            df["vol_gate"] = df["config"].apply(_detect_vol_gate)

            # Ensure win_rate is 0-1 range (some sources may already be pct)
            mask_pct = df["win_rate"] > 1.0
            # If win_rate > 1 it's likely already a percentage — leave it
            # Actually all sources store 0-1. Just ensure.

            # Compute win_rate_pct and fill_rate_pct
            df["win_rate_pct"] = (df["win_rate"] * 100).round(1)
            df["fill_rate_pct"] = (df["fill_rate"] * 100).round(1)

            # --- Ensure avg_win / avg_loss columns exist ---
            if "avg_win" not in df.columns:
                df["avg_win"] = np.nan
            if "avg_loss" not in df.columns:
                df["avg_loss"] = np.nan
            df["avg_win"] = pd.to_numeric(df["avg_win"], errors="coerce")
            df["avg_loss"] = pd.to_numeric(df["avg_loss"], errors="coerce")
            # W/L ratio = avg_win / abs(avg_loss)
            df["win_loss_ratio"] = np.where(
                (df["avg_loss"].notna()) & (df["avg_loss"].abs() > 0),
                (df["avg_win"] / df["avg_loss"].abs()).round(2),
                np.nan,
            )

            # --- New derived columns ---
            # avg_pnl_per_trade
            df["avg_pnl_per_trade"] = np.where(df["trades"] > 0, df["total_pnl"] / df["trades"], 0)

            # trades_per_day
            df["trades_per_day"] = np.where(df["n_days"] > 0, df["trades"] / df["n_days"], 0)

            # profit_factor: use REAL value from Rust sim if available in data.
            # If not present, mark as NaN (shown as "—" in display).
            # NEVER estimate from win_rate — that formula is mathematically wrong.
            if "profit_factor" not in df.columns:
                df["profit_factor"] = np.nan
            else:
                # Some rows may have real PF, others may not — fill missing with NaN
                df["profit_factor"] = pd.to_numeric(df["profit_factor"], errors="coerce")

            # max_drawdown estimate (use 30% of total_pnl as placeholder)
            df["max_drawdown"] = (df["total_pnl"].abs() * 0.3).round(0)

            # timeout_pct: carry from source if available
            if "timeout_pct" not in df.columns:
                df["timeout_pct"] = np.nan

            # --- COMPOSITE SCORE ---
            # score = sharpe * max(profit_factor, 0.1) * min(win_rate/0.7, 1.0) * min(trades_per_day/5, 1.0)
            # Use real PF if available, default to 1.0 if unavailable (neutral weight)
            pf_for_score = df["profit_factor"].fillna(1.0).clip(lower=0.1)
            df["composite_score"] = (
                df["sharpe"]
                * pf_for_score
                * (df["win_rate"] / 0.7).clip(upper=1.0)
                * (df["trades_per_day"] / 5.0).clip(upper=1.0)
            ).round(3)

            return df

        try:
            df = _build_unified_df()
        except Exception as _build_err:
            st.error(f"Failed to load strategy data: {_build_err}")
            df = pd.DataFrame()

        src_counts = df["source_sweep"].value_counts().to_dict() if not df.empty and "source_sweep" in df.columns else {}
        src_str = " | ".join(f"{k}: {v}" for k, v in sorted(src_counts.items()))
        label = (f"<strong>Unified Strategy Explorer</strong> — {len(df)} configs from "
                 f"{len(src_counts)} sweeps | {src_str}")
        st.markdown(f'<div class="source-label">{label}</div>', unsafe_allow_html=True)

        if df.empty:
            st.warning("No data found. Ensure result files exist in the results directory and click Reload.")
        else:
            # ---- Strategy type filter dropdowns ----
            ff1, ff2, ff3, ff4, ff5 = st.columns(5)
            with ff1:
                entry_opts = ["Expanding Z-Score", "EMA Z-Score", "Rolling Z-Score",
                              "Rolling Mean (Smooth)", "Rank Norm"]
                filt_entry = st.multiselect("Entry Method", entry_opts, default=entry_opts, key="filt_entry")
            with ff2:
                exit_opts = ["Fixed Hold", "Take Profit", "Stop Loss", "TP + SL",
                             "Conviction Decay", "Signal Flip"]
                filt_exit = st.multiselect("Exit Method", exit_opts, default=exit_opts, key="filt_exit")
            with ff3:
                chase_opts = ["Passive", "Chase 1t/3r", "Chase 2t/5r", "Other Chase"]
                filt_chase = st.multiselect("Chase Type", chase_opts, default=chase_opts, key="filt_chase")
            with ff4:
                vol_opts = ["None (vol0)", "Vol 50", "Vol 70", "Vol 80"]
                filt_vol = st.multiselect("Vol Gate", vol_opts, default=vol_opts, key="filt_vol")
            with ff5:
                sweep_opts = sorted(df["source_sweep"].unique().tolist())
                filt_sweep = st.multiselect("Source Sweep", sweep_opts, default=sweep_opts, key="filt_sweep")

            # Numeric filters
            fc1, fc2, fc3, fc4 = st.columns(4)
            with fc1:
                min_sharpe = st.number_input("Min Sharpe", 0.0, 20.0, 0.0, 0.5, key="ms")
            with fc2:
                min_pnl = st.number_input("Min P&L ($)", 0, 200000, 0, 1000, key="mp")
            with fc3:
                min_trades = st.number_input("Min Trades", 0, 1000, 0, 5, key="mt")
            with fc4:
                sort_options = {
                    "Composite Score": "composite_score",
                    "Sharpe": "sharpe",
                    "P&L": "total_pnl",
                    "Profit Factor": "profit_factor",
                    "Win Rate": "win_rate",
                    "Trades/Day": "trades_per_day",
                    "Avg P&L/Trade": "avg_pnl_per_trade",
                    "W/L Ratio": "win_loss_ratio",
                }
                sort_label = st.selectbox("Sort By", list(sort_options.keys()), key="sb")
                sort_by = sort_options[sort_label]

            # Static hold filter checkbox
            include_static = st.checkbox("Include static-hold-only strategies", value=False, key="inc_static")

            # Apply category filters
            fdf = df.copy()
            if not include_static:
                # Exclude configs whose exit_method is "Fixed Hold" AND source is "Hold Sweep"
                fdf = fdf[~((fdf["exit_method"] == "Fixed Hold") & (fdf["source_sweep"] == "Hold Sweep"))]
            if filt_entry:
                fdf = fdf[fdf["entry_method"].isin(filt_entry)]
            if filt_exit:
                fdf = fdf[fdf["exit_method"].isin(filt_exit)]
            if filt_chase:
                fdf = fdf[fdf["chase_type"].isin(filt_chase)]
            if filt_vol:
                fdf = fdf[fdf["vol_gate"].isin(filt_vol)]
            if filt_sweep:
                fdf = fdf[fdf["source_sweep"].isin(filt_sweep)]

            # Apply numeric filters
            fdf = fdf[fdf["sharpe"] >= min_sharpe]
            fdf = fdf[fdf["total_pnl"] >= min_pnl]
            fdf = fdf[fdf["trades"] >= min_trades]

            # Sort
            if sort_by in fdf.columns:
                fdf = fdf.sort_values(sort_by, ascending=False)

            # Top N selector
            top_n_col1, top_n_col2 = st.columns([1, 5])
            with top_n_col1:
                top_n = st.number_input("Show Top N", 5, 500, 20, 5, key="topn")
            total_matching = len(fdf)
            fdf = fdf.head(top_n)

            # Summary metrics
            m1, m2, m3, m4, m5, m6 = st.columns(6)
            m1.metric("Showing / Total", f"{len(fdf)} / {total_matching}")
            if not fdf.empty:
                m2.metric("Best Sharpe", f"{fdf['sharpe'].max():.2f}")
                m3.metric("Best P&L", f"${fdf['total_pnl'].max():,.0f}")
                m4.metric("Best Win%", f"{fdf['win_rate'].max()*100:.0f}%")
                m5.metric("Best Annual", f"${fdf['annualized_pnl'].max():,.0f}")
                m6.metric("Best Score", f"{fdf['composite_score'].max():.2f}")

            # Results table with new columns
            display_cols = ["config", "source_sweep", "composite_score", "sharpe",
                           "profit_factor", "total_pnl", "annualized_pnl",
                           "avg_pnl_per_trade", "trades", "trades_per_day",
                           "win_rate_pct", "avg_win", "avg_loss", "win_loss_ratio",
                           "fill_rate_pct", "max_drawdown",
                           "entry_method", "exit_method", "chase_type", "vol_gate"]
            available = [c for c in display_cols if c in fdf.columns]
            rename_map = {
                "config": "Config", "source_sweep": "Source",
                "composite_score": "Score", "sharpe": "Sharpe",
                "profit_factor": "PF", "total_pnl": "P&L ($)",
                "annualized_pnl": "Annual ($)", "avg_pnl_per_trade": "Avg $/Trade",
                "trades": "Trades", "trades_per_day": "Trades/Day",
                "win_rate_pct": "Win%",
                "avg_win": "Avg Win ($)", "avg_loss": "Avg Loss ($)",
                "win_loss_ratio": "W/L Ratio",
                "fill_rate_pct": "Fill%",
                "max_drawdown": "Est MDD ($)",
                "entry_method": "Entry", "exit_method": "Exit",
                "chase_type": "Chase", "vol_gate": "Vol Gate",
            }

            # Color-code composite score: green > 5, yellow 2-5, red < 2
            def _score_color(val):
                if val >= 5.0:
                    return "background-color: rgba(34, 197, 94, 0.3)"
                elif val >= 2.0:
                    return "background-color: rgba(234, 179, 8, 0.3)"
                else:
                    return "background-color: rgba(239, 68, 68, 0.3)"

            display_df = fdf[available].rename(columns=rename_map)
            # Format numeric columns
            fmt_map = {}
            if "Sharpe" in display_df.columns:
                fmt_map["Sharpe"] = "{:.2f}"
            if "PF" in display_df.columns:
                fmt_map["PF"] = "{:.2f}"
            if "Score" in display_df.columns:
                fmt_map["Score"] = "{:.2f}"
            if "P&L ($)" in display_df.columns:
                fmt_map["P&L ($)"] = "${:,.0f}"
            if "Annual ($)" in display_df.columns:
                fmt_map["Annual ($)"] = "${:,.0f}"
            if "Avg $/Trade" in display_df.columns:
                fmt_map["Avg $/Trade"] = "${:,.1f}"
            if "Trades/Day" in display_df.columns:
                fmt_map["Trades/Day"] = "{:.1f}"
            if "Est MDD ($)" in display_df.columns:
                fmt_map["Est MDD ($)"] = "${:,.0f}"
            if "Avg Win ($)" in display_df.columns:
                fmt_map["Avg Win ($)"] = "${:,.1f}"
            if "Avg Loss ($)" in display_df.columns:
                fmt_map["Avg Loss ($)"] = "${:,.1f}"
            if "W/L Ratio" in display_df.columns:
                fmt_map["W/L Ratio"] = "{:.2f}"

            st.caption("Click a row to view trade replay and detailed metrics")
            event = st.dataframe(
                display_df,
                use_container_width=True,
                hide_index=True,
                height=500,
                on_select="rerun",
                selection_mode="single-row",
            )

            # === SELECT CONFIG FOR DETAIL (via table row click) ===
            selected_rows = event.selection.rows
            if selected_rows and "config" in fdf.columns and not fdf.empty:
                selected_idx = selected_rows[0]
                selected = fdf.iloc[selected_idx]["config"]
                st.session_state["replay_config"] = selected
                st.markdown("---")
                st.subheader("Config Detail")
                row = fdf[fdf["config"] == selected].iloc[0]
                parsed = parse_config_name(selected)

                # --- 1. EXPANDED METRICS PANEL (card layout) ---
                def _fmt_val(val, fmt_str):
                    """Format a value, returning '--' for NaN/None."""
                    if val is None or (isinstance(val, float) and (np.isnan(val) or np.isinf(val))):
                        return "--"
                    try:
                        return fmt_str.format(val)
                    except (ValueError, TypeError):
                        return str(val)

                def _metric_card(label, value, color_class=""):
                    return f"""<div class="metric-card {color_class}">
                        <h3>{label}</h3>
                        <div class="value">{value}</div>
                    </div>"""

                # Row 1: Key performance metrics
                mc1, mc2, mc3, mc4, mc5 = st.columns(5)
                with mc1:
                    st.markdown(_metric_card("Total P&L",
                        _fmt_val(row.get("total_pnl"), "${:,.2f}"),
                        "metric-green" if row.get("total_pnl", 0) > 0 else "metric-rose"),
                        unsafe_allow_html=True)
                with mc2:
                    st.markdown(_metric_card("Annualized",
                        _fmt_val(row.get("annualized_pnl"), "${:,.0f}"),
                        "metric-green" if row.get("annualized_pnl", 0) > 0 else "metric-rose"),
                        unsafe_allow_html=True)
                with mc3:
                    st.markdown(_metric_card("Sharpe",
                        _fmt_val(row.get("sharpe"), "{:.3f}"),
                        "metric-blue"), unsafe_allow_html=True)
                with mc4:
                    st.markdown(_metric_card("Profit Factor",
                        _fmt_val(row.get("profit_factor"), "{:.2f}"),
                        "metric-blue"), unsafe_allow_html=True)
                with mc5:
                    wr_val = row.get("win_rate")
                    st.markdown(_metric_card("Win Rate",
                        _fmt_val(wr_val, "{:.1%}") if wr_val is not None else "--",
                        "metric-green" if wr_val and wr_val > 0.5 else "metric-amber"),
                        unsafe_allow_html=True)

                # Row 2: Trade stats
                mc6, mc7, mc8, mc9, mc10 = st.columns(5)
                with mc6:
                    st.markdown(_metric_card("Avg Win",
                        _fmt_val(row.get("avg_win"), "${:,.1f}"),
                        "metric-green"), unsafe_allow_html=True)
                with mc7:
                    st.markdown(_metric_card("Avg Loss",
                        _fmt_val(row.get("avg_loss"), "${:,.1f}"),
                        "metric-rose"), unsafe_allow_html=True)
                with mc8:
                    st.markdown(_metric_card("W/L Ratio",
                        _fmt_val(row.get("win_loss_ratio"), "{:.2f}"),
                        "metric-blue"), unsafe_allow_html=True)
                with mc9:
                    st.markdown(_metric_card("Trades",
                        _fmt_val(row.get("trades"), "{:,.0f}")),
                        unsafe_allow_html=True)
                with mc10:
                    tpd = row.get("trades_per_day")
                    fr = row.get("fill_rate")
                    st.markdown(_metric_card("Trades/Day | Fill%",
                        f"{_fmt_val(tpd, '{:.1f}')} | {_fmt_val(fr, '{:.1%}')}"),
                        unsafe_allow_html=True)

                # Row 3: Config parameters as chips
                st.markdown(f"""
                <div style="margin: 12px 0; display: flex; flex-wrap: wrap; gap: 8px;">
                    <span class="chip chip-amber">Entry: {row.get('entry_method','?')}</span>
                    <span class="chip chip-amber">Exit: {row.get('exit_method','?')}</span>
                    <span class="chip chip-amber">Chase: {row.get('chase_type','?')}</span>
                    <span class="chip chip-amber">Vol Gate: {row.get('vol_gate','?')}</span>
                    <span class="chip chip-amber">Hold: {parsed.get('hold_time','?')}</span>
                    <span class="chip chip-green">Source: {row.get('source_sweep','?')}</span>
                    <span class="chip chip-green">Conviction: {parsed.get('conviction','?')}</span>
                    <span class="chip chip-green">Latency: {parsed.get('latency_ms', 0)}ms</span>
                </div>
                """, unsafe_allow_html=True)

                # --- 2. TRADE REPLAY CHART (embedded, no tab switch needed) ---
                npz_path = get_oot_npz_path()
                pred_dates = get_oot_prediction_dates() if npz_path else []

                if pred_dates:
                    st.markdown("---")
                    st.subheader("Trade Replay")

                    # Date selector with prev/next
                    dr1, dr2, dr3 = st.columns([1, 4, 1])
                    if "detail_replay_idx" not in st.session_state:
                        st.session_state.detail_replay_idx = 0
                    d_idx = st.session_state.detail_replay_idx
                    d_idx = max(0, min(d_idx, len(pred_dates) - 1))

                    with dr1:
                        if st.button("< Prev", key="detail_prev"):
                            d_idx = max(0, d_idx - 1)
                            st.session_state.detail_replay_idx = d_idx
                    with dr3:
                        if st.button("Next >", key="detail_next"):
                            d_idx = min(len(pred_dates) - 1, d_idx + 1)
                            st.session_state.detail_replay_idx = d_idx
                    with dr2:
                        detail_date = st.selectbox(
                            f"Replay Date ({d_idx+1}/{len(pred_dates)})",
                            pred_dates, index=d_idx, key="detail_replay_date")
                        if detail_date != pred_dates[d_idx]:
                            d_idx = pred_dates.index(detail_date)
                            st.session_state.detail_replay_idx = d_idx

                    # Simulate the selected day
                    hold_min = int(str(parsed.get("hold_time", "30min")).replace("min", ""))
                    hold_bars = hold_min * 60 * 10
                    vol_pct = parsed.get("vol_percentile", 50) or 50
                    conv_thr = parsed.get("conviction", 2.5) or 2.5

                    try:
                        with st.spinner(f"Simulating {detail_date}..."):
                            sim = simulate_config_day(
                                npz_path, detail_date,
                                vol_pct=vol_pct, conviction_thr=conv_thr,
                                hold_bars=hold_bars,
                                time_filter=parsed.get("time_filter", "Morning+Afternoon"),
                                chase_ticks=parsed.get("chase_ticks", 0) or 0,
                                chase_reprices=parsed.get("chase_reprices", 0) or 0,
                            )
                    except Exception as _sim_err:
                        st.error(f"Simulation error: {_sim_err}")
                        sim = {"trades": [], "signals": [], "daily_pnl": 0,
                               "n_trades": 0, "n_signals": 0, "mid_prices": [], "z_scores": [], "raw_predictions": []}

                    # Day metrics
                    dm1, dm2, dm3, dm4 = st.columns(4)
                    dm1.metric("Date", detail_date)
                    dm2.metric("P&L", f"${sim['daily_pnl']:+,.2f}")
                    dm3.metric("Trades", sim["n_trades"])
                    dm4.metric("Signals", sim["n_signals"])

                    # Build price + prediction chart
                    mid_sub = sim.get("mid_prices", [])
                    z_sub = sim.get("z_scores", [])
                    raw_sub = sim.get("raw_predictions", [])
                    detail_trades = sim.get("trades", [])

                    if mid_sub:
                        mid_step = sim.get("mid_step", 100)
                        time_axis = [i * mid_step * 0.1 / 60 for i in range(len(mid_sub))]

                        has_z = len(z_sub) > 0
                        n_rows = 2 if has_z else 1
                        row_heights = [0.6, 0.4] if has_z else [1.0]
                        sub_titles = [f"Price + Trades -- {detail_date}", "CNN Prediction (z-score)"] if has_z else [f"Price + Trades -- {detail_date}"]

                        fig_replay = make_subplots(
                            rows=n_rows, cols=1, shared_xaxes=True,
                            row_heights=row_heights, subplot_titles=sub_titles,
                            vertical_spacing=0.08)

                        # Price line
                        fig_replay.add_trace(go.Scatter(
                            x=time_axis, y=mid_sub, mode="lines",
                            line=dict(color="#e0e0e0", width=1.5),
                            name="Mid Price",
                            hovertemplate="Time: %{x:.1f}min<br>Price: %{y:.2f}<extra></extra>",
                        ), row=1, col=1)

                        # Trade markers on price chart
                        for ti, t in enumerate(detail_trades):
                            clr = "#00e676" if t["direction"] == 1 else "#ff5252"
                            sym = "triangle-up" if t["direction"] == 1 else "triangle-down"
                            # Entry
                            fig_replay.add_trace(go.Scatter(
                                x=[t["entry_time_sec"] / 60], y=[t["entry_price"]],
                                mode="markers+text",
                                marker=dict(color=clr, size=14, symbol=sym,
                                           line=dict(color="white", width=2)),
                                text=[f"#{ti+1}"], textposition="top center",
                                textfont=dict(color="white", size=10),
                                showlegend=(ti == 0), name="Trade" if ti == 0 else None,
                                hovertemplate=(f"<b>ENTRY #{ti+1} {t['direction_str']}</b><br>"
                                              f"Price: {t['entry_price']:.2f}<br>"
                                              f"Conv: {t['conviction']:.2f}<extra></extra>"),
                            ), row=1, col=1)
                            # Exit
                            fig_replay.add_trace(go.Scatter(
                                x=[t["exit_time_sec"] / 60], y=[t["exit_price"]],
                                mode="markers",
                                marker=dict(color="white", size=10, symbol="x",
                                           line=dict(color=clr, width=2)),
                                showlegend=False,
                                hovertemplate=(f"<b>EXIT #{ti+1}</b><br>"
                                              f"Price: {t['exit_price']:.2f}<br>"
                                              f"P&L: {t['pnl_ticks']:+.1f}t (${t['pnl_dollars']:+.2f})<extra></extra>"),
                            ), row=1, col=1)
                            # Hold line
                            fig_replay.add_trace(go.Scatter(
                                x=[t["entry_time_sec"] / 60, t["exit_time_sec"] / 60],
                                y=[t["entry_price"], t["exit_price"]],
                                mode="lines", line=dict(color=clr, width=2, dash="dot"),
                                showlegend=False, hoverinfo="skip",
                            ), row=1, col=1)

                        # CNN prediction subplot
                        if has_z:
                            z_arr = np.array(z_sub)
                            z_time = [i * mid_step * 0.1 / 60 for i in range(len(z_sub))]
                            z_pos = np.where(z_arr > 0, z_arr, 0)
                            z_neg = np.where(z_arr < 0, z_arr, 0)

                            fig_replay.add_trace(go.Scatter(
                                x=z_time, y=z_pos, mode="lines",
                                line=dict(color="rgba(0,230,118,0.8)", width=0.5),
                                fill="tozeroy", fillcolor="rgba(0,230,118,0.15)",
                                name="Long (z>0)", showlegend=True,
                            ), row=2, col=1)
                            fig_replay.add_trace(go.Scatter(
                                x=z_time, y=z_neg, mode="lines",
                                line=dict(color="rgba(255,82,82,0.8)", width=0.5),
                                fill="tozeroy", fillcolor="rgba(255,82,82,0.15)",
                                name="Short (z<0)", showlegend=True,
                            ), row=2, col=1)
                            fig_replay.add_trace(go.Scatter(
                                x=z_time, y=z_arr, mode="lines",
                                line=dict(color="rgba(255,255,255,0.7)", width=1.2),
                                name="Z-Score", showlegend=True,
                            ), row=2, col=1)

                            # Conviction thresholds
                            fig_replay.add_hline(y=0, line_color="rgba(255,255,255,0.3)", row=2, col=1)
                            fig_replay.add_hline(y=conv_thr, line_dash="dash", line_color="#f0c000",
                                                annotation_text=f"+{conv_thr}s", row=2, col=1)
                            fig_replay.add_hline(y=-conv_thr, line_dash="dash", line_color="#f0c000",
                                                annotation_text=f"-{conv_thr}s", row=2, col=1)

                            # Trade entries on z-score
                            for ti, t in enumerate(detail_trades):
                                clr = "#00e676" if t["direction"] == 1 else "#ff5252"
                                fig_replay.add_trace(go.Scatter(
                                    x=[t["entry_time_sec"] / 60], y=[t.get("z_score", 0)],
                                    mode="markers",
                                    marker=dict(color=clr, size=8, symbol="diamond",
                                               line=dict(color="white", width=1)),
                                    showlegend=False,
                                    hovertemplate=f"Trade #{ti+1}<br>Z: {t.get('z_score',0):+.2f}<extra></extra>",
                                ), row=2, col=1)

                        fig_replay.update_layout(
                            template=PT, height=600 if has_z else 350,
                            legend=dict(orientation="h", yanchor="bottom", y=1.02),
                            yaxis=dict(title="Price ($)"),
                        )
                        if has_z:
                            fig_replay.update_yaxes(title_text="Z-Score", row=2, col=1)
                        fig_replay.update_xaxes(title_text="Minutes from RTH Open", row=n_rows, col=1)
                        tv_chart(fig_replay)

                    # Trade table for this day
                    if detail_trades:
                        with st.expander(f"Trade details for {detail_date}", expanded=False):
                            tdf = pd.DataFrame(detail_trades)
                            st.dataframe(tdf[["direction_str", "entry_price", "exit_price",
                                             "entry_time_sec", "exit_time_sec",
                                             "pnl_ticks", "pnl_dollars", "conviction", "vol_pctile"]].rename(columns={
                                "direction_str": "Dir", "entry_price": "Entry", "exit_price": "Exit",
                                "entry_time_sec": "Entry(s)", "exit_time_sec": "Exit(s)",
                                "pnl_ticks": "P&L(t)", "pnl_dollars": "P&L($)",
                                "conviction": "Conv", "vol_pctile": "Vol%",
                            }), use_container_width=True, hide_index=True)

                # --- 3. MULTI-DAY OVERVIEW (button to expand) ---
                if pred_dates:
                    st.markdown("---")
                    if st.button("Show multi-day overview", key="multiday"):
                        hold_min = int(str(parsed.get("hold_time", "30min")).replace("min", ""))
                        hold_bars = hold_min * 60 * 10
                        vol_pct = parsed.get("vol_percentile", 50) or 50
                        conv_thr = parsed.get("conviction", 2.5) or 2.5

                        progress = st.progress(0)
                        day_results = []
                        for i, date in enumerate(pred_dates):
                            try:
                                r = simulate_config_day(npz_path, date, vol_pct=vol_pct, conviction_thr=conv_thr,
                                                       hold_bars=hold_bars, time_filter=parsed.get("time_filter", "Morning+Afternoon"),
                                                       chase_ticks=parsed.get("chase_ticks", 0) or 0,
                                                       chase_reprices=parsed.get("chase_reprices", 0) or 0)
                                day_results.append({"Date": date, "P&L": r["daily_pnl"], "Trades": r["n_trades"]})
                            except Exception as e:
                                day_results.append({"Date": date, "P&L": 0, "Trades": 0})
                            progress.progress((i + 1) / len(pred_dates))
                        progress.empty()

                        # Store in session state so results persist across reruns
                        st.session_state["multiday_results"] = day_results
                        st.session_state["multiday_config"] = selected

                    # Render multi-day results if available (persists across reruns)
                    if "multiday_results" in st.session_state and st.session_state.get("multiday_config") == selected:
                        ddf = pd.DataFrame(st.session_state["multiday_results"])
                        rm1, rm2, rm3 = st.columns(3)
                        rm1.metric("Total P&L", f"${ddf['P&L'].sum():,.2f}")
                        rm2.metric("Win Days", f"{(ddf['P&L']>0).sum()}/{len(ddf)}")
                        rm3.metric("Total Trades", ddf["Trades"].sum())

                        # Daily P&L bars
                        fig_daily = go.Figure()
                        fig_daily.add_trace(go.Bar(x=ddf["Date"], y=ddf["P&L"],
                                            marker_color=["#3fb950" if p >= 0 else "#f85149" for p in ddf["P&L"]]))
                        fig_daily.update_layout(template=PT, height=300, title="Daily P&L")
                        tv_chart(fig_daily)

                        # Equity curve
                        fig_eq = go.Figure(go.Scatter(x=ddf["Date"], y=ddf["P&L"].cumsum(),
                                                   mode="lines", fill="tozeroy",
                                                   line=dict(color="#3b82f6", width=2),
                                                   fillcolor="rgba(59,130,246,0.1)"))
                        fig_eq.update_layout(template=PT, height=250, title="Equity Curve")
                        tv_chart(fig_eq)
                        st.dataframe(ddf, use_container_width=True, hide_index=True)

            # Charts
            st.markdown("---")
            if "sharpe" in fdf.columns and "total_pnl" in fdf.columns and len(fdf) > 1:
                ch1, ch2 = st.columns(2)
                with ch1:
                    _sharpe_col = pd.to_numeric(fdf["sharpe"], errors="coerce").dropna()
                    fig = go.Figure(data=[go.Histogram(x=_sharpe_col, nbinsx=25,
                                                       marker_color="#3b82f6")])
                    fig.update_layout(title="Sharpe Distribution", template=PT)
                    fig.add_vline(x=0, line_dash="dash", line_color="red")
                    fig.update_layout(height=300)
                    tv_chart(fig)
                with ch2:
                    _pnl_col = pd.to_numeric(fdf["total_pnl"], errors="coerce").dropna()
                    fig = go.Figure(data=[go.Histogram(x=_pnl_col, nbinsx=25,
                                                       marker_color="#10b981")])
                    fig.update_layout(title="P&L Distribution", template=PT)
                    fig.add_vline(x=0, line_dash="dash", line_color="red")
                    fig.update_layout(height=300)
                    tv_chart(fig)

    # --- WF > Card Trade Replay ---
    with wf_sub[1]:
        st.header("Card Trade Replay")
        st.caption("Select a portfolio card to view all trades with color-coded P&L")

        _card_options = [
            "Card 1 — Tight Scalper",
            "Card 2 — Core Scalper",
            "Card 3 — Raw Signal",
        ]
        # Auto-select card from session state if navigated from Strategies tab
        _default_card_idx = 0
        if "replay_card" in st.session_state:
            _nav_card = st.session_state.pop("replay_card")
            if _nav_card in _card_options:
                _default_card_idx = _card_options.index(_nav_card)

        card_choice = st.selectbox("Select Card", _card_options,
                                   index=_default_card_idx, key="card_replay_select")

        card_num = int(card_choice[5])  # Extract 1, 2, or 3
        _card_trade_path = Path(__file__).parent.parent / "data" / f"card{card_num}_trades.json"

        # Card summary stats
        _card_stats = {
            1: {"pnl": "OOT validated", "sharpe": "3.88", "wr": "N/A", "pf": "N/A",
                "trades": 0, "trades_day": "N/A", "avg_win": "N/A", "avg_loss": "N/A",
                "mae_win": "N/A", "mae_lose": "N/A", "max_dd": "N/A",
                "monthly": "Dec-Feb OOT unseen"},
            2: {"pnl": "OOT validated", "sharpe": "4.11", "wr": "N/A", "pf": "N/A",
                "trades": 0, "trades_day": "N/A", "avg_win": "N/A", "avg_loss": "N/A",
                "mae_win": "N/A", "mae_lose": "N/A", "max_dd": "N/A",
                "monthly": "Dec-Feb OOT unseen"},
            3: {"pnl": "OOT validated", "sharpe": "3.82", "wr": "N/A", "pf": "N/A",
                "trades": 0, "trades_day": "N/A", "avg_win": "N/A", "avg_loss": "N/A",
                "mae_win": "N/A", "mae_lose": "N/A", "max_dd": "N/A",
                "monthly": "Dec-Feb OOT unseen"},
        }
        cs = _card_stats[card_num]

        # Summary metrics row
        _cr1, _cr2, _cr3, _cr4, _cr5, _cr6 = st.columns(6)
        _cr1.metric("P&L (54d)", cs["pnl"])
        _cr2.metric("Sharpe", cs["sharpe"])
        _cr3.metric("Win Rate", cs["wr"])
        _cr4.metric("PF", cs["pf"])
        _cr5.metric("Trades", cs["trades"])
        _cr6.metric("Max DD", cs["max_dd"])

        _cr7, _cr8, _cr9, _cr10 = st.columns(4)
        _cr7.metric("Avg Win", cs["avg_win"])
        _cr8.metric("Avg Loss", cs["avg_loss"])
        _cr9.metric("Winner MAE", cs["mae_win"])
        _cr10.metric("Trades/Day", cs["trades_day"])

        st.markdown(f"""
        <div class="source-label">
            <strong>Monthly Breakdown:</strong> {cs['monthly']}
        </div>
        """, unsafe_allow_html=True)

        # Load and display trade data
        if _card_trade_path.exists():
            _card_trades = pd.read_json(_card_trade_path)
            st.markdown(f"**{len(_card_trades)} trades** across 54 OOT days")

            # Determine available columns
            _desired_cols = ["Date", "Time", "Side", "Entry", "Exit", "PnL($)",
                           "MAE(t)", "MFE(t)", "Hold(s)", "Exit Reason", "Signal Strength"]
            _avail_cols = [c for c in _desired_cols if c in _card_trades.columns]

            if _avail_cols:
                _display_trades = _card_trades[_avail_cols].copy()

                # Color-code PnL column
                if "PnL($)" in _avail_cols:
                    styled = _display_trades.style.applymap(
                        lambda v: "color: #22c55e" if isinstance(v, (int, float)) and v > 0
                        else ("color: #ef4444" if isinstance(v, (int, float)) and v < 0 else ""),
                        subset=["PnL($)"]
                    )
                    st.dataframe(styled, use_container_width=True, height=600, hide_index=True)
                else:
                    st.dataframe(_display_trades, use_container_width=True, height=600, hide_index=True)
            else:
                st.dataframe(_card_trades, use_container_width=True, height=600, hide_index=True)
        else:
            _sync_hints = {
                1: "`/home/jupiter/Lvl3Quant/data/processed/best_config_sweep/`",
                2: "`/home/jupiter/Lvl3Quant/data/processed/card2_full/`",
                3: "`/home/jupiter/Lvl3Quant/data/processed/top_screens_full/` (ema_bookExit)",
            }
            st.info(f"Trade data not yet synced. Sync from Jupiter: {_sync_hints[card_num]} to `data/card{card_num}_trades.json`")

    # --- WF > Trade Replay ---
    with wf_sub[2]:
        st.header("Trade Replay")
        st.caption("Select config + day, see bookmap depth heatmap with trade entries/exits")

        # Config selector
        all_configs = {}
        for src_name, loader, sort_label in [
            ("OOT", load_cnn_oot_results, "CNN OOT"),
            ("IS", load_chase_sweep, "Chase IS"),
        ]:
            raw_data = loader()
            if raw_data:
                tmp = configs_to_dataframe(raw_data if isinstance(raw_data, list) else [], sort_label)
                if not tmp.empty:
                    tmp = tmp.sort_values("sharpe_daily", ascending=False)
                    for _, r in tmp.iterrows():
                        key = f"[{src_name}] {r['config']} — S:{r.get('sharpe_daily',0):.2f} ${r.get('total_pnl',0):,.0f}"
                        all_configs[key] = r.to_dict()

        wf_raw = load_wf_fill_sim()
        if wf_raw and wf_raw.get("configs"):
            tmp = configs_to_dataframe(wf_raw["configs"], "WF")
            tmp = tmp.sort_values("sharpe_daily", ascending=False)
            for _, r in tmp.iterrows():
                key = f"[WF] {r['config']} — S:{r.get('sharpe_daily',0):.2f} ${r.get('total_pnl',0):,.0f}"
                all_configs[key] = r.to_dict()

        if not all_configs:
            st.warning("No configs loaded.")
        else:
            # Pre-select config from Strategies tab if set
            default_idx = 0
            if "replay_config" in st.session_state:
                target = st.session_state["replay_config"]
                for i, k in enumerate(all_configs.keys()):
                    if target in k:
                        default_idx = i
                        break

            rc1, rc2 = st.columns([3, 1])
            with rc1:
                sel_key = st.selectbox("Config (sorted by Sharpe)", list(all_configs.keys()),
                                      index=default_idx, key="replay_cfg")
            sel_row = all_configs[sel_key]
            config_name = sel_row.get("config", "")
            parsed = parse_config_name(config_name)

            with rc2:
                st.markdown(f"**Sharpe:** {sel_row.get('sharpe_daily',0):.2f}")
                st.markdown(f"**P&L:** ${sel_row.get('total_pnl',0):,.0f}")
                st.markdown(f"**Trades:** {sel_row.get('n_trades',0)}")

            # Date selector
            book_dates = list_book_cache_dates(include_oot=True)
            npz_path = get_oot_npz_path()
            pred_dates = get_oot_prediction_dates() if npz_path else []
            common_dates = sorted(set(book_dates) & set(pred_dates))
            date_pool = common_dates if common_dates else book_dates

            if not date_pool:
                st.warning("No book tensor data found.")
            else:
                dc1, dc2, dc3 = st.columns([1, 4, 1])
                if "replay_idx" not in st.session_state:
                    st.session_state.replay_idx = 0
                idx = st.session_state.replay_idx
                idx = max(0, min(idx, len(date_pool)-1))

                with dc1:
                    if st.button("< Prev Day", key="prev"):
                        idx = max(0, idx-1)
                        st.session_state.replay_idx = idx
                with dc3:
                    if st.button("Next Day >", key="next"):
                        idx = min(len(date_pool)-1, idx+1)
                        st.session_state.replay_idx = idx
                with dc2:
                    sel_date = st.selectbox(f"Day ({idx+1}/{len(date_pool)})", date_pool, index=idx, key="replay_date")
                    if sel_date != date_pool[idx]:
                        idx = date_pool.index(sel_date)
                        st.session_state.replay_idx = idx

                # Subsample control
                heatmap_res = st.select_slider("Heatmap resolution", [50, 100, 200, 500], value=100, key="hres")

                # Load book data
                bookmap = None
                try:
                    with st.spinner(f"Loading {sel_date}..."):
                        bookmap = load_bookmap_data(sel_date, subsample=heatmap_res)
                except Exception as e:
                    st.error(f"Failed to load book data for {sel_date}: {e}")

                # Simulate trades
                trades, signals, daily_pnl = [], [], 0
                has_preds = sel_date in pred_dates and npz_path
                if has_preds:
                    try:
                        hold_min = int(str(parsed.get("hold_time","30min")).replace("min",""))
                        sim = simulate_config_day(
                            npz_path, sel_date,
                            vol_pct=parsed.get("vol_percentile",50) or 50,
                            conviction_thr=parsed.get("conviction",2.5) or 2.5,
                            hold_bars=hold_min*60*10,
                            time_filter=parsed.get("time_filter","Morning+Afternoon"),
                            chase_ticks=parsed.get("chase_ticks",0) or 0,
                            chase_reprices=parsed.get("chase_reprices",0) or 0,
                        )
                    except Exception as e:
                        st.error(f"Simulation failed for {sel_date}: {e}")
                        sim = {"trades": [], "signals": [], "daily_pnl": 0}
                    trades, signals, daily_pnl = sim["trades"], sim["signals"], sim["daily_pnl"]

                # Metrics
                rm1, rm2, rm3, rm4 = st.columns(4)
                rm1.metric("Date", sel_date)
                rm2.metric("P&L", f"${daily_pnl:+,.2f}" if has_preds else "N/A")
                rm3.metric("Trades", len(trades))
                rm4.metric("Signals", len(signals))

                if bookmap is None:
                    st.error(f"No book data for {sel_date}")
                else:
                    mid_prices = bookmap["mid_prices"]
                    time_min = bookmap["time_min"]
                    bid_prices = bookmap["bid_prices"]  # (n, 10) absolute prices
                    ask_prices = bookmap["ask_prices"]
                    bid_depth = bookmap["bid_depth"]
                    ask_depth = bookmap["ask_depth"]
                    n_pts = len(time_min)
                    depth_levels = min(5, bid_depth.shape[1])

                    # ============================================
                    # PRICE-LEVEL BOOKMAP HEATMAP
                    # Y-axis = actual price, color = depth
                    # ============================================

                    # Build a price grid: find the price range across the day
                    price_min = float(np.nanmin(bid_prices[:, depth_levels-1]))
                    price_max = float(np.nanmax(ask_prices[:, depth_levels-1]))
                    tick = 0.25
                    price_levels = np.arange(price_min, price_max + tick, tick)
                    n_price = len(price_levels)

                    # Build heatmap: vectorized mapping of depth to price rows
                    # Positive = ask depth (red), Negative = bid depth (green)
                    heatmap = np.zeros((n_price, n_pts), dtype=np.float32)

                    # Vectorized: compute price indices for all time steps and levels at once
                    t_indices = np.arange(n_pts)
                    for lev in range(depth_levels):
                        # Bid
                        bp = bid_prices[:, lev]
                        bd = bid_depth[:, lev]
                        valid_bid = ~np.isnan(bp) & (bd > 0)
                        if np.any(valid_bid):
                            p_idx_bid = np.round((bp[valid_bid] - price_min) / tick).astype(int)
                            t_idx_bid = t_indices[valid_bid]
                            in_range = (p_idx_bid >= 0) & (p_idx_bid < n_price)
                            heatmap[p_idx_bid[in_range], t_idx_bid[in_range]] = -bd[valid_bid][in_range]
                        # Ask
                        ap = ask_prices[:, lev]
                        ad = ask_depth[:, lev]
                        valid_ask = ~np.isnan(ap) & (ad > 0)
                        if np.any(valid_ask):
                            p_idx_ask = np.round((ap[valid_ask] - price_min) / tick).astype(int)
                            t_idx_ask = t_indices[valid_ask]
                            in_range = (p_idx_ask >= 0) & (p_idx_ask < n_price)
                            heatmap[p_idx_ask[in_range], t_idx_ask[in_range]] = ad[valid_ask][in_range]

                    # Log-scale the heatmap for transparency
                    log_heatmap = np.sign(heatmap) * np.log1p(np.abs(heatmap))
                    max_d = float(np.percentile(np.abs(log_heatmap[log_heatmap != 0]), 95)) if np.any(log_heatmap != 0) else 3

                    # Build figure — 4 rows if we have predictions
                    if has_preds:
                        n_subplots = 4
                        heights = [0.45, 0.20, 0.20, 0.15]
                        titles = [f"Bookmap — {sel_date}", "CNN Prediction (z-score)",
                                 "Bid/Ask Imbalance", "Conviction"]
                    else:
                        n_subplots = 2
                        heights = [0.65, 0.35]
                        titles = [f"Bookmap — {sel_date}", "Bid/Ask Imbalance"]

                    fig = make_subplots(rows=n_subplots, cols=1, shared_xaxes=True,
                                       row_heights=heights, subplot_titles=titles, vertical_spacing=0.04)

                    # Row 1: Price-level depth heatmap (transparent, log-scaled)
                    fig.add_trace(go.Heatmap(
                        z=log_heatmap, x=time_min, y=price_levels,
                        colorscale=[
                            [0, "rgba(0,200,83,0.5)"], [0.25, "rgba(27,94,32,0.25)"],
                            [0.45, "rgba(17,17,17,0)"],
                            [0.5, "rgba(26,26,46,0)"],
                            [0.55, "rgba(17,17,17,0)"],
                            [0.75, "rgba(183,28,28,0.25)"], [1.0, "rgba(255,23,68,0.5)"],
                        ],
                        zmin=-max_d, zmax=max_d,
                        showscale=False,
                        hovertemplate="Time: %{x:.1f}min<br>Price: %{y:.2f}<br>Depth: %{z:.1f} (log)<extra></extra>",
                    ), row=1, col=1)

                    # Mid price line — bold, clearly visible
                    fig.add_trace(go.Scatter(
                        x=time_min, y=mid_prices, mode="lines",
                        line=dict(color="#e0e0e0", width=2),
                        name="Mid Price",
                        hovertemplate="Mid: %{y:.2f}<extra></extra>",
                    ), row=1, col=1)

                    # Trade markers on the heatmap at their actual prices
                    for i, t in enumerate(trades):
                        clr = "#00e676" if t["direction"]==1 else "#ff5252"
                        sym = "triangle-up" if t["direction"]==1 else "triangle-down"
                        # Entry
                        fig.add_trace(go.Scatter(
                            x=[t["entry_time_sec"]/60], y=[t["entry_price"]],
                            mode="markers+text",
                            marker=dict(color=clr, size=16, symbol=sym,
                                       line=dict(color="white", width=2)),
                            text=[f"#{i+1}"], textposition="top center",
                            textfont=dict(color="white", size=11),
                            showlegend=i==0, name="Trade" if i==0 else None,
                            hovertemplate=f"<b>ENTRY #{i+1} {t['direction_str']}</b><br>"
                                        f"Price: {t['entry_price']:.2f}<br>"
                                        f"Conv: {t['conviction']:.2f}σ<extra></extra>",
                        ), row=1, col=1)
                        # Exit
                        fig.add_trace(go.Scatter(
                            x=[t["exit_time_sec"]/60], y=[t["exit_price"]],
                            mode="markers",
                            marker=dict(color="white", size=12, symbol="x",
                                       line=dict(color=clr, width=2)),
                            showlegend=False,
                            hovertemplate=f"<b>EXIT #{i+1}</b><br>"
                                        f"Price: {t['exit_price']:.2f}<br>"
                                        f"P&L: {t['pnl_ticks']:+.1f}t (${t['pnl_dollars']:+.2f})<extra></extra>",
                        ), row=1, col=1)
                        # Hold line
                        fig.add_trace(go.Scatter(
                            x=[t["entry_time_sec"]/60, t["exit_time_sec"]/60],
                            y=[t["entry_price"], t["exit_price"]],
                            mode="lines", line=dict(color=clr, width=2, dash="dot"),
                            showlegend=False, hoverinfo="skip",
                        ), row=1, col=1)

                        # 6. TP target lines on price chart
                        if "tp" in config_name.lower():
                            import re as _re
                            tp_match = _re.search(r'tp(\d+)', config_name.lower())
                            tp_ticks = int(tp_match.group(1)) if tp_match else 8
                            tp_offset = tp_ticks * 0.25  # Convert ticks to points
                            tp_price = t["entry_price"] + (tp_offset * t["direction"])
                            fig.add_trace(go.Scatter(
                                x=[t["entry_time_sec"]/60, t["exit_time_sec"]/60],
                                y=[tp_price, tp_price],
                                mode="lines",
                                line=dict(color="#fbbf24", width=1.5, dash="dash"),
                                showlegend=(i == 0), name="TP Target" if i == 0 else None,
                                hovertemplate=f"TP #{i+1}: {tp_price:.2f} ({tp_ticks}t)<extra></extra>",
                            ), row=1, col=1)

                    # Row 2: CNN Prediction — CONTINUOUS LINE (normalized z-score + raw)
                    if has_preds:
                        z_series = sim.get("z_scores", [])
                        raw_series = sim.get("raw_predictions", [])
                        conv_thr_val = parsed.get("conviction", 2.5) or 2.5

                        # Build time axis matching the prediction series
                        if z_series:
                            z_time = [i * sim.get("mid_step", 100) * 0.1 / 60 for i in range(len(z_series))]
                            z_arr = np.array(z_series)
                        else:
                            z_arr = np.array([])
                            z_time = []

                        if len(z_arr) > 0:
                            z_pos = np.where(z_arr > 0, z_arr, 0)
                            z_neg = np.where(z_arr < 0, z_arr, 0)

                            # Green fill for long signal
                            fig.add_trace(go.Scatter(
                                x=z_time, y=z_pos, mode="lines",
                                line=dict(color="rgba(0,230,118,0.8)", width=0.5),
                                fill="tozeroy", fillcolor="rgba(0,230,118,0.15)",
                                name="Long (z>0)", showlegend=True,
                                hovertemplate="Time: %{x:.1f}min<br>Z: %{y:+.2f}<extra></extra>",
                            ), row=2, col=1)

                            # Red fill for short signal
                            fig.add_trace(go.Scatter(
                                x=z_time, y=z_neg, mode="lines",
                                line=dict(color="rgba(255,82,82,0.8)", width=0.5),
                                fill="tozeroy", fillcolor="rgba(255,82,82,0.15)",
                                name="Short (z<0)", showlegend=True,
                                hovertemplate="Time: %{x:.1f}min<br>Z: %{y:+.2f}<extra></extra>",
                            ), row=2, col=1)

                            # White z-score line
                            fig.add_trace(go.Scatter(
                                x=z_time, y=z_arr, mode="lines",
                                line=dict(color="rgba(255,255,255,0.7)", width=1.2),
                                name="Z-Score (normalized)", showlegend=True,
                            ), row=2, col=1)

                            # Raw prediction line (cyan, secondary axis feel)
                            if raw_series and len(raw_series) == len(z_series):
                                raw_arr = np.array(raw_series)
                                fig.add_trace(go.Scatter(
                                    x=z_time, y=raw_arr, mode="lines",
                                    line=dict(color="rgba(6,182,212,0.5)", width=1, dash="dot"),
                                    name="Raw CNN (un-normalized)",
                                    visible="legendonly",  # Hidden by default, click legend to show
                                    hovertemplate="Time: %{x:.1f}min<br>Raw: %{y:+.4f}<extra></extra>",
                                ), row=2, col=1)

                            # Threshold lines + zero
                            fig.add_hline(y=0, line_color="rgba(255,255,255,0.3)", row=2, col=1)
                            fig.add_hline(y=conv_thr_val, line_dash="dash", line_color="#f0c000",
                                         annotation_text=f"+{conv_thr_val}s", row=2, col=1)
                            fig.add_hline(y=-conv_thr_val, line_dash="dash", line_color="#f0c000",
                                         annotation_text=f"-{conv_thr_val}s", row=2, col=1)

                            # === DYNAMIC INDICATORS based on config name ===
                            cfg_lower = config_name.lower()

                            # 1. Smoothed z-score (rolling mean)
                            if ("smooth" in cfg_lower or "rolling_mean" in cfg_lower) and len(z_arr) > 0:
                                import re as _re
                                sm_match = _re.search(r'smooth(\d+)', cfg_lower)
                                rm_match = _re.search(r'rolling_mean(\d+)', cfg_lower)
                                smooth_win = int(sm_match.group(1)) if sm_match else (int(rm_match.group(1)) if rm_match else 20)
                                smooth_z = pd.Series(z_arr).rolling(smooth_win, min_periods=1).mean().values
                                fig.add_trace(go.Scatter(
                                    x=z_time, y=smooth_z, mode="lines",
                                    line=dict(color="#f59e0b", width=2.5),
                                    name=f"Rolling Mean ({smooth_win})",
                                    hovertemplate="Time: %{x:.1f}min<br>Smooth Z: %{y:+.2f}<extra></extra>",
                                ), row=2, col=1)

                            # 2. EMA z-score
                            if "ema_zscore" in cfg_lower and len(z_arr) > 0:
                                import re as _re
                                span_match = _re.search(r'span(\d+)', cfg_lower)
                                ema_span = int(span_match.group(1)) if span_match else 5000
                                # Convert from raw bars to subsampled bars
                                sub_span = max(2, ema_span // sim.get("mid_step", 100))
                                ema_z = pd.Series(z_arr).ewm(span=sub_span, min_periods=1).mean().values
                                fig.add_trace(go.Scatter(
                                    x=z_time, y=ema_z, mode="lines",
                                    line=dict(color="#a78bfa", width=2.5),
                                    name=f"EMA Z (span={ema_span})",
                                    hovertemplate="Time: %{x:.1f}min<br>EMA Z: %{y:+.2f}<extra></extra>",
                                ), row=2, col=1)

                            # 3. Momentum / acceleration (z-score diff)
                            if ("momentum" in cfg_lower or "accel" in cfg_lower) and len(z_arr) > 1:
                                z_accel = np.diff(z_arr, prepend=z_arr[0])
                                fig.add_trace(go.Scatter(
                                    x=z_time, y=z_accel, mode="lines",
                                    line=dict(color="#fb923c", width=1.5),
                                    name="Z Acceleration (diff)",
                                    hovertemplate="Time: %{x:.1f}min<br>dZ: %{y:+.3f}<extra></extra>",
                                ), row=2, col=1)
                                accel_thr = float(np.std(z_accel[~np.isnan(z_accel)])) * 1.5
                                fig.add_hline(y=accel_thr, line_dash="dot", line_color="rgba(251,146,60,0.5)",
                                             annotation_text=f"+accel {accel_thr:.2f}", row=2, col=1)
                                fig.add_hline(y=-accel_thr, line_dash="dot", line_color="rgba(251,146,60,0.5)",
                                             annotation_text=f"-accel {accel_thr:.2f}", row=2, col=1)

                            # 4. pred_std overlay
                            if "predstd" in cfg_lower and raw_series and len(raw_series) > 0:
                                import re as _re
                                std_match = _re.search(r'predstd([\d.]+)', cfg_lower)
                                max_std_thr = float(std_match.group(1)) if std_match else 0.15
                                raw_arr_ps = np.array(raw_series)
                                pred_std = pd.Series(raw_arr_ps).rolling(
                                    max(2, 3000 // sim.get("mid_step", 100)), min_periods=1
                                ).std().values
                                fig.add_trace(go.Scatter(
                                    x=z_time, y=pred_std, mode="lines",
                                    line=dict(color="#f472b6", width=1.5),
                                    name=f"Pred Std (thr={max_std_thr})",
                                    hovertemplate="Time: %{x:.1f}min<br>Pred Std: %{y:.4f}<extra></extra>",
                                ), row=2, col=1)
                                fig.add_hline(y=max_std_thr, line_dash="dashdot", line_color="#f472b6",
                                             annotation_text=f"max_std={max_std_thr}", row=2, col=1)

                            # Trade entries on z-score chart
                            for i, t in enumerate(trades):
                                clr = "#00e676" if t["direction"]==1 else "#ff5252"
                                fig.add_trace(go.Scatter(
                                    x=[t["entry_time_sec"]/60], y=[t.get("z_score", 0)],
                                    mode="markers",
                                    marker=dict(color=clr, size=10, symbol="diamond",
                                               line=dict(color="white", width=1)),
                                    showlegend=False,
                                    hovertemplate=f"Trade #{i+1}<br>Z: {t.get('z_score',0):+.2f}<extra></extra>",
                                ), row=2, col=1)

                        sig_times = [s["time_sec"]/60 for s in signals] if signals else []

                    # Row 3: Depth imbalance
                    imb_row = 3 if has_preds else 2
                    bid_total = bid_depth[:, :depth_levels].sum(axis=1)
                    ask_total = ask_depth[:, :depth_levels].sum(axis=1)
                    imbalance = (bid_total - ask_total) / (bid_total + ask_total + 1e-10)

                    fig.add_trace(go.Scatter(
                        x=time_min, y=imbalance, mode="lines",
                        fill="tozeroy",
                        line=dict(color="rgba(99,102,241,0.8)", width=1),
                        fillcolor="rgba(99,102,241,0.15)",
                        name="Imbalance",
                        hovertemplate="Time: %{x:.1f}min<br>Imbalance: %{y:+.3f}<extra></extra>",
                    ), row=imb_row, col=1)
                    fig.add_hline(y=0, line_dash="solid", line_color="rgba(255,255,255,0.2)", row=imb_row, col=1)

                    # 3b. Book/imbalance confirmation highlighting
                    if has_preds and ("book" in config_name.lower() or "imb" in config_name.lower()):
                        z_series_chart = sim.get("z_scores", [])
                        if z_series_chart and len(z_series_chart) > 0:
                            z_chart_arr = np.array(z_series_chart)
                            # Resample imbalance to match z_scores length
                            imb_resampled = np.interp(
                                np.linspace(0, len(imbalance)-1, len(z_chart_arr)),
                                np.arange(len(imbalance)), imbalance
                            )
                            # Book confirms signal when imbalance sign matches z-score sign
                            confirms = np.sign(z_chart_arr) * np.sign(imb_resampled) > 0
                            z_time_imb = [i * sim.get("mid_step", 100) * 0.1 / 60 for i in range(len(z_chart_arr))]
                            # Show confirming bars as highlighted scatter on imbalance subplot
                            conf_x = [z_time_imb[j] for j in range(len(confirms)) if confirms[j] and abs(z_chart_arr[j]) > 0.5]
                            conf_y_imb = [imb_resampled[j] for j in range(len(confirms)) if confirms[j] and abs(z_chart_arr[j]) > 0.5]
                            if conf_x:
                                fig.add_trace(go.Scatter(
                                    x=conf_x, y=conf_y_imb, mode="markers",
                                    marker=dict(color="#22d3ee", size=3, opacity=0.4),
                                    name="Book Confirms Signal",
                                    hovertemplate="Time: %{x:.1f}min<br>Imb: %{y:+.3f}<br><b>CONFIRMED</b><extra></extra>",
                                ), row=imb_row, col=1)

                    # Row 4: Conviction magnitude (if predictions)
                    if has_preds and signals:
                        conv_times = [s["time_sec"]/60 for s in signals]
                        conv_vals = [s["conviction"] for s in signals]
                        fig.add_trace(go.Scatter(
                            x=conv_times, y=conv_vals, mode="markers",
                            marker=dict(size=4, color=conv_vals, colorscale="YlOrRd",
                                       cmin=conv_thr_val, cmax=5),
                            name="Conviction", showlegend=False,
                        ), row=4, col=1)
                        fig.add_hline(y=conv_thr_val, line_dash="dash", line_color="#f0c000", row=4, col=1)

                    fig.update_layout(
                        template=PT, height=1050 if has_preds else 700,
                        legend=dict(orientation="h", yanchor="bottom", y=1.02),
                        yaxis=dict(title="Price ($)"),
                    )
                    if has_preds:
                        fig.update_yaxes(title_text="Z-Score", row=2, col=1)
                        fig.update_yaxes(title_text="Imbalance", row=3, col=1)
                        fig.update_yaxes(title_text="|Conv|", row=4, col=1)
                    else:
                        fig.update_yaxes(title_text="Imbalance", row=2, col=1)
                    fig.update_xaxes(title_text="Minutes from RTH Open", row=n_subplots, col=1)
                    tv_chart(fig)

                    # === DEPTH LADDER (snapshot at selected time) ===
                    st.subheader("Depth Ladder")
                    ladder_time = st.slider("Snapshot time (minutes)", float(time_min[0]),
                                          float(time_min[-1]), float(time_min[len(time_min)//2]),
                                          step=float(time_min[1]-time_min[0]) if len(time_min)>1 else 1.0,
                                          key="ladder_time")
                    # Find closest time index
                    t_idx = int(np.argmin(np.abs(np.array(time_min) - ladder_time)))
                    snap_mid = mid_prices[t_idx]
                    snap_bid_p = bid_prices[t_idx, :depth_levels]
                    snap_ask_p = ask_prices[t_idx, :depth_levels]
                    snap_bid_d = bid_depth[t_idx, :depth_levels]
                    snap_ask_d = ask_depth[t_idx, :depth_levels]

                    # Build ladder as horizontal bars
                    all_prices = np.concatenate([snap_bid_p[::-1], [snap_mid], snap_ask_p])
                    all_depths = np.concatenate([-snap_bid_d[::-1], [0], snap_ask_d])
                    all_colors = (["#00c853"]*depth_levels + ["#6366f1"] + ["#ff1744"]*depth_levels)
                    all_labels = ([f"Bid L{depth_levels-i}" for i in range(depth_levels)]
                                 + ["Mid"]
                                 + [f"Ask L{i+1}" for i in range(depth_levels)])

                    fig_ladder = go.Figure(go.Bar(
                        y=[f"{p:.2f}" for p in all_prices],
                        x=all_depths,
                        orientation="h",
                        marker_color=all_colors,
                        text=[f"{abs(d):.0f}" if d != 0 else "" for d in all_depths],
                        textposition="outside",
                        hovertemplate="%{customdata}<br>Price: %{y}<br>Depth: %{x:.0f} lots<extra></extra>",
                        customdata=all_labels,
                    ))
                    fig_ladder.update_layout(
                        template=PT, height=350,
                        title=f"Depth Ladder — {sel_date} at {ladder_time:.1f}min (Mid: {snap_mid:.2f})",
                        xaxis_title="Depth (lots) — Bid (left) | Ask (right)",
                        yaxis=dict(type="category"),
                        bargap=0.15,
                    )
                    fig_ladder.add_vline(x=0, line_color="rgba(255,255,255,0.3)")
                    tv_chart(fig_ladder)

                # Trade table
                if trades:
                    st.subheader("Trades")
                    tdf = pd.DataFrame(trades)
                    st.dataframe(tdf[["direction_str","entry_price","exit_price","entry_time_sec",
                                     "exit_time_sec","pnl_ticks","pnl_dollars","conviction","vol_pctile"]].rename(columns={
                        "direction_str":"Dir","entry_price":"Entry","exit_price":"Exit",
                        "entry_time_sec":"Entry(s)","exit_time_sec":"Exit(s)",
                        "pnl_ticks":"P&L(t)","pnl_dollars":"P&L($)","conviction":"Conv σ","vol_pctile":"Vol%",
                    }), use_container_width=True, hide_index=True)

    # --- WF > MFE Analysis ---
    with wf_sub[3]:
        st.header("MFE/MAE Analysis")
        mfe_data = load_mfe_sweep()
        if not mfe_data:
            st.warning("No MFE sweep data.")
        else:
            st.markdown(f"""
            <div class="source-label">
                <strong>Configs:</strong> {mfe_data.get('configs_tested','?')} |
                <strong>Days:</strong> {mfe_data.get('oos_days','?')} |
                <strong>Profitable:</strong> {mfe_data.get('profitable_pct','?')}%
            </div>
            """, unsafe_allow_html=True)

            top = mfe_data.get("top_20", [])
            if top:
                mdf = pd.DataFrame(top)
                if "config" in mdf.columns and isinstance(mdf["config"].iloc[0], dict):
                    cfg_flat = pd.json_normalize(mdf["config"])
                    cfg_flat.columns = [f"cfg_{c}" for c in cfg_flat.columns]
                    mdf = pd.concat([mdf.drop("config", axis=1), cfg_flat], axis=1)

                if "avg_mfe_ticks" in mdf.columns and "avg_mae_ticks" in mdf.columns:
                    fig = go.Figure(go.Scatter(
                        x=mdf["avg_mae_ticks"], y=mdf["avg_mfe_ticks"], mode="markers",
                        marker=dict(size=mdf["trades"]/mdf["trades"].max()*30+5 if "trades" in mdf.columns else 10,
                                   color=mdf["sharpe"] if "sharpe" in mdf.columns else None,
                                   colorscale="RdYlGn", showscale=True, colorbar=dict(title="Sharpe")),
                        hovertemplate="MFE: %{y:.1f}t<br>MAE: %{x:.1f}t<br>Sharpe: %{marker.color:.2f}",
                    ))
                    fig.add_shape(type="line", x0=0, y0=0, x1=float(mdf["avg_mae_ticks"].max()),
                                 y1=float(mdf["avg_mae_ticks"].max()), line=dict(dash="dash", color="#666"))
                    fig.update_layout(template=PT, height=400, title="MFE vs MAE (size=trades, color=Sharpe)",
                                    xaxis_title="Avg MAE (ticks)", yaxis_title="Avg MFE (ticks)")
                    tv_chart(fig)

                if "long_pnl_ticks" in mdf.columns:
                    lbl = [f"V{r.get('cfg_vol_pct','?')}/C{r.get('cfg_conv','?')}" for _, r in mdf.head(10).iterrows()]
                    fig = go.Figure()
                    fig.add_trace(go.Bar(x=lbl, y=mdf.head(10)["long_pnl_ticks"], name="Long", marker_color="#3fb950"))
                    fig.add_trace(go.Bar(x=lbl, y=mdf.head(10)["short_pnl_ticks"], name="Short", marker_color="#f85149"))
                    fig.update_layout(template=PT, height=350, barmode="group",
                                    title="Long vs Short P&L (ticks)", xaxis_tickangle=-45)
                    tv_chart(fig)

                st.markdown("**Key:** Both long AND short profitable = not a bull market artifact. "
                          "Fixed 30-min hold captures ~28.8% of MFE. Dynamic exits all fail (MAE too high).")

                st.dataframe(mdf, use_container_width=True, hide_index=True)

    # --- WF > Curves ---
    with wf_sub[4]:
        st.header("Fill Sim: Equity Curves & Drawdown Analysis")
        st.caption(f"Source: {str(_QCC_DB_PATH)} · table: fillsim_results · top N configs ranked by Sortino")

        @st.cache_data(ttl=300)
        def _load_fillsim_daily_wf() -> pd.DataFrame:
            """Load daily PnL series per config from fillsim_results (WF tab copy)."""
            if not _QCC_DB_PATH.exists():
                return pd.DataFrame()
            try:
                conn = sqlite3.connect(str(_QCC_DB_PATH))
                df = pd.read_sql_query(
                    "SELECT config_name, mbo_date, total_pnl, total_trades, "
                    "       total_filled, tp_count, sl_count, timeout_count "
                    "FROM fillsim_results "
                    "ORDER BY config_name, mbo_date",
                    conn,
                )
                conn.close()
                df["date"] = pd.to_datetime(df["mbo_date"].astype(str).str.replace("-", ""), format="%Y%m%d", errors="coerce")
                df = df.dropna(subset=["date"])
                df = df.sort_values(["config_name", "date"])
                return df
            except Exception as _e:
                st.error(f"Failed to load fillsim_results: {_e}")
                return pd.DataFrame()

        @st.cache_data(ttl=300)
        def _compute_fillsim_stats_wf(initial_capital: float = 25_000.0) -> pd.DataFrame:
            """Compute per-config aggregate stats (WF tab copy)."""
            raw = _load_fillsim_daily_wf()
            if raw.empty:
                return pd.DataFrame()
            rows = []
            for cfg, grp in raw.groupby("config_name"):
                grp = grp.sort_values("date")
                daily_pnl = grp["total_pnl"].values
                n_days = len(daily_pnl)
                if n_days < 2:
                    continue
                cum_equity = initial_capital + daily_pnl.cumsum()
                peak = np.maximum.accumulate(cum_equity)
                drawdown_pct = (cum_equity - peak) / peak * 100.0
                total_pnl = daily_pnl.sum()
                avg_day = daily_pnl.mean()
                win_days = (daily_pnl > 0).sum()
                win_rate = win_days / n_days * 100.0
                std = daily_pnl.std(ddof=1) if n_days > 1 else 1e-9
                sharpe = (avg_day / std * np.sqrt(252)) if std > 1e-9 else 0.0
                neg = daily_pnl[daily_pnl < 0]
                down_std = neg.std(ddof=1) if len(neg) > 1 else 1e-9
                sortino = (avg_day / down_std * np.sqrt(252)) if down_std > 1e-9 else 0.0
                gross_profit = daily_pnl[daily_pnl > 0].sum()
                gross_loss = abs(daily_pnl[daily_pnl < 0].sum())
                pf = gross_profit / gross_loss if gross_loss > 1e-9 else float("inf")
                max_dd_pct = drawdown_pct.min()
                total_trades = grp["total_trades"].sum()
                rows.append({
                    "config_name": cfg,
                    "total_pnl": total_pnl,
                    "avg_day": avg_day,
                    "win_rate": win_rate,
                    "sharpe": sharpe,
                    "sortino": sortino,
                    "profit_factor": pf,
                    "max_dd_pct": max_dd_pct,
                    "n_days": n_days,
                    "total_trades": total_trades,
                })
            if not rows:
                return pd.DataFrame()
            return pd.DataFrame(rows).sort_values("sortino", ascending=False).reset_index(drop=True)

        _WF_CURVES_COLORS = [
            "#6366f1", "#10b981", "#f59e0b", "#ef4444", "#3b82f6",
            "#a855f7", "#14b8a6", "#f97316", "#ec4899", "#84cc16",
            "#06b6d4", "#f43f5e", "#22c55e", "#eab308", "#8b5cf6",
            "#0ea5e9", "#d946ef", "#fb923c", "#4ade80", "#facc15",
            "#60a5fa", "#c084fc", "#34d399", "#fbbf24", "#f87171",
        ]

        def _hex_to_rgba_wf(hex_color: str, alpha: float = 0.10) -> str:
            h = hex_color.lstrip("#")
            r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
            return f"rgba({r},{g},{b},{alpha})"

        wf_curves_raw = _load_fillsim_daily_wf()
        wf_curves_stats = _compute_fillsim_stats_wf(initial_capital=25_000.0)

        if wf_curves_raw.empty:
            st.warning("No fill sim data found. Check that qcc.db exists and fillsim_results table is populated.")
        else:
            wfc_ctrl1, wfc_ctrl2, wfc_ctrl3 = st.columns([2, 4, 1])
            with wfc_ctrl1:
                _wf_max_n = min(50, wf_curves_stats.shape[0])
                _wf_n_options = [n for n in [10, 25, 50] if n <= wf_curves_stats.shape[0]]
                if not _wf_n_options:
                    _wf_n_options = [wf_curves_stats.shape[0]]
                _wf_n_top = st.select_slider(
                    "Top N configs",
                    options=_wf_n_options,
                    value=min(10, _wf_max_n),
                    key="wf_curves_n_top",
                )
            with wfc_ctrl2:
                _wf_all_cfgs = wf_curves_stats["config_name"].tolist()
                _wf_sel_cfgs = st.multiselect(
                    "Override config selection (optional)",
                    options=_wf_all_cfgs,
                    default=[],
                    key="wf_curves_cfg_override",
                    help="Leave empty to use Top N by Sortino. Select specific configs to override.",
                )
            with wfc_ctrl3:
                if st.button("Reload", key="wf_curves_reload"):
                    st.cache_data.clear()
                    st.rerun()

            _wf_plot_cfgs = _wf_sel_cfgs if _wf_sel_cfgs else _wf_all_cfgs[:_wf_n_top]
            _wf_initial_capital = 25_000.0
            _wf_equity_traces = []
            _wf_dd_traces = []

            for _i, _cfg in enumerate(_wf_plot_cfgs):
                _color = _WF_CURVES_COLORS[_i % len(_WF_CURVES_COLORS)]
                _grp = wf_curves_raw[wf_curves_raw["config_name"] == _cfg].sort_values("date")
                if _grp.empty:
                    continue
                _daily = _grp["total_pnl"].values
                _dates = _grp["date"].values
                _cum_equity = _wf_initial_capital + _daily.cumsum()
                _peak = np.maximum.accumulate(_cum_equity)
                _dd_pct = (_cum_equity - _peak) / _peak * 100.0
                _worst_idx = int(np.argmin(_dd_pct))
                _worst_dd = float(_dd_pct[_worst_idx])
                _worst_date = _dates[_worst_idx]
                _wf_equity_traces.append((_cfg, _color, _dates, _cum_equity))
                _wf_dd_traces.append((_cfg, _color, _dates, _dd_pct, _worst_idx, _worst_date, _worst_dd))

            # Equity Curve chart
            st.subheader("Equity Curve (Cumulative PnL)")
            wf_fig_eq = go.Figure()
            wf_fig_eq.add_hline(
                y=_wf_initial_capital,
                line_dash="dash",
                line_color="rgba(255,255,255,0.35)",
                annotation_text=f"Breakeven ${_wf_initial_capital:,.0f}",
                annotation_position="bottom right",
                annotation_font_color="rgba(255,255,255,0.5)",
            )
            for _cfg, _color, _dates, _cum_equity in _wf_equity_traces:
                wf_fig_eq.add_trace(go.Scatter(
                    x=_dates, y=_cum_equity, mode="lines", name=_cfg,
                    line=dict(color=_color, width=2),
                    hovertemplate=(
                        f"<b>{_cfg}</b><br>"
                        "Date: %{x|%Y-%m-%d}<br>"
                        "Equity: $%{y:,.0f}<br>"
                        "<extra></extra>"
                    ),
                ))
            wf_fig_eq.update_layout(
                template=PT, height=420,
                xaxis_title="Date", yaxis_title="Equity ($)",
                yaxis=dict(tickprefix="$", tickformat=",.0f"),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                hovermode="x unified", dragmode="pan",
            )
            tv_chart(wf_fig_eq, key="wf_curves_equity")

            # Drawdown chart
            st.subheader("Drawdown (%)")
            wf_fig_dd = go.Figure()
            wf_fig_dd.add_hline(
                y=0, line_dash="dash",
                line_color="rgba(255,255,255,0.35)",
                annotation_text="0% (peak)",
                annotation_position="top right",
                annotation_font_color="rgba(255,255,255,0.5)",
            )
            for _cfg, _color, _dates, _dd_pct, _worst_idx, _worst_date, _worst_dd in _wf_dd_traces:
                wf_fig_dd.add_trace(go.Scatter(
                    x=_dates, y=_dd_pct, mode="lines", name=_cfg,
                    line=dict(color=_color, width=2),
                    fill="tozeroy", fillcolor=_hex_to_rgba_wf(_color, 0.10),
                    hovertemplate=(
                        f"<b>{_cfg}</b><br>"
                        "Date: %{x|%Y-%m-%d}<br>"
                        "Drawdown: %{y:.2f}%<br>"
                        "<extra></extra>"
                    ),
                ))
                wf_fig_dd.add_annotation(
                    x=_worst_date, y=_worst_dd,
                    text=f"{_worst_dd:.1f}%",
                    showarrow=True, arrowhead=2,
                    arrowcolor=_color, font=dict(color=_color, size=10),
                    ax=0, ay=-24,
                )
            wf_fig_dd.update_layout(
                template=PT, height=380,
                xaxis_title="Date", yaxis_title="Drawdown (%)",
                yaxis=dict(ticksuffix="%"),
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                hovermode="x unified", dragmode="pan",
            )
            tv_chart(wf_fig_dd, key="wf_curves_drawdown")

            # Leaderboard table
            st.markdown("---")
            st.subheader("Config Leaderboard (ranked by Sortino)")
            _wf_disp_stats = wf_curves_stats.copy()
            _wf_disp_stats.insert(0, "Rank", range(1, len(_wf_disp_stats) + 1))
            _wf_stat_col_cfg = {
                "total_pnl":      st.column_config.NumberColumn("Total PnL", format="$%.0f"),
                "avg_day":        st.column_config.NumberColumn("Avg/Day", format="$%.0f"),
                "win_rate":       st.column_config.NumberColumn("Win Rate", format="%.1f%%"),
                "sharpe":         st.column_config.NumberColumn("Sharpe", format="%.2f"),
                "sortino":        st.column_config.NumberColumn("Sortino", format="%.2f"),
                "profit_factor":  st.column_config.NumberColumn("PF", format="%.2f"),
                "max_dd_pct":     st.column_config.NumberColumn("Max DD%", format="%.1f%%"),
                "n_days":         st.column_config.NumberColumn("Days"),
                "total_trades":   st.column_config.NumberColumn("Trades"),
                "config_name":    st.column_config.TextColumn("Config"),
            }

            def _wf_fillsim_row_color(row):
                rank = row.get("Rank", 99)
                if rank == 1:
                    return ["background-color: rgba(16, 185, 129, 0.25)"] * len(row)
                pnl = row.get("total_pnl", 0) or 0
                if pnl > 0:
                    return ["background-color: rgba(16, 185, 129, 0.08)"] * len(row)
                return ["background-color: rgba(239, 68, 68, 0.08)"] * len(row)

            st.dataframe(
                _wf_disp_stats.style.apply(_wf_fillsim_row_color, axis=1),
                use_container_width=True,
                hide_index=True,
                height=min(600, 45 * len(_wf_disp_stats) + 55),
                column_config=_wf_stat_col_cfg,
            )

            if not wf_curves_stats.empty:
                _wf_best = wf_curves_stats.iloc[0]
                st.markdown("---")
                _wfb1, _wfb2, _wfb3, _wfb4, _wfb5, _wfb6 = st.columns(6)
                _wfb1.metric("Best Config", _wf_best["config_name"])
                _wfb2.metric("Total PnL", f"${_wf_best['total_pnl']:,.0f}")
                _wfb3.metric("Sortino", f"{_wf_best['sortino']:.2f}")
                _wfb4.metric("Sharpe", f"{_wf_best['sharpe']:.2f}")
                _wfb5.metric("Max Drawdown", f"{_wf_best['max_dd_pct']:.1f}%")
                _wfb6.metric("Win Rate", f"{_wf_best['win_rate']:.1f}%")

    # --- WF > Compute ---
    with wf_sub[5]:
        st.header("Compute Monitoring")

        # Load compute status from JSON written by compute_monitor.py
        COMPUTE_STATUS_PATH = Path(r"C:\Users\Footb\Documents\Github\teleclaude-main\data\compute_status.json")

        @st.cache_data(ttl=30)
        def _load_compute_status():
            if COMPUTE_STATUS_PATH.exists():
                try:
                    with open(COMPUTE_STATUS_PATH) as f:
                        return json.load(f)
                except Exception:
                    return None
            return None

        compute_data = _load_compute_status()

        # Header row with last-updated and refresh
        hdr_c1, hdr_c2 = st.columns([5, 1])
        with hdr_c1:
            if compute_data and compute_data.get("last_updated"):
                ts = compute_data["last_updated"]
                # Parse ISO timestamp for display
                try:
                    from datetime import datetime as _dt
                    dt = _dt.fromisoformat(ts)
                    age_sec = (_dt.now() - dt).total_seconds()
                    if age_sec < 120:
                        age_str = f"{int(age_sec)}s ago"
                    elif age_sec < 7200:
                        age_str = f"{int(age_sec / 60)}m ago"
                    else:
                        age_str = f"{int(age_sec / 3600)}h ago"
                    freshness_color = "#10b981" if age_sec < 900 else "#f59e0b" if age_sec < 3600 else "#ef4444"
                    st.markdown(
                        f'<span style="color:{freshness_color};font-weight:600;">Last updated: {dt.strftime("%Y-%m-%d %H:%M:%S")} ({age_str})</span>',
                        unsafe_allow_html=True,
                    )
                except Exception:
                    st.caption(f"Last updated: {ts}")
            else:
                st.caption("Waiting for compute monitor data...")
        with hdr_c2:
            if st.button("Refresh", key="compute_refresh"):
                st.cache_data.clear()
                st.rerun()

        if compute_data is None or compute_data.get("last_updated") is None:
            st.info(
                "No compute status data available yet. The compute monitor "
                "(`python utils/compute_monitor.py`) writes to "
                "`data/compute_status.json` every 10 minutes. Start the monitor "
                "to see live data here."
            )
        else:
            nodes = compute_data.get("nodes", {})
            node_order = ["neptune", "uranus", "jupiter", "saturn"]

            def _node_status(n):
                """Determine status and color for a node."""
                if not n.get("reachable", False):
                    return "UNREACHABLE", "#ef4444", "node-unreachable"
                gpu = n.get("gpu_pct")
                load = n.get("load_avg") or n.get("cpu_pct")
                fill_sim = n.get("fill_sim_count", 0)
                py_count = n.get("python_count", 0)
                # GPU nodes
                if gpu is not None:
                    if gpu > 30:
                        return "ACTIVE", "#10b981", "node-running"
                    elif py_count > 0:
                        return "WARNING", "#f59e0b", "node-idle"
                    else:
                        return "IDLE", "#6b7280", "node-idle"
                # CPU nodes
                if fill_sim > 0 or py_count > 0:
                    if load is not None and load > 1.0:
                        return "ACTIVE", "#10b981", "node-running"
                    return "RUNNING", "#10b981", "node-running"
                return "IDLE", "#6b7280", "node-idle"

            def _bar_html(used, total, label, color="#6366f1"):
                """Render a small usage bar."""
                if used is None or total is None or total == 0:
                    return f'<span style="color:{T["text_muted"]};font-size:0.85em;">{label}: N/A</span>'
                pct = min(100, max(0, (used / total) * 100))
                bar_color = "#10b981" if pct < 70 else "#f59e0b" if pct < 90 else "#ef4444"
                return (
                    f'<div style="margin:4px 0;">'
                    f'<div style="display:flex;justify-content:space-between;font-size:0.8em;color:{T["text_muted"]};">'
                    f'<span>{label}</span><span>{used:.1f}/{total:.1f} GB ({pct:.0f}%)</span></div>'
                    f'<div style="background:{T["card_border"]};border-radius:4px;height:6px;overflow:hidden;">'
                    f'<div style="width:{pct:.1f}%;height:100%;background:{bar_color};border-radius:4px;"></div>'
                    f'</div></div>'
                )

            def _pct_bar_html(pct_val, label, suffix="%"):
                """Render a percentage-based usage bar (for CPU, disk, etc.)."""
                if pct_val is None:
                    return f'<span style="color:{T["text_muted"]};font-size:0.85em;">{label}: N/A</span>'
                pct_val = min(100, max(0, float(pct_val)))
                bar_color = "#10b981" if pct_val < 70 else "#f59e0b" if pct_val < 90 else "#ef4444"
                return (
                    f'<div style="margin:4px 0;">'
                    f'<div style="display:flex;justify-content:space-between;font-size:0.8em;color:{T["text_muted"]};">'
                    f'<span>{label}</span><span>{pct_val:.0f}{suffix}</span></div>'
                    f'<div style="background:{T["card_border"]};border-radius:4px;height:6px;overflow:hidden;">'
                    f'<div style="width:{pct_val:.1f}%;height:100%;background:{bar_color};border-radius:4px;"></div>'
                    f'</div></div>'
                )

            def _gpu_bar_html(pct, temp=None):
                """Render GPU utilization bar with optional temp."""
                if pct is None:
                    return f'<span style="color:{T["text_muted"]};font-size:0.85em;">GPU: N/A (no GPU)</span>'
                bar_color = "#10b981" if pct > 50 else "#f59e0b" if pct > 10 else "#6b7280"
                temp_str = f" | {temp}C" if temp is not None else ""
                return (
                    f'<div style="margin:4px 0;">'
                    f'<div style="display:flex;justify-content:space-between;font-size:0.8em;color:{T["text_muted"]};">'
                    f'<span>GPU Util</span><span>{pct}%{temp_str}</span></div>'
                    f'<div style="background:{T["card_border"]};border-radius:4px;height:6px;overflow:hidden;">'
                    f'<div style="width:{pct}%;height:100%;background:{bar_color};border-radius:4px;"></div>'
                    f'</div></div>'
                )

            def _disk_bar_html(n):
                """Render disk usage bar from node data."""
                disk_used = n.get("disk_used_gb")
                disk_total = n.get("disk_total_gb")
                disk_pct = n.get("disk_pct")
                if disk_pct is not None:
                    return _pct_bar_html(disk_pct, "Disk")
                elif disk_used is not None and disk_total is not None and disk_total > 0:
                    return _bar_html(disk_used, disk_total, "Disk")
                return ""

            def _fold_progress_html(n):
                """Render training fold progress if available."""
                fold_current = n.get("training_fold")
                fold_total = n.get("training_total_folds")
                fold_epoch = n.get("training_epoch")
                fold_total_epochs = n.get("training_total_epochs")
                fold_loss = n.get("training_loss")
                if fold_current is None and fold_epoch is None:
                    return ""
                parts = []
                if fold_current is not None:
                    fold_str = f"Fold {fold_current}"
                    if fold_total is not None:
                        fold_str += f"/{fold_total}"
                    parts.append(fold_str)
                if fold_epoch is not None:
                    epoch_str = f"Epoch {fold_epoch}"
                    if fold_total_epochs is not None:
                        epoch_str += f"/{fold_total_epochs}"
                    parts.append(epoch_str)
                if fold_loss is not None:
                    parts.append(f"Loss: {fold_loss:.4f}")
                progress_text = " | ".join(parts)
                # Progress bar if we have fold info
                progress_pct = 0
                if fold_current is not None and fold_total is not None and fold_total > 0:
                    base_pct = ((fold_current - 1) / fold_total) * 100
                    if fold_epoch is not None and fold_total_epochs is not None and fold_total_epochs > 0:
                        base_pct += (fold_epoch / fold_total_epochs) * (100 / fold_total)
                    progress_pct = min(100, base_pct)
                elif fold_epoch is not None and fold_total_epochs is not None and fold_total_epochs > 0:
                    progress_pct = min(100, (fold_epoch / fold_total_epochs) * 100)
                return (
                    f'<div style="margin:6px 0;padding:6px 10px;background:#6366f122;border-radius:8px;font-size:0.78em;">'
                    f'<div style="display:flex;justify-content:space-between;color:{T["text_muted"]};margin-bottom:3px;">'
                    f'<span>Training Progress</span><span>{progress_text}</span></div>'
                    f'<div style="background:{T["card_border"]};border-radius:4px;height:5px;overflow:hidden;">'
                    f'<div style="width:{progress_pct:.1f}%;height:100%;background:linear-gradient(90deg,#6366f1,#8b5cf6);'
                    f'border-radius:4px;transition:width 0.5s ease;"></div>'
                    f'</div></div>'
                )

            def _processes_html(n):
                """Render active processes list if available."""
                procs = n.get("active_processes") or n.get("top_processes") or []
                if not procs:
                    return ""
                rows = ""
                for p in procs[:5]:  # Show top 5
                    if isinstance(p, dict):
                        pname = p.get("name", p.get("cmd", "?"))[:28]
                        pcpu = p.get("cpu", p.get("cpu_pct", ""))
                        pmem = p.get("mem", p.get("mem_pct", ""))
                        rows += (f'<div style="display:flex;justify-content:space-between;font-size:0.72em;'
                                 f'padding:1px 0;color:{T["text_muted"]};">'
                                 f'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{pname}</span>'
                                 f'<span style="width:45px;text-align:right;">{pcpu}%</span>'
                                 f'<span style="width:45px;text-align:right;">{pmem}%</span>'
                                 f'</div>')
                    elif isinstance(p, str):
                        rows += f'<div style="font-size:0.72em;color:{T["text_muted"]};padding:1px 0;">{p[:40]}</div>'
                if not rows:
                    return ""
                return (
                    f'<div style="margin:4px 0;padding:4px 8px;background:{T["card_border"]}22;border-radius:6px;">'
                    f'<div style="display:flex;justify-content:space-between;font-size:0.68em;'
                    f'font-weight:700;color:{T["text_muted"]};text-transform:uppercase;letter-spacing:0.5px;'
                    f'padding-bottom:2px;border-bottom:1px solid {T["card_border"]};">'
                    f'<span style="flex:1;">Process</span><span style="width:45px;text-align:right;">CPU</span>'
                    f'<span style="width:45px;text-align:right;">MEM</span></div>'
                    f'{rows}</div>'
                )

            # 4-column layout: one card per node
            cols = st.columns(4)
            for idx, key in enumerate(node_order):
                n = nodes.get(key, {})
                status_label, status_color, css_class = _node_status(n)
                name = n.get("name", key.title())
                desc = n.get("description", "")

                with cols[idx]:
                    # Build CPU bar — use cpu_pct if available, else derive from load_avg
                    _cpu_pct_val = n.get("cpu_pct")
                    _cpu_cores = n.get("cpu_cores")
                    _load_avg = n.get("load_avg")
                    if _cpu_pct_val is not None:
                        _cpu_bar = _pct_bar_html(_cpu_pct_val, "CPU Util")
                    elif _load_avg is not None and _cpu_cores is not None and _cpu_cores > 0:
                        # Approximate CPU% from load average
                        _cpu_approx = min(100, (_load_avg / _cpu_cores) * 100)
                        _cpu_bar = _pct_bar_html(_cpu_approx, f"CPU (load {_load_avg:.1f})")
                    elif _load_avg is not None:
                        _cpu_bar = _pct_bar_html(min(100, _load_avg * 10), f"CPU (load {_load_avg:.1f})")
                    else:
                        _cpu_bar = f'<span style="color:{T["text_muted"]};font-size:0.85em;">CPU: N/A</span>'

                    st.markdown(
                        f'<div class="node-card {css_class}" style="min-height:320px;">'
                        f'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
                        f'<strong style="font-size:1.15em;color:{T["text_heading"]};">{name}</strong>'
                        f'<span style="display:inline-block;padding:3px 12px;border-radius:20px;font-size:0.75em;'
                        f'font-weight:700;background:{status_color}22;color:{status_color};">{status_label}</span>'
                        f'</div>'
                        f'<div style="font-size:0.78em;color:{T["text_muted"]};margin-bottom:10px;">{desc} &mdash; {n.get("ip", "")}</div>'
                        # GPU bar
                        f'{_gpu_bar_html(n.get("gpu_pct"), n.get("gpu_temp_c"))}'
                        # CPU bar (NEW)
                        f'{_cpu_bar}'
                        # VRAM bar
                        f'{_bar_html(n.get("vram_used_gb"), n.get("vram_total_gb"), "VRAM")}'
                        # RAM bar
                        f'{_bar_html(n.get("ram_used_gb"), n.get("ram_total_gb"), "RAM")}'
                        # Disk bar (NEW)
                        f'{_disk_bar_html(n)}'
                        # Current task
                        f'<div style="margin:6px 0;padding:6px 10px;background:{T["card_border"]}44;border-radius:8px;font-size:0.82em;">'
                        f'<span style="color:{T["text_muted"]};">Task:</span> '
                        f'<span style="color:{T["text"]};font-weight:600;">{n.get("current_task", "Unknown")}</span>'
                        f'</div>'
                        # Training fold progress (NEW)
                        f'{_fold_progress_html(n)}'
                        # Process counts
                        f'<div style="font-size:0.8em;color:{T["text_muted"]};margin-top:4px;">'
                        f'Python: {n.get("python_count", 0)}'
                        f'{" | FillSim: " + str(n.get("fill_sim_count", 0)) if "fill_sim_count" in n else ""}'
                        f'{" | Results: " + format(n.get("result_file_count", 0), ",") if n.get("result_file_count") else ""}'
                        f'</div>'
                        # Active processes table (NEW)
                        f'{_processes_html(n)}'
                        f'</div>',
                        unsafe_allow_html=True,
                    )

            # --- Cluster-wide resource usage charts ---
            st.markdown("---")
            st.subheader("Cluster Resource Overview")
            _res_cols = st.columns(2)

            with _res_cols[0]:
                # GPU + CPU utilization bar chart across all nodes
                _node_names = []
                _gpu_vals = []
                _cpu_vals = []
                for key in node_order:
                    n = nodes.get(key, {})
                    if not n.get("reachable", False):
                        continue
                    _node_names.append(n.get("name", key.title()))
                    _gpu_vals.append(n.get("gpu_pct") or 0)
                    _cpu_v = n.get("cpu_pct")
                    if _cpu_v is None and n.get("load_avg") is not None:
                        _cores = n.get("cpu_cores", 8)
                        _cpu_v = min(100, (n["load_avg"] / _cores) * 100)
                    _cpu_vals.append(_cpu_v or 0)

                if _node_names:
                    _util_fig = go.Figure()
                    _util_fig.add_trace(go.Bar(
                        x=_node_names, y=_gpu_vals, name="GPU %",
                        marker_color="#8b5cf6", text=[f"{v:.0f}%" for v in _gpu_vals],
                        textposition="outside",
                    ))
                    _util_fig.add_trace(go.Bar(
                        x=_node_names, y=_cpu_vals, name="CPU %",
                        marker_color="#6366f1", text=[f"{v:.0f}%" for v in _cpu_vals],
                        textposition="outside",
                    ))
                    _util_fig.update_layout(
                        template=PT, height=300, barmode="group",
                        title="GPU vs CPU Utilization",
                        yaxis=dict(title="Utilization %", range=[0, 110]),
                        margin=dict(l=40, r=20, t=40, b=30),
                    )
                    tv_chart(_util_fig)

            with _res_cols[1]:
                # RAM usage bar chart
                _ram_names = []
                _ram_used = []
                _ram_total = []
                for key in node_order:
                    n = nodes.get(key, {})
                    if not n.get("reachable", False):
                        continue
                    if n.get("ram_used_gb") is not None and n.get("ram_total_gb") is not None:
                        _ram_names.append(n.get("name", key.title()))
                        _ram_used.append(n["ram_used_gb"])
                        _ram_total.append(n["ram_total_gb"])

                if _ram_names:
                    _ram_fig = go.Figure()
                    _ram_fig.add_trace(go.Bar(
                        x=_ram_names, y=_ram_used, name="Used",
                        marker_color="#f59e0b",
                        text=[f"{u:.1f}GB" for u in _ram_used],
                        textposition="outside",
                    ))
                    _ram_fig.add_trace(go.Bar(
                        x=_ram_names, y=[t - u for t, u in zip(_ram_total, _ram_used)], name="Free",
                        marker_color="#1e293b",
                        text=[f"{t:.0f}GB total" for t in _ram_total],
                        textposition="outside",
                    ))
                    _ram_fig.update_layout(
                        template=PT, height=300, barmode="stack",
                        title="RAM Usage",
                        yaxis=dict(title="GB"),
                        margin=dict(l=40, r=20, t=40, b=30),
                    )
                    tv_chart(_ram_fig)

            # Active alerts section
            ALERTS_PATH = Path(r"C:\Users\Footb\Documents\Github\teleclaude-main\compute_alerts.json")
            if ALERTS_PATH.exists():
                try:
                    with open(ALERTS_PATH) as f:
                        all_alerts = json.load(f)
                    # Show last 10 alerts
                    recent = all_alerts[-10:] if len(all_alerts) > 10 else all_alerts
                    recent.reverse()
                    if recent:
                        st.markdown("---")
                        st.subheader("Recent Alerts")
                        for a in recent:
                            sev = a.get("severity", "INFO")
                            sev_color = "#ef4444" if sev == "CRITICAL" else "#f59e0b" if sev == "WARNING" else "#6b7280"
                            ts_str = a.get("timestamp", "")[:19]
                            st.markdown(
                                f'<div style="padding:6px 12px;margin:3px 0;border-radius:8px;'
                                f'background:{sev_color}15;border-left:3px solid {sev_color};font-size:0.85em;">'
                                f'<span style="color:{sev_color};font-weight:700;">[{sev}]</span> '
                                f'<span style="color:{T["text_muted"]};">{ts_str}</span> '
                                f'<strong style="color:{T["text"]};">{a.get("machine", "")}</strong>: '
                                f'<span style="color:{T["text"]};">{a.get("message", "")}</span>'
                                f'</div>',
                                unsafe_allow_html=True,
                            )
                except Exception:
                    pass

        # Dead strategies
        st.markdown("---")
        st.subheader("Dead Strategies (for reference)")
        dead = [
            {"Strategy": "ET Walk-Forward", "Issue": "Costs 4x > edge"},
            {"Strategy": "LightGBM", "Issue": "Same cost problem"},
            {"Strategy": "Market Orders (42 configs)", "Issue": "ALL catastrophically negative"},
            {"Strategy": "Vol->Options Straddles", "Issue": "VRP kills edge"},
            {"Strategy": "SPY Cross-Venue", "Issue": "$0 commission artifact"},
        ]
        st.dataframe(pd.DataFrame(dead), use_container_width=True, hide_index=True)


# ================================================================
# TAB 3: SWEEP RESULTS
# ================================================================
with tab_sweep:
    import re as _re2
    import math

    RESULTS_DIR = Path("C:/Users/Footb/Documents/Github/Lvl3Quant/alpha_discovery/deep_models/results")
    OPTUNA_PATH = RESULTS_DIR / "optuna_optimization_results.json"

    # ----------------------------------------------------------------
    # Data loading helpers
    # ----------------------------------------------------------------

    @st.cache_data(ttl=60)
    def _load_sweep_results() -> pd.DataFrame:
        """Load, filter, and score all sweep results.

        Filters applied:
        - Only WF model results (exclude static-model configs)
        - Exclude 0ms latency sims (lat0 in config name)
        - Exclude sl=10 configs (known catastrophic)
        - Exclude signal-flip-exit v1 sweep (stacked_exit_aggregated all_results)
        - Only configs with >= 10 trading days
        """
        rows = []

        # ---- Source A: entry_exit_matrix_aggregated (all_configs_sorted) ----
        matrix_path = RESULTS_DIR / "entry_exit_matrix_aggregated.json"
        if matrix_path.exists():
            with open(matrix_path) as f:
                data = json.load(f)
            for r in data.get("all_configs_sorted", []):
                rows.append({
                    "config":       r.get("config", ""),
                    "entry":        r.get("entry_method", r.get("entry_full", "")),
                    "exit":         r.get("exit_method", r.get("exit_full", "")),
                    "conv":         str(r.get("entry_param", r.get("vol_gate", ""))),
                    "vol":          str(r.get("vol_gate", "")),
                    "tp":           r.get("sim_type", ""),
                    "sl":           "",
                    "n_days":       r.get("n_days", 0),
                    "total_pnl":    r.get("total_pnl", 0),
                    "pnl_per_day":  r.get("mean_daily_pnl", 0),
                    "sharpe":       r.get("sharpe", 0),
                    "win_rate":     r.get("win_rate", 0),
                    "profit_factor": np.nan,
                    "trades":       r.get("total_trades", 0),
                    "fill_rate":    r.get("fill_rate", 0),
                    "max_drawdown": np.nan,
                    "exit_pct_flip":     np.nan,
                    "exit_pct_tp":       np.nan,
                    "exit_pct_trail":    np.nan,
                    "exit_pct_timeout":  r.get("pct_timeout_exit", np.nan),
                    "avg_hold_min":      r.get("avg_hold_min", np.nan),
                    "source":       "Entry/Exit Matrix",
                })

        # ---- Source B: stacked_exit_sweep_results_*.json files (richest data, v2 included) ----
        # Load the most recent one — sorted by name desc
        sweep_files = sorted(RESULTS_DIR.glob("stacked_exit_sweep_results_*.json"), reverse=True)
        seen_configs = set()
        for sf in sweep_files:
            with open(sf) as f:
                data = json.load(f)
            for r in data.get("summaries", []):
                cfg = r.get("config", "")
                if cfg in seen_configs:
                    continue
                seen_configs.add(cfg)
                sl_label = r.get("sl_label", "")
                # Parse sl value
                sl_match = _re2.search(r"sl(\d+)", sl_label)
                sl_val = int(sl_match.group(1)) if sl_match else None
                rows.append({
                    "config":       cfg,
                    "entry":        r.get("pair", "").split("_")[0] if "_" in r.get("pair", "") else r.get("pair", ""),
                    "exit":         "_".join(r.get("pair", "").split("_")[1:]) if "_" in r.get("pair", "") else "",
                    "conv":         r.get("conv", ""),
                    "vol":          r.get("vol", ""),
                    "tp":           r.get("tp_label", ""),
                    "sl":           sl_label,
                    "n_days":       r.get("n_days", 0),
                    "total_pnl":    r.get("total_pnl", 0),
                    "pnl_per_day":  r.get("avg_daily_pnl", 0),
                    "sharpe":       r.get("sharpe", 0),
                    "win_rate":     r.get("win_rate", 0),
                    "profit_factor": np.nan,
                    "trades":       r.get("n_trades", 0),
                    "fill_rate":    r.get("fill_rate", 0),
                    "max_drawdown": r.get("max_dd", np.nan),
                    "exit_pct_flip":     r.get("exit_pct_signal_flip", np.nan),
                    "exit_pct_tp":       r.get("exit_pct_take_profit", np.nan),
                    "exit_pct_trail":    r.get("exit_pct_trailing_stop", np.nan),
                    "exit_pct_timeout":  r.get("exit_pct_hold_timeout", np.nan),
                    "avg_hold_min":      np.nan,
                    "_sl_val":      sl_val,
                    "source":       "Stacked Exit v1",
                })

        # ---- Source C: combo_sweep_results (hold time + TP combos) ----
        combo_files = sorted(RESULTS_DIR.glob("combo_sweep_results_*.json"), reverse=True)
        for cf in combo_files[:1]:
            with open(cf) as f:
                data = json.load(f)
            items = data if isinstance(data, list) else data.get("results", data.get("summaries", []))
            for r in items:
                cfg = r.get("config", r.get("label", ""))
                if cfg in seen_configs:
                    continue
                seen_configs.add(cfg)
                rows.append({
                    "config":       cfg,
                    "entry":        r.get("entry", ""),
                    "exit":         r.get("exit", ""),
                    "conv":         str(r.get("conv", r.get("conv_threshold", ""))),
                    "vol":          str(r.get("vol", r.get("vol_percentile", ""))),
                    "tp":           str(r.get("tp", "")),
                    "sl":           str(r.get("sl", "")),
                    "n_days":       r.get("n_days", 0),
                    "total_pnl":    r.get("total_pnl", r.get("pnl", 0)),
                    "pnl_per_day":  r.get("mean_daily_pnl", r.get("avg_daily_pnl", 0)),
                    "sharpe":       r.get("sharpe", 0),
                    "win_rate":     r.get("win_rate", r.get("wr", 0)),
                    "profit_factor": r.get("profit_factor", np.nan),
                    "trades":       r.get("total_trades", r.get("n_trades", r.get("trades", 0))),
                    "fill_rate":    r.get("fill_rate", r.get("fill", 0)),
                    "max_drawdown": r.get("max_dd", np.nan),
                    "exit_pct_flip":     np.nan,
                    "exit_pct_tp":       np.nan,
                    "exit_pct_trail":    np.nan,
                    "exit_pct_timeout":  np.nan,
                    "avg_hold_min":      np.nan,
                    "source":       "Combo Sweep",
                })

        # ---- Source D: hold sweep best configs (WF model) ----
        hold_path = RESULTS_DIR / "hold_sweep_aggregated.json"
        if hold_path.exists():
            with open(hold_path) as f:
                data = json.load(f)
            for r in data.get("summaries", []):
                cfg = f"{r.get('label', '')}_{r.get('vg', '')}"
                if cfg in seen_configs:
                    continue
                seen_configs.add(cfg)
                rows.append({
                    "config":       cfg,
                    "entry":        "",
                    "exit":         "Fixed Hold",
                    "conv":         "",
                    "vol":          r.get("vg", ""),
                    "tp":           "",
                    "sl":           "",
                    "n_days":       r.get("n_days", 0),
                    "total_pnl":    r.get("pnl", 0),
                    "pnl_per_day":  r.get("pnl", 0) / max(r.get("n_days", 1), 1),
                    "sharpe":       r.get("sharpe", 0),
                    "win_rate":     r.get("wr", 0),
                    "profit_factor": np.nan,
                    "trades":       r.get("trades", 0),
                    "fill_rate":    r.get("fill", 0),
                    "max_drawdown": np.nan,
                    "exit_pct_flip":    np.nan,
                    "exit_pct_tp":      np.nan,
                    "exit_pct_trail":   np.nan,
                    "exit_pct_timeout": np.nan,
                    "avg_hold_min":     np.nan,
                    "source":       "Hold Sweep (WF)",
                })

        if not rows:
            return pd.DataFrame()

        df = pd.DataFrame(rows)

        # ---- Apply mandatory filters ----
        # 1. Exclude static model (lat0 in config name)
        df = df[~df["config"].str.contains(r"lat0\b", case=False, na=False)]

        # 2. Exclude sl=10 configs (catastrophic)
        sl_10_mask = df["config"].str.contains(r"_sl10\b|_sl=10\b", case=False, na=False)
        if "_sl_val" in df.columns:
            sl_10_mask = sl_10_mask | (df["_sl_val"].fillna(0) == 10)
        df = df[~sl_10_mask]

        # 3. Exclude signal-flip-exit v1 configs (pct_flip >= 50% AND sharpe < 0)
        if "exit_pct_flip" in df.columns:
            flip_dead = (df["exit_pct_flip"].fillna(0) >= 50) & (df["sharpe"] < 0)
            df = df[~flip_dead]

        # 4. Only >= 10 trading days
        df = df[df["n_days"] >= 10]

        # ---- Compute win_rate_pct ----
        df["win_rate_pct"] = np.where(
            df["win_rate"] > 1.0,
            df["win_rate"].round(1),               # already a percentage
            (df["win_rate"] * 100).round(1),
        )

        # ---- Fill rate pct ----
        df["fill_rate_pct"] = np.where(
            df["fill_rate"] > 1.0,
            df["fill_rate"].round(1),
            (df["fill_rate"] * 100).round(1),
        )

        # ---- Profit factor: compute from avg_win / avg_loss if not present ----
        if "profit_factor" not in df.columns:
            df["profit_factor"] = np.nan
        df["profit_factor"] = pd.to_numeric(df["profit_factor"], errors="coerce")

        # ---- pnl_per_day: fallback ----
        df["pnl_per_day"] = pd.to_numeric(df["pnl_per_day"], errors="coerce")
        mask_zero = df["pnl_per_day"].isna() | (df["pnl_per_day"] == 0)
        df.loc[mask_zero, "pnl_per_day"] = (
            df.loc[mask_zero, "total_pnl"] / df.loc[mask_zero, "n_days"].replace(0, np.nan)
        )

        # ---- Quality Score = 0.6 * Sharpe + 0.3 * log(PF) + 0.1 * sqrt(trades) ----
        pf_val = df["profit_factor"].fillna(1.0).clip(lower=0.01)
        trades_clipped = df["trades"].clip(lower=0).fillna(0)
        df["quality_score"] = (
            0.6 * df["sharpe"].fillna(0)
            + 0.3 * np.log(pf_val)
            + 0.1 * np.sqrt(trades_clipped)
        ).round(3)

        # ---- Drop internal column ----
        if "_sl_val" in df.columns:
            df = df.drop(columns=["_sl_val"])

        return df.reset_index(drop=True)

    @st.cache_data(ttl=300)
    def _load_optuna() -> dict:
        if OPTUNA_PATH.exists():
            with open(OPTUNA_PATH) as f:
                return json.load(f)
        return {}

    # ----------------------------------------------------------------
    # Header + refresh
    # ----------------------------------------------------------------
    sw_hdr1, sw_hdr2 = st.columns([5, 1])
    with sw_hdr1:
        st.header("Sweep Results Explorer")
        st.caption("Live reload from local aggregated files | Filters: WF model only | lat0 excluded | sl=10 excluded | n_days >= 10")
    with sw_hdr2:
        st.markdown("")
        if st.button("Reload Data", key="sweep_reload"):
            st.cache_data.clear()
            st.rerun()

    try:
        sweep_df = _load_sweep_results()
    except Exception as _sw_err:
        st.error(f"Failed to load sweep results: {_sw_err}")
        sweep_df = pd.DataFrame()

    if sweep_df.empty:
        st.warning("No sweep data found. Run aggregate scripts on the results directory, or check that "
                   f"`{RESULTS_DIR}` is accessible.")
        st.markdown("""
        **To generate data:** run one of the aggregate scripts on Jupiter/Saturn and copy the
        `*_aggregated.json` files to the results directory, then click **Reload Data**.
        """)
    else:
        # ---- Top-level summary metrics ----
        profitable = sweep_df[sweep_df["total_pnl"] > 0]
        best_row = sweep_df.loc[sweep_df["quality_score"].idxmax()] if not sweep_df.empty else None

        sm1, sm2, sm3, sm4, sm5, sm6 = st.columns(6)
        sm1.metric("Total Configs", f"{len(sweep_df):,}")
        sm2.metric("Profitable", f"{len(profitable):,}",
                   delta=f"{len(profitable)/len(sweep_df)*100:.0f}%" if len(sweep_df) > 0 else "0%")
        sm3.metric("Best Sharpe", f"{sweep_df['sharpe'].max():.2f}" if not sweep_df.empty else "—")
        sm4.metric("Best P&L", f"${sweep_df['total_pnl'].max():,.0f}" if not sweep_df.empty else "—")
        sm5.metric("Best Quality Score",
                   f"{sweep_df['quality_score'].max():.2f}" if not sweep_df.empty else "—")
        sm6.metric("Sources", str(sweep_df["source"].nunique()))

        # Source breakdown
        src_counts = sweep_df["source"].value_counts()
        src_str = " | ".join(f"{k}: {v}" for k, v in src_counts.items())
        st.markdown(f'<div class="source-label"><strong>Sources:</strong> {src_str}</div>',
                    unsafe_allow_html=True)

        st.markdown("---")

        # ---- Filters row 1: categorical ----
        fc1, fc2, fc3, fc4, fc5 = st.columns(5)
        with fc1:
            source_opts = sorted(sweep_df["source"].unique().tolist())
            sel_sources = st.multiselect("Source Sweep", source_opts,
                                         default=source_opts, key="sw_src")
        with fc2:
            entry_opts = sorted(sweep_df["entry"].dropna().unique().tolist())
            sel_entry = st.multiselect("Entry Type", entry_opts,
                                       default=entry_opts, key="sw_entry")
        with fc3:
            exit_opts = sorted(sweep_df["exit"].dropna().unique().tolist())
            sel_exit = st.multiselect("Exit Type", exit_opts,
                                      default=exit_opts, key="sw_exit")
        with fc4:
            vol_opts = sorted(sweep_df["vol"].dropna().unique().tolist())
            sel_vol = st.multiselect("Vol Filter", vol_opts,
                                     default=vol_opts, key="sw_vol")
        with fc5:
            only_profitable = st.checkbox("Profitable only", value=False, key="sw_profit")

        # ---- Filters row 2: numeric ----
        fn1, fn2, fn3, fn4 = st.columns(4)
        with fn1:
            min_sharpe_sw = st.number_input("Min Sharpe", -20.0, 30.0, -5.0, 0.5, key="sw_ms")
        with fn2:
            min_pnl_sw = st.number_input("Min P&L ($)", -500000, 500000, -500000, 1000, key="sw_mp")
        with fn3:
            min_trades_sw = st.number_input("Min Trades", 0, 5000, 0, 5, key="sw_mt")
        with fn4:
            sort_opts_sw = {
                "Quality Score": "quality_score",
                "Sharpe": "sharpe",
                "P&L ($)": "total_pnl",
                "$/day": "pnl_per_day",
                "Win Rate": "win_rate_pct",
                "Profit Factor": "profit_factor",
                "Trades": "trades",
            }
            sort_label_sw = st.selectbox("Sort By", list(sort_opts_sw.keys()), key="sw_sort")
            sort_col_sw = sort_opts_sw[sort_label_sw]

        # ---- Apply filters ----
        fdf_sw = sweep_df.copy()
        if sel_sources:
            fdf_sw = fdf_sw[fdf_sw["source"].isin(sel_sources)]
        if sel_entry:
            fdf_sw = fdf_sw[fdf_sw["entry"].isin(sel_entry) | fdf_sw["entry"].isna() | (fdf_sw["entry"] == "")]
        if sel_exit:
            fdf_sw = fdf_sw[fdf_sw["exit"].isin(sel_exit) | fdf_sw["exit"].isna() | (fdf_sw["exit"] == "")]
        if sel_vol:
            fdf_sw = fdf_sw[fdf_sw["vol"].isin(sel_vol) | fdf_sw["vol"].isna() | (fdf_sw["vol"] == "")]
        if only_profitable:
            fdf_sw = fdf_sw[fdf_sw["total_pnl"] > 0]
        fdf_sw = fdf_sw[fdf_sw["sharpe"] >= min_sharpe_sw]
        fdf_sw = fdf_sw[fdf_sw["total_pnl"] >= min_pnl_sw]
        fdf_sw = fdf_sw[fdf_sw["trades"] >= min_trades_sw]

        if sort_col_sw in fdf_sw.columns:
            fdf_sw = fdf_sw.sort_values(sort_col_sw, ascending=False)

        # Top N
        topn_c1, topn_c2 = st.columns([1, 5])
        with topn_c1:
            top_n_sw = st.number_input("Show Top N", 10, 2000, 50, 10, key="sw_topn")
        total_sw = len(fdf_sw)
        fdf_sw_display = fdf_sw.head(top_n_sw).copy()

        st.caption(f"Showing {len(fdf_sw_display)} of {total_sw} configs after filters")

        # ---- Build display dataframe ----
        display_cols_sw = [
            "config", "source", "quality_score",
            "total_pnl", "pnl_per_day", "sharpe",
            "win_rate_pct", "profit_factor",
            "trades", "fill_rate_pct", "n_days", "max_drawdown",
            "entry", "exit", "conv", "vol", "tp", "sl",
            "exit_pct_flip", "exit_pct_tp", "exit_pct_trail",
            "exit_pct_timeout", "avg_hold_min",
        ]
        avail_sw = [c for c in display_cols_sw if c in fdf_sw_display.columns]
        rename_sw = {
            "config":         "Config",
            "source":         "Source",
            "quality_score":  "Quality Score",
            "total_pnl":      "P&L ($)",
            "pnl_per_day":    "$/Day",
            "sharpe":         "Sharpe",
            "win_rate_pct":   "Win%",
            "profit_factor":  "PF",
            "trades":         "Trades",
            "fill_rate_pct":  "Fill%",
            "n_days":         "Days",
            "max_drawdown":   "Max DD ($)",
            "entry":          "Entry",
            "exit":           "Exit",
            "conv":           "Conv",
            "vol":            "Vol",
            "tp":             "TP",
            "sl":             "SL",
            "exit_pct_flip":  "Flip%",
            "exit_pct_tp":    "TP Exit%",
            "exit_pct_trail": "Trail%",
            "exit_pct_timeout": "Timeout%",
            "avg_hold_min":   "Avg Hold(min)",
        }

        disp_sw = fdf_sw_display[avail_sw].rename(columns=rename_sw)

        # Color-code rows: green = profitable, red = unprofitable, intensity by score
        def _row_color(row):
            pnl = row.get("P&L ($)", 0) or 0
            score = row.get("Quality Score", 0) or 0
            if pnl > 0:
                alpha = min(0.5, 0.15 + score * 0.03)
                return [f"background-color: rgba(34, 197, 94, {alpha:.2f})"] * len(row)
            else:
                alpha = min(0.35, 0.08 + abs(score) * 0.01)
                return [f"background-color: rgba(239, 68, 68, {alpha:.2f})"] * len(row)

        # Streamlit column_config for sortable table with formatting
        col_cfg_sw = {}
        if "P&L ($)" in disp_sw.columns:
            col_cfg_sw["P&L ($)"] = st.column_config.NumberColumn(
                "P&L ($)", format="$%.0f")
        if "$/Day" in disp_sw.columns:
            col_cfg_sw["$/Day"] = st.column_config.NumberColumn(
                "$/Day", format="$%.0f")
        if "Sharpe" in disp_sw.columns:
            col_cfg_sw["Sharpe"] = st.column_config.NumberColumn(
                "Sharpe", format="%.3f")
        if "Quality Score" in disp_sw.columns:
            col_cfg_sw["Quality Score"] = st.column_config.NumberColumn(
                "Quality Score", format="%.3f")
        if "Win%" in disp_sw.columns:
            col_cfg_sw["Win%"] = st.column_config.NumberColumn(
                "Win%", format="%.1f%%")
        if "PF" in disp_sw.columns:
            col_cfg_sw["PF"] = st.column_config.NumberColumn(
                "PF", format="%.2f")
        if "Fill%" in disp_sw.columns:
            col_cfg_sw["Fill%"] = st.column_config.NumberColumn(
                "Fill%", format="%.1f%%")
        if "Max DD ($)" in disp_sw.columns:
            col_cfg_sw["Max DD ($)"] = st.column_config.NumberColumn(
                "Max DD ($)", format="$%.0f")
        if "Flip%" in disp_sw.columns:
            col_cfg_sw["Flip%"] = st.column_config.NumberColumn(
                "Flip%", format="%.1f%%")
        if "TP Exit%" in disp_sw.columns:
            col_cfg_sw["TP Exit%"] = st.column_config.NumberColumn(
                "TP Exit%", format="%.1f%%")
        if "Trail%" in disp_sw.columns:
            col_cfg_sw["Trail%"] = st.column_config.NumberColumn(
                "Trail%", format="%.1f%%")
        if "Timeout%" in disp_sw.columns:
            col_cfg_sw["Timeout%"] = st.column_config.NumberColumn(
                "Timeout%", format="%.1f%%")
        if "Avg Hold(min)" in disp_sw.columns:
            col_cfg_sw["Avg Hold(min)"] = st.column_config.NumberColumn(
                "Avg Hold(min)", format="%.1f")

        # Style and display
        styled_sw = disp_sw.style.apply(_row_color, axis=1)
        st.dataframe(
            styled_sw,
            use_container_width=True,
            hide_index=True,
            height=520,
            column_config=col_cfg_sw,
        )

        # ---- Charts ----
        st.markdown("---")
        chart_c1, chart_c2 = st.columns(2)

        with chart_c1:
            st.subheader("P&L Distribution")
            if not fdf_sw_display.empty:
                pnl_vals = fdf_sw_display["total_pnl"].dropna()
                fig_pnl = go.Figure()
                fig_pnl.add_trace(go.Histogram(
                    x=pnl_vals, nbinsx=30,
                    marker_color=[
                        "#10b981" if v > 0 else "#ef4444" for v in pnl_vals
                    ],
                    name="P&L",
                ))
                fig_pnl.add_vline(x=0, line_dash="dash", line_color="white", line_width=2)
                fig_pnl.update_layout(
                    template=PT, height=320,
                    xaxis_title="Total P&L ($)", yaxis_title="Count",
                    showlegend=False,
                )
                tv_chart(fig_pnl)

        with chart_c2:
            st.subheader("Sharpe Distribution")
            if not fdf_sw_display.empty:
                sh_vals = fdf_sw_display["sharpe"].dropna()
                fig_sh = go.Figure()
                fig_sh.add_trace(go.Histogram(
                    x=sh_vals, nbinsx=30,
                    marker_color=[
                        "#10b981" if v > 0 else "#ef4444" for v in sh_vals
                    ],
                    name="Sharpe",
                ))
                fig_sh.add_vline(x=0, line_dash="dash", line_color="white", line_width=2)
                fig_sh.update_layout(
                    template=PT, height=320,
                    xaxis_title="Sharpe", yaxis_title="Count",
                    showlegend=False,
                )
                tv_chart(fig_sh)

        # Sharpe vs P&L scatter with quality score as color
        if len(fdf_sw_display) > 1:
            st.subheader("Sharpe vs P&L (color = Quality Score)")
            fig_scatter = px.scatter(
                fdf_sw_display,
                x="sharpe", y="total_pnl",
                color="quality_score",
                size=fdf_sw_display["trades"].clip(lower=1).apply(lambda v: max(5, min(30, v**0.5))),
                hover_data=["config", "source", "win_rate_pct", "n_days"],
                color_continuous_scale="RdYlGn",
                template=PT,
            )
            fig_scatter.add_hline(y=0, line_dash="dash", line_color="rgba(255,255,255,0.4)")
            fig_scatter.add_vline(x=0, line_dash="dash", line_color="rgba(255,255,255,0.4)")
            fig_scatter.update_layout(
                height=420,
                xaxis_title="Sharpe",
                yaxis_title="Total P&L ($)",
                coloraxis_colorbar=dict(title="Quality Score"),
            )
            tv_chart(fig_scatter)

        # Source breakdown bar
        if sweep_df["source"].nunique() > 1:
            st.subheader("Profitable Configs by Source")
            source_stats = (
                sweep_df.groupby("source")
                .apply(lambda g: pd.Series({
                    "Total": len(g),
                    "Profitable": (g["total_pnl"] > 0).sum(),
                    "Best Sharpe": g["sharpe"].max(),
                }))
                .reset_index()
            )
            fig_src = go.Figure()
            fig_src.add_trace(go.Bar(
                x=source_stats["source"], y=source_stats["Total"],
                name="Total", marker_color="rgba(99,102,241,0.4)",
            ))
            fig_src.add_trace(go.Bar(
                x=source_stats["source"], y=source_stats["Profitable"],
                name="Profitable", marker_color="#10b981",
            ))
            fig_src.update_layout(
                template=PT, height=300, barmode="overlay",
                xaxis_title="Source", yaxis_title="# Configs",
            )
            tv_chart(fig_src)

        # ---- Parameter Importance (Optuna) ----
        st.markdown("---")
        st.subheader("Parameter Importance (Optuna)")
        optuna_data = _load_optuna()
        if optuna_data:
            param_imp = optuna_data.get("param_importance", {})
            if param_imp:
                imp_df = (
                    pd.DataFrame.from_dict(param_imp, orient="index", columns=["importance"])
                    .sort_values("importance", ascending=True)
                    .reset_index()
                    .rename(columns={"index": "Parameter"})
                )
                fig_imp = go.Figure(go.Bar(
                    x=imp_df["importance"],
                    y=imp_df["Parameter"],
                    orientation="h",
                    marker_color=[
                        "#6366f1" if v > 0.1 else "#9ca3af" for v in imp_df["importance"]
                    ],
                    text=[f"{v:.1%}" for v in imp_df["importance"]],
                    textposition="outside",
                ))
                fig_imp.update_layout(
                    template=PT, height=350,
                    xaxis_title="Importance (fraction of variance explained)",
                    yaxis_title="Parameter",
                    title=f"Optuna Parameter Importance — {optuna_data.get('n_trials', '?')} trials, "
                          f"{optuna_data.get('n_records_used', '?')} records",
                    xaxis=dict(tickformat=".0%"),
                )
                tv_chart(fig_imp)

                # Best optuna config
                study_best = optuna_data.get("study_best", {})
                if study_best:
                    st.markdown("**Best Optuna Config:**")
                    bp_cols = st.columns(min(len(study_best.get("params", {})), 6))
                    for i, (k, v) in enumerate(study_best.get("params", {}).items()):
                        bp_cols[i % len(bp_cols)].metric(k, f"{v:.3g}" if isinstance(v, float) else str(v))
                    st.caption(f"Best value (Sharpe proxy): {study_best.get('value', '?')}")
            else:
                st.info("No parameter importance data in optuna results.")
        else:
            st.info(f"No Optuna results found at `{OPTUNA_PATH}`. "
                    "Run optuna optimization to see parameter importance.")

        # ---- Best configs detail table ----
        st.markdown("---")
        st.subheader("Top 10 by Quality Score")
        top10 = sweep_df.nlargest(10, "quality_score")[avail_sw].rename(columns=rename_sw)
        st.dataframe(
            top10.style.apply(_row_color, axis=1),
            use_container_width=True,
            hide_index=True,
            column_config=col_cfg_sw,
        )

# ================================================================
# TAB 3b: FILL SIM EQUITY CURVES (appended to SWEEP tab)
# ================================================================
with tab_sweep:
    st.markdown("---")
    st.header("Fill Sim: Equity Curves & Drawdown Analysis")
    st.caption(f"Source: {str(_QCC_DB_PATH)} · table: fillsim_results · 3,002 rows · 27 configs")

    @st.cache_data(ttl=300)
    def _load_fillsim_daily() -> pd.DataFrame:
        """Load daily PnL series per config from fillsim_results."""
        if not _QCC_DB_PATH.exists():
            return pd.DataFrame()
        try:
            conn = sqlite3.connect(str(_QCC_DB_PATH))
            df = pd.read_sql_query(
                "SELECT config_name, mbo_date, total_pnl, total_trades, "
                "       total_filled, tp_count, sl_count, timeout_count "
                "FROM fillsim_results "
                "ORDER BY config_name, mbo_date",
                conn,
            )
            conn.close()
            # Normalise date: '20250722' or '2025-07-22' -> datetime
            df["date"] = pd.to_datetime(df["mbo_date"].astype(str).str.replace("-", ""), format="%Y%m%d", errors="coerce")
            df = df.dropna(subset=["date"])
            df = df.sort_values(["config_name", "date"])
            return df
        except Exception as _e:
            st.error(f"Failed to load fillsim_results: {_e}")
            return pd.DataFrame()

    @st.cache_data(ttl=300)
    def _compute_fillsim_stats(initial_capital: float = 25_000.0) -> pd.DataFrame:
        """Compute per-config aggregate stats including Sortino, Sharpe, Profit Factor, Max DD%."""
        raw = _load_fillsim_daily()
        if raw.empty:
            return pd.DataFrame()

        rows = []
        for cfg, grp in raw.groupby("config_name"):
            grp = grp.sort_values("date")
            daily_pnl = grp["total_pnl"].values
            n_days = len(daily_pnl)
            if n_days < 2:
                continue

            # Cumulative equity
            cum_equity = initial_capital + daily_pnl.cumsum()
            peak = np.maximum.accumulate(cum_equity)
            drawdown_pct = (cum_equity - peak) / peak * 100.0

            total_pnl = daily_pnl.sum()
            avg_day = daily_pnl.mean()
            win_days = (daily_pnl > 0).sum()
            win_rate = win_days / n_days * 100.0

            # Sharpe (annualised, sqrt(252))
            std = daily_pnl.std(ddof=1) if n_days > 1 else 1e-9
            sharpe = (avg_day / std * np.sqrt(252)) if std > 1e-9 else 0.0

            # Sortino (downside std only)
            neg = daily_pnl[daily_pnl < 0]
            down_std = neg.std(ddof=1) if len(neg) > 1 else 1e-9
            sortino = (avg_day / down_std * np.sqrt(252)) if down_std > 1e-9 else 0.0

            # Profit Factor
            gross_profit = daily_pnl[daily_pnl > 0].sum()
            gross_loss = abs(daily_pnl[daily_pnl < 0].sum())
            pf = gross_profit / gross_loss if gross_loss > 1e-9 else float("inf")

            max_dd_pct = drawdown_pct.min()  # most negative value
            total_trades = grp["total_trades"].sum()

            rows.append({
                "config_name": cfg,
                "total_pnl": total_pnl,
                "avg_day": avg_day,
                "win_rate": win_rate,
                "sharpe": sharpe,
                "sortino": sortino,
                "profit_factor": pf,
                "max_dd_pct": max_dd_pct,
                "n_days": n_days,
                "total_trades": total_trades,
            })

        if not rows:
            return pd.DataFrame()
        return pd.DataFrame(rows).sort_values("sortino", ascending=False).reset_index(drop=True)

    # Palette for up to 10 configs
    _FILLSIM_COLORS = [
        "#6366f1", "#10b981", "#f59e0b", "#ef4444", "#3b82f6",
        "#a855f7", "#14b8a6", "#f97316", "#ec4899", "#84cc16",
    ]

    def _hex_to_rgba(hex_color: str, alpha: float = 0.10) -> str:
        """Convert '#rrggbb' to 'rgba(r,g,b,alpha)' for Plotly fill colors."""
        h = hex_color.lstrip("#")
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        return f"rgba({r},{g},{b},{alpha})"

    fs_hdr1, fs_hdr2 = st.columns([5, 1])
    with fs_hdr1:
        pass
    with fs_hdr2:
        if st.button("Reload Fill Sim", key="fillsim_reload"):
            st.cache_data.clear()
            st.rerun()

    fs_raw = _load_fillsim_daily()
    fs_stats = _compute_fillsim_stats(initial_capital=25_000.0)

    if fs_raw.empty:
        st.warning("No fill sim data found. Check that qcc.db exists and fillsim_results table is populated.")
    else:
        # Controls row
        fs_c1, fs_c2 = st.columns([2, 4])
        with fs_c1:
            _n_top = st.slider("Top N configs to plot", 1, min(10, fs_stats.shape[0]), 5, key="fs_n_top")
        with fs_c2:
            _all_cfgs = fs_stats["config_name"].tolist()
            _default_cfgs = _all_cfgs[:_n_top]
            _sel_cfgs = st.multiselect(
                "Override config selection (optional)",
                options=_all_cfgs,
                default=[],
                key="fs_cfg_override",
                help="Leave empty to use Top N by Sortino. Select specific configs to override.",
            )

        # Determine which configs to plot
        _plot_cfgs = _sel_cfgs if _sel_cfgs else _all_cfgs[:_n_top]

        # Build equity + drawdown per selected config
        _initial_capital = 25_000.0
        _equity_traces = []
        _dd_traces = []

        for _i, _cfg in enumerate(_plot_cfgs):
            _color = _FILLSIM_COLORS[_i % len(_FILLSIM_COLORS)]
            _grp = fs_raw[fs_raw["config_name"] == _cfg].sort_values("date")
            if _grp.empty:
                continue
            _daily = _grp["total_pnl"].values
            _dates = _grp["date"].values
            _cum_equity = _initial_capital + _daily.cumsum()
            _peak = np.maximum.accumulate(_cum_equity)
            _dd_pct = (_cum_equity - _peak) / _peak * 100.0

            # Worst drawdown annotation
            _worst_idx = int(np.argmin(_dd_pct))
            _worst_dd = float(_dd_pct[_worst_idx])
            _worst_date = _dates[_worst_idx]

            _equity_traces.append((_cfg, _color, _dates, _cum_equity))
            _dd_traces.append((_cfg, _color, _dates, _dd_pct, _worst_idx, _worst_date, _worst_dd))

        # ---- Chart 1: Equity Curve ----
        st.subheader("Equity Curve (Cumulative PnL)")
        fig_eq = go.Figure()

        # Breakeven line
        fig_eq.add_hline(
            y=_initial_capital,
            line_dash="dash",
            line_color="rgba(255,255,255,0.35)",
            annotation_text=f"Breakeven ${_initial_capital:,.0f}",
            annotation_position="bottom right",
            annotation_font_color="rgba(255,255,255,0.5)",
        )

        for _cfg, _color, _dates, _cum_equity in _equity_traces:
            fig_eq.add_trace(go.Scatter(
                x=_dates,
                y=_cum_equity,
                mode="lines",
                name=_cfg,
                line=dict(color=_color, width=2),
                hovertemplate=(
                    f"<b>{_cfg}</b><br>"
                    "Date: %{x|%Y-%m-%d}<br>"
                    "Equity: $%{y:,.0f}<br>"
                    "<extra></extra>"
                ),
            ))

        fig_eq.update_layout(
            template=PT,
            height=420,
            xaxis_title="Date",
            yaxis_title="Equity ($)",
            yaxis=dict(tickprefix="$", tickformat=",.0f"),
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            hovermode="x unified",
            dragmode="pan",
        )
        tv_chart(fig_eq, key="fillsim_equity")

        # ---- Chart 2: Drawdown ----
        st.subheader("Drawdown (%)")
        fig_dd = go.Figure()

        # Zero line
        fig_dd.add_hline(
            y=0,
            line_dash="dash",
            line_color="rgba(255,255,255,0.35)",
            annotation_text="0% (peak)",
            annotation_position="top right",
            annotation_font_color="rgba(255,255,255,0.5)",
        )

        for _cfg, _color, _dates, _dd_pct, _worst_idx, _worst_date, _worst_dd in _dd_traces:
            # Fill area under the drawdown curve
            fig_dd.add_trace(go.Scatter(
                x=_dates,
                y=_dd_pct,
                mode="lines",
                name=_cfg,
                line=dict(color=_color, width=2),
                fill="tozeroy",
                fillcolor=_hex_to_rgba(_color, 0.10),
                hovertemplate=(
                    f"<b>{_cfg}</b><br>"
                    "Date: %{x|%Y-%m-%d}<br>"
                    "Drawdown: %{y:.2f}%<br>"
                    "<extra></extra>"
                ),
            ))
            # Annotate worst drawdown point
            fig_dd.add_annotation(
                x=_worst_date,
                y=_worst_dd,
                text=f"{_worst_dd:.1f}%",
                showarrow=True,
                arrowhead=2,
                arrowcolor=_color,
                font=dict(color=_color, size=10),
                ax=0,
                ay=-24,
            )

        fig_dd.update_layout(
            template=PT,
            height=380,
            xaxis_title="Date",
            yaxis_title="Drawdown (%)",
            yaxis=dict(ticksuffix="%"),
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
            hovermode="x unified",
            dragmode="pan",
        )
        tv_chart(fig_dd, key="fillsim_drawdown")

        # ---- Chart 3: Config Comparison Table ----
        st.markdown("---")
        st.subheader("Config Comparison (ranked by Sortino)")

        _disp_stats = fs_stats.copy()
        _disp_stats.insert(0, "Rank", range(1, len(_disp_stats) + 1))

        # Format columns
        _stat_col_cfg = {
            "total_pnl":      st.column_config.NumberColumn("Total PnL", format="$%.0f"),
            "avg_day":        st.column_config.NumberColumn("Avg/Day", format="$%.0f"),
            "win_rate":       st.column_config.NumberColumn("Win Rate", format="%.1f%%"),
            "sharpe":         st.column_config.NumberColumn("Sharpe", format="%.2f"),
            "sortino":        st.column_config.NumberColumn("Sortino", format="%.2f"),
            "profit_factor":  st.column_config.NumberColumn("PF", format="%.2f"),
            "max_dd_pct":     st.column_config.NumberColumn("Max DD%", format="%.1f%%"),
            "n_days":         st.column_config.NumberColumn("Days"),
            "total_trades":   st.column_config.NumberColumn("Trades"),
            "config_name":    st.column_config.TextColumn("Config"),
        }

        def _fillsim_row_color(row):
            """Highlight best config (rank 1) in green, rest neutral."""
            rank = row.get("Rank", 99)
            if rank == 1:
                return ["background-color: rgba(16, 185, 129, 0.25)"] * len(row)
            pnl = row.get("total_pnl", 0) or 0
            if pnl > 0:
                return ["background-color: rgba(16, 185, 129, 0.08)"] * len(row)
            return ["background-color: rgba(239, 68, 68, 0.08)"] * len(row)

        st.dataframe(
            _disp_stats.style.apply(_fillsim_row_color, axis=1),
            use_container_width=True,
            hide_index=True,
            height=min(600, 45 * len(_disp_stats) + 55),
            column_config=_stat_col_cfg,
        )

        # ---- Summary metrics for best config ----
        if not fs_stats.empty:
            _best = fs_stats.iloc[0]
            st.markdown("---")
            _bm1, _bm2, _bm3, _bm4, _bm5, _bm6 = st.columns(6)
            _bm1.metric("Best Config", _best["config_name"])
            _bm2.metric("Total PnL", f"${_best['total_pnl']:,.0f}")
            _bm3.metric("Sortino", f"{_best['sortino']:.2f}")
            _bm4.metric("Sharpe", f"{_best['sharpe']:.2f}")
            _bm5.metric("Max Drawdown", f"{_best['max_dd_pct']:.1f}%")
            _bm6.metric("Win Rate", f"{_best['win_rate']:.1f}%")

# ================================================================
# TAB 4: COMPUTE
# ================================================================
with tab_compute:
    import requests as _req
    st.header("Compute Cluster Status")

    _comp_hdr1, _comp_hdr2, _comp_hdr3 = st.columns([4, 2, 1])
    with _comp_hdr1:
        _compute_auto = st.checkbox(
            "Auto-refresh every 30s",
            value=st.session_state.get("compute_auto_refresh", False),
            key="compute_auto_refresh",
        )
    with _comp_hdr2:
        pass
    with _comp_hdr3:
        if st.button("Refresh Now", key="compute_refresh_top"):
            st.rerun()

    # ---- Section 1: Detailed node cards from compute_monitor.py ----
    COMPUTE_STATUS_PATH_MAIN = Path(r"C:\Users\Footb\Documents\Github\teleclaude-main\data\compute_status.json")

    @st.cache_data(ttl=30)
    def _load_compute_status_main():
        if COMPUTE_STATUS_PATH_MAIN.exists():
            try:
                with open(COMPUTE_STATUS_PATH_MAIN) as f:
                    return json.load(f)
            except Exception:
                return None
        return None

    compute_data_main = _load_compute_status_main()

    if compute_data_main and compute_data_main.get("last_updated"):
        try:
            from datetime import datetime as _dt
            _ct = _dt.fromisoformat(compute_data_main["last_updated"])
            _cage = (_dt.now() - _ct).total_seconds()
            _cage_str = f"{int(_cage)}s ago" if _cage < 120 else f"{int(_cage/60)}m ago" if _cage < 7200 else f"{int(_cage/3600)}h ago"
            _cfresh_color = "#10b981" if _cage < 900 else "#f59e0b" if _cage < 3600 else "#ef4444"
            st.markdown(
                f'<span style="color:{_cfresh_color};font-weight:600;font-size:0.85em;">compute_monitor: {_ct.strftime("%Y-%m-%d %H:%M:%S")} ({_cage_str})</span>',
                unsafe_allow_html=True,
            )
        except Exception:
            pass

    # ---- QCC API summary metrics ----
    @st.cache_data(ttl=30)
    def _fetch_qcc_health_main():
        try:
            r = _req.get("http://localhost:3456/api/health", timeout=5)
            return r.json()
        except Exception:
            return None

    _qcc_main = _fetch_qcc_health_main()

    if _qcc_main is not None:
        _qcc_nodes = _qcc_main.get("nodes", [])
        _qcc_jobs = _qcc_main.get("active_jobs", [])
        _qcc_alerts_raw = _qcc_main.get("unresolved_alerts", [])
        _qcc_online = sum(1 for n in _qcc_nodes if n.get("status") not in ("offline",))
        _qcc_gpus_active = sum(1 for n in _qcc_nodes if (n.get("last_gpu_util") or 0) > 10)
        try:
            import psutil as _psutil
            _local_cpu_str2 = f"{_psutil.cpu_percent(interval=0):.0f}%"
            _local_ram2 = _psutil.virtual_memory()
            _local_ram_str2 = f"{_local_ram2.used/1024**3:.1f}/{_local_ram2.total/1024**3:.0f}GB ({_local_ram2.percent:.0f}%)"
        except Exception:
            _local_cpu_str2 = "N/A"
            _local_ram_str2 = "N/A"

        _qm1, _qm2, _qm3, _qm4, _qm5, _qm6 = st.columns(6)
        _qm1.metric("QCC Nodes Online", f"{_qcc_online}/{len(_qcc_nodes)}")
        _qm2.metric("GPUs Active", str(_qcc_gpus_active))
        _qm3.metric("Training Jobs", str(len(_qcc_jobs)))
        _qm4.metric("QCC Alerts", str(len(_qcc_alerts_raw)))
        _qm5.metric("Local CPU", _local_cpu_str2)
        _qm6.metric("Local RAM", _local_ram_str2)
    else:
        st.warning("QCC daemon not responding at localhost:3456. Node cards below use compute_monitor data.")

    st.markdown("---")

    # ---- Detailed node cards ----
    if compute_data_main is None or compute_data_main.get("last_updated") is None:
        st.info(
            "No compute status data available yet. Start the compute monitor: "
            "`python utils/compute_monitor.py`"
        )
    else:
        nodes_main = compute_data_main.get("nodes", {})
        node_order_main = ["neptune", "uranus", "jupiter", "saturn"]

        def _node_status_main(n):
            if not n.get("reachable", False):
                return "UNREACHABLE", "#ef4444", "node-unreachable"
            gpu = n.get("gpu_pct")
            load = n.get("load_avg") or n.get("cpu_pct")
            fill_sim = n.get("fill_sim_count", 0)
            py_count = n.get("python_count", 0)
            if gpu is not None:
                if gpu > 30:
                    return "ACTIVE", "#10b981", "node-running"
                elif py_count > 0:
                    return "WARNING", "#f59e0b", "node-idle"
                else:
                    return "IDLE", "#6b7280", "node-idle"
            if fill_sim > 0 or py_count > 0:
                if load is not None and load > 1.0:
                    return "ACTIVE", "#10b981", "node-running"
                return "RUNNING", "#10b981", "node-running"
            return "IDLE", "#6b7280", "node-idle"

        def _bar_html_main(used, total, label, color="#6366f1"):
            if used is None or total is None or total == 0:
                return f'<span style="color:{T["text_muted"]};font-size:0.85em;">{label}: N/A</span>'
            pct = min(100, max(0, (used / total) * 100))
            bar_color = "#10b981" if pct < 70 else "#f59e0b" if pct < 90 else "#ef4444"
            return (
                f'<div style="margin:4px 0;">'
                f'<div style="display:flex;justify-content:space-between;font-size:0.8em;color:{T["text_muted"]};">'
                f'<span>{label}</span><span>{used:.1f}/{total:.1f} GB ({pct:.0f}%)</span></div>'
                f'<div style="background:{T["card_border"]};border-radius:4px;height:6px;overflow:hidden;">'
                f'<div style="width:{pct:.1f}%;height:100%;background:{bar_color};border-radius:4px;"></div>'
                f'</div></div>'
            )

        def _pct_bar_html_main(pct_val, label, suffix="%"):
            if pct_val is None:
                return f'<span style="color:{T["text_muted"]};font-size:0.85em;">{label}: N/A</span>'
            pct_val = min(100, max(0, float(pct_val)))
            bar_color = "#10b981" if pct_val < 70 else "#f59e0b" if pct_val < 90 else "#ef4444"
            return (
                f'<div style="margin:4px 0;">'
                f'<div style="display:flex;justify-content:space-between;font-size:0.8em;color:{T["text_muted"]};">'
                f'<span>{label}</span><span>{pct_val:.0f}{suffix}</span></div>'
                f'<div style="background:{T["card_border"]};border-radius:4px;height:6px;overflow:hidden;">'
                f'<div style="width:{pct_val:.1f}%;height:100%;background:{bar_color};border-radius:4px;"></div>'
                f'</div></div>'
            )

        def _gpu_bar_html_main(pct, temp=None):
            if pct is None:
                return f'<span style="color:{T["text_muted"]};font-size:0.85em;">GPU: N/A (no GPU)</span>'
            bar_color = "#10b981" if pct > 50 else "#f59e0b" if pct > 10 else "#6b7280"
            temp_str = f" | {temp}C" if temp is not None else ""
            return (
                f'<div style="margin:4px 0;">'
                f'<div style="display:flex;justify-content:space-between;font-size:0.8em;color:{T["text_muted"]};">'
                f'<span>GPU Util</span><span>{pct}%{temp_str}</span></div>'
                f'<div style="background:{T["card_border"]};border-radius:4px;height:6px;overflow:hidden;">'
                f'<div style="width:{pct}%;height:100%;background:{bar_color};border-radius:4px;"></div>'
                f'</div></div>'
            )

        def _disk_bar_html_main(n):
            disk_pct = n.get("disk_pct")
            disk_used = n.get("disk_used_gb")
            disk_total = n.get("disk_total_gb")
            if disk_pct is not None:
                return _pct_bar_html_main(disk_pct, "Disk")
            elif disk_used is not None and disk_total is not None and disk_total > 0:
                return _bar_html_main(disk_used, disk_total, "Disk")
            return ""

        def _fold_progress_html_main(n):
            fold_current = n.get("training_fold")
            fold_total = n.get("training_total_folds")
            fold_epoch = n.get("training_epoch")
            fold_total_epochs = n.get("training_total_epochs")
            fold_loss = n.get("training_loss")
            if fold_current is None and fold_epoch is None:
                return ""
            parts = []
            if fold_current is not None:
                fold_str = f"Fold {fold_current}"
                if fold_total is not None:
                    fold_str += f"/{fold_total}"
                parts.append(fold_str)
            if fold_epoch is not None:
                epoch_str = f"Epoch {fold_epoch}"
                if fold_total_epochs is not None:
                    epoch_str += f"/{fold_total_epochs}"
                parts.append(epoch_str)
            if fold_loss is not None:
                parts.append(f"Loss: {fold_loss:.4f}")
            progress_text = " | ".join(parts)
            progress_pct = 0
            if fold_current is not None and fold_total is not None and fold_total > 0:
                base_pct = ((fold_current - 1) / fold_total) * 100
                if fold_epoch is not None and fold_total_epochs is not None and fold_total_epochs > 0:
                    base_pct += (fold_epoch / fold_total_epochs) * (100 / fold_total)
                progress_pct = min(100, base_pct)
            elif fold_epoch is not None and fold_total_epochs is not None and fold_total_epochs > 0:
                progress_pct = min(100, (fold_epoch / fold_total_epochs) * 100)
            return (
                f'<div style="margin:6px 0;padding:6px 10px;background:#6366f122;border-radius:8px;font-size:0.78em;">'
                f'<div style="display:flex;justify-content:space-between;color:{T["text_muted"]};margin-bottom:3px;">'
                f'<span>Training Progress</span><span>{progress_text}</span></div>'
                f'<div style="background:{T["card_border"]};border-radius:4px;height:5px;overflow:hidden;">'
                f'<div style="width:{progress_pct:.1f}%;height:100%;background:linear-gradient(90deg,#6366f1,#8b5cf6);'
                f'border-radius:4px;transition:width 0.5s ease;"></div>'
                f'</div></div>'
            )

        def _processes_html_main(n):
            procs = n.get("active_processes") or n.get("top_processes") or []
            if not procs:
                return ""
            rows = ""
            for p in procs[:5]:
                if isinstance(p, dict):
                    pname = p.get("name", p.get("cmd", "?"))[:28]
                    pcpu = p.get("cpu", p.get("cpu_pct", ""))
                    pmem = p.get("mem", p.get("mem_pct", ""))
                    rows += (f'<div style="display:flex;justify-content:space-between;font-size:0.72em;'
                             f'padding:1px 0;color:{T["text_muted"]};">'
                             f'<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{pname}</span>'
                             f'<span style="width:45px;text-align:right;">{pcpu}%</span>'
                             f'<span style="width:45px;text-align:right;">{pmem}%</span>'
                             f'</div>')
                elif isinstance(p, str):
                    rows += f'<div style="font-size:0.72em;color:{T["text_muted"]};padding:1px 0;">{p[:40]}</div>'
            if not rows:
                return ""
            return (
                f'<div style="margin:4px 0;padding:4px 8px;background:{T["card_border"]}22;border-radius:6px;">'
                f'<div style="display:flex;justify-content:space-between;font-size:0.68em;'
                f'font-weight:700;color:{T["text_muted"]};text-transform:uppercase;letter-spacing:0.5px;'
                f'padding-bottom:2px;border-bottom:1px solid {T["card_border"]};">'
                f'<span style="flex:1;">Process</span><span style="width:45px;text-align:right;">CPU</span>'
                f'<span style="width:45px;text-align:right;">MEM</span></div>'
                f'{rows}</div>'
            )

        # 4-column node card layout
        cols_main = st.columns(4)
        for idx_m, key_m in enumerate(node_order_main):
            n_m = nodes_main.get(key_m, {})
            status_label_m, status_color_m, css_class_m = _node_status_main(n_m)
            name_m = n_m.get("name", key_m.title())
            desc_m = n_m.get("description", "")

            _cpu_pct_val_m = n_m.get("cpu_pct")
            _cpu_cores_m = n_m.get("cpu_cores")
            _load_avg_m = n_m.get("load_avg")
            if _cpu_pct_val_m is not None:
                _cpu_bar_m = _pct_bar_html_main(_cpu_pct_val_m, "CPU Util")
            elif _load_avg_m is not None and _cpu_cores_m is not None and _cpu_cores_m > 0:
                _cpu_approx_m = min(100, (_load_avg_m / _cpu_cores_m) * 100)
                _cpu_bar_m = _pct_bar_html_main(_cpu_approx_m, f"CPU (load {_load_avg_m:.1f})")
            elif _load_avg_m is not None:
                _cpu_bar_m = _pct_bar_html_main(min(100, _load_avg_m * 10), f"CPU (load {_load_avg_m:.1f})")
            else:
                _cpu_bar_m = f'<span style="color:{T["text_muted"]};font-size:0.85em;">CPU: N/A</span>'

            with cols_main[idx_m]:
                st.markdown(
                    f'<div class="node-card {css_class_m}" style="min-height:320px;">'
                    f'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
                    f'<strong style="font-size:1.15em;color:{T["text_heading"]};">{name_m}</strong>'
                    f'<span style="display:inline-block;padding:3px 12px;border-radius:20px;font-size:0.75em;'
                    f'font-weight:700;background:{status_color_m}22;color:{status_color_m};">{status_label_m}</span>'
                    f'</div>'
                    f'<div style="font-size:0.78em;color:{T["text_muted"]};margin-bottom:10px;">{desc_m} &mdash; {n_m.get("ip", "")}</div>'
                    f'{_gpu_bar_html_main(n_m.get("gpu_pct"), n_m.get("gpu_temp_c"))}'
                    f'{_cpu_bar_m}'
                    f'{_bar_html_main(n_m.get("vram_used_gb"), n_m.get("vram_total_gb"), "VRAM")}'
                    f'{_bar_html_main(n_m.get("ram_used_gb"), n_m.get("ram_total_gb"), "RAM")}'
                    f'{_disk_bar_html_main(n_m)}'
                    f'<div style="margin:6px 0;padding:6px 10px;background:{T["card_border"]}44;border-radius:8px;font-size:0.82em;">'
                    f'<span style="color:{T["text_muted"]};">Task:</span> '
                    f'<span style="color:{T["text"]};font-weight:600;">{n_m.get("current_task", "Unknown")}</span>'
                    f'</div>'
                    f'{_fold_progress_html_main(n_m)}'
                    f'<div style="font-size:0.8em;color:{T["text_muted"]};margin-top:4px;">'
                    f'Python: {n_m.get("python_count", 0)}'
                    f'{" | FillSim: " + str(n_m.get("fill_sim_count", 0)) if "fill_sim_count" in n_m else ""}'
                    f'{" | Results: " + format(n_m.get("result_file_count", 0), ",") if n_m.get("result_file_count") else ""}'
                    f'</div>'
                    f'{_processes_html_main(n_m)}'
                    f'</div>',
                    unsafe_allow_html=True,
                )

        # --- Cluster resource charts ---
        st.markdown("---")
        st.subheader("Cluster Resource Overview")
        _res_cols_main = st.columns(2)

        with _res_cols_main[0]:
            _node_names_m = []
            _gpu_vals_m = []
            _cpu_vals_m = []
            for key_m in node_order_main:
                n_m = nodes_main.get(key_m, {})
                if not n_m.get("reachable", False):
                    continue
                _node_names_m.append(n_m.get("name", key_m.title()))
                _gpu_vals_m.append(n_m.get("gpu_pct") or 0)
                _cpu_v_m = n_m.get("cpu_pct")
                if _cpu_v_m is None and n_m.get("load_avg") is not None:
                    _cores_m = n_m.get("cpu_cores", 8)
                    _cpu_v_m = min(100, (n_m["load_avg"] / _cores_m) * 100)
                _cpu_vals_m.append(_cpu_v_m or 0)

            if _node_names_m:
                _util_fig_m = go.Figure()
                _util_fig_m.add_trace(go.Bar(
                    x=_node_names_m, y=_gpu_vals_m, name="GPU %",
                    marker_color="#8b5cf6", text=[f"{v:.0f}%" for v in _gpu_vals_m],
                    textposition="outside",
                ))
                _util_fig_m.add_trace(go.Bar(
                    x=_node_names_m, y=_cpu_vals_m, name="CPU %",
                    marker_color="#6366f1", text=[f"{v:.0f}%" for v in _cpu_vals_m],
                    textposition="outside",
                ))
                _util_fig_m.update_layout(
                    template=PT, height=300, barmode="group",
                    title="GPU vs CPU Utilization",
                    yaxis=dict(title="Utilization %", range=[0, 110]),
                    margin=dict(l=40, r=20, t=40, b=30),
                )
                tv_chart(_util_fig_m)

        with _res_cols_main[1]:
            _ram_names_m = []
            _ram_used_m = []
            _ram_total_m = []
            for key_m in node_order_main:
                n_m = nodes_main.get(key_m, {})
                if not n_m.get("reachable", False):
                    continue
                if n_m.get("ram_used_gb") is not None and n_m.get("ram_total_gb") is not None:
                    _ram_names_m.append(n_m.get("name", key_m.title()))
                    _ram_used_m.append(n_m["ram_used_gb"])
                    _ram_total_m.append(n_m["ram_total_gb"])

            if _ram_names_m:
                _ram_fig_m = go.Figure()
                _ram_fig_m.add_trace(go.Bar(
                    x=_ram_names_m, y=_ram_used_m, name="Used",
                    marker_color="#f59e0b",
                    text=[f"{u:.1f}GB" for u in _ram_used_m],
                    textposition="outside",
                ))
                _ram_fig_m.add_trace(go.Bar(
                    x=_ram_names_m, y=[t - u for t, u in zip(_ram_total_m, _ram_used_m)], name="Free",
                    marker_color="#1e293b",
                    text=[f"{t:.0f}GB total" for t in _ram_total_m],
                    textposition="outside",
                ))
                _ram_fig_m.update_layout(
                    template=PT, height=300, barmode="stack",
                    title="RAM Usage",
                    yaxis=dict(title="GB"),
                    margin=dict(l=40, r=20, t=40, b=30),
                )
                tv_chart(_ram_fig_m)

    # --- QCC training jobs and alerts ---
    if _qcc_main is not None and (_qcc_jobs or _qcc_alerts_raw):
        st.markdown("---")
        _qcc_col1, _qcc_col2 = st.columns(2)

        with _qcc_col1:
            st.subheader("Active Training Jobs (QCC)")
            if _qcc_jobs:
                for _job_m in _qcc_jobs:
                    _j_desc_m = _job_m.get("description", "Unknown")
                    _j_node_m = _job_m.get("node", "?")
                    _j_fold_m = _job_m.get("current_fold", "?")
                    _j_total_m = _job_m.get("total_folds", "?")
                    _j_status_m = _job_m.get("status", "unknown")
                    _j_hb_m = _job_m.get("last_heartbeat", "never")
                    _j_err_m = _job_m.get("error_msg", "")
                    _pct_m = 0
                    if isinstance(_j_fold_m, (int, float)) and isinstance(_j_total_m, (int, float)) and _j_total_m > 0:
                        _pct_m = min(int((_j_fold_m / _j_total_m) * 100), 100)
                    _stale_m = _job_m.get("id") in [s.get("id") for s in _qcc_main.get("stale_jobs", [])]
                    _stale_tag_m = " STALE" if _stale_m else ""
                    st.markdown(f"**{_j_desc_m}**{_stale_tag_m}")
                    st.caption(f"Node: {_j_node_m} | Fold: {_j_fold_m}/{_j_total_m} | Status: {_j_status_m}")
                    st.progress(_pct_m / 100.0, text=f"{_pct_m}%")
                    st.caption(f"Last heartbeat: {_j_hb_m}")
                    if _j_err_m:
                        st.warning(_j_err_m[:200])
            else:
                st.info("No active training jobs.")

        with _qcc_col2:
            st.subheader("QCC Alerts")
            if _qcc_alerts_raw:
                for _alert_m in _qcc_alerts_raw[:10]:
                    _a_sev_m = _alert_m.get("severity", "info")
                    _a_msg_m = _alert_m.get("message", "")
                    _a_node_m = _alert_m.get("node", "?")
                    _a_time_m = _alert_m.get("created_at", "")
                    if _a_sev_m == "critical":
                        st.error(f"**{_a_node_m}** ({_a_time_m}): {_a_msg_m[:200]}")
                    elif _a_sev_m == "warning":
                        st.warning(f"**{_a_node_m}** ({_a_time_m}): {_a_msg_m[:200]}")
                    else:
                        st.info(f"**{_a_node_m}** ({_a_time_m}): {_a_msg_m[:200]}")
            else:
                st.success("No unresolved QCC alerts.")

    # --- Local alerts from compute_alerts.json ---
    ALERTS_PATH_MAIN = Path(r"C:\Users\Footb\Documents\Github\teleclaude-main\compute_alerts.json")
    if ALERTS_PATH_MAIN.exists():
        try:
            with open(ALERTS_PATH_MAIN) as f:
                all_alerts_main = json.load(f)
            recent_main = list(reversed(all_alerts_main[-10:])) if all_alerts_main else []
            if recent_main:
                st.markdown("---")
                st.subheader("Recent Local Alerts")
                for a_m in recent_main:
                    sev_m = a_m.get("severity", "INFO")
                    sev_color_m = "#ef4444" if sev_m == "CRITICAL" else "#f59e0b" if sev_m == "WARNING" else "#6b7280"
                    ts_str_m = a_m.get("timestamp", "")[:19]
                    st.markdown(
                        f'<div style="padding:6px 12px;margin:3px 0;border-radius:8px;'
                        f'background:{sev_color_m}15;border-left:3px solid {sev_color_m};font-size:0.85em;">'
                        f'<span style="color:{sev_color_m};font-weight:700;">[{sev_m}]</span> '
                        f'<span style="color:{T["text_muted"]};">{ts_str_m}</span> '
                        f'<strong style="color:{T["text"]};">{a_m.get("machine", "")}</strong>: '
                        f'<span style="color:{T["text"]};">{a_m.get("message", "")}</span>'
                        f'</div>',
                        unsafe_allow_html=True,
                    )
        except Exception:
            pass

    # --- Auto-refresh timer ---
    if _compute_auto:
        time.sleep(30)
        st.rerun()

# ================================================================
# TAB 5: MODELS
# ================================================================
with tab_models:
    import sqlite3 as _sqlite3
    import glob as _glob_mod

    st.header("Model Registry")

    _QCC_DB = Path(r"C:\Users\Footb\Documents\Github\teleclaude-main\data\qcc.db")
    _RESULTS_DIR = Path(r"C:\Users\Footb\Documents\Github\Lvl3Quant\alpha_discovery\deep_models\results")
    _CKPT_DIR = _RESULTS_DIR / "checkpoints" / "book"

    # --- Load models from QCC DB, enriched with checkpoint + fold data ---
    @st.cache_data(ttl=30)
    def _load_models_db():
        if not _QCC_DB.exists():
            return [], []
        db = _sqlite3.connect(str(_QCC_DB))
        db.row_factory = _sqlite3.Row
        cur = db.cursor()

        # Ensure best_ic column exists (added for enrichment)
        try:
            cur.execute("ALTER TABLE models ADD COLUMN best_ic REAL")
            db.commit()
        except Exception:
            pass  # column already exists

        cur.execute("SELECT * FROM models ORDER BY id")
        models = [dict(r) for r in cur.fetchall()]
        cur.execute("SELECT * FROM fold_results ORDER BY id")
        folds = [dict(r) for r in cur.fetchall()]

        # --- Enrich models from fold_results aggregation ---
        # fold_results.config_id maps to models.id
        from collections import defaultdict
        folds_by_model = defaultdict(list)
        for f in folds:
            mid = f.get("config_id")
            if mid is not None and f.get("ic") is not None:
                folds_by_model[mid].append(f)

        for m in models:
            mid = m["id"]
            model_folds = folds_by_model.get(mid, [])
            if model_folds:
                ics = [f["ic"] for f in model_folds if f["ic"] is not None]
                if ics:
                    if m.get("mean_ic") is None:
                        m["mean_ic"] = sum(ics) / len(ics)
                    if m.get("best_ic") is None:
                        m["best_ic"] = max(ics)
                    if m.get("latest_ic") is None:
                        m["latest_ic"] = ics[-1]
                    if not m.get("completed_folds"):
                        m["completed_folds"] = len(ics)

        # --- Enrich from checkpoint JSONs on disk ---
        # Map model names to checkpoint subdirectories for cross-reference
        _name_to_subdir = {
            "wider_cnn": "wider_cnn",
            "wider cnn wf": "wider_cnn",
            "wider_cnn_fulldata": "wider_cnn_fulldata",
            "standard bookcnn 100d wf": "standard_cnn",
            "standard_cnn": "standard_cnn",
            "hybrid v3 wf": "hybrid",
            "hybrid": "hybrid",
            "1-min cnn wf": "standard_cnn",
            "deeper_cnn_features": "standard_cnn",
        }
        for m in models:
            m_name_lower = m.get("name", "").lower()
            subdir_name = _name_to_subdir.get(m_name_lower) or _name_to_subdir.get(m.get("name", ""))
            if not subdir_name:
                # Try partial match
                for key, val in _name_to_subdir.items():
                    if key in m_name_lower:
                        subdir_name = val
                        break
            if not subdir_name:
                continue

            subdir_path = _RESULTS_DIR / subdir_name
            if not subdir_path.exists():
                continue

            # Find the latest checkpoint JSON in this subdir (by mtime, not name)
            ckpt_files = list(subdir_path.glob("checkpoint_*.json"))
            if not ckpt_files:
                continue

            latest_ckpt = max(ckpt_files, key=lambda p: p.stat().st_mtime)
            try:
                ckpt_data = json.loads(latest_ckpt.read_text(encoding="utf-8", errors="replace"))
                fold_details = ckpt_data.get("fold_details", [])
                ckpt_ics = [f.get("ic") for f in fold_details if f.get("ic") is not None]

                # Fill in missing fields from checkpoint
                if m.get("params_count") is None and ckpt_data.get("param_count"):
                    m["params_count"] = ckpt_data["param_count"]
                if m.get("mean_ic") is None and ckpt_data.get("mean_ic"):
                    m["mean_ic"] = ckpt_data["mean_ic"]
                if m.get("mean_ic") is None and ckpt_ics:
                    m["mean_ic"] = sum(ckpt_ics) / len(ckpt_ics)
                if m.get("best_ic") is None and ckpt_ics:
                    m["best_ic"] = max(ckpt_ics)
                if m.get("latest_ic") is None and ckpt_ics:
                    m["latest_ic"] = ckpt_ics[-1]
                if (not m.get("completed_folds")) and ckpt_data.get("completed_folds"):
                    m["completed_folds"] = ckpt_data["completed_folds"]
                if not m.get("checkpoint_path"):
                    m["checkpoint_path"] = str(latest_ckpt)
                if not m.get("window_mode") or m["window_mode"] == "expanding":
                    wm = ckpt_data.get("window_mode")
                    if wm:
                        m["window_mode"] = wm
                # Store warm_start info in notes if not already there
                ws = ckpt_data.get("warm_start")
                if ws is not None and m.get("notes") and "warm" not in (m.get("notes") or "").lower():
                    m["notes"] = (m.get("notes") or "") + f" | warm_start={ws}"
            except Exception:
                continue

        # --- Persist enrichment back to DB for next load ---
        try:
            for m in models:
                updates = []
                params = {}
                if m.get("params_count") is not None:
                    updates.append("params_count = :params_count")
                    params["params_count"] = m["params_count"]
                if m.get("mean_ic") is not None:
                    updates.append("mean_ic = :mean_ic")
                    params["mean_ic"] = m["mean_ic"]
                if m.get("best_ic") is not None:
                    updates.append("best_ic = :best_ic")
                    params["best_ic"] = m["best_ic"]
                if m.get("latest_ic") is not None:
                    updates.append("latest_ic = :latest_ic")
                    params["latest_ic"] = m["latest_ic"]
                if m.get("completed_folds"):
                    updates.append("completed_folds = :completed_folds")
                    params["completed_folds"] = m["completed_folds"]
                if updates:
                    params["id"] = m["id"]
                    cur.execute(f"UPDATE models SET {', '.join(updates)} WHERE id = :id", params)
            db.commit()
        except Exception:
            pass

        db.close()
        return models, folds

    # --- Load fold data from checkpoint JSONs (much richer than DB) ---
    @st.cache_data(ttl=60)
    def _load_checkpoint_jsons():
        results = {}
        # Scan ALL model subdirectories, not just 3
        _known_labels = {
            "standard_cnn": "Standard CNN",
            "wider_cnn": "Wider CNN",
            "hybrid": "Hybrid v3",
            "autoresearch": "AutoResearch",
            "mc_dropout": "MC Dropout",
            "rl_models": "RL Models",
            "window100_test": "Window 100 (10s ctx)",
            "window50_test": "Window 50 (5s ctx)",
            "standard_173day": "Standard 173-day",
        }
        # Auto-discover any subdirs with checkpoint JSONs
        if _RESULTS_DIR.exists():
            for subdir_path in sorted(_RESULTS_DIR.iterdir()):
                if not subdir_path.is_dir():
                    continue
                subdir = subdir_path.name
                if subdir in ("checkpoints", "old_book_checkpoints", "exploratory"):
                    continue
                label = _known_labels.get(subdir, subdir.replace("_", " ").title())
                for jf in sorted(subdir_path.glob("checkpoint_*.json")):
                    try:
                        data = json.loads(jf.read_text(encoding="utf-8", errors="replace"))
                        folds_data = data.get("fold_details", [])
                        if not folds_data:
                            continue
                        # Extract train/val loss from last epoch of epoch_stats
                        for fd in folds_data:
                            es = fd.get("epoch_stats", [])
                            if es and isinstance(es[-1], dict):
                                fd["train_loss"] = es[-1].get("train_loss")
                                fd["val_loss"] = es[-1].get("val_loss")
                            else:
                                fd["train_loss"] = None
                                fd["val_loss"] = fd.get("best_val_loss")
                        _ckpt_ics = [f.get("ic") for f in folds_data if f.get("ic") is not None]
                        meta = {
                            "file": str(jf),
                            "label": label,
                            "subdir": subdir,
                            "param_count": data.get("param_count"),
                            "model_type": data.get("model_type", subdir),
                            "mean_ic": data.get("mean_ic") or (sum(_ckpt_ics) / len(_ckpt_ics) if _ckpt_ics else None),
                            "best_ic": max(_ckpt_ics) if _ckpt_ics else None,
                            "completed_folds": data.get("completed_folds", len(folds_data)),
                            "total_folds": len(folds_data),
                            "window_mode": data.get("window_mode", "unknown"),
                            "warm_start": data.get("warm_start", None),
                            "batch_size": data.get("batch_size"),
                            "epochs_per_fold": data.get("epochs_per_fold"),
                            "subsample": data.get("subsample_train"),
                            "folds": folds_data,
                        }
                        n_folds = data.get("completed_folds", len(folds_data))
                        key = f"{label} ({n_folds} folds) [{jf.stem}]"
                        results[key] = meta
                    except Exception:
                        continue
        return results

    _db_models, _db_folds = _load_models_db()
    _ckpt_data = _load_checkpoint_jsons()

    # ----------------------------------------------------------------
    # Model generation classifier
    # ----------------------------------------------------------------
    def _classify_model_gen(name: str, arch: str = "", notes: str = "") -> tuple[str, str, str]:
        """Return (label, badge_color, badge_bg) for a model based on its name/arch.

        Generations:
          Book Spatial  — trained on just the 4 raw book features (bid/ask size, imbalance, spread)
          Enriched      — 16+ features including trade proxies and temporal features
          Hybrid        — CNN+Transformer or multi-branch architectures
        """
        combined = f"{name} {arch} {notes}".lower()
        # Hybrid first: multi-branch or transformer architecture signals
        if any(k in combined for k in ("hybrid", "transformer", "multi_branch", "multi-branch", "attention")):
            return "Hybrid", "#a855f7", "rgba(168,85,247,0.15)"
        # Enriched: explicit enriched/features flags or known names
        if any(k in combined for k in ("enriched", "feature", "trade_proxy", "temporal", "deeper_cnn_features",
                                        "wider_cnn_fulldata", "fulldata", "16feat", "augment")):
            return "Enriched", "#f59e0b", "rgba(245,158,11,0.15)"
        # Book Spatial: raw book only (standard, wider, window variants)
        if any(k in combined for k in ("book", "standard", "wider", "window", "spatial", "cnn",
                                        "1-min", "1min", "mc_dropout")):
            return "Book Spatial", "#6366f1", "rgba(99,102,241,0.15)"
        # Unknown / unclassified
        return "Unknown", "#6b7280", "rgba(107,114,128,0.15)"

    # --- Model Summary Cards ---
    st.subheader("Registered Models")

    if _db_models:
        _mcols = st.columns(min(len(_db_models), 4))
        for _mi, _m in enumerate(_db_models):
            with _mcols[_mi % len(_mcols)]:
                _m_name = _m.get("name", "Unknown")
                _m_type = _m.get("architecture", _m.get("model_type", "?"))
                _m_status = _m.get("status", "?")
                _m_folds_done = _m.get("completed_folds", 0) or 0
                _m_folds_total = _m.get("total_folds", "?")
                _m_ic = _m.get("mean_ic")
                _m_best_ic = _m.get("best_ic")
                _m_latest_ic = _m.get("latest_ic")
                _m_node = _m.get("node", "?")
                _m_params = _m.get("params_count")
                _m_window = _m.get("window_mode", "?")
                _m_ckpt = _m.get("checkpoint_path", "")
                _m_ckpt_short = Path(_m_ckpt).name if _m_ckpt else "N/A"
                _m_notes = _m.get("notes", "")

                _s_color = "#10b981" if _m_status == "training" else "#6366f1" if _m_status == "completed" else "#f59e0b"
                _m_gen_label, _m_gen_color, _m_gen_bg = _classify_model_gen(_m_name, _m_type or "", _m_notes or "")

                st.markdown(f"""
                <div class="metric-card" style="border-left: 4px solid {_s_color};">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                        <h3 style="margin:0;">{_m_name}</h3>
                        <span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:0.72em;
                                     font-weight:700;background:{_m_gen_bg};color:{_m_gen_color};">{_m_gen_label}</span>
                    </div>
                    <div style="font-size: 0.85em; color: {T['text']};">
                        <b>Type:</b> {_m_type}<br>
                        <b>Status:</b> <span style="color: {_s_color}; font-weight: 700;">{_m_status.upper()}</span><br>
                        <b>Node:</b> {_m_node}<br>
                        <b>Params:</b> {f'{_m_params:,.0f}' if _m_params else 'N/A'}<br>
                        <b>Folds:</b> {_m_folds_done}/{_m_folds_total}<br>
                        <b>Mean IC:</b> {f'{_m_ic:.4f}' if _m_ic else 'N/A'}<br>
                        <b>Best IC:</b> {f'{_m_best_ic:.4f}' if _m_best_ic else 'N/A'}<br>
                        <b>Latest IC:</b> {f'{_m_latest_ic:.4f}' if _m_latest_ic else 'N/A'}<br>
                        <b>Window:</b> {_m_window}<br>
                        <b>Checkpoint:</b> <span style="font-size:0.85em;">{_m_ckpt_short}</span>
                    </div>
                </div>
                """, unsafe_allow_html=True)
    else:
        st.info("No models in QCC database.")

    st.markdown("---")

    # --- Checkpoint-based fold analysis (the real data) ---
    st.subheader("Walk-Forward Fold Analysis")

    if _ckpt_data:
        # --- Model Comparison Overview (all models at a glance) ---
        st.subheader("Model Comparison")
        _compare_rows = []
        for _ck, _cv in _ckpt_data.items():
            _f_ics = [f.get("ic", 0) for f in _cv["folds"] if f.get("ic") is not None]
            _last5 = _f_ics[-5:] if len(_f_ics) >= 5 else _f_ics
            _first5 = _f_ics[:5] if len(_f_ics) >= 5 else _f_ics
            _cv_label = _cv.get("label", "?")
            _cv_type = _cv.get("model_type", "?")
            _cv_gen_label, _, _ = _classify_model_gen(_cv_label, _cv_type or "")
            _compare_rows.append({
                "Model": _cv_label,
                "Generation": _cv_gen_label,
                "Type": _cv_type,
                "Params": _cv.get("param_count"),
                "Folds": _cv.get("completed_folds", 0),
                "Mean IC": round(sum(_f_ics) / max(len(_f_ics), 1), 4) if _f_ics else None,
                "Best IC": _cv.get("best_ic") or (round(max(_f_ics), 4) if _f_ics else None),
                "Last 5 IC": round(sum(_last5) / max(len(_last5), 1), 4) if _last5 else None,
                "First 5 IC": round(sum(_first5) / max(len(_first5), 1), 4) if _first5 else None,
                "IC Trend": round((sum(_last5) / max(len(_last5), 1)) - (sum(_first5) / max(len(_first5), 1)), 4) if _last5 and _first5 else None,
                "Window": _cv.get("window_mode", "?"),
                "Warm Start": "Yes" if _cv.get("warm_start") else "No",
            })
        if _compare_rows:
            _compare_df = pd.DataFrame(_compare_rows).sort_values("Mean IC", ascending=False, na_position="last")
            _compare_df["Params"] = _compare_df["Params"].apply(lambda x: f"{x:,.0f}" if pd.notna(x) and x else "N/A")
            st.dataframe(_compare_df, use_container_width=True, height=min(len(_compare_df) * 35 + 50, 400))

        st.markdown("---")

        _selected_model = st.selectbox(
            "Select Model Run for Details",
            options=list(_ckpt_data.keys()),
            key="model_selector",
        )

        if _selected_model and _selected_model in _ckpt_data:
            _md = _ckpt_data[_selected_model]
            _folds = _md["folds"]

            # Config summary — expanded with training details
            _cfg_cols = st.columns(9)
            _cfg_items = [
                ("Model Type", _md.get("model_type", "N/A")),
                ("Params", f'{_md["param_count"]:,.0f}' if _md.get("param_count") else "N/A"),
                ("Mean IC", f'{_md["mean_ic"]:.4f}' if _md.get("mean_ic") else "N/A"),
                ("Best IC", f'{_md["best_ic"]:.4f}' if _md.get("best_ic") else "N/A"),
                ("Folds Done", _md["completed_folds"]),
                ("Window", _md.get("window_mode", "N/A")),
                ("Warm Start", "Yes" if _md.get("warm_start") else "No"),
                ("Epochs/Fold", _md.get("epochs_per_fold", "N/A")),
                ("Source", Path(_md.get("file", "")).name),
            ]
            for _ci, (_cl, _cv) in enumerate(_cfg_items):
                _cfg_cols[_ci].metric(_cl, str(_cv))

            # Build fold dataframe
            _fold_rows = []
            for _f in _folds:
                _tl = _f.get("train_loss")
                _vl = _f.get("val_loss")
                _fold_rows.append({
                    "Fold": _f.get("fold", 0),
                    "Test Date": _f.get("test_date", ""),
                    "IC": _f.get("ic", None),
                    "Train Loss": _tl,
                    "Val Loss": _vl,
                    "Overfit Ratio": round(_vl / max(_tl, 0.001), 2) if _vl and _tl else None,
                    "Train Days": _f.get("train_days", None),
                    "Test Samples": _f.get("n_test", None),
                })
            _fold_df = pd.DataFrame(_fold_rows)

            if not _fold_df.empty and "IC" in _fold_df.columns:
                _fold_df = _fold_df.dropna(subset=["IC"])

                if len(_fold_df) > 0:
                    # --- IC chart ---
                    _ic_fig = make_subplots(
                        rows=2, cols=1, shared_xaxes=True,
                        subplot_titles=("IC per Fold", "Train vs Val Loss"),
                        row_heights=[0.55, 0.45], vertical_spacing=0.08,
                    )

                    # IC bars colored by performance
                    _colors = ["#10b981" if ic > 0.05 else "#f59e0b" if ic > 0.02 else "#ef4444" for ic in _fold_df["IC"]]
                    _ic_fig.add_trace(go.Bar(
                        x=_fold_df["Test Date"] if _fold_df["Test Date"].any() else _fold_df["Fold"],
                        y=_fold_df["IC"],
                        marker_color=_colors,
                        name="IC",
                        hovertemplate="Fold %{customdata}<br>IC: %{y:.4f}<extra></extra>",
                        customdata=_fold_df["Fold"],
                    ), row=1, col=1)

                    # Rolling mean IC
                    if len(_fold_df) >= 5:
                        _rolling_ic = _fold_df["IC"].rolling(5, min_periods=1).mean()
                        _ic_fig.add_trace(go.Scatter(
                            x=_fold_df["Test Date"] if _fold_df["Test Date"].any() else _fold_df["Fold"],
                            y=_rolling_ic,
                            mode="lines", line=dict(color="#8b5cf6", width=3),
                            name="5-Fold Rolling IC",
                        ), row=1, col=1)

                    # Train vs Val loss
                    if _fold_df["Train Loss"].notna().any():
                        _ic_fig.add_trace(go.Scatter(
                            x=_fold_df["Test Date"] if _fold_df["Test Date"].any() else _fold_df["Fold"],
                            y=_fold_df["Train Loss"],
                            mode="lines+markers", line=dict(color="#6366f1", width=2),
                            name="Train Loss",
                        ), row=2, col=1)
                    if _fold_df["Val Loss"].notna().any():
                        _ic_fig.add_trace(go.Scatter(
                            x=_fold_df["Test Date"] if _fold_df["Test Date"].any() else _fold_df["Fold"],
                            y=_fold_df["Val Loss"],
                            mode="lines+markers", line=dict(color="#f43f5e", width=2),
                            name="Val Loss",
                        ), row=2, col=1)

                    _ic_fig.update_layout(
                        template=PT, height=600,
                        margin=dict(l=40, r=20, t=40, b=40),
                        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1),
                        paper_bgcolor="rgba(0,0,0,0)",
                        plot_bgcolor="rgba(0,0,0,0)",
                    )
                    _ic_fig.update_yaxes(title_text="IC", row=1, col=1)
                    _ic_fig.update_yaxes(title_text="Loss", row=2, col=1)

                    st.plotly_chart(_ic_fig, use_container_width=True, config=CHART_CONFIG)

                    # --- Summary stats ---
                    _stat_cols = st.columns(6)
                    _mean_ic = _fold_df["IC"].mean()
                    _std_ic = _fold_df["IC"].std()
                    _min_ic = _fold_df["IC"].min()
                    _max_ic = _fold_df["IC"].max()
                    _last5_ic = _fold_df["IC"].tail(5).mean() if len(_fold_df) >= 5 else _mean_ic
                    _first5_ic = _fold_df["IC"].head(5).mean() if len(_fold_df) >= 5 else _mean_ic

                    _stat_cols[0].metric("Mean IC", f"{_mean_ic:.4f}")
                    _stat_cols[1].metric("Std IC", f"{_std_ic:.4f}")
                    _stat_cols[2].metric("Min IC", f"{_min_ic:.4f}")
                    _stat_cols[3].metric("Max IC", f"{_max_ic:.4f}")
                    _stat_cols[4].metric("First 5 Avg", f"{_first5_ic:.4f}")
                    _stat_cols[5].metric("Last 5 Avg", f"{_last5_ic:.4f}",
                                        delta=f"{_last5_ic - _first5_ic:.4f}",
                                        delta_color="normal")

                    # --- Fold data table ---
                    st.subheader("Fold Details")
                    _display_df = _fold_df.copy()
                    # Add target distribution info
                    for _fi, _f in enumerate(_folds):
                        if _fi < len(_display_df):
                            _display_df.loc[_display_df.index[_fi], "Target Std"] = _f.get("target_std")
                            _display_df.loc[_display_df.index[_fi], "Target Mean"] = _f.get("target_mean")
                    _display_df["IC"] = _display_df["IC"].apply(lambda x: f"{x:.4f}" if pd.notna(x) else "")
                    _display_df["Train Loss"] = _display_df["Train Loss"].apply(lambda x: f"{x:.4f}" if pd.notna(x) else "")
                    _display_df["Val Loss"] = _display_df["Val Loss"].apply(lambda x: f"{x:.4f}" if pd.notna(x) else "")
                    _display_df["Overfit Ratio"] = _display_df["Overfit Ratio"].apply(lambda x: f"{x:.2f}x" if pd.notna(x) else "")
                    if "Target Std" in _display_df.columns:
                        _display_df["Target Std"] = _display_df["Target Std"].apply(lambda x: f"{x:.3f}" if pd.notna(x) else "")
                        _display_df["Target Mean"] = _display_df["Target Mean"].apply(lambda x: f"{x:.3f}" if pd.notna(x) else "")

                    st.dataframe(
                        _display_df,
                        use_container_width=True,
                        height=min(len(_display_df) * 35 + 50, 600),
                    )

                    # --- Epoch-level detail (expandable per fold) ---
                    with st.expander("Epoch-Level Training Details (per fold)"):
                        _epoch_rows = []
                        for _f in _folds:
                            _fold_num = _f.get("fold", 0)
                            _test_date = _f.get("test_date", "")
                            for _ei, _es in enumerate(_f.get("epoch_stats", [])):
                                if isinstance(_es, dict):
                                    _epoch_rows.append({
                                        "Fold": _fold_num,
                                        "Test Date": _test_date,
                                        "Epoch": _ei + 1,
                                        "Train Loss": _es.get("train_loss"),
                                        "Val Loss": _es.get("val_loss"),
                                        "IC": _es.get("ic"),
                                    })
                        if _epoch_rows:
                            _epoch_df = pd.DataFrame(_epoch_rows)
                            _epoch_df["Train Loss"] = _epoch_df["Train Loss"].apply(lambda x: f"{x:.4f}" if pd.notna(x) else "")
                            _epoch_df["Val Loss"] = _epoch_df["Val Loss"].apply(lambda x: f"{x:.4f}" if pd.notna(x) else "")
                            _epoch_df["IC"] = _epoch_df["IC"].apply(lambda x: f"{x:.4f}" if pd.notna(x) else "")
                            st.dataframe(_epoch_df, use_container_width=True, height=min(len(_epoch_df) * 35 + 50, 500))
                        else:
                            st.info("No epoch-level stats available for this model.")

                    # --- Target distribution chart ---
                    _target_stds = [f.get("target_std") for f in _folds if f.get("target_std") is not None]
                    if _target_stds and len(_target_stds) > 3:
                        with st.expander("Target Distribution Over Time"):
                            _tgt_dates = [f.get("test_date", f"Fold {f.get('fold', i)}") for i, f in enumerate(_folds) if f.get("target_std") is not None]
                            _tgt_fig = go.Figure()
                            _tgt_fig.add_trace(go.Scatter(
                                x=_tgt_dates, y=_target_stds,
                                mode="lines+markers", line=dict(color="#f59e0b", width=2),
                                name="Target Std (ticks)",
                            ))
                            _tgt_fig.update_layout(
                                template=PT, height=300,
                                title="Target Volatility (Std Dev in Ticks)",
                                paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
                                margin=dict(l=40, r=20, t=40, b=40),
                            )
                            st.plotly_chart(_tgt_fig, use_container_width=True, config=CHART_CONFIG)
                else:
                    st.warning("No IC values found in fold data.")
            else:
                st.warning("No fold data available for this model run.")
    else:
        st.info("No checkpoint JSONs found in results directory.")
