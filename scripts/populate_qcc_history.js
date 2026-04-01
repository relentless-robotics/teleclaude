/**
 * Populate QCC Database with FULL historical data, sweep results,
 * decisions, paper trading history, training results, and infrastructure.
 *
 * Run: node scripts/populate_qcc_history.js
 *
 * This supplements the basic populate_qcc.js with comprehensive history
 * from memory files and session logs.
 */

const path = require('path');
const { QCCDatabase } = require('../lib/qcc-database');

const DB_PATH = path.join(__dirname, '..', 'data', 'qcc.db');
const db = new QCCDatabase(DB_PATH);

console.log('QCC History Loader — opening DB at:', DB_PATH);

let totalInserted = 0;

// Helper: log an action with structured args
function logDecision(category, description, details = {}) {
  db.logAction(
    `decision:${category}`,
    JSON.stringify(details),
    description
  );
  totalInserted++;
}

function logSweepResult(category, description, details = {}) {
  db.logAction(
    `sweep_result:${category}`,
    JSON.stringify(details),
    description
  );
  totalInserted++;
}

function logEvent(category, description, details = {}) {
  db.logAction(
    `event:${category}`,
    JSON.stringify(details),
    description
  );
  totalInserted++;
}

function logInfra(category, description, details = {}) {
  db.logAction(
    `infrastructure:${category}`,
    JSON.stringify(details),
    description
  );
  totalInserted++;
}

// ================================================================
// A. COMPLETED SWEEP RESULTS
// ================================================================
console.log('\n=== A. Completed Sweep Results ===');

