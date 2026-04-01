#!/usr/bin/env python3
"""Patch fill_sim_main.rs to add queue pos and time window args."""

with open('/home/jupiter/Lvl3Quant/rust_cache_builder/src/fill_sim_main.rs', 'r') as f:
    content = f.read()

errors = []

# 1. Add new Args fields after conviction_exit_mag
OLD1 = '''    /// Conviction exit: minimum |z-score| of opposite signal to count.
    /// 0.0 = any opposite signal. 1.0 = require |prediction| >= 1.0.
    #[arg(long, default_value_t = 0.0)]
    conviction_exit_mag: f64,

    /// Suppress progress output
    #[arg(long)]
    quiet: bool,
}'''

NEW1 = '''    /// Conviction exit: minimum |z-score| of opposite signal to count.
    /// 0.0 = any opposite signal. 1.0 = require |prediction| >= 1.0.
    #[arg(long, default_value_t = 0.0)]
    conviction_exit_mag: f64,

    /// Queue position filter: skip trades where queue_position_at_post < this value.
    /// Use to study signals with good queue position only (e.g., near top-of-book).
    /// Default: 0 (no filter).
    #[arg(long, default_value_t = 0)]
    min_queue_pos: u32,

    /// Queue position filter: skip trades where queue_position_at_post > this value.
    /// Use to exclude signals posted far back in the queue.
    /// Default: 999999 (no filter).
    #[arg(long, default_value_t = 999_999)]
    max_queue_pos: u32,

    /// Time window start (ET, HH:MM format, e.g. "09:30"). Only simulate signals
    /// within this time window. Useful for time-of-day analysis (Track 2B).
    /// Default: empty string (no filter).
    #[arg(long, default_value_t = String::new())]
    time_window_start: String,

    /// Time window end (ET, HH:MM format, e.g. "16:00"). Must be paired with
    /// --time-window-start. Signals outside this window are skipped.
    /// Default: empty string (no filter).
    #[arg(long, default_value_t = String::new())]
    time_window_end: String,

    /// Suppress progress output
    #[arg(long)]
    quiet: bool,
}'''

if OLD1 in content:
    content = content.replace(OLD1, NEW1)
    print("PATCH1 OK: Added new Args fields")
else:
    errors.append("PATCH1 FAIL: conviction_exit_mag args block not found")

# 2. Add helper functions before main()
OLD2 = 'const BAR_NS: u64 = 100_000_000; // 100ms per bar\n\nfn main() -> Result<()> {'

NEW2 = '''const BAR_NS: u64 = 100_000_000; // 100ms per bar

/// Parse "HH:MM" time string into minutes from midnight ET.
fn parse_hhmm(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.splitn(2, ':').collect();
    if parts.len() != 2 { return None; }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    if h > 23 || m > 59 { return None; }
    Some(h * 60 + m)
}

/// Check if a nanosecond UTC timestamp falls within a custom HH:MM time window (ET).
/// window_start_min and window_end_min are minutes from midnight ET.
fn is_within_time_window(timestamp_ns: u64, window_start_min: u32, window_end_min: u32) -> bool {
    if timestamp_ns == 0 { return false; }
    let ts_sec = (timestamp_ns / 1_000_000_000) as i64;
    // DST_END_2025: Nov 2, 2025 06:00 UTC
    const DST_END_2025_NS: u64 = 1_762_056_000_000_000_000;
    let et_offset: i64 = if timestamp_ns < DST_END_2025_NS { -4 } else { -5 };
    let et_sec = ts_sec + et_offset * 3600;
    let secs_in_day = et_sec.rem_euclid(86400) as u32;
    let time_minutes = secs_in_day / 60;
    time_minutes >= window_start_min && time_minutes < window_end_min
}

fn main() -> Result<()> {'''

if OLD2 in content:
    content = content.replace(OLD2, NEW2)
    print("PATCH2 OK: Added helper functions")
else:
    errors.append("PATCH2 FAIL: BAR_NS + main() block not found")

# 3. Parse new args after signal_threshold
OLD3 = '    let signal_threshold = args.signal_threshold;\n\n    let entry_mode = if sim_config.market_entry {'

