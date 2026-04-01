/**
 * Populate QCC Database with current system state
 * Run: node scripts/populate_qcc.js
 */

const path = require('path');
const { QCCDatabase } = require('../lib/qcc-database');

const DB_PATH = path.join(__dirname, '..', 'data', 'qcc.db');
const db = new QCCDatabase(DB_PATH);

console.log('QCC Database opened at:', DB_PATH);

// ========================
// 1. COMPUTE NODES
// ========================
console.log('\n--- Populating Compute Nodes ---');

// Clear existing nodes to repopulate with accurate data
db.db.prepare('DELETE FROM compute_nodes').run();

const insertNode = db.db.prepare(`
  INSERT INTO compute_nodes (name, host, tailscale_ip, port, ssh_user, hop_through, gpu, gpu_vram_gb, ram_gb, os, lvl3_root, status, ssh_password, ssh_auth_method)
  VALUES (@name, @host, @tailscale_ip, @port, @ssh_user, @hop_through, @gpu, @gpu_vram_gb, @ram_gb, @os, @lvl3_root, @status, @ssh_password, @ssh_auth_method)
`);

const nodes = [
  {
    name: 'neptune', host: 'localhost', tailscale_ip: '100.109.245.73', port: 22,
    ssh_user: null, hop_through: null, gpu: 'RTX 3090 24GB', gpu_vram_gb: 24,
    ram_gb: 64, os: 'windows', lvl3_root: 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant',
    status: 'online', ssh_password: null, ssh_auth_method: 'key'
  },
  {
    name: 'uranus', host: '100.100.83.37', tailscale_ip: '100.100.83.37', port: 22,
    ssh_user: 'nick', hop_through: null, gpu: 'RTX 5090 32GB', gpu_vram_gb: 32,
    ram_gb: 128, os: 'windows', lvl3_root: 'C:\\Users\\nick\\Lvl3Quant',
    status: 'unknown', ssh_password: 'Pb26116467', ssh_auth_method: 'password'
  },
  {
    name: 'jupiter', host: '192.168.0.108', tailscale_ip: '100.102.174.30', port: 22,
    ssh_user: 'jupiter', hop_through: null, gpu: 'none', gpu_vram_gb: null,
    ram_gb: 64, os: 'linux', lvl3_root: '/home/jupiter/Lvl3Quant',
    status: 'online', ssh_password: 'Pb26116467', ssh_auth_method: 'password'
  },
  {
    name: 'saturn', host: '10.0.0.2', tailscale_ip: '100.101.101.9', port: 22,
    ssh_user: 'saturn', hop_through: 'jupiter', gpu: 'none', gpu_vram_gb: null,
    ram_gb: 32, os: 'linux', lvl3_root: '/home/saturn/Lvl3Quant',
    status: 'online', ssh_password: 'Pb26116467', ssh_auth_method: 'password'
  },
  {
    name: 'razer', host: '100.102.215.75', tailscale_ip: '100.102.215.75', port: 22,
    ssh_user: 'claude', hop_through: null, gpu: 'RTX 3070 8GB', gpu_vram_gb: 8,
    ram_gb: 16, os: 'windows', lvl3_root: 'C:\\Users\\claude\\Lvl3Quant',
    status: 'online', ssh_password: 'Pb26116467', ssh_auth_method: 'password'
  },
];

const insertNodes = db.db.transaction((rows) => {
  for (const row of rows) {
    insertNode.run(row);
    console.log(`  + ${row.name} (${row.host}, ${row.gpu}, ${row.status})`);
  }
});
insertNodes(nodes);

// Update neptune status to training (it's the bridge + has GPU running)
db.updateNodeStatus('neptune', 'online');

// ========================
// 2. CARDS (Trading Strategies)
// ========================
console.log('\n--- Populating Cards ---');

// Clear existing cards
db.db.prepare('DELETE FROM cards').run();

