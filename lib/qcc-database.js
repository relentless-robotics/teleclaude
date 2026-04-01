/**
 * QCC Database Layer - SQLite backend for Quant Command Center
 *
 * Uses better-sqlite3 for synchronous, high-performance SQLite access.
 * WAL mode for concurrent reads, foreign keys enforced.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class QCCDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;

    // Ensure parent directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this._createSchema();
    this._createIndexes();
    this._migrateSchema();
  }

  _createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS compute_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        host TEXT NOT NULL,
        tailscale_ip TEXT,
        port INTEGER DEFAULT 22,
        ssh_user TEXT,
        hop_through TEXT,
        gpu TEXT,
        gpu_vram_gb INTEGER,
        ram_gb INTEGER,
        os TEXT DEFAULT 'linux',
        lvl3_root TEXT NOT NULL,
        status TEXT DEFAULT 'unknown' CHECK(status IN ('online','offline','training','idle','unknown')),
        last_heartbeat TEXT,
        last_gpu_util REAL,
        last_gpu_mem_mb INTEGER,
        last_ram_pct REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        architecture TEXT NOT NULL,
        params_count INTEGER,
        horizon_bars INTEGER DEFAULT 100,
        subsample INTEGER DEFAULT 5,
        window_mode TEXT DEFAULT 'expanding',
        max_train_days INTEGER DEFAULT 30,
        epochs INTEGER DEFAULT 3,
        batch_size INTEGER DEFAULT 512,
        lr REAL DEFAULT 3e-4,
        dropout REAL DEFAULT 0.1,
        config_json TEXT,
        node TEXT,
        checkpoint_path TEXT,
        status TEXT DEFAULT 'training' CHECK(status IN ('training','completed','deployed','archived','failed')),
        total_folds INTEGER,
        completed_folds INTEGER DEFAULT 0,
        latest_ic REAL,
        mean_ic REAL,
        best_ic REAL,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS folds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL,
        fold_idx INTEGER NOT NULL,
        test_date TEXT,
        ic REAL,
        train_loss REAL,
        val_loss REAL,
        train_days INTEGER,
        train_samples INTEGER,
        test_samples INTEGER,
        duration_sec REAL,
        gpu_used TEXT,
        metrics_json TEXT,
        completed_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(model_id, fold_idx),
        FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        model_variant TEXT NOT NULL,
        conviction_threshold REAL NOT NULL,
        vol_percentile_gate INTEGER NOT NULL,
        tp_ticks INTEGER NOT NULL,
        sl_ticks INTEGER DEFAULT 0,
        hold_ms INTEGER DEFAULT 7200000,
        mae_exit_ticks INTEGER DEFAULT 10,
        mae_exit_hold_sec INTEGER DEFAULT 600,
        chase_entry INTEGER DEFAULT 1,
        chase_max_ticks INTEGER DEFAULT 1,
        chase_max_reprices INTEGER DEFAULT 3,
        ratchet_thresholds_json TEXT,
        backtest_sharpe REAL,
        backtest_trades INTEGER,
        backtest_win_rate REAL,
        backtest_notes TEXT,
        status TEXT DEFAULT 'paper' CHECK(status IN ('paper','live','retired','testing')),
        deployed_model_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS training_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER,
        node TEXT NOT NULL,
        job_type TEXT NOT NULL CHECK(job_type IN ('training','sweep','fillsim','inference','sync','pipeline','other')),
        description TEXT,
        config_json TEXT,
        pid INTEGER,
        tmux_session TEXT,
        start_fold INTEGER,
        current_fold INTEGER,
        total_folds INTEGER,
        status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','failed','stale','cancelled','queued')),
        progress_pct REAL DEFAULT 0.0,
        eta_minutes REAL,
        result_json TEXT,
        error_msg TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        last_heartbeat TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS data_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node TEXT NOT NULL,
        date TEXT,
        file_type TEXT NOT NULL CHECK(file_type IN ('mbo','book_tensor','prediction','checkpoint','config','other')),
        filename TEXT NOT NULL,
        path TEXT NOT NULL,
        size_bytes INTEGER,
        row_count INTEGER,
        checksum TEXT,
        verified_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(node, path)
      );

      CREATE TABLE IF NOT EXISTS research_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        hypothesis TEXT,
        status TEXT DEFAULT 'proposed' CHECK(status IN ('proposed','active','blocked','completed','abandoned')),
        priority INTEGER DEFAULT 3,
        related_model_ids TEXT,
        findings TEXT,
        next_steps TEXT,
        tags TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS directories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node TEXT NOT NULL,
        path TEXT NOT NULL,
        purpose TEXT,
        contents_description TEXT,
        important_files TEXT,
        last_verified TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(node, path)
      );

      CREATE TABLE IF NOT EXISTS sync_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_node TEXT NOT NULL,
        dest_node TEXT NOT NULL,
        file_type TEXT,
        file_pattern TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
        files_total INTEGER DEFAULT 0,
        files_transferred INTEGER DEFAULT 0,
        bytes_transferred INTEGER DEFAULT 0,
        error_msg TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        severity TEXT NOT NULL CHECK(severity IN ('critical','warning','info')),
        source TEXT NOT NULL,
        node TEXT,
        message TEXT NOT NULL,
        resolved INTEGER DEFAULT 0,
        resolved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        summary TEXT,
        tasks_completed TEXT,
        tasks_pending TEXT,
        context_json TEXT
      );

      CREATE TABLE IF NOT EXISTS action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        args_json TEXT,
        result_summary TEXT,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sweeps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        sweep_type TEXT CHECK(sweep_type IN ('card','fillsim','optuna','grid','manual')),
        config_json TEXT,
        total_configs INTEGER,
        completed_configs INTEGER DEFAULT 0,
        best_config_json TEXT,
        best_metric REAL,
        metric_name TEXT DEFAULT 'sharpe',
        node TEXT,
        status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled')),
        results_path TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS sweep_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sweep_id INTEGER NOT NULL,
        config_json TEXT NOT NULL,
        sharpe REAL,
        pnl REAL,
        trades INTEGER,
        win_rate REAL,
        max_drawdown REAL,
        avg_hold_sec REAL,
        metrics_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (sweep_id) REFERENCES sweeps(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        cron_expr TEXT NOT NULL,
        task_type TEXT NOT NULL CHECK(task_type IN ('training','sync','scan','pipeline','health','report','custom')),
        command_json TEXT,
        node TEXT,
        enabled INTEGER DEFAULT 1,
        last_run TEXT,
        last_status TEXT,
        last_error TEXT,
        next_run TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS trade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_name TEXT NOT NULL,
        session_date TEXT NOT NULL,
        side TEXT CHECK(side IN ('LONG','SHORT')),
        entry_price REAL,
        exit_price REAL,
        entry_time TEXT,
        exit_time TEXT,
        pnl_dollars REAL,
        pnl_ticks REAL,
        hold_sec REAL,
        mae_ticks REAL,
        mfe_ticks REAL,
        exit_reason TEXT,
        entry_zscore REAL,
        exit_zscore REAL,
        conviction REAL,
        vol_percentile REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS node_state_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_name TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        status TEXT,
        gpu_util REAL,
        gpu_mem_mb REAL,
        gpu_temp REAL,
        cpu_load REAL,
        ram_pct REAL,
        disk_pct REAL,
        active_processes TEXT,
        active_jobs INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS data_pipelines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        stage TEXT NOT NULL,
        node_name TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
        input_path TEXT,
        output_path TEXT,
        file_hash TEXT,
        job_id INTEGER REFERENCES job_queue(id),
        started_at TEXT,
        completed_at TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(date, stage)
      );

      CREATE TABLE IF NOT EXISTS job_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL,
        job_name TEXT NOT NULL,
        node_name TEXT,
        requires_gpu INTEGER DEFAULT 0,
        command TEXT NOT NULL,
        working_dir TEXT,
        config_json TEXT,

        status TEXT DEFAULT 'queued' CHECK(status IN ('queued','assigned','running','completed','failed','cancelled')),
        priority INTEGER DEFAULT 5,

        depends_on INTEGER REFERENCES job_queue(id),
        chain_next TEXT,

        pid INTEGER,
        started_at TEXT,
        completed_at TEXT,
        duration_sec REAL,
        exit_code INTEGER,
        output_tail TEXT,
        error_tail TEXT,
        result_json TEXT,

        created_by TEXT DEFAULT 'claude',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS resource_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_name TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        job_id INTEGER REFERENCES job_queue(id),
        reserved_at TEXT DEFAULT (datetime('now')),
        released_at TEXT,
        UNIQUE(node_name, resource_type, job_id)
      );

      CREATE TABLE IF NOT EXISTS daily_pnl (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        card_id INTEGER NOT NULL,
        card_name TEXT,
        trades INTEGER DEFAULT 0,
        gross_pnl REAL DEFAULT 0,
        net_pnl REAL DEFAULT 0,
        commission REAL DEFAULT 0,
        win_count INTEGER DEFAULT 0,
        loss_count INTEGER DEFAULT 0,
        avg_win REAL,
        avg_loss REAL,
        max_drawdown REAL,
        sharpe_daily REAL,
        signals_total INTEGER,
        fill_rate REAL,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(date, card_id)
      );

      CREATE TABLE IF NOT EXISTS pnl_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        card_name TEXT NOT NULL,
        cumulative_pnl REAL,
        trades_today INTEGER,
        position INTEGER,
        unrealized_pnl REAL,
        zscore REAL,
        conviction REAL,
        vol_percentile REAL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Card performance profiles (MAE/MFE/decay/conviction analysis)
      CREATE TABLE IF NOT EXISTS card_performance_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id INTEGER NOT NULL,
        card_name TEXT NOT NULL,
        profile_date TEXT NOT NULL,
        oot_start TEXT,
        oot_end TEXT,
        n_days INTEGER,
        n_trades INTEGER,

        -- Core performance
        sharpe REAL,
        total_pnl REAL,
        daily_pnl_avg REAL,
        daily_pnl_std REAL,
        win_rate REAL,
        profit_factor REAL,
        avg_trades_per_day REAL,

        -- Win/Loss economics
        avg_win REAL,
        avg_loss REAL,
        wl_ratio REAL,
        best_trade REAL,
        worst_trade REAL,
        best_day REAL,
        worst_day REAL,

        -- MAE analysis (Max Adverse Excursion)
        mae_avg REAL,
        mae_p50 REAL,
        mae_p75 REAL,
        mae_p95 REAL,
        mae_worst REAL,
        mae_winners_avg REAL,
        mae_losers_avg REAL,

        -- MFE analysis (Max Favorable Excursion)
        mfe_avg REAL,
        mfe_p50 REAL,
        mfe_p75 REAL,
        mfe_p95 REAL,
        mfe_best REAL,
        mfe_winners_avg REAL,
        mfe_losers_avg REAL,

        -- Hold time analysis
        avg_hold_sec_winners REAL,
        avg_hold_sec_losers REAL,
        avg_hold_sec_all REAL,

        -- Edge decay curve
        edge_decay_json TEXT,
        optimal_hold_min REAL,

        -- Consistency
        positive_days INTEGER,
        negative_days INTEGER,
        positive_day_pct REAL,
        max_consecutive_loss_days INTEGER,
        max_drawdown REAL,
        max_drawdown_duration_days INTEGER,

        -- Exit reason breakdown
        exit_reasons_json TEXT,

        -- Fill analysis
        fill_rate REAL,
        avg_queue_position REAL,
        avg_fill_latency_ms REAL,

        -- Conviction exit analysis
        conviction_exit_tested INTEGER DEFAULT 0,
        conviction_best_config TEXT,
        conviction_net_pnl_delta REAL,
        conviction_verdict TEXT,

        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(card_id, profile_date)
      );

      -- Strategy results: fill-sim or backtest outcomes per strategy config
      CREATE TABLE IF NOT EXISTS strategy_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER REFERENCES research_queue(id),
        strategy_name TEXT NOT NULL,
        config_json TEXT,
        node TEXT,
        data_days INTEGER,
        data_source TEXT CHECK(data_source IN ('fillsim','backtest')),
        total_trades INTEGER,
        win_rate REAL,
        total_pnl REAL,
        avg_win REAL,
        avg_loss REAL,
        sharpe REAL,
        sortino REAL,
        profit_factor REAL,
        max_drawdown_pct REAL,
        validated_fillsim INTEGER DEFAULT 0,
        monte_carlo_passed INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Fill simulation results: per-config, per-date runs
      CREATE TABLE IF NOT EXISTS fillsim_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER REFERENCES research_queue(id),
        config_name TEXT NOT NULL,
        mbo_date TEXT NOT NULL,
        signal_source TEXT,
        total_pnl REAL,
        total_trades INTEGER,
        total_filled INTEGER,
        fill_rate REAL,
        avg_queue_position REAL,
        avg_fill_latency_ms REAL,
        tp_count INTEGER,
        sl_count INTEGER,
        timeout_count INTEGER,
        tp_ticks REAL,
        sl_ticks REAL,
        hold_ms INTEGER,
        signal_threshold REAL,
        trailing_ticks REAL,
        time_decay_config TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Experiment metrics: time-series of training progress per fold/epoch
      CREATE TABLE IF NOT EXISTS experiment_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER REFERENCES research_queue(id),
        epoch INTEGER,
        fold INTEGER,
        train_loss REAL,
        val_loss REAL,
        ic REAL,
        dir_accuracy REAL,
        sortino REAL,
        vram_gb REAL,
        power_watts REAL,
        epoch_time_sec REAL,
        recorded_at TEXT DEFAULT (datetime('now'))
      );

      -- Research decisions: immutable audit log of what the orchestrator decided and why
      CREATE TABLE IF NOT EXISTS research_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision TEXT NOT NULL,
        rationale TEXT,
        evidence_json TEXT,
        outcome TEXT,
        category TEXT CHECK(category IN ('model','strategy','execution','infra')),
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Training run aggregate statistics
      CREATE TABLE IF NOT EXISTS training_run_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        training_job_id INTEGER REFERENCES training_jobs(id),
        config_id INTEGER, -- references training_configs(id) if that table exists

        -- Aggregate fold stats
        total_folds INTEGER,
        completed_folds INTEGER,
        failed_folds INTEGER,

        -- IC statistics
        ic_mean REAL,
        ic_median REAL,
        ic_std REAL,
        ic_min REAL,
        ic_max REAL,
        ic_p25 REAL,
        ic_p75 REAL,

        -- Loss statistics
        train_loss_mean REAL,
        val_loss_mean REAL,
        overfitting_ratio_mean REAL,

        -- Temporal IC trend
        ic_trend_slope REAL,
        ic_trend_r2 REAL,

        -- Duration
        total_duration_hours REAL,
        avg_fold_duration_min REAL,

        -- Comparison to previous version
        prev_version_ic_mean REAL,
        ic_improvement_pct REAL,

        updated_at TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Immutable model versioning
      CREATE TABLE IF NOT EXISTS model_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_name TEXT NOT NULL,
        version INTEGER NOT NULL,
        config_id INTEGER REFERENCES training_configs(id),
        manifest_id INTEGER REFERENCES data_manifests(id),

        -- Artifact tracking
        checkpoint_path TEXT,
        checkpoint_hash TEXT,
        prediction_dir TEXT,
        prediction_count INTEGER,

        -- Performance summary
        avg_ic REAL,
        min_ic REAL,
        max_ic REAL,
        total_folds INTEGER,
        oot_sharpe REAL,

        -- Status lifecycle
        status TEXT DEFAULT 'training' CHECK(status IN ('training','validated','deployed','deprecated')),
        promoted_at TEXT,
        deployed_at TEXT,
        deprecated_at TEXT,
        deprecated_reason TEXT,

        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(model_name, version)
      );

      -- Prediction invalidation tracking
      CREATE TABLE IF NOT EXISTS prediction_invalidations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_version_id INTEGER NOT NULL REFERENCES model_versions(id),
        reason TEXT NOT NULL,
        affected_dates TEXT,
        resolved INTEGER DEFAULT 0,
        resolved_at TEXT,
        invalidated_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  _createIndexes() {
    this.db.exec(`
      -- folds indexes
      CREATE INDEX IF NOT EXISTS idx_folds_model_id ON folds(model_id);
      CREATE INDEX IF NOT EXISTS idx_folds_test_date ON folds(test_date);

      -- models indexes
      CREATE INDEX IF NOT EXISTS idx_models_status ON models(status);
      CREATE INDEX IF NOT EXISTS idx_models_node ON models(node);
      CREATE INDEX IF NOT EXISTS idx_models_architecture ON models(architecture);

      -- cards indexes
      CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
      CREATE INDEX IF NOT EXISTS idx_cards_deployed_model ON cards(deployed_model_id);

      -- training_jobs indexes
      CREATE INDEX IF NOT EXISTS idx_training_jobs_model_id ON training_jobs(model_id);
      CREATE INDEX IF NOT EXISTS idx_training_jobs_node ON training_jobs(node);
      CREATE INDEX IF NOT EXISTS idx_training_jobs_status ON training_jobs(status);

      -- data_files indexes
      CREATE INDEX IF NOT EXISTS idx_data_files_node ON data_files(node);
      CREATE INDEX IF NOT EXISTS idx_data_files_date ON data_files(date);
      CREATE INDEX IF NOT EXISTS idx_data_files_type ON data_files(file_type);

      -- research_projects indexes
      CREATE INDEX IF NOT EXISTS idx_research_status ON research_projects(status);
      CREATE INDEX IF NOT EXISTS idx_research_priority ON research_projects(priority);

      -- directories indexes
      CREATE INDEX IF NOT EXISTS idx_directories_node ON directories(node);

      -- sync_tasks indexes
      CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_tasks(status);

      -- alerts indexes
      CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
      CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved);
      CREATE INDEX IF NOT EXISTS idx_alerts_node ON alerts(node);
      CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);

      -- sessions indexes
      CREATE INDEX IF NOT EXISTS idx_sessions_session_id ON sessions(session_id);

      -- action_log indexes
      CREATE INDEX IF NOT EXISTS idx_action_log_tool ON action_log(tool_name);
      CREATE INDEX IF NOT EXISTS idx_action_log_session ON action_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_action_log_created ON action_log(created_at);

      -- node_state_history indexes
      CREATE INDEX IF NOT EXISTS idx_node_history_node_time ON node_state_history(node_name, timestamp);
      CREATE INDEX IF NOT EXISTS idx_node_history_timestamp ON node_state_history(timestamp);

      -- sweeps indexes
      CREATE INDEX IF NOT EXISTS idx_sweeps_status ON sweeps(status);
      CREATE INDEX IF NOT EXISTS idx_sweeps_node ON sweeps(node);

      -- sweep_results indexes
      CREATE INDEX IF NOT EXISTS idx_sweep_results_sweep_id ON sweep_results(sweep_id);

      -- scheduled_tasks indexes
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_type ON scheduled_tasks(task_type);
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled ON scheduled_tasks(enabled);

      -- trade_history indexes
      CREATE INDEX IF NOT EXISTS idx_trades_card ON trade_history(card_name);
      CREATE INDEX IF NOT EXISTS idx_trades_date ON trade_history(session_date);
      CREATE INDEX IF NOT EXISTS idx_trades_side ON trade_history(side);

      -- data_pipelines indexes
      CREATE INDEX IF NOT EXISTS idx_pipelines_date ON data_pipelines(date);
      CREATE INDEX IF NOT EXISTS idx_pipelines_stage ON data_pipelines(stage);
      CREATE INDEX IF NOT EXISTS idx_pipelines_status ON data_pipelines(status);
      CREATE INDEX IF NOT EXISTS idx_pipelines_node ON data_pipelines(node_name);

      -- job_queue indexes
      CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
      CREATE INDEX IF NOT EXISTS idx_job_queue_node ON job_queue(node_name);
      CREATE INDEX IF NOT EXISTS idx_job_queue_priority ON job_queue(priority);
      CREATE INDEX IF NOT EXISTS idx_job_queue_depends ON job_queue(depends_on);
      CREATE INDEX IF NOT EXISTS idx_job_queue_created ON job_queue(created_at);

      -- resource_reservations indexes
      CREATE INDEX IF NOT EXISTS idx_reservations_node ON resource_reservations(node_name);
      CREATE INDEX IF NOT EXISTS idx_reservations_job ON resource_reservations(job_id);
      CREATE INDEX IF NOT EXISTS idx_reservations_active ON resource_reservations(node_name, resource_type) WHERE released_at IS NULL;

      -- daily_pnl indexes
      CREATE INDEX IF NOT EXISTS idx_daily_pnl_date ON daily_pnl(date);
      CREATE INDEX IF NOT EXISTS idx_daily_pnl_card ON daily_pnl(card_id);
      CREATE INDEX IF NOT EXISTS idx_daily_pnl_card_date ON daily_pnl(card_id, date);

      -- pnl_snapshots indexes
      CREATE INDEX IF NOT EXISTS idx_pnl_snapshots_card ON pnl_snapshots(card_name);
      CREATE INDEX IF NOT EXISTS idx_pnl_snapshots_ts ON pnl_snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_pnl_snapshots_card_ts ON pnl_snapshots(card_name, timestamp);

      -- card_performance_profiles indexes
      CREATE INDEX IF NOT EXISTS idx_card_profiles_card_id ON card_performance_profiles(card_id);
      CREATE INDEX IF NOT EXISTS idx_card_profiles_card_name ON card_performance_profiles(card_name);
      CREATE INDEX IF NOT EXISTS idx_card_profiles_date ON card_performance_profiles(profile_date);
      CREATE INDEX IF NOT EXISTS idx_card_profiles_card_date ON card_performance_profiles(card_id, profile_date);

      -- training_run_stats indexes
      CREATE INDEX IF NOT EXISTS idx_training_run_stats_job ON training_run_stats(training_job_id);
      CREATE INDEX IF NOT EXISTS idx_training_run_stats_config ON training_run_stats(config_id);
      CREATE INDEX IF NOT EXISTS idx_training_run_stats_created ON training_run_stats(created_at);

      -- model_versions indexes
      CREATE INDEX IF NOT EXISTS idx_model_versions_name ON model_versions(model_name);
      CREATE INDEX IF NOT EXISTS idx_model_versions_status ON model_versions(status);
      CREATE INDEX IF NOT EXISTS idx_model_versions_config ON model_versions(config_id);
      CREATE INDEX IF NOT EXISTS idx_model_versions_name_ver ON model_versions(model_name, version);

      -- prediction_invalidations indexes
      CREATE INDEX IF NOT EXISTS idx_pred_invalid_version ON prediction_invalidations(model_version_id);
      CREATE INDEX IF NOT EXISTS idx_pred_invalid_resolved ON prediction_invalidations(resolved);

      -- strategy_results indexes
      CREATE INDEX IF NOT EXISTS idx_strategy_results_name ON strategy_results(strategy_name);
      CREATE INDEX IF NOT EXISTS idx_strategy_results_experiment ON strategy_results(experiment_id);
      CREATE INDEX IF NOT EXISTS idx_strategy_results_source ON strategy_results(data_source);
      CREATE INDEX IF NOT EXISTS idx_strategy_results_sharpe ON strategy_results(sharpe);
      CREATE INDEX IF NOT EXISTS idx_strategy_results_created ON strategy_results(created_at);

      -- fillsim_results indexes
      CREATE INDEX IF NOT EXISTS idx_fillsim_config ON fillsim_results(config_name);
      CREATE INDEX IF NOT EXISTS idx_fillsim_date ON fillsim_results(mbo_date);
      CREATE INDEX IF NOT EXISTS idx_fillsim_experiment ON fillsim_results(experiment_id);
      CREATE INDEX IF NOT EXISTS idx_fillsim_source ON fillsim_results(signal_source);
      CREATE INDEX IF NOT EXISTS idx_fillsim_config_date ON fillsim_results(config_name, mbo_date);

      -- experiment_metrics indexes
      CREATE INDEX IF NOT EXISTS idx_exp_metrics_experiment ON experiment_metrics(experiment_id);
      CREATE INDEX IF NOT EXISTS idx_exp_metrics_recorded ON experiment_metrics(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_exp_metrics_exp_fold ON experiment_metrics(experiment_id, fold);

      -- research_decisions indexes
      CREATE INDEX IF NOT EXISTS idx_decisions_category ON research_decisions(category);
      CREATE INDEX IF NOT EXISTS idx_decisions_created ON research_decisions(created_at);
    `);
  }

  // ========================
  // SCHEMA MIGRATIONS
  // ========================

  _migrateSchema() {
    // Add SSH credential columns to compute_nodes if they don't exist
    const cols = this.db.pragma('table_info(compute_nodes)').map(c => c.name);
    if (!cols.includes('ssh_password')) {
      this.db.exec("ALTER TABLE compute_nodes ADD COLUMN ssh_password TEXT");
    }
    if (!cols.includes('ssh_key_path')) {
      this.db.exec("ALTER TABLE compute_nodes ADD COLUMN ssh_key_path TEXT");
    }
    if (!cols.includes('ssh_auth_method')) {
      this.db.exec("ALTER TABLE compute_nodes ADD COLUMN ssh_auth_method TEXT DEFAULT 'password'");
    }

    // Add GPU power monitoring columns
    if (!cols.includes('last_gpu_power_w')) {
      this.db.exec("ALTER TABLE compute_nodes ADD COLUMN last_gpu_power_w REAL");
    }
    if (!cols.includes('gpu_power_limit_w')) {
      this.db.exec("ALTER TABLE compute_nodes ADD COLUMN gpu_power_limit_w REAL");
    }

    // Add best_ic column to models if it doesn't exist
    const modelCols = this.db.pragma('table_info(models)').map(c => c.name);
    if (!modelCols.includes('best_ic')) {
      this.db.exec("ALTER TABLE models ADD COLUMN best_ic REAL");
    }

    // Create resource_reservations table if it doesn't exist (migration for existing DBs)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resource_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_name TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        job_id INTEGER REFERENCES job_queue(id),
        reserved_at TEXT DEFAULT (datetime('now')),
        released_at TEXT,
        UNIQUE(node_name, resource_type, job_id)
      );
      CREATE INDEX IF NOT EXISTS idx_reservations_node ON resource_reservations(node_name);
      CREATE INDEX IF NOT EXISTS idx_reservations_job ON resource_reservations(job_id);
      CREATE INDEX IF NOT EXISTS idx_reservations_active ON resource_reservations(node_name, resource_type) WHERE released_at IS NULL;
    `);

    // Create card_performance_profiles and training_run_stats if they don't exist (migration for existing DBs)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS card_performance_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_id INTEGER NOT NULL,
        card_name TEXT NOT NULL,
        profile_date TEXT NOT NULL,
        oot_start TEXT, oot_end TEXT, n_days INTEGER, n_trades INTEGER,
        sharpe REAL, total_pnl REAL, daily_pnl_avg REAL, daily_pnl_std REAL,
        win_rate REAL, profit_factor REAL, avg_trades_per_day REAL,
        avg_win REAL, avg_loss REAL, wl_ratio REAL, best_trade REAL, worst_trade REAL,
        best_day REAL, worst_day REAL,
        mae_avg REAL, mae_p50 REAL, mae_p75 REAL, mae_p95 REAL, mae_worst REAL,
        mae_winners_avg REAL, mae_losers_avg REAL,
        mfe_avg REAL, mfe_p50 REAL, mfe_p75 REAL, mfe_p95 REAL, mfe_best REAL,
        mfe_winners_avg REAL, mfe_losers_avg REAL,
        avg_hold_sec_winners REAL, avg_hold_sec_losers REAL, avg_hold_sec_all REAL,
        edge_decay_json TEXT, optimal_hold_min REAL,
        positive_days INTEGER, negative_days INTEGER, positive_day_pct REAL,
        max_consecutive_loss_days INTEGER, max_drawdown REAL, max_drawdown_duration_days INTEGER,
        exit_reasons_json TEXT,
        fill_rate REAL, avg_queue_position REAL, avg_fill_latency_ms REAL,
        conviction_exit_tested INTEGER DEFAULT 0, conviction_best_config TEXT,
        conviction_net_pnl_delta REAL, conviction_verdict TEXT,
        notes TEXT, created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(card_id, profile_date)
      );
      CREATE TABLE IF NOT EXISTS training_run_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        training_job_id INTEGER REFERENCES training_jobs(id),
        config_id INTEGER,
        total_folds INTEGER, completed_folds INTEGER, failed_folds INTEGER,
        ic_mean REAL, ic_median REAL, ic_std REAL, ic_min REAL, ic_max REAL, ic_p25 REAL, ic_p75 REAL,
        train_loss_mean REAL, val_loss_mean REAL, overfitting_ratio_mean REAL,
        ic_trend_slope REAL, ic_trend_r2 REAL,
        total_duration_hours REAL, avg_fold_duration_min REAL,
        prev_version_ic_mean REAL, ic_improvement_pct REAL,
        updated_at TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_card_profiles_card_id ON card_performance_profiles(card_id);
      CREATE INDEX IF NOT EXISTS idx_card_profiles_card_name ON card_performance_profiles(card_name);
      CREATE INDEX IF NOT EXISTS idx_card_profiles_date ON card_performance_profiles(profile_date);
      CREATE INDEX IF NOT EXISTS idx_card_profiles_card_date ON card_performance_profiles(card_id, profile_date);
      CREATE INDEX IF NOT EXISTS idx_training_run_stats_job ON training_run_stats(training_job_id);
      CREATE INDEX IF NOT EXISTS idx_training_run_stats_config ON training_run_stats(config_id);
      CREATE INDEX IF NOT EXISTS idx_training_run_stats_created ON training_run_stats(created_at);
    `);

    // Research experiments table — tracks harness results (LGBM, static CNN, mini WF)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_experiments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES research_projects(id),
        stage TEXT NOT NULL CHECK(stage IN ('lgbm', 'static_cnn', 'mini_wf', 'full_wf')),
        hypothesis TEXT,
        config_json TEXT NOT NULL,
        horizon_bars INTEGER,
        train_days INTEGER,
        oot_days INTEGER,
        model_type TEXT,
        ic REAL,
        ic_std REAL,
        ic_ci_low REAL,
        ic_ci_high REAL,
        train_loss REAL,
        val_loss REAL,
        overfit_ratio REAL,
        param_count INTEGER,
        n_folds INTEGER,
        positive_fold_pct REAL,
        feature_importance_json TEXT,
        elapsed_seconds REAL,
        node TEXT,
        verdict TEXT CHECK(verdict IN ('promising', 'neutral', 'weak', 'reject', 'pending')),
        notes TEXT,
        result_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_experiments_stage ON research_experiments(stage);
      CREATE INDEX IF NOT EXISTS idx_experiments_ic ON research_experiments(ic);
      CREATE INDEX IF NOT EXISTS idx_experiments_project ON research_experiments(project_id);
      CREATE INDEX IF NOT EXISTS idx_experiments_verdict ON research_experiments(verdict);
      CREATE INDEX IF NOT EXISTS idx_experiments_created ON research_experiments(created_at);
    `);

    // Add model_version_id to card_model_bindings if it doesn't exist
    try {
      const cmbCols = this.db.pragma('table_info(card_model_bindings)').map(c => c.name);
      if (cmbCols.length > 0 && !cmbCols.includes('model_version_id')) {
        this.db.exec("ALTER TABLE card_model_bindings ADD COLUMN model_version_id INTEGER REFERENCES model_versions(id)");
      }
    } catch (e) {
      // card_model_bindings may not exist yet (created via migration script)
    }

    // New tables: strategy_results, fillsim_results, experiment_metrics, research_decisions
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS strategy_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER REFERENCES research_queue(id),
        strategy_name TEXT NOT NULL,
        config_json TEXT,
        node TEXT,
        data_days INTEGER,
        data_source TEXT CHECK(data_source IN ('fillsim','backtest')),
        total_trades INTEGER,
        win_rate REAL,
        total_pnl REAL,
        avg_win REAL,
        avg_loss REAL,
        sharpe REAL,
        sortino REAL,
        profit_factor REAL,
        max_drawdown_pct REAL,
        validated_fillsim INTEGER DEFAULT 0,
        monte_carlo_passed INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS fillsim_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER REFERENCES research_queue(id),
        config_name TEXT NOT NULL,
        mbo_date TEXT NOT NULL,
        signal_source TEXT,
        total_pnl REAL,
        total_trades INTEGER,
        total_filled INTEGER,
        fill_rate REAL,
        avg_queue_position REAL,
        avg_fill_latency_ms REAL,
        tp_count INTEGER,
        sl_count INTEGER,
        timeout_count INTEGER,
        tp_ticks REAL,
        sl_ticks REAL,
        hold_ms INTEGER,
        signal_threshold REAL,
        trailing_ticks REAL,
        time_decay_config TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS experiment_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id INTEGER REFERENCES research_queue(id),
        epoch INTEGER,
        fold INTEGER,
        train_loss REAL,
        val_loss REAL,
        ic REAL,
        dir_accuracy REAL,
        sortino REAL,
        vram_gb REAL,
        power_watts REAL,
        epoch_time_sec REAL,
        recorded_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS research_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision TEXT NOT NULL,
        rationale TEXT,
        evidence_json TEXT,
        outcome TEXT,
        category TEXT CHECK(category IN ('model','strategy','execution','infra')),
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_strategy_results_name ON strategy_results(strategy_name);
      CREATE INDEX IF NOT EXISTS idx_strategy_results_experiment ON strategy_results(experiment_id);
      CREATE INDEX IF NOT EXISTS idx_strategy_results_source ON strategy_results(data_source);
      CREATE INDEX IF NOT EXISTS idx_strategy_results_sharpe ON strategy_results(sharpe);
      CREATE INDEX IF NOT EXISTS idx_strategy_results_created ON strategy_results(created_at);

      CREATE INDEX IF NOT EXISTS idx_fillsim_config ON fillsim_results(config_name);
      CREATE INDEX IF NOT EXISTS idx_fillsim_date ON fillsim_results(mbo_date);
      CREATE INDEX IF NOT EXISTS idx_fillsim_experiment ON fillsim_results(experiment_id);
      CREATE INDEX IF NOT EXISTS idx_fillsim_source ON fillsim_results(signal_source);
      CREATE INDEX IF NOT EXISTS idx_fillsim_config_date ON fillsim_results(config_name, mbo_date);

      CREATE INDEX IF NOT EXISTS idx_exp_metrics_experiment ON experiment_metrics(experiment_id);
      CREATE INDEX IF NOT EXISTS idx_exp_metrics_recorded ON experiment_metrics(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_exp_metrics_exp_fold ON experiment_metrics(experiment_id, fold);

      CREATE INDEX IF NOT EXISTS idx_decisions_category ON research_decisions(category);
      CREATE INDEX IF NOT EXISTS idx_decisions_created ON research_decisions(created_at);
    `);

    // Researcher tables: researchers, researcher_tasks, researcher_findings
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS researchers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        node_primary TEXT,
        nodes_secondary TEXT,
        context_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS researcher_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        researcher_id TEXT NOT NULL REFERENCES researchers(id),
        task TEXT NOT NULL,
        description TEXT,
        priority INTEGER DEFAULT 5,
        status TEXT DEFAULT 'queued',
        experiment_id INTEGER,
        result_summary TEXT,
        iteration_of INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS researcher_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        researcher_id TEXT NOT NULL REFERENCES researchers(id),
        finding TEXT NOT NULL,
        evidence TEXT,
        impact TEXT,
        experiment_id INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_researcher_tasks_researcher ON researcher_tasks(researcher_id);
      CREATE INDEX IF NOT EXISTS idx_researcher_tasks_status ON researcher_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_researcher_findings_researcher ON researcher_findings(researcher_id);
      CREATE INDEX IF NOT EXISTS idx_researcher_findings_experiment ON researcher_findings(experiment_id);
    `);

    // Seed the 4 researchers if the table is empty
    this._seedResearchers();

    // Populate SSH credentials for known nodes from config
    this._populateSSHCredentials();
  }

  _populateSSHCredentials() {
    // Only populate if credentials are currently empty (check jupiter since neptune has no password)
    const jupiter = this.db.prepare("SELECT ssh_password FROM compute_nodes WHERE name = 'jupiter'").get();
    if (jupiter && jupiter.ssh_password) return; // Already populated

    const configPath = path.join(__dirname, '..', 'config', 'remote_servers.json');
    let serverConfig = {};
    try {
      if (fs.existsSync(configPath)) {
        serverConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')).servers || {};
      }
    } catch (e) {
      // Config not found, use hardcoded defaults
    }

    const updates = this.db.prepare(`
      UPDATE compute_nodes SET
        ssh_password = @ssh_password,
        ssh_key_path = @ssh_key_path,
        ssh_auth_method = @ssh_auth_method,
        ssh_user = COALESCE(@ssh_user, ssh_user),
        os = COALESCE(@os, os),
        tailscale_ip = COALESCE(@tailscale_ip, tailscale_ip),
        updated_at = datetime('now')
      WHERE name = @name
    `);

    const nodeCredentials = [
      {
        name: 'neptune',
        ssh_password: null,
        ssh_key_path: 'C:\\Users\\Footb\\.ssh\\id_ed25519',
        ssh_auth_method: 'key',
        ssh_user: null,
        os: 'windows',
        tailscale_ip: '100.109.245.73',
      },
      {
        name: 'uranus',
        ssh_password: serverConfig.uranus?.password || null,
        ssh_key_path: serverConfig.uranus?.key_file || null,
        ssh_auth_method: serverConfig.uranus?.password ? 'both' : 'key',
        ssh_user: serverConfig.uranus?.user || 'nick',
        os: 'windows',
        tailscale_ip: '100.100.83.37',
      },
      {
        name: 'jupiter',
        ssh_password: serverConfig.jupiter?.password || null,
        ssh_key_path: serverConfig.jupiter?.key_file || null,
        ssh_auth_method: serverConfig.jupiter?.password ? 'both' : 'key',
        ssh_user: serverConfig.jupiter?.user || 'jupiter',
        os: 'windows',
        tailscale_ip: '100.102.174.30',
      },
      {
        name: 'saturn',
        ssh_password: serverConfig.saturn?.password || null,
        ssh_key_path: null,
        ssh_auth_method: 'password',
        ssh_user: serverConfig.saturn?.user || 'saturn',
        os: 'linux',
        tailscale_ip: '100.101.101.9',
      },
      {
        name: 'razer',
        ssh_password: serverConfig.razer?.password || null,
        ssh_key_path: null,
        ssh_auth_method: 'password',
        ssh_user: serverConfig.razer?.user || 'claude',
        os: 'windows',
        tailscale_ip: '100.102.215.75',
      },
    ];

    const runAll = this.db.transaction((rows) => {
      for (const row of rows) {
        try { updates.run(row); } catch (e) { /* node may not exist yet */ }
      }
    });
    runAll(nodeCredentials);
  }

  // ========================
  // SEED DATA
  // ========================

  seedIfEmpty() {
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM compute_nodes').get().cnt;
    if (count > 0) return false;

    this._seedComputeNodes();
    this._seedCards();
    this._seedScheduledTasks();
    this._seedResearchProjects();
    this.seedCardProfiles();
    this.seedTrainingRunStats();
    return true;
  }

  _seedComputeNodes() {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO compute_nodes (name, host, tailscale_ip, port, ssh_user, hop_through, gpu, gpu_vram_gb, ram_gb, os, lvl3_root)
      VALUES (@name, @host, @tailscale_ip, @port, @ssh_user, @hop_through, @gpu, @gpu_vram_gb, @ram_gb, @os, @lvl3_root)
    `);

    const nodes = [
      { name: 'neptune', host: 'localhost', tailscale_ip: '100.109.245.73', port: 22, ssh_user: null, hop_through: null, gpu: 'RTX 3090', gpu_vram_gb: 24, ram_gb: 64, os: 'windows', lvl3_root: 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant' },
      { name: 'uranus', host: '100.100.83.37', tailscale_ip: null, port: 22, ssh_user: 'footb', hop_through: null, gpu: 'RTX 5090', gpu_vram_gb: 32, ram_gb: 128, os: 'linux', lvl3_root: '/home/footb/Lvl3Quant' },
      { name: 'jupiter', host: '192.168.0.108', tailscale_ip: null, port: 22, ssh_user: 'footb', hop_through: null, gpu: 'none', gpu_vram_gb: null, ram_gb: 64, os: 'linux', lvl3_root: '/home/footb/Lvl3Quant' },
      { name: 'saturn', host: '10.0.0.2', tailscale_ip: null, port: 22, ssh_user: 'footb', hop_through: 'jupiter', gpu: 'none', gpu_vram_gb: null, ram_gb: 32, os: 'linux', lvl3_root: '/home/footb/Lvl3Quant' },
      { name: 'razer', host: '100.102.215.75', tailscale_ip: null, port: 22, ssh_user: 'footb', hop_through: null, gpu: 'RTX 3070', gpu_vram_gb: 8, ram_gb: 16, os: 'linux', lvl3_root: '/home/footb/Lvl3Quant' },
    ];

    const insertMany = this.db.transaction((rows) => {
      for (const row of rows) insert.run(row);
    });
    insertMany(nodes);
  }

  _seedCards() {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO cards (name, model_variant, conviction_threshold, vol_percentile_gate, tp_ticks, sl_ticks, hold_ms, mae_exit_ticks, mae_exit_hold_sec, chase_entry, chase_max_ticks, chase_max_reprices, backtest_sharpe, status)
      VALUES (@name, @model_variant, @conviction_threshold, @vol_percentile_gate, @tp_ticks, @sl_ticks, @hold_ms, @mae_exit_ticks, @mae_exit_hold_sec, @chase_entry, @chase_max_ticks, @chase_max_reprices, @backtest_sharpe, @status)
    `);

    const cards = [
      { name: 'Card1', model_variant: 'book_predstd_conv1.5_vol50_TP8', conviction_threshold: 0.1, vol_percentile_gate: 50, tp_ticks: 8, sl_ticks: 0, hold_ms: 7200000, mae_exit_ticks: 25, mae_exit_hold_sec: 600, chase_entry: 0, chase_max_ticks: 0, chase_max_reprices: 0, backtest_sharpe: 1.18, status: 'paper' },
      { name: 'Card2', model_variant: 'book_predstd_conv1.5_vol50_TP15', conviction_threshold: 0.5, vol_percentile_gate: 50, tp_ticks: 15, sl_ticks: 0, hold_ms: 7200000, mae_exit_ticks: 10, mae_exit_hold_sec: 600, chase_entry: 0, chase_max_ticks: 0, chase_max_reprices: 0, backtest_sharpe: 1.35, status: 'paper' },
      { name: 'Card3', model_variant: 'book_predstd_conv1.5_vol50_TP10', conviction_threshold: 0.5, vol_percentile_gate: 50, tp_ticks: 10, sl_ticks: 0, hold_ms: 7200000, mae_exit_ticks: 10, mae_exit_hold_sec: 600, chase_entry: 0, chase_max_ticks: 0, chase_max_reprices: 0, backtest_sharpe: 2.05, status: 'retired' },
      { name: 'Card4', model_variant: 'book_predstd_conv2.0_vol70_TP20', conviction_threshold: 0.5, vol_percentile_gate: 70, tp_ticks: 20, sl_ticks: 0, hold_ms: 7200000, mae_exit_ticks: 10, mae_exit_hold_sec: 600, chase_entry: 0, chase_max_ticks: 0, chase_max_reprices: 0, backtest_sharpe: 2.62, status: 'paper' },
      { name: 'Card5', model_variant: 'book_predstdExit_conv2.0_vol70', conviction_threshold: 0.1, vol_percentile_gate: 70, tp_ticks: 4, sl_ticks: 0, hold_ms: 120000, mae_exit_ticks: 10, mae_exit_hold_sec: 600, chase_entry: 1, chase_max_ticks: 1, chase_max_reprices: 3, backtest_sharpe: 1.99, status: 'paper' },
      { name: 'Card6', model_variant: 'book_predstdExit_conv2.0_vol70', conviction_threshold: 0.1, vol_percentile_gate: 70, tp_ticks: 4, sl_ticks: 0, hold_ms: 120000, mae_exit_ticks: 10, mae_exit_hold_sec: 600, chase_entry: 1, chase_max_ticks: 2, chase_max_reprices: 5, backtest_sharpe: null, status: 'paper' },
      { name: 'Card7', model_variant: 'book_predstdExit_conv2.0_vol70', conviction_threshold: 0.1, vol_percentile_gate: 70, tp_ticks: 5, sl_ticks: 0, hold_ms: 120000, mae_exit_ticks: 10, mae_exit_hold_sec: 600, chase_entry: 1, chase_max_ticks: 1, chase_max_reprices: 3, backtest_sharpe: null, status: 'paper' },
    ];

    const insertMany = this.db.transaction((rows) => {
      for (const row of rows) insert.run(row);
    });
    insertMany(cards);
  }

  _seedScheduledTasks() {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO scheduled_tasks (name, description, cron_expr, task_type)
      VALUES (@name, @description, @cron_expr, @task_type)
    `);

    const tasks = [
      { name: 'daily_mbo_sync', description: 'Sync overnight MBO data to all nodes', cron_expr: '0 6 * * 1-5', task_type: 'sync' },
      { name: 'daily_tensor_build', description: 'Build book tensors from new MBO data', cron_expr: '0 7 * * 1-5', task_type: 'pipeline' },
      { name: 'daily_wf_fold', description: 'Run next WF fold on available GPU', cron_expr: '0 8 * * 1-5', task_type: 'training' },
      { name: 'health_check', description: 'Check all nodes, training jobs, paper engine', cron_expr: '*/15 * * * *', task_type: 'health' },
      { name: 'daily_report', description: 'EOD trading report to Discord', cron_expr: '0 16 * * 1-5', task_type: 'report' },
      { name: 'nightly_data_verify', description: 'Verify data integrity across all nodes', cron_expr: '0 22 * * 1-5', task_type: 'scan' },
    ];

    const insertMany = this.db.transaction((rows) => {
      for (const row of rows) insert.run(row);
    });
    insertMany(tasks);
  }

  _seedResearchProjects() {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO research_projects (name, hypothesis, status, priority, tags)
      VALUES (@name, @hypothesis, @status, @priority, @tags)
    `);

    const projects = [
      { name: 'TLOB Dual Attention', hypothesis: 'Transformer LOB with dual attention mechanism may capture cross-level dependencies better', status: 'proposed', priority: 1, tags: 'architecture,transformer' },
      { name: 'LiT Transformer', hypothesis: 'Lightweight transformer variant could match CNN with lower compute cost', status: 'proposed', priority: 2, tags: 'architecture,transformer,efficiency' },
      { name: 'MBO+LOB Ensemble', hypothesis: 'Combining MBO and LOB features in an ensemble may improve prediction quality', status: 'proposed', priority: 2, tags: 'ensemble,features' },
      { name: 'Double OOT Validation', hypothesis: 'Two-stage out-of-time validation reduces overfitting risk', status: 'proposed', priority: 3, tags: 'validation,methodology' },
      { name: 'Decay Window Analysis', hypothesis: 'Analyzing prediction decay windows reveals optimal hold times per card', status: 'proposed', priority: 2, tags: 'analysis,exits' },
      { name: 'Ablation Study', hypothesis: 'Systematic feature ablation identifies which input channels drive IC', status: 'proposed', priority: 3, tags: 'analysis,features' },
      { name: 'Conviction Exit', hypothesis: 'Using model conviction change as exit signal instead of fixed TP/SL', status: 'proposed', priority: 2, tags: 'exits,strategy' },
      { name: 'Multi-Horizon Ensemble', hypothesis: 'Combining 10s, 30s, 60s horizon models improves robustness', status: 'proposed', priority: 1, tags: 'ensemble,multi-horizon' },
      { name: 'Queue Features', hypothesis: 'Adding queue position and queue imbalance features improves fill prediction', status: 'proposed', priority: 3, tags: 'features,microstructure' },
    ];

    const insertMany = this.db.transaction((rows) => {
      for (const row of rows) insert.run(row);
    });
    insertMany(projects);
  }

  // ========================
  // COMPUTE NODES
  // ========================

  getNodes(status = null) {
    if (status) {
      return this.db.prepare('SELECT * FROM compute_nodes WHERE status = ?').all(status);
    }
    return this.db.prepare('SELECT * FROM compute_nodes ORDER BY name').all();
  }

  getNode(name) {
    return this.db.prepare('SELECT * FROM compute_nodes WHERE name = ?').get(name);
  }

  updateNodeStatus(name, status, gpuUtil = null, gpuMemMb = null, ramPct = null, gpuPowerW = null, gpuPowerLimitW = null) {
    return this.db.prepare(`
      UPDATE compute_nodes SET status = ?, last_heartbeat = datetime('now'),
        last_gpu_util = COALESCE(?, last_gpu_util),
        last_gpu_mem_mb = COALESCE(?, last_gpu_mem_mb),
        last_ram_pct = COALESCE(?, last_ram_pct),
        last_gpu_power_w = COALESCE(?, last_gpu_power_w),
        gpu_power_limit_w = COALESCE(?, gpu_power_limit_w),
        updated_at = datetime('now')
      WHERE name = ?
    `).run(status, gpuUtil, gpuMemMb, ramPct, gpuPowerW, gpuPowerLimitW, name);
  }

  // ========================
  // MODELS
  // ========================

  registerModel(data) {
    const stmt = this.db.prepare(`
      INSERT INTO models (name, architecture, params_count, horizon_bars, subsample, window_mode,
        max_train_days, epochs, batch_size, lr, dropout, config_json, node, checkpoint_path,
        status, total_folds, notes)
      VALUES (@name, @architecture, @params_count, @horizon_bars, @subsample, @window_mode,
        @max_train_days, @epochs, @batch_size, @lr, @dropout, @config_json, @node, @checkpoint_path,
        @status, @total_folds, @notes)
    `);
    const result = stmt.run({
      name: data.name,
      architecture: data.architecture,
      params_count: data.params_count || null,
      horizon_bars: data.horizon_bars || 100,
      subsample: data.subsample || 5,
      window_mode: data.window_mode || 'expanding',
      max_train_days: data.max_train_days || 30,
      epochs: data.epochs || 3,
      batch_size: data.batch_size || 512,
      lr: data.lr || 3e-4,
      dropout: data.dropout || 0.1,
      config_json: data.config_json || null,
      node: data.node || null,
      checkpoint_path: data.checkpoint_path || null,
      status: data.status || 'training',
      total_folds: data.total_folds || null,
      notes: data.notes || null,
    });
    return { id: result.lastInsertRowid, ...data };
  }

  listModels(status = null, limit = 50) {
    if (status) {
      return this.db.prepare('SELECT * FROM models WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, limit);
    }
    return this.db.prepare('SELECT * FROM models ORDER BY updated_at DESC LIMIT ?').all(limit);
  }

  getModel(id) {
    return this.db.prepare('SELECT * FROM models WHERE id = ?').get(id);
  }

  updateModel(id, fields) {
    const allowed = ['name', 'status', 'completed_folds', 'latest_ic', 'mean_ic', 'best_ic', 'params_count', 'architecture', 'total_folds', 'window_mode', 'notes', 'checkpoint_path', 'node', 'config_json'];
    const sets = [];
    const values = {};
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) {
        sets.push(`${k} = @${k}`);
        values[k] = v;
      }
    }
    if (sets.length === 0) return null;
    sets.push("updated_at = datetime('now')");
    values.id = id;
    return this.db.prepare(`UPDATE models SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }

  // ========================
  // FOLDS
  // ========================

  addFold(data) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO folds (model_id, fold_idx, test_date, ic, train_loss, val_loss,
        train_days, train_samples, test_samples, duration_sec, gpu_used, metrics_json)
      VALUES (@model_id, @fold_idx, @test_date, @ic, @train_loss, @val_loss,
        @train_days, @train_samples, @test_samples, @duration_sec, @gpu_used, @metrics_json)
    `);
    return stmt.run({
      model_id: data.model_id,
      fold_idx: data.fold_idx,
      test_date: data.test_date || null,
      ic: data.ic || null,
      train_loss: data.train_loss || null,
      val_loss: data.val_loss || null,
      train_days: data.train_days || null,
      train_samples: data.train_samples || null,
      test_samples: data.test_samples || null,
      duration_sec: data.duration_sec || null,
      gpu_used: data.gpu_used || null,
      metrics_json: data.metrics_json || null,
    });
  }

  getModelFolds(modelId, limit = 200) {
    return this.db.prepare('SELECT * FROM folds WHERE model_id = ? ORDER BY fold_idx LIMIT ?').all(modelId, limit);
  }

  // ========================
  // CARDS
  // ========================

  listCards(status = null) {
    if (status) {
      return this.db.prepare('SELECT * FROM cards WHERE status = ? ORDER BY name').all(status);
    }
    return this.db.prepare('SELECT * FROM cards ORDER BY name').all();
  }

  getCard(name) {
    return this.db.prepare('SELECT * FROM cards WHERE name = ?').get(name);
  }

  createCard(data) {
    const stmt = this.db.prepare(`
      INSERT INTO cards (name, model_variant, conviction_threshold, vol_percentile_gate, tp_ticks,
        sl_ticks, hold_ms, mae_exit_ticks, mae_exit_hold_sec, chase_entry, chase_max_ticks,
        chase_max_reprices, ratchet_thresholds_json, backtest_sharpe, backtest_trades,
        backtest_win_rate, backtest_notes, status, deployed_model_id)
      VALUES (@name, @model_variant, @conviction_threshold, @vol_percentile_gate, @tp_ticks,
        @sl_ticks, @hold_ms, @mae_exit_ticks, @mae_exit_hold_sec, @chase_entry, @chase_max_ticks,
        @chase_max_reprices, @ratchet_thresholds_json, @backtest_sharpe, @backtest_trades,
        @backtest_win_rate, @backtest_notes, @status, @deployed_model_id)
    `);
    const result = stmt.run({
      name: data.name,
      model_variant: data.model_variant,
      conviction_threshold: data.conviction_threshold,
      vol_percentile_gate: data.vol_percentile_gate,
      tp_ticks: data.tp_ticks,
      sl_ticks: data.sl_ticks || 0,
      hold_ms: data.hold_ms || 7200000,
      mae_exit_ticks: data.mae_exit_ticks || 10,
      mae_exit_hold_sec: data.mae_exit_hold_sec || 600,
      chase_entry: data.chase_entry || 0,
      chase_max_ticks: data.chase_max_ticks || 0,
      chase_max_reprices: data.chase_max_reprices || 0,
      ratchet_thresholds_json: data.ratchet_thresholds_json || null,
      backtest_sharpe: data.backtest_sharpe || null,
      backtest_trades: data.backtest_trades || null,
      backtest_win_rate: data.backtest_win_rate || null,
      backtest_notes: data.backtest_notes || null,
      status: data.status || 'testing',
      deployed_model_id: data.deployed_model_id || null,
    });
    return { id: result.lastInsertRowid };
  }

  updateCard(name, fields) {
    const allowed = ['status', 'backtest_sharpe', 'backtest_trades', 'backtest_win_rate', 'backtest_notes', 'deployed_model_id', 'tp_ticks', 'sl_ticks', 'hold_ms', 'mae_exit_ticks', 'mae_exit_hold_sec', 'chase_entry', 'chase_max_ticks', 'chase_max_reprices', 'ratchet_thresholds_json'];
    const sets = [];
    const values = {};
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) {
        sets.push(`${k} = @${k}`);
        values[k] = v;
      }
    }
    if (sets.length === 0) return null;
    sets.push("updated_at = datetime('now')");
    values.name = name;
    return this.db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE name = @name`).run(values);
  }

  // ========================
  // TRAINING JOBS
  // ========================

  createTrainingJob(data) {
    const stmt = this.db.prepare(`
      INSERT INTO training_jobs (model_id, node, job_type, description, config_json, pid, tmux_session,
        start_fold, current_fold, total_folds, status, eta_minutes)
      VALUES (@model_id, @node, @job_type, @description, @config_json, @pid, @tmux_session,
        @start_fold, @current_fold, @total_folds, @status, @eta_minutes)
    `);
    const result = stmt.run({
      model_id: data.model_id || null,
      node: data.node,
      job_type: data.job_type,
      description: data.description || null,
      config_json: data.config_json || null,
      pid: data.pid || null,
      tmux_session: data.tmux_session || null,
      start_fold: data.start_fold || null,
      current_fold: data.current_fold || null,
      total_folds: data.total_folds || null,
      status: data.status || 'running',
      eta_minutes: data.eta_minutes || null,
    });
    return { id: result.lastInsertRowid };
  }

  listTrainingJobs(status = null, node = null) {
    let sql = 'SELECT * FROM training_jobs WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (node) { sql += ' AND node = ?'; params.push(node); }
    sql += ' ORDER BY started_at DESC LIMIT 50';
    return this.db.prepare(sql).all(...params);
  }

  updateTrainingJob(id, fields) {
    const allowed = ['status', 'current_fold', 'progress_pct', 'eta_minutes', 'result_json', 'error_msg', 'completed_at', 'pid', 'tmux_session'];
    const sets = [];
    const values = {};
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) {
        sets.push(`${k} = @${k}`);
        values[k] = v;
      }
    }
    if (sets.length === 0) return null;
    sets.push("last_heartbeat = datetime('now')");
    values.id = id;
    return this.db.prepare(`UPDATE training_jobs SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }

  // ========================
  // DATA FILES
  // ========================

  addDataFile(data) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO data_files (node, date, file_type, filename, path, size_bytes, row_count, checksum)
      VALUES (@node, @date, @file_type, @filename, @path, @size_bytes, @row_count, @checksum)
    `);
    return stmt.run({
      node: data.node,
      date: data.date || null,
      file_type: data.file_type,
      filename: data.filename,
      path: data.path,
      size_bytes: data.size_bytes || null,
      row_count: data.row_count || null,
      checksum: data.checksum || null,
    });
  }

  listDataFiles(node = null, fileType = null, date = null) {
    let sql = 'SELECT * FROM data_files WHERE 1=1';
    const params = [];
    if (node) { sql += ' AND node = ?'; params.push(node); }
    if (fileType) { sql += ' AND file_type = ?'; params.push(fileType); }
    if (date) { sql += ' AND date = ?'; params.push(date); }
    sql += ' ORDER BY date DESC, node LIMIT 200';
    return this.db.prepare(sql).all(...params);
  }

  // ========================
  // RESEARCH PROJECTS
  // ========================

  listResearch(status = null) {
    if (status) {
      return this.db.prepare('SELECT * FROM research_projects WHERE status = ? ORDER BY priority, name').all(status);
    }
    return this.db.prepare('SELECT * FROM research_projects ORDER BY priority, name').all();
  }

  createResearch(data) {
    const stmt = this.db.prepare(`
      INSERT INTO research_projects (name, hypothesis, status, priority, related_model_ids, findings, next_steps, tags)
      VALUES (@name, @hypothesis, @status, @priority, @related_model_ids, @findings, @next_steps, @tags)
    `);
    const result = stmt.run({
      name: data.name,
      hypothesis: data.hypothesis || null,
      status: data.status || 'proposed',
      priority: data.priority || 3,
      related_model_ids: data.related_model_ids || null,
      findings: data.findings || null,
      next_steps: data.next_steps || null,
      tags: data.tags || null,
    });
    return { id: result.lastInsertRowid };
  }

  updateResearch(id, fields) {
    const allowed = ['name', 'hypothesis', 'status', 'priority', 'related_model_ids', 'findings', 'next_steps', 'tags'];
    const sets = [];
    const values = {};
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) {
        sets.push(`${k} = @${k}`);
        values[k] = v;
      }
    }
    if (sets.length === 0) return null;
    sets.push("updated_at = datetime('now')");
    values.id = id;
    return this.db.prepare(`UPDATE research_projects SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }

  // ========================
  // RESEARCH EXPERIMENTS
  // ========================

  createExperiment(data) {
    const stmt = this.db.prepare(`
      INSERT INTO research_experiments
        (project_id, stage, hypothesis, config_json, horizon_bars, train_days, oot_days,
         model_type, ic, ic_std, ic_ci_low, ic_ci_high, train_loss, val_loss,
         overfit_ratio, param_count, n_folds, positive_fold_pct,
         feature_importance_json, elapsed_seconds, node, verdict, notes, result_json)
      VALUES (@project_id, @stage, @hypothesis, @config_json, @horizon_bars, @train_days, @oot_days,
              @model_type, @ic, @ic_std, @ic_ci_low, @ic_ci_high, @train_loss, @val_loss,
              @overfit_ratio, @param_count, @n_folds, @positive_fold_pct,
              @feature_importance_json, @elapsed_seconds, @node, @verdict, @notes, @result_json)
    `);
    const result = stmt.run({
      project_id: data.project_id || null,
      stage: data.stage,
      hypothesis: data.hypothesis || null,
      config_json: typeof data.config === 'object' ? JSON.stringify(data.config) : (data.config_json || '{}'),
      horizon_bars: data.horizon_bars || null,
      train_days: data.train_days || null,
      oot_days: data.oot_days || null,
      model_type: data.model_type || null,
      ic: data.ic ?? null,
      ic_std: data.ic_std ?? null,
      ic_ci_low: data.ic_ci_low ?? null,
      ic_ci_high: data.ic_ci_high ?? null,
      train_loss: data.train_loss ?? null,
      val_loss: data.val_loss ?? null,
      overfit_ratio: data.overfit_ratio ?? null,
      param_count: data.param_count ?? null,
      n_folds: data.n_folds ?? null,
      positive_fold_pct: data.positive_fold_pct ?? null,
      feature_importance_json: data.feature_importance_json || null,
      elapsed_seconds: data.elapsed_seconds ?? null,
      node: data.node || null,
      verdict: data.verdict || 'pending',
      notes: data.notes || null,
      result_json: data.result_json || null,
    });
    return { id: result.lastInsertRowid };
  }

  listExperiments(stage = null, limit = 50) {
    if (stage) {
      return this.db.prepare(
        'SELECT * FROM research_experiments WHERE stage = ? ORDER BY created_at DESC LIMIT ?'
      ).all(stage, limit);
    }
    return this.db.prepare(
      'SELECT * FROM research_experiments ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  }

  getExperimentLeaderboard(stage = null, horizon = null) {
    let sql = 'SELECT * FROM research_experiments WHERE ic IS NOT NULL';
    const params = [];
    if (stage) { sql += ' AND stage = ?'; params.push(stage); }
    if (horizon) { sql += ' AND horizon_bars = ?'; params.push(horizon); }
    sql += ' ORDER BY ic DESC LIMIT 50';
    return this.db.prepare(sql).all(...params);
  }

  // ========================
  // DIRECTORIES
  // ========================

  describeDir(data) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO directories (node, path, purpose, contents_description, important_files, last_verified)
      VALUES (@node, @path, @purpose, @contents_description, @important_files, datetime('now'))
    `);
    return stmt.run({
      node: data.node,
      path: data.path,
      purpose: data.purpose || null,
      contents_description: data.contents_description || null,
      important_files: data.important_files || null,
    });
  }

  listDirs(node = null) {
    if (node) {
      return this.db.prepare('SELECT * FROM directories WHERE node = ? ORDER BY path').all(node);
    }
    return this.db.prepare('SELECT * FROM directories ORDER BY node, path').all();
  }

  // ========================
  // SYNC TASKS
  // ========================

  createSyncTask(data) {
    const stmt = this.db.prepare(`
      INSERT INTO sync_tasks (source_node, dest_node, file_type, file_pattern, status)
      VALUES (@source_node, @dest_node, @file_type, @file_pattern, 'pending')
    `);
    const result = stmt.run({
      source_node: data.source_node,
      dest_node: data.dest_node,
      file_type: data.file_type || null,
      file_pattern: data.file_pattern || null,
    });
    return { id: result.lastInsertRowid };
  }

  // ========================
  // ALERTS
  // ========================

  sendAlert(severity, source, message, node = null) {
    const stmt = this.db.prepare(`
      INSERT INTO alerts (severity, source, node, message)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(severity, source, node, message);
    return { id: result.lastInsertRowid };
  }

  listAlerts(resolved = null, limit = 50) {
    if (resolved !== null) {
      return this.db.prepare('SELECT * FROM alerts WHERE resolved = ? ORDER BY created_at DESC LIMIT ?').all(resolved ? 1 : 0, limit);
    }
    return this.db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  resolveAlert(id) {
    return this.db.prepare("UPDATE alerts SET resolved = 1, resolved_at = datetime('now') WHERE id = ?").run(id);
  }

  // ========================
  // SESSIONS
  // ========================

  startSession(sessionId, contextJson = null) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (session_id, context_json)
      VALUES (?, ?)
    `);
    stmt.run(sessionId, contextJson);

    // Return context for the new session
    const lastSession = this.db.prepare('SELECT * FROM sessions WHERE session_id != ? ORDER BY started_at DESC LIMIT 1').get(sessionId);
    const activeJobs = this.listTrainingJobs('running');
    const unresolvedAlerts = this.listAlerts(false, 20);
    const scheduledTasks = this.db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY name').all();

    return {
      previous_session: lastSession,
      active_jobs: activeJobs,
      unresolved_alerts: unresolvedAlerts,
      scheduled_tasks: scheduledTasks,
    };
  }

  endSession(sessionId, summary, tasksCompleted, tasksPending) {
    return this.db.prepare(`
      UPDATE sessions SET ended_at = datetime('now'), summary = ?, tasks_completed = ?, tasks_pending = ?
      WHERE session_id = ?
    `).run(summary, tasksCompleted, tasksPending, sessionId);
  }

  // ========================
  // ACTION LOG
  // ========================

  logAction(toolName, argsJson, resultSummary, sessionId = null) {
    this.db.prepare(`
      INSERT INTO action_log (tool_name, args_json, result_summary, session_id)
      VALUES (?, ?, ?, ?)
    `).run(toolName, argsJson, resultSummary, sessionId);
  }

  // ========================
  // SWEEPS
  // ========================

  listSweeps(status = null) {
    if (status) {
      return this.db.prepare('SELECT * FROM sweeps WHERE status = ? ORDER BY started_at DESC').all(status);
    }
    return this.db.prepare('SELECT * FROM sweeps ORDER BY started_at DESC LIMIT 50').all();
  }

  getSweepResults(sweepId, limit = 100) {
    return this.db.prepare('SELECT * FROM sweep_results WHERE sweep_id = ? ORDER BY sharpe DESC LIMIT ?').all(sweepId, limit);
  }

  createSweep(data) {
    const stmt = this.db.prepare(`
      INSERT INTO sweeps (name, description, sweep_type, config_json, total_configs, metric_name, node, notes)
      VALUES (@name, @description, @sweep_type, @config_json, @total_configs, @metric_name, @node, @notes)
    `);
    const result = stmt.run({
      name: data.name,
      description: data.description || null,
      sweep_type: data.sweep_type || 'manual',
      config_json: data.config_json || null,
      total_configs: data.total_configs || null,
      metric_name: data.metric_name || 'sharpe',
      node: data.node || null,
      notes: data.notes || null,
    });
    return { id: result.lastInsertRowid };
  }

  addSweepResult(data) {
    const stmt = this.db.prepare(`
      INSERT INTO sweep_results (sweep_id, config_json, sharpe, pnl, trades, win_rate, max_drawdown, avg_hold_sec, metrics_json)
      VALUES (@sweep_id, @config_json, @sharpe, @pnl, @trades, @win_rate, @max_drawdown, @avg_hold_sec, @metrics_json)
    `);
    return stmt.run({
      sweep_id: data.sweep_id,
      config_json: data.config_json,
      sharpe: data.sharpe || null,
      pnl: data.pnl || null,
      trades: data.trades || null,
      win_rate: data.win_rate || null,
      max_drawdown: data.max_drawdown || null,
      avg_hold_sec: data.avg_hold_sec || null,
      metrics_json: data.metrics_json || null,
    });
  }

  // ========================
  // SCHEDULED TASKS
  // ========================

  listScheduledTasks(enabled = null) {
    if (enabled !== null) {
      return this.db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = ? ORDER BY name').all(enabled ? 1 : 0);
    }
    return this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY name').all();
  }

  updateScheduledTask(name, fields) {
    const allowed = ['enabled', 'last_run', 'last_status', 'last_error', 'next_run', 'cron_expr', 'description'];
    const sets = [];
    const values = {};
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) {
        sets.push(`${k} = @${k}`);
        values[k] = v;
      }
    }
    if (sets.length === 0) return null;
    values.name = name;
    return this.db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE name = @name`).run(values);
  }

  // ========================
  // TRADE HISTORY
  // ========================

  addTrade(data) {
    const stmt = this.db.prepare(`
      INSERT INTO trade_history (card_name, session_date, side, entry_price, exit_price, entry_time, exit_time,
        pnl_dollars, pnl_ticks, hold_sec, mae_ticks, mfe_ticks, exit_reason, entry_zscore, exit_zscore,
        conviction, vol_percentile)
      VALUES (@card_name, @session_date, @side, @entry_price, @exit_price, @entry_time, @exit_time,
        @pnl_dollars, @pnl_ticks, @hold_sec, @mae_ticks, @mfe_ticks, @exit_reason, @entry_zscore,
        @exit_zscore, @conviction, @vol_percentile)
    `);
    const result = stmt.run({
      card_name: data.card_name,
      session_date: data.session_date,
      side: data.side || null,
      entry_price: data.entry_price || null,
      exit_price: data.exit_price || null,
      entry_time: data.entry_time || null,
      exit_time: data.exit_time || null,
      pnl_dollars: data.pnl_dollars || null,
      pnl_ticks: data.pnl_ticks || null,
      hold_sec: data.hold_sec || null,
      mae_ticks: data.mae_ticks || null,
      mfe_ticks: data.mfe_ticks || null,
      exit_reason: data.exit_reason || null,
      entry_zscore: data.entry_zscore || null,
      exit_zscore: data.exit_zscore || null,
      conviction: data.conviction || null,
      vol_percentile: data.vol_percentile || null,
    });
    return { id: result.lastInsertRowid };
  }

  listTrades(cardName = null, date = null, limit = 100) {
    let sql = 'SELECT * FROM trade_history WHERE 1=1';
    const params = [];
    if (cardName) { sql += ' AND card_name = ?'; params.push(cardName); }
    if (date) { sql += ' AND session_date = ?'; params.push(date); }
    sql += ' ORDER BY entry_time DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  // ========================
  // STRATEGY RESULTS
  // ========================

  insertStrategyResult(data) {
    const stmt = this.db.prepare(`
      INSERT INTO strategy_results
        (experiment_id, strategy_name, config_json, node, data_days, data_source,
         total_trades, win_rate, total_pnl, avg_win, avg_loss,
         sharpe, sortino, profit_factor, max_drawdown_pct,
         validated_fillsim, monte_carlo_passed)
      VALUES
        (@experiment_id, @strategy_name, @config_json, @node, @data_days, @data_source,
         @total_trades, @win_rate, @total_pnl, @avg_win, @avg_loss,
         @sharpe, @sortino, @profit_factor, @max_drawdown_pct,
         @validated_fillsim, @monte_carlo_passed)
    `);
    const result = stmt.run({
      experiment_id: data.experiment_id || null,
      strategy_name: data.strategy_name,
      config_json: data.config_json ? (typeof data.config_json === 'object' ? JSON.stringify(data.config_json) : data.config_json) : null,
      node: data.node || null,
      data_days: data.data_days ?? null,
      data_source: data.data_source || 'backtest',
      total_trades: data.total_trades ?? null,
      win_rate: data.win_rate ?? null,
      total_pnl: data.total_pnl ?? null,
      avg_win: data.avg_win ?? null,
      avg_loss: data.avg_loss ?? null,
      sharpe: data.sharpe ?? null,
      sortino: data.sortino ?? null,
      profit_factor: data.profit_factor ?? null,
      max_drawdown_pct: data.max_drawdown_pct ?? null,
      validated_fillsim: data.validated_fillsim ? 1 : 0,
      monte_carlo_passed: data.monte_carlo_passed ? 1 : 0,
    });
    return { id: Number(result.lastInsertRowid) };
  }

  getStrategyResults(filters = {}) {
    let sql = 'SELECT * FROM strategy_results WHERE 1=1';
    const params = [];
    if (filters.strategy_name) { sql += ' AND strategy_name = ?'; params.push(filters.strategy_name); }
    if (filters.data_source) { sql += ' AND data_source = ?'; params.push(filters.data_source); }
    if (filters.experiment_id) { sql += ' AND experiment_id = ?'; params.push(filters.experiment_id); }
    if (filters.validated_fillsim !== undefined) { sql += ' AND validated_fillsim = ?'; params.push(filters.validated_fillsim ? 1 : 0); }
    if (filters.min_sharpe !== undefined) { sql += ' AND sharpe >= ?'; params.push(filters.min_sharpe); }
    sql += ' ORDER BY sharpe DESC NULLS LAST, created_at DESC';
    if (filters.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }
    else { sql += ' LIMIT 200'; }
    return this.db.prepare(sql).all(...params);
  }

  getBestStrategies(topN = 10, dataSource = null) {
    let sql = 'SELECT * FROM strategy_results WHERE sharpe IS NOT NULL';
    const params = [];
    if (dataSource) { sql += ' AND data_source = ?'; params.push(dataSource); }
    sql += ' ORDER BY sharpe DESC LIMIT ?';
    params.push(topN);
    return this.db.prepare(sql).all(...params);
  }

  // ========================
  // FILL SIM RESULTS
  // ========================

  insertFillsimResult(data) {
    const stmt = this.db.prepare(`
      INSERT INTO fillsim_results
        (experiment_id, config_name, mbo_date, signal_source,
         total_pnl, total_trades, total_filled, fill_rate,
         avg_queue_position, avg_fill_latency_ms,
         tp_count, sl_count, timeout_count,
         tp_ticks, sl_ticks, hold_ms, signal_threshold, trailing_ticks, time_decay_config)
      VALUES
        (@experiment_id, @config_name, @mbo_date, @signal_source,
         @total_pnl, @total_trades, @total_filled, @fill_rate,
         @avg_queue_position, @avg_fill_latency_ms,
         @tp_count, @sl_count, @timeout_count,
         @tp_ticks, @sl_ticks, @hold_ms, @signal_threshold, @trailing_ticks, @time_decay_config)
    `);
    const result = stmt.run({
      experiment_id: data.experiment_id || null,
      config_name: data.config_name,
      mbo_date: data.mbo_date,
      signal_source: data.signal_source || null,
      total_pnl: data.total_pnl ?? null,
      total_trades: data.total_trades ?? null,
      total_filled: data.total_filled ?? null,
      fill_rate: data.fill_rate ?? null,
      avg_queue_position: data.avg_queue_position ?? null,
      avg_fill_latency_ms: data.avg_fill_latency_ms ?? null,
      tp_count: data.tp_count ?? null,
      sl_count: data.sl_count ?? null,
      timeout_count: data.timeout_count ?? null,
      tp_ticks: data.tp_ticks ?? null,
      sl_ticks: data.sl_ticks ?? null,
      hold_ms: data.hold_ms ?? null,
      signal_threshold: data.signal_threshold ?? null,
      trailing_ticks: data.trailing_ticks ?? null,
      time_decay_config: data.time_decay_config ? (typeof data.time_decay_config === 'object' ? JSON.stringify(data.time_decay_config) : data.time_decay_config) : null,
    });
    return { id: Number(result.lastInsertRowid) };
  }

  getFillsimResults(configName, limit = 200) {
    return this.db.prepare(
      'SELECT * FROM fillsim_results WHERE config_name = ? ORDER BY mbo_date DESC LIMIT ?'
    ).all(configName, limit);
  }

  getFillsimSummary(configName) {
    // Aggregate across all dates for a given config
    return this.db.prepare(`
      SELECT
        config_name,
        COUNT(*) as run_count,
        COUNT(DISTINCT mbo_date) as date_count,
        SUM(total_pnl) as cumulative_pnl,
        AVG(total_pnl) as avg_daily_pnl,
        AVG(fill_rate) as avg_fill_rate,
        AVG(avg_queue_position) as avg_queue_pos,
        SUM(total_trades) as total_trades,
        SUM(total_filled) as total_filled,
        SUM(tp_count) as total_tp,
        SUM(sl_count) as total_sl,
        SUM(timeout_count) as total_timeout
      FROM fillsim_results WHERE config_name = ?
    `).get(configName);
  }

  // ========================
  // EXPERIMENT METRICS (time-series)
  // ========================

  insertMetric(data) {
    const stmt = this.db.prepare(`
      INSERT INTO experiment_metrics
        (experiment_id, epoch, fold, train_loss, val_loss, ic,
         dir_accuracy, sortino, vram_gb, power_watts, epoch_time_sec)
      VALUES
        (@experiment_id, @epoch, @fold, @train_loss, @val_loss, @ic,
         @dir_accuracy, @sortino, @vram_gb, @power_watts, @epoch_time_sec)
    `);
    const result = stmt.run({
      experiment_id: data.experiment_id,
      epoch: data.epoch ?? null,
      fold: data.fold ?? null,
      train_loss: data.train_loss ?? null,
      val_loss: data.val_loss ?? null,
      ic: data.ic ?? null,
      dir_accuracy: data.dir_accuracy ?? null,
      sortino: data.sortino ?? null,
      vram_gb: data.vram_gb ?? null,
      power_watts: data.power_watts ?? null,
      epoch_time_sec: data.epoch_time_sec ?? null,
    });
    return { id: Number(result.lastInsertRowid) };
  }

  getExperimentMetrics(experimentId, fold = null) {
    if (fold !== null) {
      return this.db.prepare(
        'SELECT * FROM experiment_metrics WHERE experiment_id = ? AND fold = ? ORDER BY epoch, recorded_at'
      ).all(experimentId, fold);
    }
    return this.db.prepare(
      'SELECT * FROM experiment_metrics WHERE experiment_id = ? ORDER BY fold, epoch, recorded_at'
    ).all(experimentId);
  }

  getLatestMetric(experimentId) {
    return this.db.prepare(
      'SELECT * FROM experiment_metrics WHERE experiment_id = ? ORDER BY recorded_at DESC LIMIT 1'
    ).get(experimentId) || null;
  }

  // ========================
  // RESEARCH DECISIONS (audit log)
  // ========================

  logDecision(decision, rationale, evidence = null, category = null) {
    const stmt = this.db.prepare(`
      INSERT INTO research_decisions (decision, rationale, evidence_json, category)
      VALUES (@decision, @rationale, @evidence_json, @category)
    `);
    const result = stmt.run({
      decision,
      rationale: rationale || null,
      evidence_json: evidence ? (typeof evidence === 'object' ? JSON.stringify(evidence) : evidence) : null,
      category: category || null,
    });
    return { id: Number(result.lastInsertRowid) };
  }

  updateDecisionOutcome(id, outcome) {
    return this.db.prepare(
      'UPDATE research_decisions SET outcome = ? WHERE id = ?'
    ).run(outcome, id);
  }

  listDecisions(category = null, limit = 100) {
    if (category) {
      return this.db.prepare(
        'SELECT * FROM research_decisions WHERE category = ? ORDER BY created_at DESC LIMIT ?'
      ).all(category, limit);
    }
    return this.db.prepare(
      'SELECT * FROM research_decisions ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  }

  // ========================
  // HEALTH CHECK (aggregated)
  // ========================

  healthCheck() {
    const nodes = this.getNodes();
    const activeJobs = this.listTrainingJobs('running');
    const unresolvedAlerts = this.listAlerts(false, 20);
    const scheduledTasks = this.listScheduledTasks(true);
    const recentTrades = this.listTrades(null, null, 10);

    // Stale job detection: jobs with last_heartbeat > 30 min ago
    const staleJobs = this.db.prepare(`
      SELECT * FROM training_jobs
      WHERE status = 'running'
        AND last_heartbeat < datetime('now', '-30 minutes')
    `).all();

    return {
      nodes,
      active_jobs: activeJobs,
      stale_jobs: staleJobs,
      unresolved_alerts: unresolvedAlerts,
      scheduled_tasks: scheduledTasks,
      recent_trades: recentTrades,
    };
  }

  // ========================
  // MIGRATION (run arbitrary SQL)
  // ========================

  migrate(sql) {
    return this.db.exec(sql);
  }

  // ========================
  // MODEL COMPARE
  // ========================

  compareModels(ids) {
    const models = [];
    for (const id of ids) {
      const model = this.getModel(id);
      if (model) {
        const folds = this.getModelFolds(id);
        const icValues = folds.filter(f => f.ic !== null).map(f => f.ic);
        const meanIc = icValues.length > 0 ? icValues.reduce((a, b) => a + b, 0) / icValues.length : null;
        const stdIc = icValues.length > 1 ? Math.sqrt(icValues.map(x => Math.pow(x - meanIc, 2)).reduce((a, b) => a + b, 0) / (icValues.length - 1)) : null;
        models.push({
          ...model,
          fold_count: folds.length,
          mean_ic: meanIc,
          std_ic: stdIc,
          min_ic: icValues.length > 0 ? Math.min(...icValues) : null,
          max_ic: icValues.length > 0 ? Math.max(...icValues) : null,
        });
      }
    }
    return models;
  }

  // ========================
  // DEPLOY MODEL
  // ========================

  deployModel(modelId, cardName) {
    this.db.prepare("UPDATE models SET status = 'deployed', updated_at = datetime('now') WHERE id = ?").run(modelId);
    if (cardName) {
      this.db.prepare("UPDATE cards SET deployed_model_id = ?, updated_at = datetime('now') WHERE name = ?").run(modelId, cardName);
    }
    return { model_id: modelId, card: cardName, status: 'deployed' };
  }

  // ========================
  // TRAINING CONFIGS
  // ========================

  getTrainingConfig(configName) {
    return this.db.prepare('SELECT * FROM training_configs WHERE config_name = ?').get(configName);
  }

  listTrainingConfigs() {
    return this.db.prepare('SELECT * FROM training_configs ORDER BY config_name').all();
  }

  // ========================
  // CARD-MODEL BINDINGS
  // ========================

  getCardBinding(cardId) {
    const binding = this.db.prepare(`
      SELECT cmb.*, tc.config_name, tc.model_type, tc.horizon_bars, tc.normalization,
             dm.manifest_name, dm.oot_start_date, dm.oot_end_date
      FROM card_model_bindings cmb
      LEFT JOIN training_configs tc ON cmb.config_id = tc.id
      LEFT JOIN data_manifests dm ON cmb.manifest_id = dm.id
      WHERE cmb.card_id = ?
    `).get(cardId);
    return binding || null;
  }

  listCardBindings(deployedOnly = false) {
    let sql = `
      SELECT cmb.*, tc.config_name, tc.model_type, dm.manifest_name
      FROM card_model_bindings cmb
      LEFT JOIN training_configs tc ON cmb.config_id = tc.id
      LEFT JOIN data_manifests dm ON cmb.manifest_id = dm.id
    `;
    if (deployedOnly) sql += ' WHERE cmb.deployed = 1';
    sql += ' ORDER BY cmb.card_id';
    return this.db.prepare(sql).all();
  }

  // ========================
  // FOLD RESULTS (new table)
  // ========================

  getFoldResults(trainingJobId) {
    return this.db.prepare(`
      SELECT fr.*, tc.config_name, dm.manifest_name
      FROM fold_results fr
      LEFT JOIN training_configs tc ON fr.config_id = tc.id
      LEFT JOIN data_manifests dm ON fr.manifest_id = dm.id
      WHERE fr.training_job_id = ?
      ORDER BY fr.fold_number
    `).all(trainingJobId);
  }

  getFoldResultsByConfig(configId, limit = 200) {
    return this.db.prepare(`
      SELECT * FROM fold_results
      WHERE config_id = ?
      ORDER BY fold_number
      LIMIT ?
    `).all(configId, limit);
  }

  getFoldResultsByNode(nodeName, limit = 200) {
    return this.db.prepare(`
      SELECT fr.*, tc.config_name
      FROM fold_results fr
      LEFT JOIN training_configs tc ON fr.config_id = tc.id
      WHERE fr.node_name = ?
      ORDER BY fr.completed_at DESC
      LIMIT ?
    `).all(nodeName, limit);
  }

  recordFoldResult(data) {
    const stmt = this.db.prepare(`
      INSERT INTO fold_results
        (training_job_id, config_id, manifest_id, fold_number, train_dates, val_dates,
         test_date, ic, train_loss, val_loss, train_ic, overfitting_ratio,
         prediction_file, duration_seconds, gpu_used, node_name, status, completed_at)
      VALUES
        (@training_job_id, @config_id, @manifest_id, @fold_number, @train_dates, @val_dates,
         @test_date, @ic, @train_loss, @val_loss, @train_ic, @overfitting_ratio,
         @prediction_file, @duration_seconds, @gpu_used, @node_name, @status, @completed_at)
    `);
    const result = stmt.run({
      training_job_id: data.training_job_id || null,
      config_id: data.config_id || null,
      manifest_id: data.manifest_id || null,
      fold_number: data.fold_number,
      train_dates: data.train_dates || null,
      val_dates: data.val_dates || null,
      test_date: data.test_date || null,
      ic: data.ic !== undefined ? data.ic : null,
      train_loss: data.train_loss !== undefined ? data.train_loss : null,
      val_loss: data.val_loss !== undefined ? data.val_loss : null,
      train_ic: data.train_ic !== undefined ? data.train_ic : null,
      overfitting_ratio: data.overfitting_ratio !== undefined ? data.overfitting_ratio : null,
      prediction_file: data.prediction_file || null,
      duration_seconds: data.duration_seconds !== undefined ? data.duration_seconds : null,
      gpu_used: data.gpu_used || null,
      node_name: data.node_name || null,
      status: data.status || 'completed',
      completed_at: data.completed_at || null,
    });
    return { id: result.lastInsertRowid };
  }

  // ========================
  // DEPLOYMENT CHECKS
  // ========================

  checkDeploymentReady(cardId) {
    const checks = this.db.prepare(`
      SELECT * FROM deployment_checks WHERE card_id = ? ORDER BY checked_at DESC
    `).all(cardId);

    if (checks.length === 0) {
      return { ready: false, reason: 'No deployment checks recorded', checks: [] };
    }

    const ootCheck = checks.find(c => c.check_type === 'oot_validation' && c.passed);
    const dataCheck = checks.find(c => c.check_type === 'data_alignment' && c.passed);
    const failures = checks.filter(c => !c.passed);

    const ready = !!ootCheck && !!dataCheck && failures.length === 0;

    let reason = '';
    if (!ootCheck) reason += 'Missing OOT validation. ';
    if (!dataCheck) reason += 'Missing data alignment check. ';
    if (failures.length > 0) {
      reason += `${failures.length} failed check(s): ${failures.map(f => f.check_type).join(', ')}. `;
    }

    return {
      ready,
      reason: ready ? 'All checks passed' : reason.trim(),
      checks,
    };
  }

  addDeploymentCheck(data) {
    const stmt = this.db.prepare(`
      INSERT INTO deployment_checks (card_id, check_type, passed, details)
      VALUES (@card_id, @check_type, @passed, @details)
    `);
    const result = stmt.run({
      card_id: data.card_id,
      check_type: data.check_type,
      passed: data.passed ? 1 : 0,
      details: data.details || null,
    });
    return { id: result.lastInsertRowid };
  }

  // ========================
  // DATA MANIFESTS
  // ========================

  getDataManifest(manifestName) {
    return this.db.prepare('SELECT * FROM data_manifests WHERE manifest_name = ?').get(manifestName);
  }

  listDataManifests() {
    return this.db.prepare('SELECT * FROM data_manifests ORDER BY created_at DESC').all();
  }

  // ========================
  // DATA PIPELINES
  // ========================

  getPipelineStatus(date) {
    return this.db.prepare(
      'SELECT * FROM data_pipelines WHERE date = ? ORDER BY CASE stage WHEN \'mbo_raw\' THEN 1 WHEN \'tensor_cache\' THEN 2 WHEN \'predictions\' THEN 3 WHEN \'validated\' THEN 4 ELSE 5 END'
    ).all(date);
  }

  updatePipelineStage(date, stage, status, outputPath = null, fileHash = null) {
    const existing = this.db.prepare(
      'SELECT id FROM data_pipelines WHERE date = ? AND stage = ?'
    ).get(date, stage);

    if (existing) {
      const sets = ['status = @status', "created_at = created_at"];
      const values = { id: existing.id, status };
      if (outputPath !== null) { sets.push('output_path = @output_path'); values.output_path = outputPath; }
      if (fileHash !== null) { sets.push('file_hash = @file_hash'); values.file_hash = fileHash; }
      if (status === 'running') { sets.push("started_at = datetime('now')"); }
      if (status === 'completed' || status === 'failed') { sets.push("completed_at = datetime('now')"); }
      return this.db.prepare(`UPDATE data_pipelines SET ${sets.join(', ')} WHERE id = @id`).run(values);
    } else {
      const startedAt = status === 'running' ? new Date().toISOString() : null;
      const completedAt = (status === 'completed' || status === 'failed') ? new Date().toISOString() : null;
      const stmt = this.db.prepare(`
        INSERT INTO data_pipelines (date, stage, status, output_path, file_hash, started_at, completed_at)
        VALUES (@date, @stage, @status, @output_path, @file_hash, @started_at, @completed_at)
      `);
      const result = stmt.run({
        date, stage, status,
        output_path: outputPath,
        file_hash: fileHash,
        started_at: startedAt,
        completed_at: completedAt,
      });
      return { id: result.lastInsertRowid };
    }
  }

  getIncompleteStages(stage = null) {
    if (stage) {
      // Find dates that have the PREVIOUS stage completed but not this stage
      const prevStageMap = { tensor_cache: 'mbo_raw', predictions: 'tensor_cache', validated: 'predictions' };
      const prevStage = prevStageMap[stage];
      if (!prevStage) {
        // For mbo_raw, return all dates where mbo_raw is not completed
        return this.db.prepare(`
          SELECT date FROM data_pipelines WHERE stage = 'mbo_raw' AND status != 'completed'
          ORDER BY date DESC
        `).all();
      }
      // Dates where prev stage is completed but this stage is missing or not completed
      return this.db.prepare(`
        SELECT prev.date FROM data_pipelines prev
        LEFT JOIN data_pipelines cur ON prev.date = cur.date AND cur.stage = ?
        WHERE prev.stage = ? AND prev.status = 'completed'
          AND (cur.id IS NULL OR cur.status NOT IN ('completed', 'running'))
        ORDER BY prev.date DESC
      `).all(stage, prevStage);
    }
    // Return all pipeline entries that are not completed
    return this.db.prepare(`
      SELECT * FROM data_pipelines WHERE status NOT IN ('completed')
      ORDER BY date DESC, stage
    `).all();
  }

  getPipelineOverview(limit = 60) {
    // Get all unique dates and their stage completion status
    const dates = this.db.prepare(`
      SELECT DISTINCT date FROM data_pipelines ORDER BY date DESC LIMIT ?
    `).all(limit);

    const stages = ['mbo_raw', 'tensor_cache', 'predictions', 'validated'];
    const overview = [];

    for (const { date } of dates) {
      const pipelineRow = { date };
      const stageRows = this.getPipelineStatus(date);
      for (const s of stages) {
        const found = stageRows.find(r => r.stage === s);
        pipelineRow[s] = found ? found.status : 'missing';
      }
      // Calculate overall completion
      const completedCount = stages.filter(s => pipelineRow[s] === 'completed').length;
      pipelineRow.completion = `${completedCount}/${stages.length}`;
      pipelineRow.fully_complete = completedCount === stages.length;
      overview.push(pipelineRow);
    }

    return overview;
  }

  linkPipelineJob(date, stage, jobId) {
    return this.db.prepare(`
      UPDATE data_pipelines SET job_id = ? WHERE date = ? AND stage = ?
    `).run(jobId, date, stage);
  }

  // ========================
  // JOB QUEUE
  // ========================

  enqueueJob(data) {
    const stmt = this.db.prepare(`
      INSERT INTO job_queue (job_type, job_name, node_name, requires_gpu, command, working_dir,
        config_json, priority, depends_on, chain_next, created_by)
      VALUES (@job_type, @job_name, @node_name, @requires_gpu, @command, @working_dir,
        @config_json, @priority, @depends_on, @chain_next, @created_by)
    `);
    const result = stmt.run({
      job_type: data.job_type || 'custom',
      job_name: data.job_name,
      node_name: data.node_name || null,
      requires_gpu: data.requires_gpu ? 1 : 0,
      command: data.command,
      working_dir: data.working_dir || null,
      config_json: data.config_json ? (typeof data.config_json === 'string' ? data.config_json : JSON.stringify(data.config_json)) : null,
      priority: data.priority || 5,
      depends_on: data.depends_on || null,
      chain_next: data.chain_next ? (typeof data.chain_next === 'string' ? data.chain_next : JSON.stringify(data.chain_next)) : null,
      created_by: data.created_by || 'claude',
    });
    return { id: result.lastInsertRowid };
  }

  getNextJob(nodeName = null) {
    // Find highest priority queued job for this node (or unassigned)
    // Must not have unfinished dependencies
    let sql = `
      SELECT jq.* FROM job_queue jq
      LEFT JOIN job_queue dep ON jq.depends_on = dep.id
      WHERE jq.status = 'queued'
        AND (jq.depends_on IS NULL OR dep.status = 'completed')
    `;
    const params = [];
    if (nodeName) {
      sql += ` AND (jq.node_name = ? OR jq.node_name IS NULL)`;
      params.push(nodeName);
    }
    sql += ` ORDER BY jq.priority ASC, jq.created_at ASC LIMIT 1`;
    return this.db.prepare(sql).get(...params) || null;
  }

  claimJob(jobId, nodeName) {
    return this.db.prepare(`
      UPDATE job_queue SET status = 'assigned', node_name = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'queued'
    `).run(nodeName, jobId);
  }

  startJob(jobId, pid) {
    return this.db.prepare(`
      UPDATE job_queue SET status = 'running', pid = ?, started_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(pid, jobId);
  }

  completeJob(jobId, exitCode, resultJson = null, outputTail = null) {
    const now = new Date().toISOString();
    this.releaseResource(jobId);
    const job = this.db.prepare('SELECT started_at FROM job_queue WHERE id = ?').get(jobId);
    let durationSec = null;
    if (job && job.started_at) {
      durationSec = (new Date(now).getTime() - new Date(job.started_at).getTime()) / 1000;
    }
    return this.db.prepare(`
      UPDATE job_queue SET
        status = 'completed', exit_code = ?, result_json = ?, output_tail = ?,
        completed_at = ?, duration_sec = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(exitCode, resultJson, outputTail, now, durationSec, jobId);
  }

  failJob(jobId, exitCode, errorTail = null) {
    const now = new Date().toISOString();
    const job = this.db.prepare('SELECT started_at FROM job_queue WHERE id = ?').get(jobId);
    this.releaseResource(jobId);
    let durationSec = null;
    if (job && job.started_at) {
      durationSec = (new Date(now).getTime() - new Date(job.started_at).getTime()) / 1000;
    }
    return this.db.prepare(`
      UPDATE job_queue SET
        status = 'failed', exit_code = ?, error_tail = ?,
        completed_at = ?, duration_sec = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(exitCode, errorTail, now, durationSec, jobId);
  }

  getJobStatus(jobId) {
    return this.db.prepare('SELECT * FROM job_queue WHERE id = ?').get(jobId) || null;
  }

  listJobs(status = null, nodeName = null, limit = 50) {
    let sql = 'SELECT * FROM job_queue WHERE 1=1';
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (nodeName) { sql += ' AND node_name = ?'; params.push(nodeName); }
    sql += ' ORDER BY CASE WHEN status = \'running\' THEN 0 WHEN status = \'assigned\' THEN 1 WHEN status = \'queued\' THEN 2 ELSE 3 END, priority ASC, created_at DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  cancelJob(jobId) {
    this.releaseResource(jobId);
    return this.db.prepare(`
      UPDATE job_queue SET status = 'cancelled', updated_at = datetime('now')
      WHERE id = ? AND status IN ('queued', 'assigned')
    `).run(jobId);
  }

  getQueueDepth() {
    const rows = this.db.prepare(`
      SELECT
        COALESCE(node_name, '__unassigned__') AS node,
        COUNT(*) AS count
      FROM job_queue
      WHERE status = 'queued'
      GROUP BY node_name
    `).all();
    const result = {};
    for (const row of rows) {
      result[row.node] = row.count;
    }
    // Also add total
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM job_queue WHERE status = 'queued'`).get();
    result.__total__ = total.count;
    // Running counts
    const running = this.db.prepare(`
      SELECT COALESCE(node_name, '__unknown__') AS node, COUNT(*) AS count
      FROM job_queue WHERE status = 'running' GROUP BY node_name
    `).all();
    const runningMap = {};
    for (const row of running) {
      runningMap[row.node] = row.count;
    }
    return { queued: result, running: runningMap };
  }

  getRunningJobs() {
    return this.db.prepare(`SELECT * FROM job_queue WHERE status = 'running' ORDER BY started_at`).all();
  }

  // ========================
  // RESOURCE RESERVATIONS
  // ========================

  /**
   * Reserve a resource slot on a node for a job.
   * @param {string} nodeName
   * @param {string} resourceType - 'gpu' or 'cpu_slot'
   * @param {number} jobId
   * @returns {{ id: number }}
   */
  reserveResource(nodeName, resourceType, jobId) {
    const stmt = this.db.prepare(`
      INSERT INTO resource_reservations (node_name, resource_type, job_id)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(nodeName, resourceType, jobId);
    return { id: result.lastInsertRowid };
  }

  /**
   * Release all resource reservations for a job.
   * @param {number} jobId
   * @returns {{ released: number }}
   */
  releaseResource(jobId) {
    const result = this.db.prepare(`
      UPDATE resource_reservations SET released_at = datetime('now')
      WHERE job_id = ? AND released_at IS NULL
    `).run(jobId);
    return { released: result.changes };
  }

  /**
   * Get all active (unreleased) reservations for a node.
   * @param {string} nodeName
   * @returns {Array}
   */
  getActiveReservations(nodeName) {
    return this.db.prepare(`
      SELECT rr.*, jq.job_name, jq.status AS job_status
      FROM resource_reservations rr
      LEFT JOIN job_queue jq ON rr.job_id = jq.id
      WHERE rr.node_name = ? AND rr.released_at IS NULL
    `).all(nodeName);
  }

  /**
   * Check if a resource is available on a node.
   * GPU nodes: max 1 active GPU reservation.
   * CPU nodes: max N active cpu_slot reservations (default 3).
   * @param {string} nodeName
   * @param {string} resourceType - 'gpu' or 'cpu_slot'
   * @param {number} [maxSlots=3] - max concurrent slots for cpu_slot type
   * @returns {boolean}
   */
  isResourceAvailable(nodeName, resourceType, maxSlots = 3) {
    const count = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM resource_reservations
      WHERE node_name = ? AND resource_type = ? AND released_at IS NULL
    `).get(nodeName, resourceType);
    const limit = resourceType === 'gpu' ? 1 : maxSlots;
    return count.cnt < limit;
  }

  // ========================
  // NODE STATE HISTORY
  // ========================

  recordNodeState(data) {
    const stmt = this.db.prepare(`
      INSERT INTO node_state_history (node_name, timestamp, status, gpu_util, gpu_mem_mb, gpu_temp,
        cpu_load, ram_pct, disk_pct, active_processes, active_jobs)
      VALUES (@node_name, @timestamp, @status, @gpu_util, @gpu_mem_mb, @gpu_temp,
        @cpu_load, @ram_pct, @disk_pct, @active_processes, @active_jobs)
    `);
    const result = stmt.run({
      node_name: data.node_name,
      timestamp: data.timestamp || new Date().toISOString(),
      status: data.status || 'unknown',
      gpu_util: data.gpu_util !== undefined ? data.gpu_util : null,
      gpu_mem_mb: data.gpu_mem_mb !== undefined ? data.gpu_mem_mb : null,
      gpu_temp: data.gpu_temp !== undefined ? data.gpu_temp : null,
      cpu_load: data.cpu_load !== undefined ? data.cpu_load : null,
      ram_pct: data.ram_pct !== undefined ? data.ram_pct : null,
      disk_pct: data.disk_pct !== undefined ? data.disk_pct : null,
      active_processes: data.active_processes ? (typeof data.active_processes === 'string' ? data.active_processes : JSON.stringify(data.active_processes)) : null,
      active_jobs: data.active_jobs !== undefined ? data.active_jobs : null,
    });
    return { id: result.lastInsertRowid };
  }

  getNodeHistory(nodeName, hours = 24) {
    return this.db.prepare(`
      SELECT * FROM node_state_history
      WHERE node_name = ? AND timestamp >= datetime('now', '-' || ? || ' hours')
      ORDER BY timestamp DESC
    `).all(nodeName, hours);
  }

  getNodeUptime(nodeName, days = 7) {
    const rows = this.db.prepare(`
      SELECT status, timestamp FROM node_state_history
      WHERE node_name = ? AND timestamp >= datetime('now', '-' || ? || ' days')
      ORDER BY timestamp ASC
    `).all(nodeName, days);

    if (rows.length === 0) return { node: nodeName, days, total_snapshots: 0, online_snapshots: 0, uptime_pct: 0 };

    const onlineCount = rows.filter(r => r.status === 'online' || r.status === 'training' || r.status === 'idle').length;
    const uptimePct = rows.length > 0 ? (onlineCount / rows.length * 100) : 0;

    let maxOnlineStreak = 0, maxOfflineStreak = 0;
    let currentStreak = 0, currentType = null;
    for (const row of rows) {
      const isOnline = row.status === 'online' || row.status === 'training' || row.status === 'idle';
      if (isOnline === (currentType === 'online')) {
        currentStreak++;
      } else {
        if (currentType === 'online') maxOnlineStreak = Math.max(maxOnlineStreak, currentStreak);
        else if (currentType === 'offline') maxOfflineStreak = Math.max(maxOfflineStreak, currentStreak);
        currentStreak = 1;
        currentType = isOnline ? 'online' : 'offline';
      }
    }
    if (currentType === 'online') maxOnlineStreak = Math.max(maxOnlineStreak, currentStreak);
    else if (currentType === 'offline') maxOfflineStreak = Math.max(maxOfflineStreak, currentStreak);

    return {
      node: nodeName,
      days,
      total_snapshots: rows.length,
      online_snapshots: onlineCount,
      uptime_pct: Math.round(uptimePct * 100) / 100,
      max_online_streak: maxOnlineStreak,
      max_offline_streak: maxOfflineStreak,
      first_seen: rows[0].timestamp,
      last_seen: rows[rows.length - 1].timestamp,
    };
  }

  getGPUUtilHistory(nodeName, hours = 24) {
    return this.db.prepare(`
      SELECT timestamp, gpu_util, gpu_mem_mb, gpu_temp
      FROM node_state_history
      WHERE node_name = ? AND timestamp >= datetime('now', '-' || ? || ' hours')
        AND gpu_util IS NOT NULL
      ORDER BY timestamp ASC
    `).all(nodeName, hours);
  }

  pruneNodeHistory(daysToKeep = 7) {
    const result = this.db.prepare(`
      DELETE FROM node_state_history
      WHERE timestamp < datetime('now', '-' || ? || ' days')
    `).run(daysToKeep);
    return { deleted: result.changes, days_kept: daysToKeep };
  }

  getNodeGaps(nodeName) {
    const rows = this.db.prepare(`
      SELECT status, timestamp FROM node_state_history
      WHERE node_name = ?
      ORDER BY timestamp ASC
    `).all(nodeName);

    if (rows.length < 2) return { node: nodeName, gaps: [] };

    const gaps = [];
    let gapStart = null;

    for (let i = 0; i < rows.length; i++) {
      const isOffline = rows[i].status === 'offline' || rows[i].status === 'unknown';
      if (isOffline && gapStart === null) {
        gapStart = rows[i].timestamp;
      } else if (!isOffline && gapStart !== null) {
        const gapEnd = rows[i].timestamp;
        const durationMs = new Date(gapEnd).getTime() - new Date(gapStart).getTime();
        const durationMin = Math.round(durationMs / 60000);
        if (durationMin >= 2) {
          gaps.push({ start: gapStart, end: gapEnd, duration_min: durationMin });
        }
        gapStart = null;
      }
    }

    if (gapStart !== null) {
      const lastTs = rows[rows.length - 1].timestamp;
      const durationMs = new Date(lastTs).getTime() - new Date(gapStart).getTime();
      const durationMin = Math.round(durationMs / 60000);
      if (durationMin >= 2) {
        gaps.push({ start: gapStart, end: null, duration_min: durationMin, ongoing: true });
      }
    }

    return { node: nodeName, total_gaps: gaps.length, gaps };
  }

  // ========================
  // MODEL VERSIONING
  // ========================

  /**
   * Create a new model version. Auto-increments version number for the given model_name.
   */
  createModelVersion(data) {
    // Auto-assign next version number
    const latest = this.db.prepare(
      'SELECT MAX(version) as max_ver FROM model_versions WHERE model_name = ?'
    ).get(data.model_name);
    const nextVersion = (latest && latest.max_ver) ? latest.max_ver + 1 : 1;

    const stmt = this.db.prepare(`
      INSERT INTO model_versions
        (model_name, version, config_id, manifest_id,
         checkpoint_path, checkpoint_hash, prediction_dir, prediction_count,
         avg_ic, min_ic, max_ic, total_folds, oot_sharpe,
         status)
      VALUES
        (@model_name, @version, @config_id, @manifest_id,
         @checkpoint_path, @checkpoint_hash, @prediction_dir, @prediction_count,
         @avg_ic, @min_ic, @max_ic, @total_folds, @oot_sharpe,
         @status)
    `);
    const result = stmt.run({
      model_name: data.model_name,
      version: data.version || nextVersion,
      config_id: data.config_id || null,
      manifest_id: data.manifest_id || null,
      checkpoint_path: data.checkpoint_path || null,
      checkpoint_hash: data.checkpoint_hash || null,
      prediction_dir: data.prediction_dir || null,
      prediction_count: data.prediction_count || null,
      avg_ic: data.avg_ic !== undefined ? data.avg_ic : null,
      min_ic: data.min_ic !== undefined ? data.min_ic : null,
      max_ic: data.max_ic !== undefined ? data.max_ic : null,
      total_folds: data.total_folds || null,
      oot_sharpe: data.oot_sharpe !== undefined ? data.oot_sharpe : null,
      status: data.status || 'training',
    });
    return {
      id: result.lastInsertRowid,
      model_name: data.model_name,
      version: data.version || nextVersion,
    };
  }

  /**
   * Get a specific model version by name and version number.
   */
  getModelVersion(modelName, version) {
    return this.db.prepare(
      'SELECT * FROM model_versions WHERE model_name = ? AND version = ?'
    ).get(modelName, version) || null;
  }

  /**
   * Get the latest version of a model by name.
   */
  getLatestModelVersion(modelName) {
    return this.db.prepare(
      'SELECT * FROM model_versions WHERE model_name = ? ORDER BY version DESC LIMIT 1'
    ).get(modelName) || null;
  }

  /**
   * List all versions for a model, or all model versions if no name given.
   */
  listModelVersions(modelName = null, status = null) {
    let sql = 'SELECT * FROM model_versions WHERE 1=1';
    const params = [];
    if (modelName) { sql += ' AND model_name = ?'; params.push(modelName); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY model_name, version DESC';
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Promote a model version to 'validated' status.
   */
  promoteModel(versionId) {
    const mv = this.db.prepare('SELECT * FROM model_versions WHERE id = ?').get(versionId);
    if (!mv) return { error: 'Model version not found' };
    if (mv.status === 'deprecated') return { error: 'Cannot promote a deprecated model version' };
    if (mv.status === 'validated' || mv.status === 'deployed') {
      return { error: `Model version already ${mv.status}` };
    }

    this.db.prepare(`
      UPDATE model_versions SET status = 'validated', promoted_at = datetime('now')
      WHERE id = ?
    `).run(versionId);

    return {
      id: versionId,
      model_name: mv.model_name,
      version: mv.version,
      status: 'validated',
      promoted_at: new Date().toISOString(),
    };
  }

  /**
   * Deploy a model version. Refuses if there are unresolved invalidations.
   */
  deployModel_v2(versionId) {
    const mv = this.db.prepare('SELECT * FROM model_versions WHERE id = ?').get(versionId);
    if (!mv) return { error: 'Model version not found' };
    if (mv.status === 'deprecated') return { error: 'Cannot deploy a deprecated model version' };

    // Guard rail: check for unresolved invalidations
    const invalidations = this.db.prepare(
      'SELECT * FROM prediction_invalidations WHERE model_version_id = ? AND resolved = 0'
    ).all(versionId);

    if (invalidations.length > 0) {
      return {
        error: 'Cannot deploy: unresolved prediction invalidations exist',
        unresolved_invalidations: invalidations,
      };
    }

    // Check it's been validated first
    if (mv.status === 'training') {
      return { error: 'Cannot deploy a model version that has not been validated. Promote first.' };
    }

    this.db.prepare(`
      UPDATE model_versions SET status = 'deployed', deployed_at = datetime('now')
      WHERE id = ?
    `).run(versionId);

    return {
      id: versionId,
      model_name: mv.model_name,
      version: mv.version,
      status: 'deployed',
      deployed_at: new Date().toISOString(),
    };
  }

  /**
   * Deprecate a model version with a reason.
   */
  deprecateModel(versionId, reason) {
    const mv = this.db.prepare('SELECT * FROM model_versions WHERE id = ?').get(versionId);
    if (!mv) return { error: 'Model version not found' };

    this.db.prepare(`
      UPDATE model_versions
      SET status = 'deprecated', deprecated_at = datetime('now'), deprecated_reason = ?
      WHERE id = ?
    `).run(reason || 'No reason given', versionId);

    return {
      id: versionId,
      model_name: mv.model_name,
      version: mv.version,
      status: 'deprecated',
      deprecated_reason: reason || 'No reason given',
    };
  }

  /**
   * Update model version fields (for updating IC stats, fold counts, etc during training).
   */
  updateModelVersion(versionId, fields) {
    const allowed = [
      'checkpoint_path', 'checkpoint_hash', 'prediction_dir', 'prediction_count',
      'avg_ic', 'min_ic', 'max_ic', 'total_folds', 'oot_sharpe',
    ];
    const sets = [];
    const values = {};
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) {
        sets.push(`${k} = @${k}`);
        values[k] = v;
      }
    }
    if (sets.length === 0) return null;
    values.id = versionId;
    return this.db.prepare(`UPDATE model_versions SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }

  // ========================
  // PREDICTION INVALIDATIONS
  // ========================

  /**
   * Record a prediction invalidation for a model version.
   * affectedDates should be a JSON array of date strings, or null for "all".
   */
  invalidatePredictions(versionId, reason, affectedDates = null) {
    const mv = this.db.prepare('SELECT * FROM model_versions WHERE id = ?').get(versionId);
    if (!mv) return { error: 'Model version not found' };

    const datesStr = affectedDates ? JSON.stringify(affectedDates) : null;
    const stmt = this.db.prepare(`
      INSERT INTO prediction_invalidations (model_version_id, reason, affected_dates)
      VALUES (?, ?, ?)
    `);
    const result = stmt.run(versionId, reason, datesStr);

    return {
      id: result.lastInsertRowid,
      model_version_id: versionId,
      model_name: mv.model_name,
      version: mv.version,
      reason,
      affected_dates: affectedDates,
    };
  }

  /**
   * Check if predictions for a model on a specific date are still valid.
   * Returns { valid: bool, invalidations: [...] }
   */
  checkPredictionValidity(modelName, date) {
    // Get the latest deployed or validated version for this model
    const mv = this.db.prepare(`
      SELECT * FROM model_versions
      WHERE model_name = ? AND status IN ('deployed', 'validated')
      ORDER BY version DESC LIMIT 1
    `).get(modelName);

    if (!mv) {
      return {
        valid: false,
        reason: `No deployed or validated version found for model '${modelName}'`,
        model_version: null,
        invalidations: [],
      };
    }

    // Check for unresolved invalidations affecting this date
    const invalidations = this.db.prepare(
      'SELECT * FROM prediction_invalidations WHERE model_version_id = ? AND resolved = 0'
    ).all(mv.id);

    // Filter to those affecting the requested date
    const relevant = invalidations.filter(inv => {
      if (!inv.affected_dates) return true; // null means all dates affected
      try {
        const dates = JSON.parse(inv.affected_dates);
        return dates.includes(date);
      } catch {
        return true; // if we can't parse, assume affected
      }
    });

    return {
      valid: relevant.length === 0,
      model_name: modelName,
      version: mv.version,
      model_version_id: mv.id,
      date,
      invalidations: relevant,
    };
  }

  /**
   * Resolve a prediction invalidation (e.g., after retraining).
   */
  resolveInvalidation(invalidationId) {
    return this.db.prepare(`
      UPDATE prediction_invalidations SET resolved = 1, resolved_at = datetime('now')
      WHERE id = ?
    `).run(invalidationId);
  }

  /**
   * List all unresolved invalidations, optionally for a specific model version.
   */
  listInvalidations(versionId = null, resolvedOnly = false) {
    let sql = 'SELECT pi.*, mv.model_name, mv.version FROM prediction_invalidations pi JOIN model_versions mv ON pi.model_version_id = mv.id WHERE 1=1';
    const params = [];
    if (versionId) { sql += ' AND pi.model_version_id = ?'; params.push(versionId); }
    if (!resolvedOnly) { sql += ' AND pi.resolved = 0'; }
    sql += ' ORDER BY pi.invalidated_at DESC';
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Auto-invalidate: when a training config changes, invalidate all predictions
   * from model versions using that config.
   */
  autoInvalidateOnConfigChange(configId, changeReason) {
    const versions = this.db.prepare(
      'SELECT * FROM model_versions WHERE config_id = ? AND status != ?'
    ).all(configId, 'deprecated');

    const results = [];
    for (const mv of versions) {
      const inv = this.invalidatePredictions(mv.id, `config_changed: ${changeReason}`);
      results.push(inv);
    }
    return { invalidated_versions: results.length, results };
  }

  // ========================
  // PNL TRACKING
  // ========================

  recordPnlSnapshot(data) {
    const stmt = this.db.prepare(`
      INSERT INTO pnl_snapshots (timestamp, card_name, cumulative_pnl, trades_today,
        position, unrealized_pnl, zscore, conviction, vol_percentile)
      VALUES (@timestamp, @card_name, @cumulative_pnl, @trades_today,
        @position, @unrealized_pnl, @zscore, @conviction, @vol_percentile)
    `);
    const result = stmt.run({
      timestamp: data.timestamp || new Date().toISOString(),
      card_name: data.card_name,
      cumulative_pnl: data.cumulative_pnl ?? null,
      trades_today: data.trades_today ?? null,
      position: data.position ?? 0,
      unrealized_pnl: data.unrealized_pnl ?? null,
      zscore: data.zscore ?? null,
      conviction: data.conviction ?? null,
      vol_percentile: data.vol_percentile ?? null,
    });
    return { id: result.lastInsertRowid };
  }

  getDailyPnl(date, cardId = null) {
    if (cardId) {
      return this.db.prepare('SELECT * FROM daily_pnl WHERE date = ? AND card_id = ?').get(date, cardId);
    }
    return this.db.prepare('SELECT * FROM daily_pnl WHERE date = ? ORDER BY card_name').all(date);
  }

  getPnlHistory(cardId, startDate = null, endDate = null) {
    let sql = 'SELECT * FROM daily_pnl WHERE card_id = ?';
    const params = [cardId];
    if (startDate) { sql += ' AND date >= ?'; params.push(startDate); }
    if (endDate) { sql += ' AND date <= ?'; params.push(endDate); }
    sql += ' ORDER BY date ASC';
    return this.db.prepare(sql).all(...params);
  }

  getDrawdown(cardId) {
    const rows = this.db.prepare(
      'SELECT date, net_pnl FROM daily_pnl WHERE card_id = ? ORDER BY date ASC'
    ).all(cardId);
    if (rows.length === 0) return { max_drawdown: 0, max_drawdown_date: null, cumulative_pnl: 0 };
    let cumPnl = 0, peak = 0, maxDD = 0, maxDDDate = null;
    for (const row of rows) {
      cumPnl += (row.net_pnl || 0);
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) { maxDD = dd; maxDDDate = row.date; }
    }
    return { max_drawdown: maxDD, max_drawdown_date: maxDDDate, cumulative_pnl: cumPnl };
  }

  getPerformanceSummary() {
    const cards = this.db.prepare(`
      SELECT card_id, card_name, COUNT(*) as days, SUM(trades) as total_trades,
        SUM(gross_pnl) as total_gross_pnl, SUM(net_pnl) as total_net_pnl,
        SUM(commission) as total_commission, SUM(win_count) as total_wins,
        SUM(loss_count) as total_losses, AVG(net_pnl) as avg_daily_pnl,
        MIN(date) as first_date, MAX(date) as last_date
      FROM daily_pnl GROUP BY card_id ORDER BY card_name
    `).all();
    const results = [];
    for (const card of cards) {
      const dailyPnls = this.db.prepare(
        'SELECT net_pnl FROM daily_pnl WHERE card_id = ? ORDER BY date'
      ).all(card.card_id).map(r => r.net_pnl || 0);
      let sharpe = null;
      if (dailyPnls.length >= 2) {
        const mean = dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length;
        const variance = dailyPnls.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / (dailyPnls.length - 1);
        const std = Math.sqrt(variance);
        if (std > 0) sharpe = (mean / std) * Math.sqrt(252);
      }
      const dd = this.getDrawdown(card.card_id);
      const winRate = (card.total_wins + card.total_losses) > 0
        ? card.total_wins / (card.total_wins + card.total_losses) : null;
      results.push({
        card_id: card.card_id, card_name: card.card_name, days_traded: card.days,
        total_trades: card.total_trades, total_gross_pnl: card.total_gross_pnl,
        total_net_pnl: card.total_net_pnl, total_commission: card.total_commission,
        win_rate: winRate, avg_daily_pnl: card.avg_daily_pnl,
        sharpe_annualized: sharpe, max_drawdown: dd.max_drawdown,
        max_drawdown_date: dd.max_drawdown_date,
        first_date: card.first_date, last_date: card.last_date,
      });
    }
    return results;
  }

  summarizeDay(date) {
    const dateStart = `${date}T00:00:00`;
    const dateEnd = `${date}T23:59:59`;
    const cardNames = this.db.prepare(`
      SELECT DISTINCT card_name FROM pnl_snapshots WHERE timestamp >= ? AND timestamp <= ?
    `).all(dateStart, dateEnd).map(r => r.card_name);
    const results = [];
    for (const cardName of cardNames) {
      const snapshots = this.db.prepare(`
        SELECT * FROM pnl_snapshots WHERE card_name = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC
      `).all(cardName, dateStart, dateEnd);
      if (snapshots.length === 0) continue;
      const last = snapshots[snapshots.length - 1];
      const first = snapshots[0];
      const dayPnl = (last.cumulative_pnl || 0) - (first.cumulative_pnl || 0);
      const tradesToday = last.trades_today || 0;
      const pnlCurve = snapshots.map(s => s.cumulative_pnl || 0);
      let peak = pnlCurve[0], maxDD = 0;
      for (const p of pnlCurve) { if (p > peak) peak = p; const dd = peak - p; if (dd > maxDD) maxDD = dd; }
      let sharpDaily = null;
      if (pnlCurve.length >= 3) {
        const returns = [];
        for (let i = 1; i < pnlCurve.length; i++) returns.push(pnlCurve[i] - pnlCurve[i - 1]);
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / (returns.length - 1);
        const std = Math.sqrt(variance);
        if (std > 0) sharpDaily = mean / std;
      }
      const card = this.db.prepare('SELECT id FROM cards WHERE name = ?').get(cardName);
      const cardId = card ? card.id : 0;
      const tradeStats = this.db.prepare(`
        SELECT COUNT(*) as trades, SUM(CASE WHEN pnl_dollars > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN pnl_dollars <= 0 THEN 1 ELSE 0 END) as losses,
          AVG(CASE WHEN pnl_dollars > 0 THEN pnl_dollars END) as avg_win,
          AVG(CASE WHEN pnl_dollars <= 0 THEN pnl_dollars END) as avg_loss,
          SUM(pnl_dollars) as gross_pnl
        FROM trade_history WHERE card_name = ? AND session_date = ?
      `).get(cardName, date);
      const trades = tradeStats?.trades || tradesToday;
      const winCount = tradeStats?.wins || 0;
      const lossCount = tradeStats?.losses || 0;
      const grossPnl = tradeStats?.gross_pnl ?? dayPnl;
      const avgWin = tradeStats?.avg_win ?? null;
      const avgLoss = tradeStats?.avg_loss ?? null;
      this.db.prepare(`
        INSERT INTO daily_pnl (date, card_id, card_name, trades, gross_pnl, net_pnl, commission,
          win_count, loss_count, avg_win, avg_loss, max_drawdown, sharpe_daily)
        VALUES (@date, @card_id, @card_name, @trades, @gross_pnl, @net_pnl, @commission,
          @win_count, @loss_count, @avg_win, @avg_loss, @max_drawdown, @sharpe_daily)
        ON CONFLICT(date, card_id) DO UPDATE SET
          trades = @trades, gross_pnl = @gross_pnl, net_pnl = @net_pnl, commission = @commission,
          win_count = @win_count, loss_count = @loss_count, avg_win = @avg_win, avg_loss = @avg_loss,
          max_drawdown = @max_drawdown, sharpe_daily = @sharpe_daily
      `).run({
        date, card_id: cardId, card_name: cardName, trades,
        gross_pnl: grossPnl, net_pnl: dayPnl, commission: grossPnl - dayPnl,
        win_count: winCount, loss_count: lossCount, avg_win: avgWin, avg_loss: avgLoss,
        max_drawdown: maxDD, sharpe_daily: sharpDaily,
      });
      results.push({ card_name: cardName, card_id: cardId, trades, net_pnl: dayPnl, max_drawdown: maxDD });
    }
    return results;
  }

  getLatestSnapshots() {
    return this.db.prepare(`
      SELECT ps.* FROM pnl_snapshots ps
      INNER JOIN (SELECT card_name, MAX(timestamp) as max_ts FROM pnl_snapshots GROUP BY card_name)
        latest ON ps.card_name = latest.card_name AND ps.timestamp = latest.max_ts
      ORDER BY ps.card_name
    `).all();
  }

  getSnapshotHistory(cardName, startTime = null, endTime = null) {
    let sql = 'SELECT * FROM pnl_snapshots WHERE card_name = ?';
    const params = [cardName];
    if (startTime) { sql += ' AND timestamp >= ?'; params.push(startTime); }
    if (endTime) { sql += ' AND timestamp <= ?'; params.push(endTime); }
    sql += ' ORDER BY timestamp ASC';
    return this.db.prepare(sql).all(...params);
  }

  // ========================
  // CARD PERFORMANCE PROFILES
  // ========================

  upsertCardProfile(data) {
    const stmt = this.db.prepare(`
      INSERT INTO card_performance_profiles (
        card_id, card_name, profile_date, oot_start, oot_end, n_days, n_trades,
        sharpe, total_pnl, daily_pnl_avg, daily_pnl_std, win_rate, profit_factor, avg_trades_per_day,
        avg_win, avg_loss, wl_ratio, best_trade, worst_trade, best_day, worst_day,
        mae_avg, mae_p50, mae_p75, mae_p95, mae_worst, mae_winners_avg, mae_losers_avg,
        mfe_avg, mfe_p50, mfe_p75, mfe_p95, mfe_best, mfe_winners_avg, mfe_losers_avg,
        avg_hold_sec_winners, avg_hold_sec_losers, avg_hold_sec_all,
        edge_decay_json, optimal_hold_min,
        positive_days, negative_days, positive_day_pct,
        max_consecutive_loss_days, max_drawdown, max_drawdown_duration_days,
        exit_reasons_json,
        fill_rate, avg_queue_position, avg_fill_latency_ms,
        conviction_exit_tested, conviction_best_config, conviction_net_pnl_delta, conviction_verdict,
        notes
      ) VALUES (
        @card_id, @card_name, @profile_date, @oot_start, @oot_end, @n_days, @n_trades,
        @sharpe, @total_pnl, @daily_pnl_avg, @daily_pnl_std, @win_rate, @profit_factor, @avg_trades_per_day,
        @avg_win, @avg_loss, @wl_ratio, @best_trade, @worst_trade, @best_day, @worst_day,
        @mae_avg, @mae_p50, @mae_p75, @mae_p95, @mae_worst, @mae_winners_avg, @mae_losers_avg,
        @mfe_avg, @mfe_p50, @mfe_p75, @mfe_p95, @mfe_best, @mfe_winners_avg, @mfe_losers_avg,
        @avg_hold_sec_winners, @avg_hold_sec_losers, @avg_hold_sec_all,
        @edge_decay_json, @optimal_hold_min,
        @positive_days, @negative_days, @positive_day_pct,
        @max_consecutive_loss_days, @max_drawdown, @max_drawdown_duration_days,
        @exit_reasons_json,
        @fill_rate, @avg_queue_position, @avg_fill_latency_ms,
        @conviction_exit_tested, @conviction_best_config, @conviction_net_pnl_delta, @conviction_verdict,
        @notes
      )
      ON CONFLICT(card_id, profile_date) DO UPDATE SET
        card_name = @card_name, oot_start = @oot_start, oot_end = @oot_end,
        n_days = @n_days, n_trades = @n_trades,
        sharpe = @sharpe, total_pnl = @total_pnl, daily_pnl_avg = @daily_pnl_avg,
        daily_pnl_std = @daily_pnl_std, win_rate = @win_rate, profit_factor = @profit_factor,
        avg_trades_per_day = @avg_trades_per_day,
        avg_win = @avg_win, avg_loss = @avg_loss, wl_ratio = @wl_ratio,
        best_trade = @best_trade, worst_trade = @worst_trade, best_day = @best_day, worst_day = @worst_day,
        mae_avg = @mae_avg, mae_p50 = @mae_p50, mae_p75 = @mae_p75, mae_p95 = @mae_p95,
        mae_worst = @mae_worst, mae_winners_avg = @mae_winners_avg, mae_losers_avg = @mae_losers_avg,
        mfe_avg = @mfe_avg, mfe_p50 = @mfe_p50, mfe_p75 = @mfe_p75, mfe_p95 = @mfe_p95,
        mfe_best = @mfe_best, mfe_winners_avg = @mfe_winners_avg, mfe_losers_avg = @mfe_losers_avg,
        avg_hold_sec_winners = @avg_hold_sec_winners, avg_hold_sec_losers = @avg_hold_sec_losers,
        avg_hold_sec_all = @avg_hold_sec_all,
        edge_decay_json = @edge_decay_json, optimal_hold_min = @optimal_hold_min,
        positive_days = @positive_days, negative_days = @negative_days, positive_day_pct = @positive_day_pct,
        max_consecutive_loss_days = @max_consecutive_loss_days, max_drawdown = @max_drawdown,
        max_drawdown_duration_days = @max_drawdown_duration_days,
        exit_reasons_json = @exit_reasons_json,
        fill_rate = @fill_rate, avg_queue_position = @avg_queue_position, avg_fill_latency_ms = @avg_fill_latency_ms,
        conviction_exit_tested = @conviction_exit_tested, conviction_best_config = @conviction_best_config,
        conviction_net_pnl_delta = @conviction_net_pnl_delta, conviction_verdict = @conviction_verdict,
        notes = @notes
    `);

    const params = {
      card_id: data.card_id,
      card_name: data.card_name,
      profile_date: data.profile_date,
      oot_start: data.oot_start || null,
      oot_end: data.oot_end || null,
      n_days: data.n_days || null,
      n_trades: data.n_trades || null,
      sharpe: data.sharpe ?? null,
      total_pnl: data.total_pnl ?? null,
      daily_pnl_avg: data.daily_pnl_avg ?? null,
      daily_pnl_std: data.daily_pnl_std ?? null,
      win_rate: data.win_rate ?? null,
      profit_factor: data.profit_factor ?? null,
      avg_trades_per_day: data.avg_trades_per_day ?? null,
      avg_win: data.avg_win ?? null,
      avg_loss: data.avg_loss ?? null,
      wl_ratio: data.wl_ratio ?? null,
      best_trade: data.best_trade ?? null,
      worst_trade: data.worst_trade ?? null,
      best_day: data.best_day ?? null,
      worst_day: data.worst_day ?? null,
      mae_avg: data.mae_avg ?? null,
      mae_p50: data.mae_p50 ?? null,
      mae_p75: data.mae_p75 ?? null,
      mae_p95: data.mae_p95 ?? null,
      mae_worst: data.mae_worst ?? null,
      mae_winners_avg: data.mae_winners_avg ?? null,
      mae_losers_avg: data.mae_losers_avg ?? null,
      mfe_avg: data.mfe_avg ?? null,
      mfe_p50: data.mfe_p50 ?? null,
      mfe_p75: data.mfe_p75 ?? null,
      mfe_p95: data.mfe_p95 ?? null,
      mfe_best: data.mfe_best ?? null,
      mfe_winners_avg: data.mfe_winners_avg ?? null,
      mfe_losers_avg: data.mfe_losers_avg ?? null,
      avg_hold_sec_winners: data.avg_hold_sec_winners ?? null,
      avg_hold_sec_losers: data.avg_hold_sec_losers ?? null,
      avg_hold_sec_all: data.avg_hold_sec_all ?? null,
      edge_decay_json: typeof data.edge_decay_json === 'string' ? data.edge_decay_json : (data.edge_decay_json ? JSON.stringify(data.edge_decay_json) : null),
      optimal_hold_min: data.optimal_hold_min ?? null,
      positive_days: data.positive_days ?? null,
      negative_days: data.negative_days ?? null,
      positive_day_pct: data.positive_day_pct ?? null,
      max_consecutive_loss_days: data.max_consecutive_loss_days ?? null,
      max_drawdown: data.max_drawdown ?? null,
      max_drawdown_duration_days: data.max_drawdown_duration_days ?? null,
      exit_reasons_json: typeof data.exit_reasons_json === 'string' ? data.exit_reasons_json : (data.exit_reasons_json ? JSON.stringify(data.exit_reasons_json) : null),
      fill_rate: data.fill_rate ?? null,
      avg_queue_position: data.avg_queue_position ?? null,
      avg_fill_latency_ms: data.avg_fill_latency_ms ?? null,
      conviction_exit_tested: data.conviction_exit_tested ? 1 : 0,
      conviction_best_config: data.conviction_best_config || null,
      conviction_net_pnl_delta: data.conviction_net_pnl_delta ?? null,
      conviction_verdict: data.conviction_verdict || null,
      notes: data.notes || null,
    };

    const result = stmt.run(params);
    return { id: result.lastInsertRowid, card_id: data.card_id, profile_date: data.profile_date };
  }

  getCardProfile(cardId) {
    const row = this.db.prepare(`
      SELECT * FROM card_performance_profiles
      WHERE card_id = ? ORDER BY profile_date DESC LIMIT 1
    `).get(cardId);
    if (row) {
      try { row.edge_decay = row.edge_decay_json ? JSON.parse(row.edge_decay_json) : null; } catch (e) { row.edge_decay = null; }
      try { row.exit_reasons = row.exit_reasons_json ? JSON.parse(row.exit_reasons_json) : null; } catch (e) { row.exit_reasons = null; }
    }
    return row || null;
  }

  getCardProfileByName(cardName) {
    const card = this.db.prepare('SELECT id FROM cards WHERE name = ?').get(cardName);
    if (!card) return null;
    return this.getCardProfile(card.id);
  }

  getCardProfileHistory(cardId) {
    const rows = this.db.prepare(`
      SELECT * FROM card_performance_profiles
      WHERE card_id = ? ORDER BY profile_date ASC
    `).all(cardId);
    for (const row of rows) {
      try { row.edge_decay = row.edge_decay_json ? JSON.parse(row.edge_decay_json) : null; } catch (e) { row.edge_decay = null; }
      try { row.exit_reasons = row.exit_reasons_json ? JSON.parse(row.exit_reasons_json) : null; } catch (e) { row.exit_reasons = null; }
    }
    return rows;
  }

  compareCards() {
    // Get latest profile for each card, side by side
    const profiles = this.db.prepare(`
      SELECT cpp.* FROM card_performance_profiles cpp
      INNER JOIN (
        SELECT card_id, MAX(profile_date) as max_date
        FROM card_performance_profiles GROUP BY card_id
      ) latest ON cpp.card_id = latest.card_id AND cpp.profile_date = latest.max_date
      ORDER BY cpp.card_name
    `).all();

    for (const row of profiles) {
      try { row.edge_decay = row.edge_decay_json ? JSON.parse(row.edge_decay_json) : null; } catch (e) { row.edge_decay = null; }
      try { row.exit_reasons = row.exit_reasons_json ? JSON.parse(row.exit_reasons_json) : null; } catch (e) { row.exit_reasons = null; }
    }

    // Build comparison summary
    const summary = profiles.map(p => ({
      card_name: p.card_name,
      sharpe: p.sharpe,
      n_trades: p.n_trades,
      win_rate: p.win_rate,
      avg_win: p.avg_win,
      avg_loss: p.avg_loss,
      wl_ratio: p.wl_ratio,
      mae_winners_avg: p.mae_winners_avg,
      mae_losers_avg: p.mae_losers_avg,
      mfe_avg: p.mfe_avg,
      optimal_hold_min: p.optimal_hold_min,
      max_drawdown: p.max_drawdown,
      fill_rate: p.fill_rate,
      conviction_verdict: p.conviction_verdict,
      profile_date: p.profile_date,
    }));

    return { count: profiles.length, summary, profiles };
  }

  // ========================
  // TRAINING RUN STATS
  // ========================

  upsertTrainingRunStats(data) {
    // Check if a record already exists for this job
    const existing = data.training_job_id
      ? this.db.prepare('SELECT id FROM training_run_stats WHERE training_job_id = ?').get(data.training_job_id)
      : null;

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE training_run_stats SET
          config_id = COALESCE(@config_id, config_id),
          total_folds = COALESCE(@total_folds, total_folds),
          completed_folds = COALESCE(@completed_folds, completed_folds),
          failed_folds = COALESCE(@failed_folds, failed_folds),
          ic_mean = COALESCE(@ic_mean, ic_mean),
          ic_median = COALESCE(@ic_median, ic_median),
          ic_std = COALESCE(@ic_std, ic_std),
          ic_min = COALESCE(@ic_min, ic_min),
          ic_max = COALESCE(@ic_max, ic_max),
          ic_p25 = COALESCE(@ic_p25, ic_p25),
          ic_p75 = COALESCE(@ic_p75, ic_p75),
          train_loss_mean = COALESCE(@train_loss_mean, train_loss_mean),
          val_loss_mean = COALESCE(@val_loss_mean, val_loss_mean),
          overfitting_ratio_mean = COALESCE(@overfitting_ratio_mean, overfitting_ratio_mean),
          ic_trend_slope = COALESCE(@ic_trend_slope, ic_trend_slope),
          ic_trend_r2 = COALESCE(@ic_trend_r2, ic_trend_r2),
          total_duration_hours = COALESCE(@total_duration_hours, total_duration_hours),
          avg_fold_duration_min = COALESCE(@avg_fold_duration_min, avg_fold_duration_min),
          prev_version_ic_mean = COALESCE(@prev_version_ic_mean, prev_version_ic_mean),
          ic_improvement_pct = COALESCE(@ic_improvement_pct, ic_improvement_pct),
          updated_at = datetime('now')
        WHERE id = @id
      `);
      stmt.run({ id: existing.id, ...this._trainingStatsParams(data) });
      return { id: existing.id, updated: true };
    }

    const stmt = this.db.prepare(`
      INSERT INTO training_run_stats (
        training_job_id, config_id,
        total_folds, completed_folds, failed_folds,
        ic_mean, ic_median, ic_std, ic_min, ic_max, ic_p25, ic_p75,
        train_loss_mean, val_loss_mean, overfitting_ratio_mean,
        ic_trend_slope, ic_trend_r2,
        total_duration_hours, avg_fold_duration_min,
        prev_version_ic_mean, ic_improvement_pct
      ) VALUES (
        @training_job_id, @config_id,
        @total_folds, @completed_folds, @failed_folds,
        @ic_mean, @ic_median, @ic_std, @ic_min, @ic_max, @ic_p25, @ic_p75,
        @train_loss_mean, @val_loss_mean, @overfitting_ratio_mean,
        @ic_trend_slope, @ic_trend_r2,
        @total_duration_hours, @avg_fold_duration_min,
        @prev_version_ic_mean, @ic_improvement_pct
      )
    `);

    const result = stmt.run({
      training_job_id: data.training_job_id || null,
      ...this._trainingStatsParams(data),
    });
    return { id: result.lastInsertRowid, created: true };
  }

  _trainingStatsParams(data) {
    return {
      config_id: data.config_id || null,
      total_folds: data.total_folds ?? null,
      completed_folds: data.completed_folds ?? null,
      failed_folds: data.failed_folds ?? null,
      ic_mean: data.ic_mean ?? null,
      ic_median: data.ic_median ?? null,
      ic_std: data.ic_std ?? null,
      ic_min: data.ic_min ?? null,
      ic_max: data.ic_max ?? null,
      ic_p25: data.ic_p25 ?? null,
      ic_p75: data.ic_p75 ?? null,
      train_loss_mean: data.train_loss_mean ?? null,
      val_loss_mean: data.val_loss_mean ?? null,
      overfitting_ratio_mean: data.overfitting_ratio_mean ?? null,
      ic_trend_slope: data.ic_trend_slope ?? null,
      ic_trend_r2: data.ic_trend_r2 ?? null,
      total_duration_hours: data.total_duration_hours ?? null,
      avg_fold_duration_min: data.avg_fold_duration_min ?? null,
      prev_version_ic_mean: data.prev_version_ic_mean ?? null,
      ic_improvement_pct: data.ic_improvement_pct ?? null,
    };
  }

  getTrainingRunStats(jobId) {
    return this.db.prepare('SELECT * FROM training_run_stats WHERE training_job_id = ?').get(jobId) || null;
  }

  compareTrainingRuns(configId) {
    const runs = this.db.prepare(`
      SELECT trs.*, tj.description as job_description, tj.node, tj.started_at as job_started_at
      FROM training_run_stats trs
      LEFT JOIN training_jobs tj ON trs.training_job_id = tj.id
      WHERE trs.config_id = ?
      ORDER BY trs.created_at ASC
    `).all(configId);

    // Build trend: is IC improving across runs?
    const summary = runs.map((r, i) => ({
      run_index: i + 1,
      job_id: r.training_job_id,
      node: r.node,
      ic_mean: r.ic_mean,
      ic_std: r.ic_std,
      completed_folds: r.completed_folds,
      total_folds: r.total_folds,
      ic_improvement_pct: r.ic_improvement_pct,
      total_duration_hours: r.total_duration_hours,
      started_at: r.job_started_at,
    }));

    return { config_id: configId, count: runs.length, summary, runs };
  }

  // ========================
  // SEED PERFORMANCE DATA
  // ========================

  seedCardProfiles() {
    // Only seed if no profiles exist
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM card_performance_profiles').get().cnt;
    if (count > 0) return false;

    const profiles = [
      {
        card_name: 'Card1',
        profile_date: '2026-03-17',
        n_trades: 697,
        sharpe: 4.07,
        win_rate: 0.93,
        avg_win: 95,
        avg_loss: -1034,
        wl_ratio: 0.092,
        mae_winners_avg: 11.5,
        mae_losers_avg: 71.4,
        mfe_avg: 7.5,
        avg_hold_sec_winners: 200,
        avg_hold_sec_losers: 1760,
        edge_decay_json: JSON.stringify([
          { hold_min: 10, sharpe: 2.64 },
          { hold_min: 30, sharpe: 2.58 },
          { hold_min: 60, sharpe: 3.88 },
          { hold_min: 120, sharpe: 4.07 }
        ]),
        optimal_hold_min: 120,
        max_drawdown: 5682,
        exit_reasons_json: JSON.stringify({ TakeProfit: 630, HoldTimeout: 67 }),
        conviction_exit_tested: 1,
        conviction_best_config: '5s_mag0.0',
        conviction_net_pnl_delta: 2571,
        conviction_verdict: 'marginal',
        notes: '2h hold optimal. WL ratio very skewed — large losers offset by high WR.',
      },
      {
        card_name: 'Card3',
        profile_date: '2026-03-17',
        n_trades: 375,
        sharpe: 2.05,
        win_rate: 0.909,
        avg_win: 120,
        avg_loss: -998,
        wl_ratio: 0.12,
        conviction_exit_tested: 1,
        conviction_best_config: 'conv10s_mag1.0',
        conviction_net_pnl_delta: null,
        conviction_verdict: 'reject',
        notes: 'Conviction exit degrades Sharpe from 2.05 to 1.54. NOT tradeable at any vol gate.',
      },
      {
        card_name: 'Card4',
        profile_date: '2026-03-17',
        n_trades: 197,
        sharpe: 2.77,
        win_rate: 0.807,
        edge_decay_json: JSON.stringify([
          { hold_min: 10, sharpe: 3.34 },
          { hold_min: 30, sharpe: 2.77 },
          { hold_min: 60, sharpe: 2.98 },
          { hold_min: 120, sharpe: 2.79 }
        ]),
        optimal_hold_min: 10,
        conviction_exit_tested: 1,
        conviction_best_config: '5s_mag0.0',
        conviction_net_pnl_delta: 802,
        conviction_verdict: 'not-worth',
        notes: 'Vol gate v70 optimal (2.77 vs v50 1.37). Short holds best.',
      },
      {
        card_name: 'Card6',
        profile_date: '2026-03-17',
        n_trades: 496,
        sharpe: 1.38,
        win_rate: 0.581,
        avg_win: 244,
        avg_loss: -322,
        wl_ratio: 0.758,
        exit_reasons_json: JSON.stringify({ TakeProfit: 288, StopLoss: 208 }),
        conviction_exit_tested: 1,
        conviction_best_config: 'conv10s_mag1.0',
        conviction_net_pnl_delta: 255,
        conviction_verdict: 'marginal-positive',
        notes: 'Conviction exit improves Sharpe from 1.38 to 1.42 (+$255). Marginal improvement.',
      },
    ];

    const insertProfile = this.db.transaction((items) => {
      for (const p of items) {
        // Look up card_id from cards table
        const card = this.db.prepare('SELECT id FROM cards WHERE name = ?').get(p.card_name);
        if (!card) continue;
        this.upsertCardProfile({ card_id: card.id, ...p });
      }
    });
    insertProfile(profiles);
    return true;
  }

  seedTrainingRunStats() {
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM training_run_stats').get().cnt;
    if (count > 0) return false;

    const runs = [
      {
        training_job_id: null,
        config_id: null,
        total_folds: 5,
        completed_folds: 5,
        failed_folds: 0,
        ic_mean: 0.073,
        ic_median: 0.073,
        ic_std: null,
        ic_min: null,
        ic_max: null,
        ic_p25: null,
        ic_p75: null,
        total_duration_hours: null,
        avg_fold_duration_min: null,
        prev_version_ic_mean: null,
        ic_improvement_pct: null,
      },
      {
        training_job_id: null,
        config_id: null,
        total_folds: 4,
        completed_folds: 4,
        failed_folds: 0,
        ic_mean: 0.062,
        ic_median: 0.059,
        ic_std: 0.024,
        ic_min: 0.038,
        ic_max: 0.094,
        ic_p25: 0.042,
        ic_p75: 0.083,
        total_duration_hours: null,
        avg_fold_duration_min: null,
        prev_version_ic_mean: null,
        ic_improvement_pct: null,
      },
    ];

    for (const run of runs) {
      this.upsertTrainingRunStats(run);
    }
    return true;
  }

  // ========================
  // RESEARCHERS
  // ========================

  _seedResearchers() {
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM researchers').get().cnt;
    if (count > 0) return false;

    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO researchers (id, name, role, node_primary, nodes_secondary)
      VALUES (@id, @name, @role, @node_primary, @nodes_secondary)
    `);

    const researchers = [
      {
        id: 'alpha',
        name: 'Dr. Alpha',
        role: 'Architecture specialist — CNN/transformer variants, model depth/width, attention mechanisms',
        node_primary: 'neptune',
        nodes_secondary: JSON.stringify(['uranus']),
      },
      {
        id: 'sigma',
        name: 'Dr. Sigma',
        role: 'Signal & feature engineer — input channels, normalization, feature ablation, multi-horizon',
        node_primary: 'uranus',
        nodes_secondary: JSON.stringify(['razer']),
      },
      {
        id: 'theta',
        name: 'Dr. Theta',
        role: 'Training & optimization specialist — walk-forward methodology, hyperparameters, overfitting controls',
        node_primary: 'neptune',
        nodes_secondary: JSON.stringify(['razer']),
      },
      {
        id: 'omega',
        name: 'Dr. Omega',
        role: 'Execution & strategy researcher — fill simulation, exit strategies, card optimization, live deployment',
        node_primary: 'jupiter',
        nodes_secondary: JSON.stringify(['neptune']),
      },
    ];

    const insertMany = this.db.transaction((rows) => {
      for (const row of rows) insert.run(row);
    });
    insertMany(researchers);
    return true;
  }

  getResearcher(id) {
    return this.db.prepare('SELECT * FROM researchers WHERE id = ?').get(id) || null;
  }

  listResearchers() {
    return this.db.prepare('SELECT * FROM researchers ORDER BY id').all();
  }

  updateResearcherContext(id, contextJson) {
    const ctx = typeof contextJson === 'string' ? contextJson : JSON.stringify(contextJson);
    return this.db.prepare(`
      UPDATE researchers SET context_json = ?, updated_at = datetime('now') WHERE id = ?
    `).run(ctx, id);
  }

  addResearcherTask(researcherId, task, description = null, priority = 5) {
    const stmt = this.db.prepare(`
      INSERT INTO researcher_tasks (researcher_id, task, description, priority)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(researcherId, task, description, priority);
    return { id: Number(result.lastInsertRowid) };
  }

  getResearcherTasks(researcherId, status = null) {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM researcher_tasks WHERE researcher_id = ? AND status = ? ORDER BY priority ASC, created_at ASC'
      ).all(researcherId, status);
    }
    return this.db.prepare(
      'SELECT * FROM researcher_tasks WHERE researcher_id = ? ORDER BY priority ASC, created_at ASC'
    ).all(researcherId);
  }

  updateResearcherTask(taskId, updates) {
    const allowed = ['status', 'experiment_id', 'result_summary', 'iteration_of', 'completed_at'];
    const sets = [];
    const values = {};
    for (const [k, v] of Object.entries(updates)) {
      if (allowed.includes(k)) {
        sets.push(`${k} = @${k}`);
        values[k] = v;
      }
    }
    if (sets.length === 0) return null;
    // Auto-set completed_at when status is terminal
    if (updates.status === 'completed' || updates.status === 'failed') {
      if (!updates.completed_at) {
        sets.push("completed_at = datetime('now')");
      }
    }
    values.id = taskId;
    return this.db.prepare(`UPDATE researcher_tasks SET ${sets.join(', ')} WHERE id = @id`).run(values);
  }

  addResearcherFinding(researcherId, finding, evidence = null, impact = null, experimentId = null) {
    const stmt = this.db.prepare(`
      INSERT INTO researcher_findings (researcher_id, finding, evidence, impact, experiment_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(researcherId, finding, evidence, impact, experimentId);
    return { id: Number(result.lastInsertRowid) };
  }

  getResearcherFindings(researcherId, limit = 50) {
    return this.db.prepare(
      'SELECT * FROM researcher_findings WHERE researcher_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(researcherId, limit);
  }

  close() {
    this.db.close();
  }
}

module.exports = { QCCDatabase };