NEW3 = '''    let signal_threshold = args.signal_threshold;

    // Parse optional time window args (HH:MM ET format)
    let time_window: Option<(u32, u32)> = if !args.time_window_start.is_empty() && !args.time_window_end.is_empty() {
        match (parse_hhmm(&args.time_window_start), parse_hhmm(&args.time_window_end)) {
            (Some(start), Some(end)) => {
                if !args.quiet {
                    eprintln!("Time window filter: {:02}:{:02} - {:02}:{:02} ET",
                        start / 60, start % 60, end / 60, end % 60);
                }
                Some((start, end))
            }
            _ => {
                eprintln!("WARNING: Invalid --time-window-start/end format. Expected HH:MM. Filter disabled.");
                None
            }
        }
    } else {
        None
    };

    // Queue position filters (applied post-sim to completed_trades)
    let min_queue_pos = args.min_queue_pos as f64;
    let max_queue_pos = args.max_queue_pos as f64;
    let has_queue_filter = args.min_queue_pos > 0 || args.max_queue_pos < 999_999;
    if has_queue_filter && !args.quiet {
        eprintln!("Queue position filter: [{}, {}]", args.min_queue_pos, args.max_queue_pos);
    }

    let entry_mode = if sim_config.market_entry {'''

if OLD3 in content:
    content = content.replace(OLD3, NEW3)
    print("PATCH3 OK: Added time window and queue pos parsing")
else:
    errors.append("PATCH3 FAIL: signal_threshold + entry_mode block not found")

# 4. Wire time window into signal submission
OLD4 = '''                    let in_prime = !sim_config.prime_hours_only
                        || is_within_prime_hours(event_bar_ns);
                    if pred.abs() > signal_threshold && !has_position && in_prime {
                        let signal = Signal {
                            bar_ns: event_bar_ns,
                            direction: pred,
                            magnitude: pred.abs(),
                            confidence: pred.abs(),
                        };
                        if sim.submit_signal(&signal).is_some() {
                            has_position = true;
                        }
                    }'''

NEW4 = '''                    let in_prime = !sim_config.prime_hours_only
                        || is_within_prime_hours(event_bar_ns);
                    let in_time_window = match time_window {
                        Some((start, end)) => is_within_time_window(event_bar_ns, start, end),
                        None => true,
                    };
                    if pred.abs() > signal_threshold && !has_position && in_prime && in_time_window {
                        let signal = Signal {
                            bar_ns: event_bar_ns,
                            direction: pred,
                            magnitude: pred.abs(),
                            confidence: pred.abs(),
                        };
                        if sim.submit_signal(&signal).is_some() {
                            has_position = true;
                        }
                    }'''

if OLD4 in content:
    content = content.replace(OLD4, NEW4)
    print("PATCH4 OK: Wired time window into signal submission")
else:
    errors.append("PATCH4 FAIL: signal submission block not found")

# 5. Add post-sim queue pos filter before summary
OLD5 = '''    // End of day \u2014 close everything
    if let Some(last_event) = events.last() {
        sim.close_all_positions(last_event.ts_event);
    }
    sim.collect_results();

    let summary = sim.summary();'''

NEW5 = '''    // End of day \u2014 close everything
    if let Some(last_event) = events.last() {
        sim.close_all_positions(last_event.ts_event);
    }
    sim.collect_results();

    // Apply queue position filter: remove trades outside [min_queue_pos, max_queue_pos].
    // queue_position_at_post is recorded per-trade in TradeResult; we post-filter here
    // so the fill simulator still runs normally (no skip during sim).
    if has_queue_filter {
        let before = sim.completed_trades.len();
        sim.completed_trades.retain(|t| {
            t.queue_position_at_post >= min_queue_pos
                && t.queue_position_at_post <= max_queue_pos
        });
        let after = sim.completed_trades.len();
        if !args.quiet {
            eprintln!("Queue pos filter [{:.0},{:.0}]: kept {}/{} trades",
                min_queue_pos, max_queue_pos, after, before);
        }
    }

    let summary = sim.summary();'''

if OLD5 in content:
    content = content.replace(OLD5, NEW5)
    print("PATCH5 OK: Added post-sim queue pos filter")
else:
    errors.append("PATCH5 FAIL: end-of-day block not found")

if errors:
    for e in errors:
        print(e)
    import sys
    sys.exit(1)

with open('/home/jupiter/Lvl3Quant/rust_cache_builder/src/fill_sim_main.rs', 'w') as f:
    f.write(content)

print("ALL PATCHES APPLIED SUCCESSFULLY")
