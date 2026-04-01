/**
 * Seed model_versions table with known model versions.
 *
 * Known versions:
 * - standard_cnn_wf v1: ~167 folds complete, avg IC ~0.073, deployed for cards 1-7
 * - wider_cnn_wf v1: training, fold 36/94
 * - hybrid_v3_wf v1: training, fold 30/94
 * - 1min_cnn_wf v1: training, fold 5/167
 *
 * Usage: node scripts/seed_model_versions.js
 */

const path = require('path');
const { QCCDatabase } = require('../lib/qcc-database');

const DB_PATH = path.join(__dirname, '..', 'data', 'qcc.db');
const db = new QCCDatabase(DB_PATH);

console.log('Seeding model_versions table...');

// Look up config IDs
const stdConfig = db.db.prepare("SELECT id FROM training_configs WHERE config_name = 'standard_cnn_wf'").get();
const widerConfig = db.db.prepare("SELECT id FROM training_configs WHERE config_name = 'wider_cnn_wf'").get();
const hybridConfig = db.db.prepare("SELECT id FROM training_configs WHERE config_name = 'hybrid_v3_wf'").get();
const oneMinConfig = db.db.prepare("SELECT id FROM training_configs WHERE config_name = '1min_cnn_wf'").get();

// Look up manifest ID
const stdManifest = db.db.prepare("SELECT id FROM data_manifests WHERE manifest_name = 'standard_oot_v1'").get();

if (!stdConfig || !widerConfig || !hybridConfig || !oneMinConfig) {
  console.error('ERROR: training_configs not found. Run scripts/add_training_metadata.js first.');
  process.exit(1);
}
if (!stdManifest) {
  console.error('ERROR: data_manifests not found. Run scripts/add_training_metadata.js first.');
  process.exit(1);
}

// Check if already seeded
const existing = db.db.prepare('SELECT COUNT(*) as cnt FROM model_versions').get();
if (existing.cnt > 0) {
  console.log(`  model_versions already has ${existing.cnt} rows. Skipping seed.`);
  db.close();
  process.exit(0);
}

const versions = [
  {
    model_name: 'standard_cnn_wf',
    config_id: stdConfig.id,
    manifest_id: stdManifest.id,
    checkpoint_path: null,
    checkpoint_hash: null,
    prediction_dir: null,
    prediction_count: 167,
    avg_ic: 0.073,
    min_ic: null,
    max_ic: null,
    total_folds: 167,
    oot_sharpe: 2.62,  // best card (Card4) Sharpe on OOT
    status: 'deployed',
  },
  {
    model_name: 'wider_cnn_wf',
    config_id: widerConfig.id,
    manifest_id: stdManifest.id,
    checkpoint_path: null,
    checkpoint_hash: null,
    prediction_dir: null,
    prediction_count: null,
    avg_ic: null,
    min_ic: null,
    max_ic: null,
    total_folds: 94,
    oot_sharpe: null,
    status: 'training',
  },
  {
    model_name: 'hybrid_v3_wf',
    config_id: hybridConfig.id,
    manifest_id: stdManifest.id,
    checkpoint_path: null,
    checkpoint_hash: null,
    prediction_dir: null,
    prediction_count: null,
    avg_ic: 0.099,  // fold 1 IC
    min_ic: 0.099,
    max_ic: 0.099,
    total_folds: 94,
    oot_sharpe: null,
    status: 'training',
  },
  {
    model_name: '1min_cnn_wf',
    config_id: oneMinConfig.id,
    manifest_id: stdManifest.id,
    checkpoint_path: null,
    checkpoint_hash: null,
    prediction_dir: null,
    prediction_count: null,
    avg_ic: 0.062,  // avg of 4 folds: 0.046, 0.071, 0.038, 0.094
    min_ic: 0.038,
    max_ic: 0.094,
    total_folds: 167,
    oot_sharpe: null,
    status: 'training',
  },
];

const insertVersion = db.db.prepare(`
  INSERT INTO model_versions
    (model_name, version, config_id, manifest_id,
     checkpoint_path, checkpoint_hash, prediction_dir, prediction_count,
     avg_ic, min_ic, max_ic, total_folds, oot_sharpe,
     status, promoted_at, deployed_at)
  VALUES
    (@model_name, @version, @config_id, @manifest_id,
     @checkpoint_path, @checkpoint_hash, @prediction_dir, @prediction_count,
     @avg_ic, @min_ic, @max_ic, @total_folds, @oot_sharpe,
     @status, @promoted_at, @deployed_at)
`);

const insertAll = db.db.transaction((rows) => {
  for (const row of rows) {
    const now = new Date().toISOString();
    insertVersion.run({
      ...row,
      version: 1,
      promoted_at: row.status === 'deployed' ? now : null,
      deployed_at: row.status === 'deployed' ? now : null,
    });
  }
});

insertAll(versions);
console.log(`  Inserted ${versions.length} model versions.`);

// Link standard_cnn_wf v1 to card_model_bindings
const stdVersion = db.db.prepare(
  "SELECT id FROM model_versions WHERE model_name = 'standard_cnn_wf' AND version = 1"
).get();

if (stdVersion) {
  try {
    const cmbCols = db.db.pragma('table_info(card_model_bindings)').map(c => c.name);
    if (cmbCols.includes('model_version_id')) {
      const updateBindings = db.db.prepare(`
        UPDATE card_model_bindings SET model_version_id = ? WHERE config_id = ?
      `);
      const result = updateBindings.run(stdVersion.id, stdConfig.id);
      console.log(`  Linked ${result.changes} card_model_bindings to standard_cnn_wf v1.`);
    }
  } catch (e) {
    console.log(`  Note: card_model_bindings update skipped (${e.message})`);
  }
}

// Summary
const versionCount = db.db.prepare('SELECT COUNT(*) as cnt FROM model_versions').get().cnt;
console.log(`\n=== Summary ===`);
console.log(`model_versions: ${versionCount} rows`);

const allVersions = db.db.prepare('SELECT model_name, version, status, avg_ic, total_folds FROM model_versions ORDER BY model_name').all();
for (const v of allVersions) {
  console.log(`  ${v.model_name} v${v.version}: status=${v.status}, avg_ic=${v.avg_ic || 'N/A'}, folds=${v.total_folds || 'N/A'}`);
}

db.close();
console.log('\nDone.');
