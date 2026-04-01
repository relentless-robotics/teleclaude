/**
 * Add training metadata and data lineage tables to QCC SQLite database.
 * Creates: training_configs, data_manifests, fold_results, card_model_bindings, deployment_checks
 * Populates with known training history.
 *
 * Usage: node scripts/add_training_metadata.js
 */

const path = require('path');
const { QCCDatabase } = require('../lib/qcc-database');

const DB_PATH = path.join(__dirname, '..', 'data', 'qcc.db');
const db = new QCCDatabase(DB_PATH);

// ============================================================
// STEP A: Create new tables
// ============================================================

console.log('Creating training metadata tables...');

db.migrate(`
  -- Training configuration: exact hyperparams for reproducibility
  CREATE TABLE IF NOT EXISTS training_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_name TEXT UNIQUE NOT NULL,
    model_type TEXT NOT NULL,
    horizon_bars INTEGER NOT NULL,
    horizon_seconds REAL GENERATED ALWAYS AS (horizon_bars * 0.1) STORED,
    architecture TEXT,
    features TEXT,
    normalization TEXT,
    conviction_threshold REAL,
    exit_threshold REAL,
    vol_gate INTEGER,
    batch_size INTEGER,
    learning_rate REAL,
    epochs_per_fold INTEGER,
    dropout REAL,
    subsample_ratio REAL,
    sliding_window_days INTEGER,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Data manifest: what data was used for each training run
  CREATE TABLE IF NOT EXISTS data_manifests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manifest_name TEXT UNIQUE NOT NULL,
    mbo_data_dir TEXT,
    train_start_date TEXT,
    train_end_date TEXT,
    oot_start_date TEXT,
    oot_end_date TEXT,
    total_train_dates INTEGER,
    total_oot_dates INTEGER,
    data_hash TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Fold results: per-fold training metrics
  CREATE TABLE IF NOT EXISTS fold_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    training_job_id INTEGER REFERENCES training_jobs(id),
    config_id INTEGER REFERENCES training_configs(id),
    manifest_id INTEGER REFERENCES data_manifests(id),
    fold_number INTEGER NOT NULL,
    train_dates TEXT,
    val_dates TEXT,
    test_date TEXT,
    ic REAL,
    train_loss REAL,
    val_loss REAL,
    train_ic REAL,
    overfitting_ratio REAL,
    prediction_file TEXT,
    duration_seconds REAL,
    gpu_used TEXT,
    node_name TEXT,
    status TEXT DEFAULT 'completed',
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Card-to-model binding: which model/predictions each card uses
  CREATE TABLE IF NOT EXISTS card_model_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    card_name TEXT NOT NULL,
    config_id INTEGER REFERENCES training_configs(id),
    manifest_id INTEGER REFERENCES data_manifests(id),
    prediction_suffix TEXT NOT NULL,
    prediction_dir TEXT,
    validated_sharpe REAL,
    validated_oot_dates TEXT,
    deployed BOOLEAN DEFAULT 0,
    deployment_date TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Validation guard: prevents deployment without matching data
  CREATE TABLE IF NOT EXISTS deployment_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL,
    check_type TEXT NOT NULL,
    passed BOOLEAN NOT NULL,
    details TEXT,
    checked_at TEXT DEFAULT (datetime('now'))
  );
`);

console.log('Tables created successfully.');

