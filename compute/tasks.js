/**
 * tasks.js — Pre-defined Task Templates for Lvl3Quant Compute
 *
 * Each template defines the resource profile and machine-specific commands
 * for common Lvl3Quant operations. The dispatcher uses these to route work.
 *
 * Template fields:
 *   type          - 'cpu', 'gpu', 'high_ram'
 *   requires      - capability requirements: ['gpu'], ['high_ram'], ['cpu'], etc.
 *   estimatedRam  - GB of RAM needed (used for routing)
 *   estimatedTime - Human-readable estimate
 *   command       - { pc: '...', server: '...' } — may include {param} placeholders
 *   workingDir    - { pc: '...', server: '...' }
 *
 * Supported placeholders (interpolated by dispatcher.addTask({ params: {...} })):
 *   {horizon}    - e.g. 'ret_10s', 'ret_30s', 'ret_1m'
 *   {targetType} - e.g. 'mfe_net', 'ret'
 *   {nDays}      - e.g. 70
 *   {workers}    - number of workers
 *   {quick}      - '--quick' or ''
 *
 * Usage:
 *   const dispatcher = require('./compute/dispatcher');
 *   dispatcher.addTask({
 *     name: 'ret_10s scan',
 *     template: 'multi_alpha_scan',
 *     params: { horizon: 'ret_10s', targetType: 'mfe_net', nDays: 70 },
 *   });
 */

'use strict';

// Common paths
const PC_LVL3 = 'C:/Users/Footb/Documents/Github/Lvl3Quant';
const SRV_LVL3 = '/home/jupiter/lvl3quant';
const PC_CACHE = `${PC_LVL3}/data/processed/mbo_features_cache`;
const SRV_CACHE = `${SRV_LVL3}/data/processed/mbo_features_cache`;
const SRV_PYTHON = `${SRV_LVL3}/venv/bin/python`;

