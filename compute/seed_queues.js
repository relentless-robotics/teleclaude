#!/usr/bin/env node
/**
 * Seed Queues — Pre-populate all node queues with current research priorities.
 *
 * Run once after deploying the queue system (or after draining stale jobs):
 *   node compute/seed_queues.js
 *   node compute/seed_queues.js --dry-run     # print without writing
 *   node compute/seed_queues.js --replace      # drain existing queued jobs first
 *
 * Based on research priorities as of 2026-03-27:
 *   Key edges: CNN IC=0.261@10s, OOT +8.5pp vs random, LGBM MFE/MAE IC=0.28
 *   Critical gaps: fill sim Monte Carlo failures, qf_passive dead, C5 paper mismatch
 */

'use strict';

const queue = require('./job_queue');

// ============================================================================
// JOB DEFINITIONS PER NODE
// ============================================================================

/**
 * Razer — CPU research node (Windows, C:\Users\claude\Lvl3Quant)
 * Math strategies, LGBM, gradient boosting, fill sim on GPU.
 * NEVER deep learning on Razer.
 */
const RAZER_JOBS = [
  {
    priority:    1,
    name:        'l1_imbalance_cnn_combo_ic',
    description: 'L1 imbalance × CNN combo IC test — does combining signals improve edge?',
    command:     'C:\\Python311\\python.exe scripts/l1_cnn_combo_ic.py',
    cwd:         'C:\\Users\\claude\\Lvl3Quant',
    tags:        ['ic_test', 'combo_signal', 'l1_imbalance', 'cnn'],
  },
  {
    priority:    1,
    name:        'qf_iceberg_chase_subset_rerun',
    description: 'Fixed qf_iceberg_chase rerun on 500-sample subset first (validate before full run)',
    command:     'C:\\Python311\\python.exe scripts/qf_iceberg_chase_fillsim_safe.py --subset 500 --incremental',
    cwd:         'C:\\Users\\claude\\Lvl3Quant',
    tags:        ['fill_sim', 'iceberg', 'chase', 'subset_validation'],
  },
  {
    priority:    2,
    name:        'conviction_sweep_c4_c5_c7',
    description: 'Conviction exit sweep for cards C4, C5, C7 (signal-based dynamic exits)',
    command:     'C:\\Python311\\python.exe scripts/conviction_refined_sweep.py --cards C4,C5,C7',
    cwd:         'C:\\Users\\claude\\Lvl3Quant',
    tags:        ['conviction', 'dynamic_exit', 'sweep', 'c4', 'c5', 'c7'],
  },
  {
    priority:    2,
    name:        'lgbm_reduced_feature_set',
    description: 'LGBM with top-20 features only — test if reduced set maintains IC=0.28',
    command:     'C:\\Python311\\python.exe scripts/feature_ablation_razer.py --top-n 20 --model lgbm',
    cwd:         'C:\\Users\\claude\\Lvl3Quant',
    tags:        ['lgbm', 'feature_ablation', 'ic_test'],
  },
  {
    priority:    3,
    name:        'lgbm_queue_position_features',
    description: 'LGBM with queue position features added — does queue depth improve IC?',
    command:     'C:\\Python311\\python.exe scripts/lgbm_thresh_sweep.py --add-queue-features',
    cwd:         'C:\\Users\\claude\\Lvl3Quant',
    tags:        ['lgbm', 'queue_position', 'microstructure', 'feature_engineering'],
  },
  {
    priority:    3,
    name:        'cancel_time_sweep',
    description: 'Cancel time sweep: 1s/2s/3s/5s/10s — optimal cancel timeout vs fill rate',
    command:     'C:\\Python311\\python.exe scripts/iceberg_early_limit_sweep.py --cancel-times 1,2,3,5,10',
    cwd:         'C:\\Users\\claude\\Lvl3Quant',
    tags:        ['cancel_time', 'fill_sim', 'sweep', 'iceberg'],
  },
  {
    priority:    4,
    name:        'spread_regime_analysis',
    description: 'Spread regime analysis — edge breakdown by tight/normal/wide spread regimes',
    command:     'C:\\Python311\\python.exe scripts/adverse_selection_analysis.py --by-spread-regime',
    cwd:         'C:\\Users\\claude\\Lvl3Quant',
    tags:        ['spread_regime', 'adverse_selection', 'microstructure'],
  },
  {
    priority:    4,
    name:        'trade_intensity_features',
    description: 'Trade intensity feature engineering — trades/sec, volume burst, short-window VWAP delta',
    command:     'C:\\Python311\\python.exe scripts/feature_ablation_razer.py --feature-set trade_intensity',
    cwd:         'C:\\Users\\claude\\Lvl3Quant',
    tags:        ['feature_engineering', 'trade_intensity', 'microstructure'],
  },
  {
    priority:    5,
    name:        'l1_cnn_combo_fill_sim',
    description: 'Full fill sim on L1 × CNN combo signal (after IC test passes)',
    command:     'C:\\Python311\\python.exe scripts/l1_cnn_combo_fillsim.py --full',
    cwd:         'C:\\Users\\claude\\Lvl3Quant',
    tags:        ['fill_sim', 'combo_signal', 'l1_imbalance', 'cnn', 'post_ic_test'],
  },
  {
    priority:    5,
    name:        'qf_iceberg_chase_full_run',
    description: 'Full qf_iceberg_chase fill sim after subset validation (all configs)',
    command:     'C:\\Python311\\python.exe scripts/qf_iceberg_chase_fillsim_safe.py --full --incremental',
    cwd:         'C:\\Users\\claude\\Lvl3Quant',
    tags:        ['fill_sim', 'iceberg', 'chase', 'post_validation'],
  },
  {
    priority:    6,
    name:        'confluence_strategy_sweep',
    description: 'Multi-signal confluence strategy (1728 configs) — find synergistic signal combos',
    command:     'C:\\Python311\\python.exe confluence_strategy.py',
    cwd:         'C:\\Users\\claude\\Lvl3Quant',
    tags:        ['confluence', 'sweep', 'multi_signal'],
  },
];