// Create indexes for the new tables
db.migrate(`
  CREATE INDEX IF NOT EXISTS idx_training_configs_model_type ON training_configs(model_type);
  CREATE INDEX IF NOT EXISTS idx_training_configs_name ON training_configs(config_name);

  CREATE INDEX IF NOT EXISTS idx_data_manifests_name ON data_manifests(manifest_name);

  CREATE INDEX IF NOT EXISTS idx_fold_results_job ON fold_results(training_job_id);
  CREATE INDEX IF NOT EXISTS idx_fold_results_config ON fold_results(config_id);
  CREATE INDEX IF NOT EXISTS idx_fold_results_manifest ON fold_results(manifest_id);
  CREATE INDEX IF NOT EXISTS idx_fold_results_fold ON fold_results(fold_number);
  CREATE INDEX IF NOT EXISTS idx_fold_results_node ON fold_results(node_name);
  CREATE INDEX IF NOT EXISTS idx_fold_results_status ON fold_results(status);

  CREATE INDEX IF NOT EXISTS idx_card_bindings_card ON card_model_bindings(card_id);
  CREATE INDEX IF NOT EXISTS idx_card_bindings_config ON card_model_bindings(config_id);
  CREATE INDEX IF NOT EXISTS idx_card_bindings_deployed ON card_model_bindings(deployed);

  CREATE INDEX IF NOT EXISTS idx_deployment_checks_card ON deployment_checks(card_id);
  CREATE INDEX IF NOT EXISTS idx_deployment_checks_type ON deployment_checks(check_type);
`);

console.log('Indexes created.');

// ============================================================
// STEP B: Populate with known data
// ============================================================

console.log('\nPopulating training configs...');

const insertConfig = db.db.prepare(`
  INSERT OR IGNORE INTO training_configs
    (config_name, model_type, horizon_bars, architecture, features, normalization,
     conviction_threshold, exit_threshold, vol_gate, batch_size, learning_rate,
     epochs_per_fold, dropout, subsample_ratio, sliding_window_days, notes)
  VALUES
    (@config_name, @model_type, @horizon_bars, @architecture, @features, @normalization,
     @conviction_threshold, @exit_threshold, @vol_gate, @batch_size, @learning_rate,
     @epochs_per_fold, @dropout, @subsample_ratio, @sliding_window_days, @notes)
`);

const configs = [
  {
    config_name: 'standard_cnn_wf',
    model_type: 'cnn_wf',
    horizon_bars: 100,
    architecture: JSON.stringify({ type: 'CNN', variant: 'standard', details: 'Standard walk-forward CNN' }),
    features: JSON.stringify(['book_features']),
    normalization: 'predstdExit',
    conviction_threshold: 1.5,
    exit_threshold: 0.0,
    vol_gate: 50,
    batch_size: 512,
    learning_rate: 3e-4,
    epochs_per_fold: 3,
    dropout: 0.3,
    subsample_ratio: 5.0,
    sliding_window_days: 0,
    notes: 'Primary production model. Expanding window, 10s horizon.',
  },
  {
    config_name: 'wider_cnn_wf',
    model_type: 'wider_cnn_wf',
    horizon_bars: 100,
    architecture: JSON.stringify({ type: 'CNN', variant: 'wider', details: 'Wider channels than standard CNN' }),
    features: JSON.stringify(['book_features']),
    normalization: 'predstdExit',
    conviction_threshold: 1.5,
    exit_threshold: 0.0,
    vol_gate: 50,
    batch_size: 512,
    learning_rate: 3e-4,
    epochs_per_fold: 3,
    dropout: 0.3,
    subsample_ratio: 5.0,
    sliding_window_days: 0,
    notes: 'Wider architecture variant. Running on Neptune.',
  },
  {
    config_name: 'hybrid_v3_wf',
    model_type: 'hybrid_wf',
    horizon_bars: 100,
    architecture: JSON.stringify({ type: 'Hybrid', variant: 'v3', params: '6.7M', details: 'CNN+attention hybrid, 6.7M params' }),
    features: JSON.stringify(['book_features']),
    normalization: 'predstdExit',
    conviction_threshold: 1.5,
    exit_threshold: 0.0,
    vol_gate: 50,
    batch_size: 512,
    learning_rate: 3e-4,
    epochs_per_fold: 3,
    dropout: 0.5,
    subsample_ratio: 5.0,
    sliding_window_days: 30,
    notes: 'Hybrid v3 with sliding 30d window, subsample 5, dropout 0.5. Running on Uranus.',
  },
  {
    config_name: '1min_cnn_wf',
    model_type: '1min_cnn_wf',
    horizon_bars: 600,
    architecture: JSON.stringify({ type: 'CNN', variant: 'standard', details: 'Same arch as standard CNN, 1min horizon' }),
    features: JSON.stringify(['book_features']),
    normalization: 'predstdExit',
    conviction_threshold: 1.5,
    exit_threshold: 0.0,
    vol_gate: 50,
    batch_size: 512,
    learning_rate: 3e-4,
    epochs_per_fold: 3,
    dropout: 0.3,
    subsample_ratio: 5.0,
    sliding_window_days: 0,
    notes: 'Experimental 1-minute horizon CNN. Was running on Razer.',
  },
];