const TASK_TEMPLATES = {

  // -------------------------------------------------------------------------
  // Feature Cache Rebuild
  // CPU only, low RAM, runs sequentially per day
  // -------------------------------------------------------------------------
  feature_cache_rebuild: {
    type: 'cpu',
    requires: ['cpu'],
    estimatedRam: 4,
    estimatedTime: '60 min',
    description: 'Rebuild the MBO feature cache from raw data files',
    command: {
      pc:     `python alpha_discovery/rebuild_feature_cache.py --workers 1`,
      server: `${SRV_PYTHON} alpha_discovery/rebuild_feature_cache.py --workers 4`,
    },
    workingDir: {
      pc:     PC_LVL3,
      server: SRV_LVL3,
    },
  },

  // -------------------------------------------------------------------------
  // Multi-Alpha Scan (CPU) — server preferred for large day counts
  // -------------------------------------------------------------------------
  multi_alpha_scan: {
    type: 'cpu',
    requires: ['cpu'],
    estimatedRam: 20,
    estimatedTime: '3-6 hours',
    description: 'Run multi-alpha scan with LightGBM (CPU)',
    command: {
      pc: [
        `python alpha_discovery/run_multi_alpha.py`,
        `--horizon {horizon}`,
        `--target-type {targetType}`,
        `--feature-cache "${PC_CACHE}"`,
        `--min-train-days 5`,
        `--n-days {nDays}`,
        `--no-execution`,
      ].join(' '),
      server: [
        `${SRV_PYTHON} alpha_discovery/run_multi_alpha.py`,
        `--horizon {horizon}`,
        `--target-type {targetType}`,
        `--feature-cache ${SRV_CACHE}`,
        `--min-train-days 5`,
        `--n-days {nDays}`,
        `--no-execution`,
      ].join(' '),
    },
    workingDir: {
      pc:     PC_LVL3,
      server: SRV_LVL3,
    },
  },

  // -------------------------------------------------------------------------
  // Multi-Alpha Scan (GPU) — PC only, requires RTX 3090
  // -------------------------------------------------------------------------
  multi_alpha_scan_gpu: {
    type: 'gpu',
    requires: ['gpu'],
    estimatedRam: 20,
    estimatedTime: '1-3 hours',
    description: 'Multi-alpha scan with GPU-accelerated LightGBM (RTX 3090)',
    command: {
      pc: [
        `python alpha_discovery/run_multi_alpha.py`,
        `--horizon {horizon}`,
        `--target-type {targetType}`,
        `--feature-cache "${PC_CACHE}"`,
        `--min-train-days 5`,
        `--n-days {nDays}`,
        `--no-execution`,
        `--gpu`,
      ].join(' '),
      // No server command — GPU not available on Jupiter
    },
    workingDir: {
      pc: PC_LVL3,
    },
  },

  // -------------------------------------------------------------------------
  // Large multi-alpha scan (>30GB RAM) — server only
  // -------------------------------------------------------------------------
  multi_alpha_scan_large: {
    type: 'cpu',
    requires: ['high_ram'],
    estimatedRam: 35,
    estimatedTime: '4-8 hours',
    description: 'Large multi-alpha scan requiring >30GB RAM — server only',
    command: {
      server: [
        `${SRV_PYTHON} alpha_discovery/run_multi_alpha.py`,
        `--horizon {horizon}`,
        `--target-type {targetType}`,
        `--feature-cache ${SRV_CACHE}`,
        `--min-train-days 5`,
        `--n-days {nDays}`,
        `--no-execution`,
      ].join(' '),
    },
    workingDir: {
      server: SRV_LVL3,
    },
  },

  // -------------------------------------------------------------------------
  // Magnitude-Gated Simulation
  // -------------------------------------------------------------------------
  magnitude_gated_sim: {
    type: 'cpu',
    requires: ['cpu'],
    estimatedRam: 20,
    estimatedTime: '2-4 hours',
    description: 'Magnitude-gated simulation with threshold analysis',
    command: {
      pc: [
        `python alpha_discovery/magnitude_gated_sim.py`,
        `--horizon {horizon}`,
        `--target-type {targetType}`,
        `--feature-cache "${PC_CACHE}"`,
        `--n-days {nDays}`,
        `--quick`,
      ].join(' '),
      server: [
        `${SRV_PYTHON} alpha_discovery/magnitude_gated_sim.py`,
        `--horizon {horizon}`,
        `--target-type {targetType}`,
        `--feature-cache ${SRV_CACHE}`,
        `--n-days {nDays}`,
        `--quick`,
      ].join(' '),
    },
    workingDir: {
      pc:     PC_LVL3,
      server: SRV_LVL3,
    },
  },

  // -------------------------------------------------------------------------
  // Realistic Simulation v2
  // -------------------------------------------------------------------------
  realistic_sim: {
    type: 'cpu',
    requires: ['cpu'],
    estimatedRam: 22,
    estimatedTime: '1-3 hours',
    description: 'Realistic simulation with market impact and latency modeling',
    command: {
      pc: [
        `python alpha_discovery/realistic_sim_v2.py`,
        `--horizon {horizon}`,
        `--feature-cache "${PC_CACHE}"`,
        `--n-days {nDays}`,
      ].join(' '),
      server: [
        `${SRV_PYTHON} alpha_discovery/realistic_sim_v2.py`,
        `--horizon {horizon}`,
        `--feature-cache ${SRV_CACHE}`,
        `--n-days {nDays}`,
      ].join(' '),
    },
    workingDir: {
      pc:     PC_LVL3,
      server: SRV_LVL3,
    },
  },

  // -------------------------------------------------------------------------
  // Rust Cache Builder
  // Fast binary, low RAM
  // -------------------------------------------------------------------------
  rust_cache_build: {
    type: 'cpu',
    requires: ['cpu'],
    estimatedRam: 2,
    estimatedTime: '30 min',
    description: 'Build MBO feature cache using Rust binary (fast)',
    command: {
      pc: [
        `rust_cache_builder/target/release/lob_cache_builder.exe`,
        `--input data/raw`,
        `--output data/processed/rust_full_test`,
        `--workers 4`,
      ].join(' '),
      server: [
        `${SRV_LVL3}/rust_cache_builder/target/release/lob_cache_builder`,
        `--input ${SRV_LVL3}/data/raw`,
        `--output ${SRV_LVL3}/data/processed/rust_full_test`,
        `--workers 4`,
      ].join(' '),
    },
    workingDir: {
      pc:     PC_LVL3,
      server: SRV_LVL3,
    },
  },

  // -------------------------------------------------------------------------
  // IASM (Intraday Alpha Signal Model) Training
  // -------------------------------------------------------------------------
  iasm_train: {
    type: 'cpu',
    requires: ['cpu'],
    estimatedRam: 16,
    estimatedTime: '2-4 hours',
    description: 'Train the IASM model on processed feature data',
    command: {
      pc: [
        `python alpha_discovery/iasm_train.py`,
        `--horizon {horizon}`,
        `--feature-cache "${PC_CACHE}"`,
        `--n-days {nDays}`,
        `--output-dir results/iasm`,
      ].join(' '),
      server: [
        `${SRV_PYTHON} alpha_discovery/iasm_train.py`,
        `--horizon {horizon}`,
        `--feature-cache ${SRV_CACHE}`,
        `--n-days {nDays}`,
        `--output-dir ${SRV_LVL3}/results/iasm`,
      ].join(' '),
    },
    workingDir: {
      pc:     PC_LVL3,
      server: SRV_LVL3,
    },
  },

  // -------------------------------------------------------------------------
  // IASM Training (GPU) — PC only
  // -------------------------------------------------------------------------
  iasm_train_gpu: {
    type: 'gpu',
    requires: ['gpu'],
    estimatedRam: 16,
    estimatedTime: '30-90 min',
    description: 'Train IASM with GPU acceleration (RTX 3090)',
    command: {
      pc: [
        `python alpha_discovery/iasm_train.py`,
        `--horizon {horizon}`,
        `--feature-cache "${PC_CACHE}"`,
        `--n-days {nDays}`,
        `--output-dir results/iasm`,
        `--device cuda`,
      ].join(' '),
    },
    workingDir: {
      pc: PC_LVL3,
    },
  },

  // -------------------------------------------------------------------------
  // Alpha Discovery Full Pipeline (chain of tasks example)
  // High RAM — server only
  // -------------------------------------------------------------------------
  alpha_full_pipeline: {
    type: 'cpu',
    requires: ['high_ram'],
    estimatedRam: 38,
    estimatedTime: '6-12 hours',
    description: 'Full alpha discovery pipeline: cache + scan + sim (server only)',
    command: {
      server: [
        `${SRV_PYTHON} alpha_discovery/run_full_pipeline.py`,
        `--horizon {horizon}`,
        `--target-type {targetType}`,
        `--feature-cache ${SRV_CACHE}`,
        `--n-days {nDays}`,
      ].join(' '),
    },
    workingDir: {
      server: SRV_LVL3,
    },
  },

  // -------------------------------------------------------------------------
  // Custom Shell Command — for one-off tasks
  // -------------------------------------------------------------------------
  custom_pc: {
    type: 'cpu',
    requires: ['cpu'],
    estimatedRam: 4,
    estimatedTime: 'unknown',
    description: 'Custom command on PC — set command.pc in params',
    command: {
      pc: '{command}',
    },
    workingDir: {
      pc: PC_LVL3,
    },
  },

  custom_server: {
    type: 'cpu',
    requires: ['cpu'],
    estimatedRam: 4,
    estimatedTime: 'unknown',
    description: 'Custom command on server — set command.server in params',
    command: {
      server: '{command}',
    },
    workingDir: {
      server: SRV_LVL3,
    },
  },

};

// ===========================================================================
// Exports
// ===========================================================================

module.exports = {
  TASK_TEMPLATES,

  // Path constants (useful for callers building custom tasks)
  PC_LVL3,
  SRV_LVL3,
  PC_CACHE,
  SRV_CACHE,
  SRV_PYTHON,

  /**
   * Get a template by name.
   * @param {string} name
   * @returns {object|null}
   */
  getTemplate(name) {
    return TASK_TEMPLATES[name] || null;
  },

  /**
   * List all template names with a brief description.
   * @returns {Array<{name, type, requires, estimatedTime, description}>}
   */
  listTemplates() {
    return Object.entries(TASK_TEMPLATES).map(([name, tmpl]) => ({
      name,
      type:          tmpl.type,
      requires:      tmpl.requires,
      estimatedRam:  tmpl.estimatedRam,
      estimatedTime: tmpl.estimatedTime,
      description:   tmpl.description || '',
      hasPcCommand:  !!tmpl.command?.pc,
      hasServerCmd:  !!tmpl.command?.server,
    }));
  },
};