/**
 * Jupiter — CPU 64GB (Linux/WSL, /home/jupiter/Lvl3Quant)
 * Fill simulation, Monte Carlo validation, execution research.
 * This is the primary execution research node.
 */
const JUPITER_JOBS = [
  {
    priority:    1,
    name:        'hold_time_opt_z2_multi_period',
    description: 'Hold time optimization for z>2.0 signals across 3/5/10/20/30s periods',
    command:     'python3 scripts/short_hold_sweep.py --min-z 2.0 --periods 3,5,10,20,30',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['hold_time', 'z_score', 'fill_sim', 'sweep'],
  },
  {
    priority:    1,
    name:        'c5_paper_vs_fillsim_diagnosis',
    description: 'C5 paper vs fill sim diagnosis — identify why paper P&L diverges from backtest',
    command:     'python3 scripts/final_fill_sim.py --card C5 --diagnose-paper-divergence',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['c5', 'paper_trading', 'diagnosis', 'fill_sim'],
  },
  {
    priority:    2,
    name:        'time_of_day_edge_analysis',
    description: 'Time-of-day edge analysis — which 30-min windows have best Sortino?',
    command:     'python3 scripts/time_of_day_sweep.py --by-window 30min',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['time_of_day', 'sortino', 'intraday_patterns'],
  },
  {
    priority:    2,
    name:        'queue_position_vs_sortino',
    description: 'Queue position vs Sortino analysis — does being 1st/2nd/3rd in queue predict outcome?',
    command:     'python3 scripts/qf_passive_analysis.py --by-queue-position',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['queue_position', 'sortino', 'microstructure', 'adverse_selection'],
  },
  {
    priority:    2,
    name:        'monte_carlo_z2_validation',
    description: 'Monte Carlo validation on z>2.0 results (500 paths, 95% CI) — is Sortino real?',
    command:     'python3 scripts/final_fill_sim.py --min-z 2.0 --monte-carlo 500 --ci 95',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['monte_carlo', 'z_score', 'validation', 'sortino'],
  },
  {
    priority:    3,
    name:        'multi_card_conviction_sweep',
    description: 'Multi-card conviction exit sweep — C1 through C10 dynamic signal exit optimization',
    command:     'python3 scripts/conviction_exit_analysis.py --all-cards --dynamic-exit',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['conviction', 'dynamic_exit', 'multi_card', 'sweep'],
  },
  {
    priority:    3,
    name:        'signal_decay_analysis',
    description: 'Signal decay analysis — how fast does CNN edge decay after signal (0-30s)',
    command:     'python3 scripts/mfe_mae_conditioned_fast.py --decay-analysis --horizons 1,2,3,5,10,20,30',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['signal_decay', 'mfe_mae', 'cnn', 'edge_analysis'],
  },
  {
    priority:    4,
    name:        'adverse_selection_by_tod',
    description: 'Adverse selection analysis segmented by time-of-day (open/midday/close)',
    command:     'python3 scripts/adverse_selection_analysis.py --by-time-of-day',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['adverse_selection', 'time_of_day', 'microstructure'],
  },
  {
    priority:    4,
    name:        'mfe_mae_lgbm_fill_sim',
    description: 'Fill sim using LGBM MFE/MAE predictions (IC=0.28) as dynamic TP/SL',
    command:     'python3 scripts/mfe_mae_multihorizon.py --model lgbm --dynamic-tpsl',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['mfe_mae', 'lgbm', 'fill_sim', 'dynamic_tpsl'],
  },
  {
    priority:    5,
    name:        'orb_iceberg_hybrid_v2',
    description: 'ORB × iceberg hybrid strategy v2 — opening range breakout with iceberg overlay',
    command:     'python3 scripts/orb_iceberg_hybrid_v2.py',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['orb', 'iceberg', 'hybrid', 'opening_range'],
  },
  {
    priority:    5,
    name:        'asymmetric_card_validation',
    description: 'Asymmetric TP/SL card validation — C1 SHORT-ONLY, C3/C4 LONG-ONLY confirmation',
    command:     'python3 scripts/asymmetric_card_validation.py --cards C1,C3,C4',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['asymmetric', 'card_validation', 'long_short_bias'],
  },
  {
    priority:    6,
    name:        'qf_passive_lowvol_retest',
    description: 'QF passive strategy in low-vol regime only (previous all-regime test failed)',
    command:     'python3 scripts/qf_passive_lowvol_jupiter.py --regime low_vol',
    cwd:         '/home/jupiter/Lvl3Quant',
    tags:        ['qf_passive', 'low_vol_regime', 'fill_sim'],
  },
];