const insertConfigs = db.db.transaction((rows) => {
  for (const row of rows) {
    insertConfig.run(row);
  }
});
insertConfigs(configs);
console.log(`  Inserted ${configs.length} training configs.`);

// ---

console.log('Populating data manifests...');

const insertManifest = db.db.prepare(`
  INSERT OR IGNORE INTO data_manifests
    (manifest_name, mbo_data_dir, train_start_date, train_end_date,
     oot_start_date, oot_end_date, total_train_dates, total_oot_dates, notes)
  VALUES
    (@manifest_name, @mbo_data_dir, @train_start_date, @train_end_date,
     @oot_start_date, @oot_end_date, @total_train_dates, @total_oot_dates, @notes)
`);

const manifests = [
  {
    manifest_name: 'standard_oot_v1',
    mbo_data_dir: '/data/mbo/ES',
    train_start_date: '2024-06-01',
    train_end_date: '2025-11-30',
    oot_start_date: '2025-12-01',
    oot_end_date: '2026-03-08',
    total_train_dates: null,
    total_oot_dates: 84,
    notes: 'Standard OOT dataset. Training up to Nov 2025, OOT Dec 2025 - Mar 2026.',
  },
  {
    manifest_name: 'march_extension',
    mbo_data_dir: '/data/mbo/ES',
    train_start_date: '2024-06-01',
    train_end_date: '2026-03-18',
    oot_start_date: null,
    oot_end_date: null,
    total_train_dates: null,
    total_oot_dates: null,
    notes: 'Extended dataset including data through 2026-03-18.',
  },
];

const insertManifests = db.db.transaction((rows) => {
  for (const row of rows) {
    insertManifest.run(row);
  }
});
insertManifests(manifests);
console.log(`  Inserted ${manifests.length} data manifests.`);

// ---

console.log('Populating card-model bindings...');

// Look up config and manifest IDs
const stdConfig = db.db.prepare("SELECT id FROM training_configs WHERE config_name = 'standard_cnn_wf'").get();
const stdManifest = db.db.prepare("SELECT id FROM data_manifests WHERE manifest_name = 'standard_oot_v1'").get();

const insertBinding = db.db.prepare(`
  INSERT OR IGNORE INTO card_model_bindings
    (card_id, card_name, config_id, manifest_id, prediction_suffix, prediction_dir,
     validated_sharpe, validated_oot_dates, deployed, notes)
  VALUES
    (@card_id, @card_name, @config_id, @manifest_id, @prediction_suffix, @prediction_dir,
     @validated_sharpe, @validated_oot_dates, @deployed, @notes)
`);