// --- MAE Threshold Test ---
const maeThresholdSweep = db.createSweep({
  name: 'MAE Threshold Test',
  description: 'Test MAE-based exits (MAE threshold + hold time cutoff) across Cards 1, 2, 4. Tick-level Rust fill_sim.',
  sweep_type: 'fillsim',
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'Card1 MAE25/10min = Sharpe 1.18 (best). Card2/4 dont benefit from MAE cuts. Completed Mar 17.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-17 23:00:00' WHERE id = ?").run(maeThresholdSweep.id);
db.addSweepResult({ sweep_id: maeThresholdSweep.id, config_json: '{"card":"Card1","mae_ticks":25,"mae_hold_sec":600}', sharpe: 1.18, pnl: null, metrics_json: '{"verdict":"BEST for Card1"}' });
db.addSweepResult({ sweep_id: maeThresholdSweep.id, config_json: '{"card":"Card2","mae_ticks":"various","mae_hold_sec":"various"}', sharpe: null, pnl: null, metrics_json: '{"verdict":"No benefit from MAE cuts"}' });
db.addSweepResult({ sweep_id: maeThresholdSweep.id, config_json: '{"card":"Card4","mae_ticks":"various","mae_hold_sec":"various"}', sharpe: null, pnl: null, metrics_json: '{"verdict":"No benefit from MAE cuts"}' });
console.log(`  + Sweep ${maeThresholdSweep.id}: MAE Threshold Test (completed)`);

// --- Scalp Sweep ---
const scalpSweep = db.createSweep({
  name: '10s Scalp Sweep',
  description: 'ALL 144 configs: TP1-6 x hold 10s-120s x passive limits. Testing 10-second horizon appropriate exits.',
  sweep_type: 'grid',
  total_configs: 144,
  completed_configs: 144,
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'ALL 144 configs NEGATIVE. Adverse selection (17-25% fill rate). Model IS predictive but passive limit orders cant overcome costs.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-18 04:00:00' WHERE id = ?").run(scalpSweep.id);
console.log(`  + Sweep ${scalpSweep.id}: 10s Scalp Sweep — ALL NEGATIVE (completed)`);
logSweepResult('scalp_sweep', 'ALL 144 scalp configs negative. Adverse selection 17-25% fill rate. Model predictive but cant overcome costs with passive limits.', { configs: 144, tp_range: '1-6', hold_range: '10s-120s', entry_type: 'passive' });

// --- Chase Entry Test ---
const chaseEntrySweep = db.createSweep({
  name: 'Chase Entry Scalp Test',
  description: 'Chase entry (1 tick, 3 reprices) with various TP/hold combos. Tests if aggressive entry fixes adverse selection.',
  sweep_type: 'grid',
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'HFT CARD FOUND: Chase1 TP4 Card4 = Sharpe 1.99! Chase entry makes scalping viable. Market entry catastrophic (-$981K). Passive barely breaks even.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-18 06:00:00', best_metric = 1.99, best_config_json = '{\"card\":\"Card4\",\"tp\":4,\"chase_ticks\":1,\"chase_reprices\":3,\"hold_sec\":120}' WHERE id = ?").run(chaseEntrySweep.id);
db.addSweepResult({ sweep_id: chaseEntrySweep.id, config_json: '{"card":"Card4","tp":4,"chase_ticks":1,"chase_reprices":3,"hold_sec":120}', sharpe: 1.99, pnl: null, metrics_json: '{"verdict":"HFT CARD FOUND","entry_type":"chase1"}' });
db.addSweepResult({ sweep_id: chaseEntrySweep.id, config_json: '{"entry_type":"market"}', sharpe: null, pnl: -981000, metrics_json: '{"verdict":"CATASTROPHIC — market entry destroys everything"}' });
db.addSweepResult({ sweep_id: chaseEntrySweep.id, config_json: '{"entry_type":"passive"}', sharpe: null, pnl: null, metrics_json: '{"verdict":"Barely breaks even"}' });
console.log(`  + Sweep ${chaseEntrySweep.id}: Chase Entry Test — Sharpe 1.99 found! (completed)`);

// --- RTH Validation ---
const rthSweep = db.createSweep({
  name: 'RTH Validation',
  description: 'Verify fill_sim already handles RTH correctly. Test open/close edge contribution.',
  sweep_type: 'manual',
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'fill_sim ALREADY does RTH. Card2 Sharpe=5.36 (best). Open/close sessions drive edge.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-17 20:00:00', best_metric = 5.36 WHERE id = ?").run(rthSweep.id);
db.addSweepResult({ sweep_id: rthSweep.id, config_json: '{"card":"Card2","rth":true}', sharpe: 5.36, metrics_json: '{"verdict":"Best RTH performance. Open/close drives edge."}' });
console.log(`  + Sweep ${rthSweep.id}: RTH Validation (completed)`);

// --- Vol Gate Analysis ---
const volGateSweep = db.createSweep({
  name: 'Vol Gate Analysis',
  description: 'Test vol percentile gates across all cards. Card3 at any gate, Card4 vol70 vs vol50.',
  sweep_type: 'manual',
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'Card3 NOT tradeable at ANY vol gate (Sharpe -0.25 to 0.06). Card4 vol70 IS optimal (Sharpe 3.30, $11,065). Vol50 worse.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-17 21:00:00' WHERE id = ?").run(volGateSweep.id);
db.addSweepResult({ sweep_id: volGateSweep.id, config_json: '{"card":"Card3","vol_gate":"all_tested"}', sharpe: 0.06, metrics_json: '{"verdict":"NOT tradeable at ANY vol gate. Sharpe -0.25 to 0.06. Drop card."}' });
db.addSweepResult({ sweep_id: volGateSweep.id, config_json: '{"card":"Card4","vol_gate":70}', sharpe: 3.30, pnl: 11065, metrics_json: '{"verdict":"vol70 IS optimal historically"}' });
db.addSweepResult({ sweep_id: volGateSweep.id, config_json: '{"card":"Card4","vol_gate":50}', sharpe: null, metrics_json: '{"verdict":"vol50 is WORSE. Dont change based on 1 day."}' });
console.log(`  + Sweep ${volGateSweep.id}: Vol Gate Analysis (completed)`);

// --- Trailing Stops Test ---
const trailingStopSweep = db.createSweep({
  name: 'Trailing Stops Test',
  description: 'Simple trailing stops across all cards. Tick-level Rust fill_sim.',
  sweep_type: 'fillsim',
  metric_name: 'sharpe',
  node: 'saturn',
  notes: 'ALL CATASTROPHIC. Sharpe -6 to -13. Microstructure noise kills trailing stops on 10s predictions.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-17 19:00:00' WHERE id = ?").run(trailingStopSweep.id);
db.addSweepResult({ sweep_id: trailingStopSweep.id, config_json: '{"exit_type":"simple_trailing","cards":"all"}', sharpe: -6.0, metrics_json: '{"range":"-6 to -13","verdict":"CATASTROPHIC. DO NOT USE."}' });
console.log(`  + Sweep ${trailingStopSweep.id}: Trailing Stops — ALL CATASTROPHIC (completed)`);

// --- Stop Losses Test ---
const stopLossSweep = db.createSweep({
  name: 'Fixed Stop Loss Test',
  description: 'Fixed stop losses across all cards. Tick-level Rust fill_sim.',
  sweep_type: 'fillsim',
  metric_name: 'sharpe',
  node: 'saturn',
  notes: 'ALL CATASTROPHIC. Sharpe -0.35 to -9.01. Same noise problem as trailing stops.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-17 19:30:00' WHERE id = ?").run(stopLossSweep.id);
db.addSweepResult({ sweep_id: stopLossSweep.id, config_json: '{"exit_type":"fixed_sl","cards":"all"}', sharpe: -0.35, metrics_json: '{"range":"-0.35 to -9.01","verdict":"CATASTROPHIC. DO NOT USE."}' });
console.log(`  + Sweep ${stopLossSweep.id}: Fixed Stop Loss — ALL CATASTROPHIC (completed)`);

// --- Hold Time Analysis ---
const holdTimeSweep = db.createSweep({
  name: 'Hold Time Analysis',
  description: 'Test hold times from 10min to 2hr across cards. Longer = better for 10s predictions.',
  sweep_type: 'fillsim',
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'Card1: 10m=2.64, 30m=2.58, 60m=3.88, 2h=4.07. Longer is better — directional bias persists well past signal expiry.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-17 22:00:00' WHERE id = ?").run(holdTimeSweep.id);
db.addSweepResult({ sweep_id: holdTimeSweep.id, config_json: '{"card":"Card1","hold_min":10}', sharpe: 2.64, metrics_json: '{}' });
db.addSweepResult({ sweep_id: holdTimeSweep.id, config_json: '{"card":"Card1","hold_min":30}', sharpe: 2.58, metrics_json: '{}' });
db.addSweepResult({ sweep_id: holdTimeSweep.id, config_json: '{"card":"Card1","hold_min":60}', sharpe: 3.88, metrics_json: '{}' });
db.addSweepResult({ sweep_id: holdTimeSweep.id, config_json: '{"card":"Card1","hold_min":120}', sharpe: 4.07, metrics_json: '{"verdict":"BEST — 2hr hold optimal for Card1"}' });
console.log(`  + Sweep ${holdTimeSweep.id}: Hold Time Analysis (completed)`);

// --- Conviction Exit Sweep ---
const convictionSweep = db.createSweep({
  name: 'Conviction Exit Sweep',
  description: '6 durations (5-120s) x 7 magnitudes (0.0-3.0) = 42 combos per card, 54 OOT days each. Then full OOT via Rust fill_sim (810 tasks).',
  sweep_type: 'grid',
  total_configs: 810,
  completed_configs: 810,
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'C6 conv10s/mag1.0 is the ONLY marginal improvement: Sharpe 1.42 vs 1.38 baseline (+$255, 17 exits). Everything else negative or neutral. 10s horizon too noisy for conviction exits.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-18 14:00:00' WHERE id = ?").run(convictionSweep.id);
db.addSweepResult({ sweep_id: convictionSweep.id, config_json: '{"card":"C6","conv_sec":10,"mag":1.0}', sharpe: 1.42, pnl: 255, metrics_json: '{"baseline_sharpe":1.38,"conviction_exits":17,"verdict":"ONLY marginal improvement"}' });
db.addSweepResult({ sweep_id: convictionSweep.id, config_json: '{"card":"C3","conv_sec":10,"mag":1.0}', sharpe: 1.54, metrics_json: '{"baseline_sharpe":2.05,"verdict":"WORSE than baseline"}' });
db.addSweepResult({ sweep_id: convictionSweep.id, config_json: '{"card":"C1","mag":0.0}', sharpe: null, metrics_json: '{"conviction_exits":1934,"verdict":"CATASTROPHIC — fires too often at mag0.0"}' });
db.addSweepResult({ sweep_id: convictionSweep.id, config_json: '{"card":"C1","mag":">=0.5"}', sharpe: null, metrics_json: '{"conviction_exits":0,"verdict":"Never fires — z-score never sustains opposite"}' });
db.addSweepResult({ sweep_id: convictionSweep.id, config_json: '{"card":"C7","conv_sec":10,"mag":3.0}', sharpe: null, pnl: 261, metrics_json: '{"conviction_exits":1,"verdict":"Trivial — smooth signals almost never flip"}' });
console.log(`  + Sweep ${convictionSweep.id}: Conviction Exit Sweep (completed)`);

// --- Ratcheting Trailing Stop ---
const ratchetSweep = db.createSweep({
  name: 'Ratcheting Trailing Stop',
  description: 'Ratcheting stop (lock profit at MFE thresholds). Rust fill_sim tick-level.',
  sweep_type: 'fillsim',
  metric_name: 'sharpe',
  node: 'saturn',
  notes: 'Sharpe 1.45 vs baseline 1.98. Cuts winners too early. REJECTED.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-17 18:00:00' WHERE id = ?").run(ratchetSweep.id);
db.addSweepResult({ sweep_id: ratchetSweep.id, config_json: '{"exit_type":"ratcheting_trailing"}', sharpe: 1.45, metrics_json: '{"baseline_sharpe":1.98,"verdict":"Cuts winners too early. REJECTED."}' });
console.log(`  + Sweep ${ratchetSweep.id}: Ratcheting Trailing Stop — REJECTED (completed)`);

// --- Breakeven Lock Test ---
const breakevenSweep = db.createSweep({
  name: 'Breakeven Lock Test',
  description: 'Lock stop to breakeven once MFE reaches threshold. Tick-level fill_sim.',
  sweep_type: 'fillsim',
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'Confirmed DESTROYS all cards. Breakeven lock causes premature exits on normal microstructure noise.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-18 05:00:00' WHERE id = ?").run(breakevenSweep.id);
console.log(`  + Sweep ${breakevenSweep.id}: Breakeven Lock — DESTROYS ALL CARDS (completed)`);

// --- Card567 Optuna Sweep ---
const card567Sweep = db.createSweep({
  name: 'Card567 Optuna Sweep',
  description: '1.68M total tasks on Jupiter. Card7 focused 90K on Saturn.',
  sweep_type: 'optuna',
  total_configs: 1680000,
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'Massive parameter sweep. Card7 focused 90K on Saturn was ~72% complete as of Mar 18.'
});
db.db.prepare("UPDATE sweeps SET status = 'running' WHERE id = ?").run(card567Sweep.id);
console.log(`  + Sweep ${card567Sweep.id}: Card567 Optuna (running, 1.68M tasks)`);

// --- MAE+Time Exit (via fill_sim validation) ---
const maeTimeSweep = db.createSweep({
  name: 'MAE+Time Exit Validation',
  description: 'MAE ticks + hold time exit rule. Tested in tick-level Rust fill_sim.',
  sweep_type: 'fillsim',
  metric_name: 'sharpe',
  node: 'saturn',
  notes: 'Sharpe 0.22 — too many false cuts. MAE+time exit REJECTED as general exit strategy. Only marginally useful for Card1 in post-hoc analysis.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-17 20:00:00' WHERE id = ?").run(maeTimeSweep.id);
db.addSweepResult({ sweep_id: maeTimeSweep.id, config_json: '{"exit_type":"mae_time","mae_ticks":10,"hold_min":10}', sharpe: 0.22, metrics_json: '{"verdict":"Too many false cuts. REJECTED."}' });
console.log(`  + Sweep ${maeTimeSweep.id}: MAE+Time Exit — Sharpe 0.22, REJECTED (completed)`);

// --- Raw Signal Flip Exit ---
const signalFlipSweep = db.createSweep({
  name: 'Raw Signal Flip Exit',
  description: 'Exit when raw z-score sign flips. Tick-level fill_sim.',
  sweep_type: 'fillsim',
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'Sharpe -15. Predictions flip too frequently at 10s horizon. DO NOT USE.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-17 18:30:00' WHERE id = ?").run(signalFlipSweep.id);
db.addSweepResult({ sweep_id: signalFlipSweep.id, config_json: '{"exit_type":"raw_signal_flip"}', sharpe: -15, metrics_json: '{"verdict":"CATASTROPHIC. Predictions flip too frequently."}' });
console.log(`  + Sweep ${signalFlipSweep.id}: Raw Signal Flip — Sharpe -15, CATASTROPHIC (completed)`);

// --- 4-Card OOT Validation (Mar 17 morning) ---
const ootValidationSweep = db.createSweep({
  name: '4-Card OOT Validation',
  description: 'Full out-of-time validation on all 4 original cards after ESZ5->ESH5 contract rollover fix.',
  sweep_type: 'fillsim',
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'All 4 cards validated. Root cause of $0 Jan/Feb: futures contract rollover ESZ5->ESH5.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-17 08:30:00' WHERE id = ?").run(ootValidationSweep.id);
db.addSweepResult({ sweep_id: ootValidationSweep.id, config_json: '{"card":"Card1","variant":"book_predstdExit_conv1.5_vol50_tp8_slN_sig0.1"}', sharpe: 3.88, metrics_json: '{"verdict":"OOT validated"}' });
db.addSweepResult({ sweep_id: ootValidationSweep.id, config_json: '{"card":"Card2","variant":"book_predstdExit_conv1.5_vol50_tp15_slN_sig0.5"}', sharpe: 4.11, metrics_json: '{"verdict":"OOT validated — BEST"}' });
db.addSweepResult({ sweep_id: ootValidationSweep.id, config_json: '{"card":"Card3","variant":"raw_smoothExit_conv0.05_vol70_tp15_slN_sig0.5"}', sharpe: 3.82, metrics_json: '{"verdict":"OOT validated (fixed from -0.45)"}' });
db.addSweepResult({ sweep_id: ootValidationSweep.id, config_json: '{"card":"Card4","variant":"book_predstdExit_conv2.0_vol70_tp20_slN_sig0.5"}', sharpe: 3.05, metrics_json: '{"verdict":"OOT validated (fixed from zero trades)"}' });
console.log(`  + Sweep ${ootValidationSweep.id}: 4-Card OOT Validation (completed)`);

// --- 36-Config Full Validation (Mar 17 evening) ---
const fullValidationSweep = db.createSweep({
  name: '36-Config Full Validation',
  description: 'Full 36-config validation on Jupiter. 1,939 jobs, ~60 min ETA. Ratchet + MAE + exit variants.',
  sweep_type: 'grid',
  total_configs: 1939,
  completed_configs: 1939,
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'Completed. Conclusion: Simple TP + EOD close is currently best exit strategy.'
});
db.db.prepare("UPDATE sweeps SET status = 'completed', completed_at = '2026-03-17 22:30:00' WHERE id = ?").run(fullValidationSweep.id);
console.log(`  + Sweep ${fullValidationSweep.id}: 36-Config Full Validation (completed)`);


// ================================================================
// B. KEY DECISIONS
// ================================================================
console.log('\n=== B. Key Decisions ===');

logDecision('model_horizon', 'CRITICAL: All CNN models are 10-second prediction horizon (horizon_bars=100). We have been testing with 30min holds on 10s predictions.', { horizon_bars: 100, horizon_seconds: 10, discovery_date: '2026-03-17 21:30' });

logDecision('entry_type', 'Chase entry (1 tick, 3 reprices) is the ONLY viable scalping approach. Market entry catastrophic. Passive barely breaks even.', { chase_ticks: 1, chase_reprices: 3, market_pnl: -981000 });

logDecision('trailing_stop', 'Ratcheting trailing stop REJECTED — cuts winners early. Sharpe 1.45 vs 1.98 baseline.', { ratchet_sharpe: 1.45, baseline_sharpe: 1.98 });

logDecision('mae_time_exit', 'MAE+time exit works for Card1 only (post-hoc). Fill_sim validation shows Sharpe 0.22 — too many false cuts for general use.', { card1_benefit: true, general_use: false, fillsim_sharpe: 0.22 });

logDecision('conviction_exit', 'Conviction exit NOT worth deploying. 10s horizon too noisy. C6 conv10s/mag1.0 is only marginal +$255. Feature exists in fill_sim for future multi-horizon use.', { best_delta_pnl: 255, best_card: 'C6', reason: '10s_horizon_noise' });

logDecision('multi_horizon', 'Multi-horizon is the NEXT research priority. Agreement/disagreement across timeframes = real conviction.', { priority: 1, horizons: ['10s', '30s', '1m', '5m'] });

logDecision('hold_time', 'Cards should use 2hr holds. Longer is better for 10s predictions. Card1: 10m=2.64, 30m=2.58, 60m=3.88, 2h=4.07.', { recommended_hold_ms: 7200000, sharpe_at_2h: 4.07 });

logDecision('rth_filter', 'RTH filter MANDATORY. Open/close sessions drive edge. fill_sim already handles RTH correctly.', { rth_start: '09:30', rth_end: '16:00', timezone: 'ET' });

logDecision('vol_gate', 'Card4 MUST use vol70. Vol50 is worse. Card3 NOT tradeable at ANY vol gate — consider dropping.', { card4_optimal: 70, card3_verdict: 'not_tradeable' });

logDecision('stop_loss', 'Fixed stop losses DESTROY alpha. Sharpe -0.35 to -9.01. DO NOT USE on any card.', { sharpe_range: [-9.01, -0.35] });

logDecision('trailing_stop_simple', 'Simple trailing stops DESTROY alpha. Sharpe -6 to -13. Microstructure noise kills them.', { sharpe_range: [-13, -6] });

logDecision('exit_strategy', 'CONCLUSION: Simple TP + EOD close is currently best exit strategy. All tested alternatives are worse.', { best_strategy: 'tp_plus_eod_close', date: '2026-03-17' });

logDecision('breakeven_lock', 'Breakeven lock DESTROYS all cards. Premature exits on normal microstructure noise.', { verdict: 'rejected' });

logDecision('signal_flip_exit', 'Raw signal flip exit: Sharpe -15. Predictions flip too frequently at 10s horizon. DO NOT USE.', { sharpe: -15 });

logDecision('contract_rollover', 'Root cause of $0 Jan/Feb performance: ESZ5 to ESH5 futures contract rollover was not handled.', { fix_date: '2026-03-17', old_contract: 'ESZ5', new_contract: 'ESH5' });

logDecision('card_deployment_rule', 'Test optimizations on historical data BEFORE deploying live. No card deployment without full MAE/MFE risk profile.', { rule: 'mandatory_backtest' });

logDecision('single_rithmic_connection', 'Only 1 concurrent Rithmic connection allowed per user. Must kill stale connections before reconnecting.', { max_connections: 1 });

console.log('  + 17 key decisions logged');


// ================================================================
// C. PAPER TRADING HISTORY
// ================================================================
console.log('\n=== C. Paper Trading History ===');

// Day 1: March 17
logEvent('paper_trading', 'Paper Day 1 (Mar 17): +$118.70 total, 100% WR, 4-5 trades (all SHORT). Card1: 3 trades (+$151.53). Card2: 2 trades (+$59.35). Card3/4: ZERO trades (vol gate 70% too restrictive).', {
  date: '2026-03-17', pnl: 118.70, trades: 5, win_rate: 1.0,
  card1_trades: 3, card1_pnl: 151.53,
  card2_trades: 2, card2_pnl: 59.35,
  card3_trades: 0, card4_trades: 0
});

// Add actual paper trades to trade_history
const day1Trades = [
  { card_name: 'Card1', session_date: '2026-03-17', side: 'SHORT', pnl_dollars: 50.51, pnl_ticks: 8, exit_reason: 'tp_hit', mae_ticks: 12, mfe_ticks: 8 },
  { card_name: 'Card1', session_date: '2026-03-17', side: 'SHORT', pnl_dollars: 29.68, exit_reason: 'timeout', mae_ticks: 27, mfe_ticks: 27 },
  { card_name: 'Card1', session_date: '2026-03-17', side: 'SHORT', pnl_dollars: 29.68, exit_reason: 'timeout', mae_ticks: 34, mfe_ticks: 34 },
  { card_name: 'Card2', session_date: '2026-03-17', side: 'SHORT', pnl_dollars: 29.68, exit_reason: 'timeout', mae_ticks: 27, mfe_ticks: 27 },
  { card_name: 'Card2', session_date: '2026-03-17', side: 'SHORT', pnl_dollars: 29.68, exit_reason: 'timeout', mae_ticks: 27, mfe_ticks: 27 },
];

for (const t of day1Trades) {
  db.addTrade(t);
  totalInserted++;
}
console.log(`  + 5 paper trades from Day 1 (Mar 17)`);

// TP trigger bug
logEvent('bug_found', 'TP Trigger Bug: Timeout trades had MFE of 27-34 ticks ($1,375-$1,700) during hold. TP8/TP15 should have triggered but didnt. Root cause: Template 150 (LastTrade) was never subscribed. Fixed — now checks every trade event.', {
  date: '2026-03-17', severity: 'critical',
  mfe_range: '27-34 ticks', status: 'fixed',
  root_cause: 'Template 150 LastTrade not subscribed'
});

// Vol gate issue
logEvent('config_issue', 'Vol gate too restrictive at 90: Card3 only 0.2% pass. Card4 100% high-conviction signals had vol 56-62%, ALL blocked. Tested vol50: Card3 would have made $2,250, Card4 would have caught SELL signal.', {
  date: '2026-03-17', card3_pass_rate: 0.002, card4_signals_blocked: '100%'
});

// Day 2: March 18
logEvent('paper_trading', 'Paper Day 2 (Mar 18): 6-card engine running (cards 1,2,4,5,6,7). Rithmic connected, MBO flowing, RTH filter active.', {
  date: '2026-03-18', active_cards: [1, 2, 4, 5, 6, 7]
});

logEvent('bug_found', 'Rithmic disconnects every 60-80s (ForcedLogout template 77). Account-level session termination, NOT code bug. Later stabilized after AMP side fix.', {
  date: '2026-03-18', template: 77, disconnect_interval: '60-80s', status: 'resolved'
});

logEvent('bug_found', 'Fixed time module bug: order_types.py `import time` shadowed datetime.time. Caused crash on time-based operations.', {
  date: '2026-03-18', file: 'order_types.py', status: 'fixed'
});

logEvent('paper_trading', 'Killed old 4-card paper engine (PID 28000), kept 6-card engine (PID 33788). Cleared stale live_state.json.', {
  date: '2026-03-18', old_pid: 28000, new_pid: 33788
});

logEvent('paper_trading', 'Rithmic connection STABLE now (no more 60s disconnects). Watchdog auto-restart re-enabled (3 crash threshold, exponential backoff).', {
  date: '2026-03-18', status: 'stable'
});

console.log('  + 7 paper trading events logged');


// ================================================================
// D. TRAINING HISTORY / RESULTS
// ================================================================
console.log('\n=== D. Training History / Results ===');

// Register the Standard CNN WF (completed) model if not present
const stdCnnModel = db.registerModel({
  name: 'Standard BookCNN 100d WF',
  architecture: 'CNN',
  horizon_bars: 100,
  subsample: 5,
  window_mode: 'expanding',
  epochs: 3,
  node: 'multiple',
  status: 'completed',
  total_folds: 94,
  notes: 'Standard BookSpatialCNN 100-day expanding WF. IC=0.1298 mean across 94 folds. COMPLETE. This was the baseline model.'
});
db.updateModel(stdCnnModel.id, { completed_folds: 94, mean_ic: 0.1298 });
console.log(`  + Model ${stdCnnModel.id}: Standard CNN WF (completed, IC=0.1298)`);

// Register training jobs for historical GPU work
db.createTrainingJob({
  model_id: stdCnnModel.id,
  node: 'neptune',
  job_type: 'training',
  description: 'Standard BookCNN WF — completed all 94 folds',
  total_folds: 94,
  current_fold: 94,
  status: 'completed',
  progress_pct: 100.0
});
totalInserted++;

// Uranus CNN WF (completed folds 163-167 on March 18)
logEvent('training', 'Uranus CNN WF folds 163-167 COMPLETE. IC avg 0.073 on Mar dates. Used --start-fold flag to bypass broken glob/permissions.', {
  node: 'uranus', folds: '163-167', ic_avg: 0.073, date: '2026-03-18'
});

// Wider CNN: notable results
logEvent('training', 'Wider CNN (12.6M params) through 6 folds: mean IC=+0.1772 (+36% vs standard!). VERY PROMISING.', {
  node: 'neptune', model: 'Wider CNN', params: '12.6M', ic_mean_6folds: 0.1772,
  improvement_vs_standard: '+36%', date: '2026-03-16'
});

// 1-min CNN WF fold results
logEvent('training', '1-min CNN WF on Razer: fold ICs = [0.046, 0.071, 0.038 (overfit), 0.094]. Mixed results — fold 3 overfitting.', {
  node: 'razer', model: '1-min CNN WF', fold_ics: [0.046, 0.071, 0.038, 0.094],
  total_folds: 167, date: '2026-03-18'
});

// Hybrid v3 fold 1 result
logEvent('training', 'Hybrid v3 WF fold 1 on Uranus: IC=0.099. 6.7M params, sliding 30d, subsample 5, dropout 0.5. No overfitting detected.', {
  node: 'uranus', model: 'Hybrid v3', ic_fold1: 0.099, params: '6.7M',
  window_mode: 'sliding_30d', dropout: 0.5, date: '2026-03-17'
});

// Dead architectures
logEvent('training', 'GNN architecture: DEAD. Failed to produce useful predictions.', { model: 'GNN', verdict: 'dead' });
logEvent('training', 'Event Transformer architecture: DEAD in fill sim. No tradeable signal.', { model: 'Event Transformer', verdict: 'dead' });

// Checkpoint corruption issue
logEvent('bug_found', 'Checkpoint system broken — has lost training progress 3+ times. Added --start-fold flag as workaround. Needs systematic fix.', {
  severity: 'critical', occurrences: '3+', workaround: '--start-fold flag'
});

console.log('  + 8 training events logged');


// ================================================================
// E. INFRASTRUCTURE (Opus Overhaul Components)
// ================================================================
console.log('\n=== E. Infrastructure Components ===');

const opusComponents = [
  { name: 'threshold_gate.py', lines: 824, type: 'LightGBM classifier, Platt scaling', desc: 'Threshold gate — determines if prediction is strong enough to trade' },
  { name: 'vol_predictor.py', lines: 1139, type: 'Dual LightGBM', desc: 'Volatility predictor — predicts future vol for position sizing and gating' },
  { name: 'trend_persistence.py', lines: 672, type: 'LightGBM binary classifier', desc: 'Trend persistence — predicts whether current trend will continue' },
  { name: 'survival_model.py', lines: 850, type: 'Discrete-time survival', desc: 'Survival model — predicts time-to-event for TP/SL hitting' },
  { name: 'cross_horizon_meta.py', lines: 950, type: 'Ridge+LightGBM, IC=0.0805', desc: 'Cross-horizon meta model — combines multiple horizon predictions' },
  { name: 'alpha_gate.py', lines: 1430, type: 'Master gating system', desc: 'Alpha gate — master entry gate combining all sub-models' },
  { name: 'signal_engine.py', lines: 600, type: 'Signal orchestrator', desc: 'Signal engine — orchestrates all components into trade signals' },
];

for (const comp of opusComponents) {
  logInfra('opus_overhaul', `Opus Component: ${comp.name} (${comp.lines} lines) — ${comp.desc}`, {
    filename: comp.name, lines: comp.lines, model_type: comp.type,
    status: 'written_not_integrated', date: '2026-03-18'
  });
}
console.log(`  + 7 Opus overhaul components logged`);

// Live infrastructure built
const infraItems = [
  { name: 'startup.py', desc: 'Master launcher for all live trading components' },
  { name: 'watchdog.py', desc: 'Auto-restart crashed processes' },
  { name: 'eod_validate.py', desc: 'End-of-day MBO data validation' },
  { name: 'ws_server.py', desc: 'WebSocket streaming server on :8600 for dashboard' },
  { name: 'measure_latency.py', desc: 'Pipeline latency measurement tool' },
  { name: 'trade_db.py', desc: 'SQLite trade database — replaces JSON logging' },
  { name: 'record_mbo_v2.py', desc: 'MBO recorder v2 for Rithmic data' },
  { name: 'Neptune Guardian', desc: 'Kills training at 85% RAM, max 16 Python processes' },
  { name: 'Compute Watchdog', desc: 'Multi-node monitoring with overfitting detection' },
  { name: 'Paper Engine v2', desc: '6-card paper engine with FIFO queue simulation, event-level processing' },
];

for (const item of infraItems) {
  logInfra('live_system', `Live Infrastructure: ${item.name} — ${item.desc}`, {
    component: item.name, status: 'deployed', date: '2026-03-17'
  });
}
console.log(`  + 10 live infrastructure components logged`);


// ================================================================
// F. LATENCY MEASUREMENTS
// ================================================================
console.log('\n=== F. Latency Measurements ===');

logEvent('latency', 'Pipeline latency measured Mar 17 10:45 AM: WebSocket RTT 55ms (one-way ~28ms to Rithmic Chicago), CNN inference 4.4ms (CUDA warm), Protobuf parse 5us, Book update 27us, Signal+order 12us. Total pipeline: ~33ms.', {
  date: '2026-03-17 10:45',
  ws_rtt_ms: 55, ws_oneway_ms: 28,
  cnn_inference_ms: 4.4, protobuf_parse_us: 5,
  book_update_us: 27, signal_order_us: 12,
  total_pipeline_ms: 33,
  note: 'Very good for non-colocated. Earlier 416ms was WRONG (clock skew).'
});
console.log('  + Latency measurements logged');


// ================================================================
// G. CARD RISK PROFILES (from 68-day OOT)
// ================================================================
console.log('\n=== G. Card Risk Profiles ===');

const riskProfiles = [
  { card: 'Card1', tp: 8, wr: 93.1, pf: 1.34, avg_win: 7.6, avg_loss: -77.0, ratio: '1:10', mae_mfe: 2.72, note: 'Most dangerous loss ratio' },
  { card: 'Card2', tp: 15, wr: 84.7, pf: 1.21, avg_win: 14.5, avg_loss: -66.1, ratio: '1:4.6', mae_mfe: 2.36, note: '' },
  { card: 'Card3', tp: 15, wr: 86.8, pf: 1.15, avg_win: 12.0, avg_loss: -68.5, ratio: '1:5.7', mae_mfe: 2.45, note: 'NOT tradeable per vol gate analysis' },
  { card: 'Card4', tp: 20, wr: 79.3, pf: 1.40, avg_win: 22.6, avg_loss: -61.7, ratio: '1:2.7', mae_mfe: 1.81, note: 'Best risk profile' },
  { card: 'Card7', tp: 0, wr: 24.0, pf: null, avg_win: 75.6, avg_loss: -20.4, ratio: '3.7:1', mae_mfe: 0.41, note: 'Best MAE/MFE ratio' },
];

for (const rp of riskProfiles) {
  logEvent('risk_profile', `${rp.card} Risk Profile (68-day OOT): TP${rp.tp}, WR ${rp.wr}%, PF ${rp.pf}, AvgWin ${rp.avg_win}t, AvgLoss ${rp.avg_loss}t, W/L Ratio ${rp.ratio}, MAE/MFE ${rp.mae_mfe}. ${rp.note}`, {
    card: rp.card, tp_ticks: rp.tp, win_rate: rp.wr / 100,
    profit_factor: rp.pf, avg_win_ticks: rp.avg_win, avg_loss_ticks: rp.avg_loss,
    win_loss_ratio: rp.ratio, mae_mfe_ratio: rp.mae_mfe,
    oot_days: 68
  });
}
console.log(`  + 5 card risk profiles logged`);


// ================================================================
// H. EDGE DECAY CURVE
// ================================================================
console.log('\n=== H. Edge Decay Curve ===');

logEvent('analysis', 'Edge Decay Curve: <1min 100% WR (pure edge), 1-5min 100% (strong), 5-10min 99% (good), 10-20min 95% (fading), 20-30min 91% (marginal), >30min 56-85% (NOISE). Confirms 10s prediction horizon — edge expires fast.', {
  date: '2026-03-17',
  decay: [
    { hold: '<1min', wr: 100, verdict: 'pure_edge' },
    { hold: '1-5min', wr: 100, verdict: 'strong' },
    { hold: '5-10min', wr: 99, verdict: 'good' },
    { hold: '10-20min', wr: 95, verdict: 'fading' },
    { hold: '20-30min', wr: 91, verdict: 'marginal' },
    { hold: '>30min', wr: '56-85', verdict: 'NOISE' }
  ]
});
console.log('  + Edge decay curve logged');


// ================================================================
// I. DEPLOYMENT CARDS (current plan)
// ================================================================
console.log('\n=== I. Deployment Card Configs ===');

logDecision('deployment', 'Card1 Deploy Config: TP8 + MAE25t/10min + 2hr hold. Sharpe 1.18.', { card: 'Card1', tp: 8, mae_ticks: 25, mae_hold_sec: 600, hold_ms: 7200000, sharpe: 1.18 });
logDecision('deployment', 'Card2 Deploy Config: TP15 + 2hr hold. Sharpe 1.35.', { card: 'Card2', tp: 15, hold_ms: 7200000, sharpe: 1.35 });
logDecision('deployment', 'Card4 Deploy Config: TP20 + 2hr hold. Sharpe 2.62.', { card: 'Card4', tp: 20, hold_ms: 7200000, sharpe: 2.62 });
logDecision('deployment', 'Card4-HFT Deploy Config: TP4 + chase entry (1t/3reprices) + 120s hold. Sharpe 1.99. NEW — NEEDS MAE/MFE risk profile before deploying.', { card: 'Card4-HFT', tp: 4, chase_ticks: 1, chase_reprices: 3, hold_sec: 120, sharpe: 1.99, needs_risk_profile: true });
console.log('  + 4 deployment configs logged');


// ================================================================
// J. RITHMIC CONNECTION DETAILS
// ================================================================
console.log('\n=== J. Rithmic Connection Details ===');

logInfra('rithmic', 'Rithmic LIVE Connection: Gateway wss://rprotocol.rithmic.com:443, System "Rithmic 01", User njliautaud@amp.com, Account 224536, FCM AMPClearing, IB AMP. Template_version 3.9, heartbeat required immediately after login.', {
  gateway: 'wss://rprotocol.rithmic.com:443',
  system: 'Rithmic 01',
  user: 'njliautaud@amp.com',
  account: '224536',
  fcm: 'AMPClearing',
  ib: 'AMP',
  template_version: '3.9',
  note: 'Rithmic Paper Trading system: permission denied (not provisioned)'
});
console.log('  + Rithmic connection details logged');


// ================================================================
// K. PIPELINE VERIFICATION
// ================================================================
console.log('\n=== K. Pipeline Verification ===');

logEvent('verification', 'Pipeline Verification (Mar 17 12:20 PM) — ALL PASSED. Test 1: Rust cache tensor vs Python LiveBookBuilder PASS. Test 2: Single-bar vs batch inference PASS. Test 3: Z-score parity PASS (<1e-7). OrderBook parse_action/parse_side bug FIXED.', {
  date: '2026-03-17 12:20',
  test1: 'Rust cache tensor vs Python LiveBookBuilder: PASS',
  test2: 'Single-bar vs batch inference: PASS (BatchNorm eval mode correct)',
  test3: 'Z-score parity: PASS (<1e-7, no leakage)',
  bug_fixed: 'OrderBook parse_action/parse_side (int ord() values)'
});
console.log('  + Pipeline verification logged');


// ================================================================
// L. CONVICTION EXIT DETAILED ANALYSIS
// ================================================================
console.log('\n=== L. Conviction Exit Cross-Card Results ===');

const convictionResults = [
  { card: 'C3', type: 'raw', threshold: '10s/mag0.0', net_pnl: 11291, losers_cut: '25/65 (38%)', fpr: 18.8, precision: 20.3 },
  { card: 'C6', type: 'raw', threshold: '10s/mag0.0', net_pnl: 3678, losers_cut: '50/224 (22%)', fpr: 15.8, precision: 50.5 },
  { card: 'C1', type: 'book', threshold: '5s/mag0.0', net_pnl: 2571, losers_cut: '4/40 (10%)', fpr: 2.3, precision: 26.7 },
  { card: 'C5', type: 'raw', threshold: '15s/mag2.0', net_pnl: 831, losers_cut: '3/136 (2.2%)', fpr: 0.6, precision: 75.0 },
  { card: 'C4', type: 'book', threshold: '5s/mag0.0', net_pnl: 802, losers_cut: '1/15 (6.7%)', fpr: 0.7, precision: 50.0 },
  { card: 'C7', type: 'smooth', threshold: '10s/mag3.0', net_pnl: 261, losers_cut: '1/90 (1.1%)', fpr: 0, precision: 100.0 },
];

for (const cr of convictionResults) {
  logEvent('conviction_analysis', `Conviction Exit ${cr.card} (${cr.type}): Best=${cr.threshold}, Net PnL=$${cr.net_pnl}, Losers Cut=${cr.losers_cut}, FPR=${cr.fpr}%, Precision=${cr.precision}%`, {
    card: cr.card, signal_type: cr.type, best_threshold: cr.threshold,
    net_pnl: cr.net_pnl, losers_cut: cr.losers_cut,
    false_positive_rate: cr.fpr, precision: cr.precision,
    note: 'Post-hoc analysis was MISLEADING — didnt model re-entry trades'
  });
}
logDecision('conviction_findings', 'Raw signal cards (C3, C6) benefit most from conviction exits. Book spatial CNN (C1, C4) oscillate too rapidly. Smooth signals (C7) — almost no conviction flips. But real fill_sim validation showed all marginal at best.', {
  raw_benefit: true, book_benefit: false, smooth_benefit: false,
  root_cause: '10s_prediction_horizon'
});
console.log(`  + 7 conviction analysis entries logged`);


// ================================================================
// M. UPDATE RESEARCH PROJECT STATUSES
// ================================================================
console.log('\n=== M. Research Project Updates ===');

// Update conviction exit to completed with findings
const convictionResearch = db.db.prepare("SELECT id FROM research_projects WHERE name LIKE '%Conviction%' LIMIT 1").get();
if (convictionResearch) {
  db.updateResearch(convictionResearch.id, {
    status: 'completed',
    findings: 'Marginal at best. C6 conv10s/mag1.0 only +$255. Post-hoc analysis was misleading — real fill_sim shows all neutral or negative. 10s prediction horizon too noisy for conviction-based exits. Feature exists in Rust fill_sim for future multi-horizon use.',
    next_steps: 'Revisit when multi-horizon models available. Agreement/disagreement across 10s/30s/1m/5m = real conviction.',
    tags: 'exits,strategy,completed,10s-horizon'
  });
  console.log(`  + Updated Conviction Exit research to completed`);
}

// Update multi-horizon priority
const multiHorizonResearch = db.db.prepare("SELECT id FROM research_projects WHERE name LIKE '%Multi-Horizon%' LIMIT 1").get();
if (multiHorizonResearch) {
  db.updateResearch(multiHorizonResearch.id, {
    status: 'proposed',
    priority: 1,
    findings: null,
    next_steps: 'Train 30s, 1m, 5m horizon models. Then build ensemble that uses agreement/disagreement as conviction signal. This is THE key next step — all current exit research blocked by single 10s horizon.',
    tags: 'ensemble,multi-horizon,high-priority,next-priority'
  });
  console.log(`  + Updated Multi-Horizon research to priority 1`);
}


// ================================================================
// N. MBO DATA & RECORDING STATS
// ================================================================
console.log('\n=== N. MBO Data Stats ===');

logEvent('data', 'MBO Recording Mar 17: Started ~10:15 AM ET. 600K+ events (287K MBO template 160 + BBO + trades). Rate: ~167 MBO/sec, ~308 total/sec. Updated recorder to save ONLY MBO events.', {
  date: '2026-03-17', events: '600K+', mbo_template: 160,
  mbo_rate: 167, total_rate: 308
});

logEvent('data', 'Events cache transfer to Uranus: COMPLETE. 100 files, 2.3GB via SFTP. Hybrid checkpoint also transferred.', {
  files: 100, size_gb: 2.3, source: 'neptune', dest: 'uranus'
});
console.log('  + 2 data events logged');


// ================================================================
// O. SAFEGUARDS & RULES
// ================================================================
console.log('\n=== O. Safeguards & Rules ===');

logDecision('safeguard', 'Neptune Guardian: kills training at 85% RAM, max 16 Python processes. NEVER allow >85% RAM or >16 CPU workers.', { ram_limit: 85, max_workers: 16, training: 'gpu_only' });
logDecision('safeguard', 'Safe Launch wrapper: preflight checks before any training launch. Compute Watchdog: 80% warning, 85% critical thresholds.', { warning_threshold: 80, critical_threshold: 85 });
logDecision('safeguard', 'Restart recovery: restart_claude.bat + restart_claude.sh created for remote restart. SSH sshd needs ListenAddress 0.0.0.0 fix (admin elevation needed).', {});
console.log('  + 3 safeguard rules logged');


// ================================================================
// SUMMARY
// ================================================================
console.log('\n========== QCC History Population Summary ==========');

const counts = {
  sweeps: db.db.prepare('SELECT COUNT(*) as cnt FROM sweeps').get().cnt,
  sweep_results: db.db.prepare('SELECT COUNT(*) as cnt FROM sweep_results').get().cnt,
  action_log: db.db.prepare('SELECT COUNT(*) as cnt FROM action_log').get().cnt,
  trades: db.db.prepare('SELECT COUNT(*) as cnt FROM trade_history').get().cnt,
  models: db.db.prepare('SELECT COUNT(*) as cnt FROM models').get().cnt,
  training_jobs: db.db.prepare('SELECT COUNT(*) as cnt FROM training_jobs').get().cnt,
  research: db.db.prepare('SELECT COUNT(*) as cnt FROM research_projects').get().cnt,
  alerts: db.db.prepare('SELECT COUNT(*) as cnt FROM alerts').get().cnt,
};

console.log(`  Sweeps:           ${counts.sweeps}`);
console.log(`  Sweep Results:    ${counts.sweep_results}`);
console.log(`  Action Log:       ${counts.action_log}`);
console.log(`  Trade History:    ${counts.trades}`);
console.log(`  Models:           ${counts.models}`);
console.log(`  Training Jobs:    ${counts.training_jobs}`);
console.log(`  Research:         ${counts.research}`);
console.log(`  Alerts:           ${counts.alerts}`);
console.log(`  Total new inserts: ~${totalInserted}`);
console.log('====================================================');
console.log('QCC history loaded successfully!');

db.db.close();