/**
 * Saturn — CPU 32GB (Linux, /home/saturn/Lvl3Quant, accessed via Jupiter hop)
 * Mega sweeps, cross-validation, regime-conditional analysis.
 */
const SATURN_JOBS = [
  {
    priority:    1,
    name:        'mega_sweep_v2_aggregation',
    description: 'mega_sweep_v2 result aggregation (after current 71% sweep finishes)',
    command:     'python3 scripts/mega_sweep_final_analysis.py --sweep mega_sweep_v2 --top-n 50',
    cwd:         '/home/saturn/Lvl3Quant',
    tags:        ['mega_sweep', 'aggregation', 'post_sweep'],
  },
  {
    priority:    2,
    name:        'top_configs_cross_validation',
    description: 'Cross-validation of top-50 mega_sweep configs (out-of-sample confirmation)',
    command:     'python3 scripts/card567_optuna_sweep.py --top-configs 50 --oos-validate',
    cwd:         '/home/saturn/Lvl3Quant',
    tags:        ['cross_validation', 'oos', 'mega_sweep', 'top_configs'],
  },
  {
    priority:    2,
    name:        'regime_conditional_strategy',
    description: 'Regime-conditional strategy analysis — best configs per vol/trend regime',
    command:     'python3 scripts/saturn_vol_regime_sweep.py --conditional',
    cwd:         '/home/saturn/Lvl3Quant',
    tags:        ['regime', 'vol_regime', 'conditional_strategy'],
  },
  {
    priority:    3,
    name:        'saturn_expanded_sweep_v2',
    description: 'Saturn expanded sweep v2 — wider TP/SL range, more signal threshold combos',
    command:     'python3 scripts/saturn_expanded_sweep.py --version 2 --workers 24',
    cwd:         '/home/saturn/Lvl3Quant',
    tags:        ['sweep', 'tpsl', 'expanded_range'],
  },
  {
    priority:    3,
    name:        'jupiter_oot_vol_sweep',
    description: 'Jupiter OOT volatility regime sweep — does edge hold across vol regimes?',
    command:     'python3 scripts/jupiter_oot_vol_sweep.py',
    cwd:         '/home/saturn/Lvl3Quant',
    tags:        ['oot', 'vol_regime', 'edge_validation'],
  },
  {
    priority:    4,
    name:        'card_l1_combo_fillsim_saturn',
    description: 'L1+CNN combo fill sim on Saturn (high-parallelism sweep)',
    command:     'python3 scripts/card_l1_combo_fillsim.py --workers 24',
    cwd:         '/home/saturn/Lvl3Quant',
    tags:        ['fill_sim', 'l1_combo', 'parallel', 'sweep'],
  },
  {
    priority:    4,
    name:        'iceberg_highcv_fillsim',
    description: 'Iceberg high-CV fill sim — test iceberg strategy in high coefficient-of-variation periods',
    command:     'python3 scripts/iceberg_highcv_fillsim.py',
    cwd:         '/home/saturn/Lvl3Quant',
    tags:        ['iceberg', 'high_cv', 'fill_sim'],
  },
  {
    priority:    5,
    name:        'asymmetric_optimization_sweep',
    description: 'Asymmetric TP/SL optimization sweep — maximize Sortino by varying TP:SL ratio 1:1 to 3:1',
    command:     'python3 scripts/asymmetric_optimization_sweep.py --ratios 1.0,1.5,2.0,2.5,3.0',
    cwd:         '/home/saturn/Lvl3Quant',
    tags:        ['asymmetric', 'tpsl_ratio', 'sortino', 'sweep'],
  },
  {
    priority:    5,
    name:        'conviction_oot_sweep',
    description: 'Conviction exit OOT sweep — validate conviction exits on held-out dates',
    command:     'python3 scripts/conviction_oot_sweep.py --oot',
    cwd:         '/home/saturn/Lvl3Quant',
    tags:        ['conviction', 'oot', 'dynamic_exit', 'validation'],
  },
  {
    priority:    6,
    name:        'full_card_optimization_saturn',
    description: 'Full card optimization sweep (C1-C10) on Saturn parallel workers',
    command:     'python3 scripts/full_card_optimization.py --workers 24 --all-cards',
    cwd:         '/home/saturn/Lvl3Quant',
    tags:        ['card_optimization', 'sweep', 'all_cards', 'parallel'],
  },
];