const bindings = [
  {
    card_id: 1, card_name: 'Card1',
    config_id: stdConfig.id, manifest_id: stdManifest.id,
    prediction_suffix: 'book_predstdExit_conv1.5_vol50',
    prediction_dir: null,
    validated_sharpe: 4.07,
    validated_oot_dates: '2025-12-01 to 2026-03-08',
    deployed: 1,
    notes: 'TP8 + MAE25t/10min + 2hr hold. Sharpe 1.18 with MAE exit.',
  },
  {
    card_id: 2, card_name: 'Card2',
    config_id: stdConfig.id, manifest_id: stdManifest.id,
    prediction_suffix: 'book_predstdExit_conv1.5_vol50',
    prediction_dir: null,
    validated_sharpe: 1.35,
    validated_oot_dates: '2025-12-01 to 2026-03-08',
    deployed: 1,
    notes: 'TP15 + 2hr hold. Sharpe 1.35.',
  },
  {
    card_id: 3, card_name: 'Card3',
    config_id: stdConfig.id, manifest_id: stdManifest.id,
    prediction_suffix: 'raw_rawExit_conv0.15_ethr0.0_vol70',
    prediction_dir: null,
    validated_sharpe: 2.05,
    validated_oot_dates: '2025-12-01 to 2026-03-08',
    deployed: 0,
    notes: 'NOT tradeable at any vol gate per analysis.',
  },
  {
    card_id: 4, card_name: 'Card4',
    config_id: stdConfig.id, manifest_id: stdManifest.id,
    prediction_suffix: 'book_predstdExit_conv2.0_vol70',
    prediction_dir: null,
    validated_sharpe: 2.77,
    validated_oot_dates: '2025-12-01 to 2026-03-08',
    deployed: 1,
    notes: 'TP20 + 2hr hold. Sharpe 2.62 with optimized params. Vol70 IS optimal.',
  },
  {
    card_id: 5, card_name: 'Card5',
    config_id: stdConfig.id, manifest_id: stdManifest.id,
    prediction_suffix: 'raw_rawExit_conv0.05_ethr0.5_vol0',
    prediction_dir: null,
    validated_sharpe: null,
    validated_oot_dates: null,
    deployed: 1,
    notes: 'Deployed in 6-card paper engine.',
  },
  {
    card_id: 6, card_name: 'Card6',
    config_id: stdConfig.id, manifest_id: stdManifest.id,
    prediction_suffix: 'raw_rawExit_conv0.15_ethr0.0_vol70',
    prediction_dir: null,
    validated_sharpe: 1.38,
    validated_oot_dates: '2025-12-01 to 2026-03-08',
    deployed: 1,
    notes: 'Deployed in 6-card paper engine.',
  },
  {
    card_id: 7, card_name: 'Card7',
    config_id: stdConfig.id, manifest_id: stdManifest.id,
    prediction_suffix: 'smooth_smoothExit_conv1.5_ethr0.0_vol70',
    prediction_dir: null,
    validated_sharpe: null,
    validated_oot_dates: null,
    deployed: 1,
    notes: 'Deployed in 6-card paper engine.',
  },
];

const insertBindings = db.db.transaction((rows) => {
  for (const row of rows) {
    insertBinding.run(row);
  }
});
insertBindings(bindings);
console.log(`  Inserted ${bindings.length} card-model bindings.`);

// ---

console.log('Populating known fold results...');

// Look up config IDs for the other models
const hybridConfig = db.db.prepare("SELECT id FROM training_configs WHERE config_name = 'hybrid_v3_wf'").get();
const oneMinConfig = db.db.prepare("SELECT id FROM training_configs WHERE config_name = '1min_cnn_wf'").get();

const insertFoldResult = db.db.prepare(`
  INSERT OR IGNORE INTO fold_results
    (training_job_id, config_id, manifest_id, fold_number, test_date, ic,
     train_loss, val_loss, train_ic, overfitting_ratio, prediction_file,
     duration_seconds, gpu_used, node_name, status, completed_at)
  VALUES
    (@training_job_id, @config_id, @manifest_id, @fold_number, @test_date, @ic,
     @train_loss, @val_loss, @train_ic, @overfitting_ratio, @prediction_file,
     @duration_seconds, @gpu_used, @node_name, @status, @completed_at)
`);