const cards = [
  {
    name: 'Card1', model_variant: 'book_predstdExit_conv1.5_vol50',
    conviction_threshold: 0.1, vol_percentile_gate: 50,
    tp_ticks: 8, sl_ticks: 0, hold_ms: 7200000,
    mae_exit_ticks: 25, mae_exit_hold_sec: 600,
    chase_entry: 0, chase_max_ticks: 0, chase_max_reprices: 0,
    backtest_sharpe: 4.07, backtest_notes: 'Sharpe range 2.58-4.07. MAE25t/10min exit. Best all-around card.',
    status: 'paper'
  },
  {
    name: 'Card2', model_variant: 'book_predstdExit_conv1.5_vol50',
    conviction_threshold: 0.5, vol_percentile_gate: 50,
    tp_ticks: 15, sl_ticks: 0, hold_ms: 7200000,
    mae_exit_ticks: 10, mae_exit_hold_sec: 600,
    chase_entry: 0, chase_max_ticks: 0, chase_max_reprices: 0,
    backtest_sharpe: 1.35, backtest_notes: 'High conviction filter. Sharpe 1.35.',
    status: 'paper'
  },
  {
    name: 'Card3', model_variant: 'raw_rawExit_conv0.15_vol70',
    conviction_threshold: 0.3, vol_percentile_gate: 70,
    tp_ticks: 10, sl_ticks: 0, hold_ms: 3600000,
    mae_exit_ticks: 10, mae_exit_hold_sec: 600,
    chase_entry: 0, chase_max_ticks: 0, chase_max_reprices: 0,
    backtest_sharpe: 2.05, backtest_notes: 'Raw features, 1hr hold. Sharpe 2.05.',
    status: 'paper'
  },
  {
    name: 'Card4', model_variant: 'book_predstdExit_conv2.0_vol70',
    conviction_threshold: 0.1, vol_percentile_gate: 70,
    tp_ticks: 20, sl_ticks: 0, hold_ms: 7200000,
    mae_exit_ticks: 10, mae_exit_hold_sec: 600,
    chase_entry: 0, chase_max_ticks: 0, chase_max_reprices: 0,
    backtest_sharpe: 2.77, backtest_notes: 'Vol70 gate optimal. Sharpe 2.77.',
    status: 'paper'
  },
  {
    name: 'Card5', model_variant: 'raw_rawExit_conv0.05_ethr0.5_vol0',
    conviction_threshold: 0.1, vol_percentile_gate: 0,
    tp_ticks: 0, sl_ticks: 0, hold_ms: 3600000,
    mae_exit_ticks: 10, mae_exit_hold_sec: 600,
    chase_entry: 0, chase_max_ticks: 0, chase_max_reprices: 0,
    backtest_sharpe: null, backtest_notes: 'No TP, 1hr hold, no vol gate. Experimental.',
    status: 'paper'
  },
  {
    name: 'Card6', model_variant: 'raw_rawExit_conv0.15_vol70',
    conviction_threshold: 0.1, vol_percentile_gate: 70,
    tp_ticks: 20, sl_ticks: 25, hold_ms: 3600000,
    mae_exit_ticks: 10, mae_exit_hold_sec: 600,
    chase_entry: 0, chase_max_ticks: 0, chase_max_reprices: 0,
    backtest_sharpe: 1.38, backtest_notes: 'TP20/SL25, 1hr hold. Sharpe 1.38.',
    status: 'paper'
  },
  {
    name: 'Card7', model_variant: 'smooth_smoothExit_conv1.5_vol70',
    conviction_threshold: 0.1, vol_percentile_gate: 70,
    tp_ticks: 0, sl_ticks: 20, hold_ms: 3600000,
    mae_exit_ticks: 10, mae_exit_hold_sec: 600,
    chase_entry: 0, chase_max_ticks: 0, chase_max_reprices: 0,
    backtest_sharpe: null, backtest_notes: 'No TP, SL20, 1hr hold. Smooth features.',
    status: 'paper'
  },
];

for (const card of cards) {
  try {
    db.createCard(card);
    console.log(`  + ${card.name}: ${card.model_variant} (TP${card.tp_ticks}, Sharpe=${card.backtest_sharpe || 'N/A'})`);
  } catch (e) {
    console.log(`  ! ${card.name}: ${e.message}`);
  }
}

// ========================
// 3. MODELS & TRAINING JOBS
// ========================
console.log('\n--- Populating Models & Training Jobs ---');

// Clear existing
db.db.prepare('DELETE FROM training_jobs').run();
db.db.prepare('DELETE FROM models').run();