/**
 * Neptune — GPU (Windows, C:\Users\Footb\Documents\Github\Lvl3Quant)
 * LOW PRIORITY. Deep learning training takes precedence.
 * Only queue items that run AFTER WF training completes.
 * WF fold 76+ is currently running.
 */
const NEPTUNE_JOBS = [
  {
    priority:    7,  // Very low — only runs after WF training complete
    name:        'wider_cnn_oot_inference',
    description: 'Full OOT inference on completed Wider CNN model (post WF training)',
    command:     'python scripts/audit_predictions.py --model wider_cnn --oot --all-dates',
    cwd:         'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant',
    tags:        ['oot', 'inference', 'wider_cnn', 'post_training'],
  },
  {
    priority:    7,
    name:        'paper_engine_config_update',
    description: 'Update paper engine config after WF training completes (new model weights)',
    command:     'python scripts/seed_model_versions.py --source wider_cnn --promote-to-paper',
    cwd:         'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant',
    tags:        ['paper_engine', 'model_deploy', 'post_training'],
  },
  {
    priority:    8,
    name:        'wider_cnn_leakage_audit',
    description: 'Leakage audit on completed Wider CNN folds (mandatory before reporting results)',
    command:     'python scripts/audit_predictions.py --model wider_cnn --leakage-check --all-folds',
    cwd:         'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant',
    tags:        ['leakage_audit', 'wider_cnn', 'compliance'],
  },
  {
    priority:    8,
    name:        'neptune_full_card_report',
    description: 'Full card report generation after WF training (IC, Sortino, WR for all folds)',
    command:     'python scripts/full_card_report.py --model wider_cnn --export',
    cwd:         'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant',
    tags:        ['card_report', 'wider_cnn', 'post_training', 'reporting'],
  },
];

/**
 * Uranus — GPU RTX 5090 (Windows, C:\Users\nick\Lvl3Quant)
 * DO NOT QUEUE — MFE/MAE CNN training is running (fold 26/168).
 * Queue items for AFTER fold 168 completes.
 */