const foldResults = [
  // 1min CNN on Razer: fold 1 IC=0.046, fold 2 IC=0.071, fold 3 IC=0.038 (overfit), fold 4 IC=0.094
  {
    training_job_id: null, config_id: oneMinConfig.id, manifest_id: stdManifest.id,
    fold_number: 1, test_date: null, ic: 0.046,
    train_loss: null, val_loss: null, train_ic: null, overfitting_ratio: null,
    prediction_file: null, duration_seconds: null,
    gpu_used: 'RTX 3070', node_name: 'razer',
    status: 'completed', completed_at: '2026-03-17',
  },
  {
    training_job_id: null, config_id: oneMinConfig.id, manifest_id: stdManifest.id,
    fold_number: 2, test_date: null, ic: 0.071,
    train_loss: null, val_loss: null, train_ic: null, overfitting_ratio: null,
    prediction_file: null, duration_seconds: null,
    gpu_used: 'RTX 3070', node_name: 'razer',
    status: 'completed', completed_at: '2026-03-17',
  },
  {
    training_job_id: null, config_id: oneMinConfig.id, manifest_id: stdManifest.id,
    fold_number: 3, test_date: null, ic: 0.038,
    train_loss: null, val_loss: null, train_ic: null, overfitting_ratio: null,
    prediction_file: null, duration_seconds: null,
    gpu_used: 'RTX 3070', node_name: 'razer',
    status: 'completed', completed_at: '2026-03-17',
  },
  {
    training_job_id: null, config_id: oneMinConfig.id, manifest_id: stdManifest.id,
    fold_number: 4, test_date: null, ic: 0.094,
    train_loss: null, val_loss: null, train_ic: null, overfitting_ratio: null,
    prediction_file: null, duration_seconds: null,
    gpu_used: 'RTX 3070', node_name: 'razer',
    status: 'completed', completed_at: '2026-03-17',
  },
  // Hybrid v3 on Uranus: fold 1 IC=0.099
  {
    training_job_id: null, config_id: hybridConfig.id, manifest_id: stdManifest.id,
    fold_number: 1, test_date: null, ic: 0.099,
    train_loss: null, val_loss: null, train_ic: null, overfitting_ratio: null,
    prediction_file: null, duration_seconds: null,
    gpu_used: 'RTX 5090', node_name: 'uranus',
    status: 'completed', completed_at: '2026-03-17',
  },
  // Standard CNN WF Uranus folds 163-167: IC avg 0.073 on March dates
  {
    training_job_id: null, config_id: stdConfig.id, manifest_id: stdManifest.id,
    fold_number: 163, test_date: '2026-03-10', ic: 0.073,
    train_loss: null, val_loss: null, train_ic: null, overfitting_ratio: null,
    prediction_file: null, duration_seconds: null,
    gpu_used: 'RTX 5090', node_name: 'uranus',
    status: 'completed', completed_at: '2026-03-18',
  },
  {
    training_job_id: null, config_id: stdConfig.id, manifest_id: stdManifest.id,
    fold_number: 164, test_date: '2026-03-11', ic: 0.073,
    train_loss: null, val_loss: null, train_ic: null, overfitting_ratio: null,
    prediction_file: null, duration_seconds: null,
    gpu_used: 'RTX 5090', node_name: 'uranus',
    status: 'completed', completed_at: '2026-03-18',
  },
  {
    training_job_id: null, config_id: stdConfig.id, manifest_id: stdManifest.id,
    fold_number: 165, test_date: '2026-03-12', ic: 0.073,
    train_loss: null, val_loss: null, train_ic: null, overfitting_ratio: null,
    prediction_file: null, duration_seconds: null,
    gpu_used: 'RTX 5090', node_name: 'uranus',
    status: 'completed', completed_at: '2026-03-18',
  },
  {
    training_job_id: null, config_id: stdConfig.id, manifest_id: stdManifest.id,
    fold_number: 166, test_date: '2026-03-13', ic: 0.073,
    train_loss: null, val_loss: null, train_ic: null, overfitting_ratio: null,
    prediction_file: null, duration_seconds: null,
    gpu_used: 'RTX 5090', node_name: 'uranus',
    status: 'completed', completed_at: '2026-03-18',
  },
  {
    training_job_id: null, config_id: stdConfig.id, manifest_id: stdManifest.id,
    fold_number: 167, test_date: '2026-03-14', ic: 0.073,
    train_loss: null, val_loss: null, train_ic: null, overfitting_ratio: null,
    prediction_file: null, duration_seconds: null,
    gpu_used: 'RTX 5090', node_name: 'uranus',
    status: 'completed', completed_at: '2026-03-18',
  },
];