// Register models
const model1 = db.registerModel({
  name: '1-min CNN WF',
  architecture: 'CNN',
  horizon_bars: 600, // 1 min = 600 bars at 100ms
  subsample: 5,
  window_mode: 'expanding',
  epochs: 3,
  node: 'razer',
  status: 'training',
  total_folds: 167,
  notes: '1-minute horizon CNN walk-forward experiment. Started ~Mar 18.'
});
console.log(`  + Model ${model1.id}: 1-min CNN WF (razer)`);

const model2 = db.registerModel({
  name: 'Wider CNN WF',
  architecture: 'CNN-Wide',
  horizon_bars: 100,
  subsample: 5,
  window_mode: 'expanding',
  epochs: 3,
  node: 'neptune',
  status: 'training',
  total_folds: 94,
  notes: 'Wider CNN walk-forward. Was at fold 36+. Currently stopped (GPU idle).'
});
console.log(`  + Model ${model2.id}: Wider CNN WF (neptune)`);

const model3 = db.registerModel({
  name: 'Hybrid v3 WF',
  architecture: 'CNN-Hybrid',
  params_count: 6700000,
  horizon_bars: 100,
  subsample: 5,
  window_mode: 'sliding',
  max_train_days: 30,
  dropout: 0.5,
  epochs: 3,
  node: 'uranus',
  status: 'training',
  total_folds: 94,
  notes: '6.7M params, sliding 30d, dropout 0.5. IC=0.099 fold 1. Was at fold 30+. Stopped (unreachable).'
});
console.log(`  + Model ${model3.id}: Hybrid v3 WF (uranus)`);

// Training jobs
const job1 = db.createTrainingJob({
  model_id: model1.id,
  node: 'razer',
  job_type: 'training',
  description: '1-min CNN walk-forward training',
  start_fold: 1,
  current_fold: 5,
  total_folds: 167,
  status: 'running',
  progress_pct: 3.0,
});
console.log(`  + Job ${job1.id}: 1-min CNN WF on razer (fold 5/167, running)`);

const job2 = db.createTrainingJob({
  model_id: model2.id,
  node: 'neptune',
  job_type: 'training',
  description: 'Wider CNN walk-forward training',
  start_fold: 1,
  current_fold: 36,
  total_folds: 94,
  status: 'stale',
  progress_pct: 38.3,
});
console.log(`  + Job ${job2.id}: Wider CNN WF on neptune (fold 36/94, stopped)`);

const job3 = db.createTrainingJob({
  model_id: model3.id,
  node: 'uranus',
  job_type: 'training',
  description: 'Hybrid v3 walk-forward training (sliding 30d)',
  start_fold: 1,
  current_fold: 30,
  total_folds: 94,
  status: 'stale',
  progress_pct: 31.9,
});
console.log(`  + Job ${job3.id}: Hybrid v3 WF on uranus (fold 30/94, stopped)`);

// ========================
// 4. RESEARCH QUEUE
// ========================
console.log('\n--- Populating Research Queue ---');

// Clear existing
db.db.prepare('DELETE FROM research_projects').run();

const research = [
  {
    name: 'TLOB Dual Attention',
    hypothesis: 'Transformer LOB with dual attention mechanism may capture cross-level dependencies better than CNN',
    status: 'proposed', priority: 1,
    tags: 'architecture,transformer,high-priority'
  },
  {
    name: 'Multi-Horizon CNN 10s+30s+1m+5m',
    hypothesis: 'Combining multiple horizon predictions (10s, 30s, 1m, 5m) in ensemble improves robustness and enables adaptive hold times',
    status: 'proposed', priority: 1,
    tags: 'ensemble,multi-horizon,high-priority'
  },
  {
    name: 'LiT Transformer',
    hypothesis: 'Lightweight transformer variant could match CNN performance with lower compute cost',
    status: 'proposed', priority: 2,
    tags: 'architecture,transformer,efficiency'
  },
  {
    name: 'MBO+LOB Ensemble',
    hypothesis: 'Combining MBO and LOB features in an ensemble may improve prediction quality beyond either alone',
    status: 'proposed', priority: 2,
    tags: 'ensemble,features'
  },
  {
    name: 'Double OOT Validation',
    hypothesis: 'Two-stage out-of-time validation reduces overfitting risk in walk-forward',
    status: 'proposed', priority: 2,
    tags: 'validation,methodology'
  },
  {
    name: 'Conviction Exit',
    hypothesis: 'Using model conviction change as exit signal instead of fixed TP/SL',
    status: 'completed', priority: 3,
    findings: 'Marginal results. Conviction-based exits did not significantly outperform fixed TP/SL in backtests.',
    tags: 'exits,strategy,completed'
  },
  {
    name: 'Ablation Study',
    hypothesis: 'Systematic feature ablation identifies which input channels drive IC',
    status: 'proposed', priority: 3,
    tags: 'analysis,features'
  },
  {
    name: 'Decay Window Analysis',
    hypothesis: 'Analyzing prediction decay windows reveals optimal hold times per card',
    status: 'proposed', priority: 2,
    tags: 'analysis,exits'
  },
  {
    name: 'Queue Features',
    hypothesis: 'Adding queue position and queue imbalance features improves fill prediction',
    status: 'proposed', priority: 3,
    tags: 'features,microstructure'
  },
];