const URANUS_JOBS = [
  {
    priority:    8,  // Deliberately low — only after MFE/MAE training finishes
    name:        'mfemae_oot_inference',
    description: 'MFE/MAE CNN OOT inference on held-out dates (post fold 168)',
    command:     'C:\\Users\\Nick\\AppData\\Local\\Programs\\Python\\Python311\\python.exe scripts/mfe_mae_conditioned.py --oot --all-dates',
    cwd:         'C:\\Users\\nick\\Lvl3Quant',
    tags:        ['mfe_mae', 'oot', 'inference', 'post_training'],
  },
  {
    priority:    8,
    name:        'mfemae_leakage_audit',
    description: 'Mandatory leakage audit on MFE/MAE CNN (post fold 168)',
    command:     'C:\\Users\\Nick\\AppData\\Local\\Programs\\Python\\Python311\\python.exe scripts/audit_predictions.py --model mfe_mae_cnn --leakage-check',
    cwd:         'C:\\Users\\nick\\Lvl3Quant',
    tags:        ['leakage_audit', 'mfe_mae', 'compliance', 'post_training'],
  },
  {
    priority:    9,
    name:        'architecture_comparison_exp',
    description: 'Architecture comparison: Wider CNN vs MFE/MAE CNN vs standard CNN on same OOT dates',
    command:     'C:\\Users\\Nick\\AppData\\Local\\Programs\\Python\\Python311\\python.exe scripts/wider_cnn_oos_fillsim_jupiter.py --compare-architectures',
    cwd:         'C:\\Users\\nick\\Lvl3Quant',
    tags:        ['architecture', 'comparison', 'wider_cnn', 'mfe_mae', 'oot'],
  },
  {
    priority:    9,
    name:        'mfemae_dynamic_tpsl_fillsim',
    description: 'Fill sim using MFE/MAE CNN predictions as dynamic TP/SL signals',
    command:     'C:\\Users\\Nick\\AppData\\Local\\Programs\\Python\\Python311\\python.exe scripts/mfe_mae_fixed.py --dynamic-tpsl --fill-sim',
    cwd:         'C:\\Users\\nick\\Lvl3Quant',
    tags:        ['mfe_mae', 'dynamic_tpsl', 'fill_sim', 'post_training'],
  },
];

// ============================================================================
// SEED FUNCTION
// ============================================================================

const ALL_JOBS = {
  razer:   RAZER_JOBS,
  jupiter: JUPITER_JOBS,
  saturn:  SATURN_JOBS,
  neptune: NEPTUNE_JOBS,
  uranus:  URANUS_JOBS,
};

function seedQueues(opts = {}) {
  const { dryRun = false, replace = false } = opts;

  let totalAdded = 0;
  let totalSkipped = 0;

  for (const [node, jobs] of Object.entries(ALL_JOBS)) {
    if (replace && !dryRun) {
      const drained = queue.drainQueue(node);
      if (drained > 0) {
        console.log(`  ${node}: drained ${drained} existing queued jobs`);
      }
    }

    const existingQueue = queue.getQueue(node);
    const existingNames = new Set(existingQueue.map(j => j.name));

    let added = 0;
    let skipped = 0;

    for (const job of jobs) {
      // Skip if a job with same name already exists (any status)
      if (existingNames.has(job.name)) {
        skipped++;
        continue;
      }

      if (!dryRun) {
        queue.addJob(node, job);
      } else {
        console.log(`  [DRY RUN] Would add to ${node}: [P${job.priority}] ${job.name} — ${job.description.slice(0, 70)}`);
      }
      added++;
    }

    if (!dryRun) {
      console.log(`  ${node}: added ${added} jobs (skipped ${skipped} already-present)`);
    }

    totalAdded   += added;
    totalSkipped += skipped;
  }

  if (!dryRun) {
    console.log(`\nTotal: ${totalAdded} jobs added, ${totalSkipped} skipped.`);
    console.log('\nCurrent queue depths:');
    const summary = queue.allQueues();
    for (const [node, info] of Object.entries(summary)) {
      console.log(`  ${node}: ${info.depth} queued, ${info.running_job ? `running: ${info.running_job.name}` : 'idle'}`);
    }
  }

  return { totalAdded, totalSkipped };
}

// ============================================================================
// CLI
// ============================================================================

if (require.main === module) {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const replace= args.includes('--replace');

  console.log('=== Queue Seeder ===');
  if (dryRun)  console.log('DRY RUN: no files will be modified.');
  if (replace) console.log('REPLACE mode: existing queued jobs will be cleared first.');
  console.log('');

  console.log('Job counts per node:');
  for (const [node, jobs] of Object.entries(ALL_JOBS)) {
    console.log(`  ${node}: ${jobs.length} jobs defined`);
  }
  console.log('');

  const result = seedQueues({ dryRun, replace });

  if (dryRun) {
    console.log(`\nWould add ${result.totalAdded} jobs total.`);
    console.log('Run without --dry-run to apply.');
  }
}

module.exports = { seedQueues, ALL_JOBS };