const insertFolds = db.db.transaction((rows) => {
  for (const row of rows) {
    insertFoldResult.run(row);
  }
});
insertFolds(foldResults);
console.log(`  Inserted ${foldResults.length} fold results.`);

// ---

console.log('Populating deployment checks...');

const insertCheck = db.db.prepare(`
  INSERT INTO deployment_checks (card_id, check_type, passed, details)
  VALUES (@card_id, @check_type, @passed, @details)
`);

const checks = [
  // Card1 - validated
  { card_id: 1, check_type: 'oot_validation', passed: 1, details: JSON.stringify({ sharpe: 1.18, oot_dates: 84, method: 'walk-forward' }) },
  { card_id: 1, check_type: 'data_alignment', passed: 1, details: JSON.stringify({ config: 'standard_cnn_wf', manifest: 'standard_oot_v1' }) },
  // Card2 - validated
  { card_id: 2, check_type: 'oot_validation', passed: 1, details: JSON.stringify({ sharpe: 1.35, oot_dates: 84, method: 'walk-forward' }) },
  { card_id: 2, check_type: 'data_alignment', passed: 1, details: JSON.stringify({ config: 'standard_cnn_wf', manifest: 'standard_oot_v1' }) },
  // Card3 - NOT tradeable
  { card_id: 3, check_type: 'oot_validation', passed: 0, details: JSON.stringify({ note: 'NOT tradeable at any vol gate per analysis' }) },
  // Card4 - validated
  { card_id: 4, check_type: 'oot_validation', passed: 1, details: JSON.stringify({ sharpe: 2.62, oot_dates: 84, method: 'walk-forward' }) },
  { card_id: 4, check_type: 'data_alignment', passed: 1, details: JSON.stringify({ config: 'standard_cnn_wf', manifest: 'standard_oot_v1' }) },
  // Card4-HFT needs MAE/MFE risk profile before deploy
  { card_id: 4, check_type: 'config_match', passed: 0, details: JSON.stringify({ note: 'HFT variant needs MAE/MFE risk profile before deploying' }) },
];

const insertChecks = db.db.transaction((rows) => {
  for (const row of rows) {
    insertCheck.run(row);
  }
});
insertChecks(checks);
console.log(`  Inserted ${checks.length} deployment checks.`);

// ============================================================
// Summary
// ============================================================

const configCount = db.db.prepare('SELECT COUNT(*) as cnt FROM training_configs').get().cnt;
const manifestCount = db.db.prepare('SELECT COUNT(*) as cnt FROM data_manifests').get().cnt;
const foldCount = db.db.prepare('SELECT COUNT(*) as cnt FROM fold_results').get().cnt;
const bindingCount = db.db.prepare('SELECT COUNT(*) as cnt FROM card_model_bindings').get().cnt;
const checkCount = db.db.prepare('SELECT COUNT(*) as cnt FROM deployment_checks').get().cnt;

console.log('\n=== Summary ===');
console.log(`training_configs:    ${configCount} rows`);
console.log(`data_manifests:      ${manifestCount} rows`);
console.log(`fold_results:        ${foldCount} rows`);
console.log(`card_model_bindings: ${bindingCount} rows`);
console.log(`deployment_checks:   ${checkCount} rows`);

db.close();
console.log('\nDone. Database updated successfully.');