for (const r of research) {
  const result = db.createResearch(r);
  console.log(`  + Research ${result.id}: ${r.name} (priority=${r.priority}, ${r.status})`);
}

// ========================
// 5. ACTIVE SWEEPS
// ========================
console.log('\n--- Populating Active Sweeps ---');

// Clear existing
db.db.prepare('DELETE FROM sweeps').run();

const sweep1 = db.createSweep({
  name: 'Card 7 Focused Sweep',
  description: 'Focused parameter sweep for Card 7 (smooth_smoothExit_conv1.5_vol70). ~90K total configs.',
  sweep_type: 'optuna',
  total_configs: 90000,
  metric_name: 'sharpe',
  node: 'saturn',
  notes: '~72% complete as of Mar 18'
});
// Update progress
db.db.prepare('UPDATE sweeps SET completed_configs = 64800 WHERE id = ?').run(sweep1.id);
console.log(`  + Sweep ${sweep1.id}: Card 7 Focused Sweep on saturn (72%, 64800/90000)`);

const sweep2 = db.createSweep({
  name: 'Conviction Refined Sweep',
  description: 'Refined conviction threshold sweep. Just launched on Jupiter.',
  sweep_type: 'optuna',
  total_configs: null,
  metric_name: 'sharpe',
  node: 'jupiter',
  notes: 'Just launched Mar 18'
});
console.log(`  + Sweep ${sweep2.id}: Conviction Refined Sweep on jupiter (just launched)`);

// ========================
// 6. ALERTS (current state)
// ========================
console.log('\n--- Populating Alerts ---');

db.sendAlert('warning', 'populate_qcc', 'Uranus (5090) unreachable via SSH - status unknown', 'uranus');
db.sendAlert('info', 'populate_qcc', 'Neptune wider CNN WF stopped at fold 36 - GPU may be idle', 'neptune');
db.sendAlert('info', 'populate_qcc', 'Rithmic connection now stable after session fix', 'neptune');
console.log('  + 3 alerts created');

// ========================
// SUMMARY
// ========================
console.log('\n========== QCC Population Summary ==========');
const nodeCount = db.db.prepare('SELECT COUNT(*) as cnt FROM compute_nodes').get().cnt;
const cardCount = db.db.prepare('SELECT COUNT(*) as cnt FROM cards').get().cnt;
const modelCount = db.db.prepare('SELECT COUNT(*) as cnt FROM models').get().cnt;
const jobCount = db.db.prepare('SELECT COUNT(*) as cnt FROM training_jobs').get().cnt;
const researchCount = db.db.prepare('SELECT COUNT(*) as cnt FROM research_projects').get().cnt;
const sweepCount = db.db.prepare('SELECT COUNT(*) as cnt FROM sweeps').get().cnt;
const alertCount = db.db.prepare('SELECT COUNT(*) as cnt FROM alerts').get().cnt;

console.log(`  Compute Nodes:    ${nodeCount}`);
console.log(`  Cards:            ${cardCount}`);
console.log(`  Models:           ${modelCount}`);
console.log(`  Training Jobs:    ${jobCount}`);
console.log(`  Research Projects: ${researchCount}`);
console.log(`  Sweeps:           ${sweepCount}`);
console.log(`  Alerts:           ${alertCount}`);
console.log('=============================================');
console.log('QCC database populated successfully!');

db.db.close();
