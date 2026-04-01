#!/usr/bin/env node
/**
 * QCC MCP Server — Quant Command Center
 *
 * Phase 1+: Full tool surface with SQLite backend and persistent SSH connections.
 * SSH pool provides auto-reconnect, heartbeat monitoring, and ProxyJump support.
 *
 * Tools (40+):
 *   Compute: qcc_node_status, qcc_ssh_exec, qcc_launch_training, qcc_stop_training, qcc_training_status
 *   Models:  qcc_register_model, qcc_model_list, qcc_model_folds, qcc_deploy_model, qcc_model_compare
 *   Versioning: qcc_model_versions, qcc_model_version_create, qcc_model_promote, qcc_model_deploy_v2, qcc_model_deprecate
 *   Predictions: qcc_prediction_check, qcc_prediction_invalidate
 *   Data:    qcc_data_inventory, qcc_data_sync, qcc_data_verify, qcc_data_scan
 *   Cards:   qcc_card_list, qcc_card_config, qcc_card_create, qcc_card_profile, qcc_card_profile_upsert
 *   Trading: qcc_paper_status, qcc_trade_history, qcc_sweep_list, qcc_sweep_results
 *   Research: qcc_research_list, qcc_research_create, qcc_research_update, qcc_dir_describe, qcc_dir_list
 *   System:  qcc_alert_send, qcc_alert_list, qcc_session_start, qcc_session_end, qcc_health_check, qcc_scheduled_tasks
 *   PnL:     qcc_pnl_status, qcc_pnl_history, qcc_pnl_summary, qcc_pnl_summarize_day
 *   Training Stats: qcc_training_run_stats, qcc_training_run_stats_upsert
 *   Registration: qcc_training_register
 *   Migration: qcc_migrate
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');

const { QCCDatabase } = require('../lib/qcc-database');
const { QCCSSHPool } = require('../lib/qcc-ssh');

// Paths
const BASE_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const LOGS_DIR = path.join(BASE_DIR, 'logs');
const LOG_FILE = path.join(LOGS_DIR, `mcp-qcc-${new Date().toISOString().split('T')[0]}.log`);
const DB_PATH = path.join(DATA_DIR, 'qcc.db');
const PAPER_STATE_PATH = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant\\live_trading\\logs\\paper\\live_state.json';

// Discord alert config — uses bot token from config.json to post to #system-status
const CHANNELS_FILE = path.join(BASE_DIR, 'trading_agents', 'data', 'discord_channels.json');
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
let discordBotToken = null;
let systemStatusChannelId = null;

function loadDiscordConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    discordBotToken = config.discordToken || null;
  } catch (e) { /* no config */ }
  try {
    const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    systemStatusChannelId = channels.channels?.systemStatus || null;
  } catch (e) { /* no channels */ }
}
loadDiscordConfig();

/**
 * Post an alert embed to #system-status via Discord Bot API.
 * Fire-and-forget — failures are logged but never block the MCP response.
 */
function notifyDiscord(severity, source, message, node) {
  if (!discordBotToken || !systemStatusChannelId) return;

  const colorMap = { critical: 0xef4444, warning: 0xfbbf24, info: 0x3b82f6 };
  const emojiMap = { critical: '\u274C', warning: '\u26A0\uFE0F', info: '\u2139\uFE0F' };
  const color = colorMap[severity] || 0x3b82f6;
  const emoji = emojiMap[severity] || '\u2139\uFE0F';

  const fields = [
    { name: 'Source', value: source, inline: true },
    { name: 'Severity', value: severity.toUpperCase(), inline: true },
  ];
  if (node) fields.push({ name: 'Node', value: node, inline: true });

  const payload = JSON.stringify({
    embeds: [{
      title: `${emoji} QCC Alert: ${source}`,
      description: message,
      color,
      fields,
      timestamp: new Date().toISOString(),
      footer: { text: 'QCC Daemon' }
    }]
  });

  const options = {
    hostname: 'discord.com',
    path: `/api/v10/channels/${systemStatusChannelId}/messages`,
    method: 'POST',
    headers: {
      'Authorization': `Bot ${discordBotToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    }
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        log('INFO', `Discord alert sent to #system-status`, { severity, source });
      } else {
        log('WARN', `Discord alert failed: ${res.statusCode}`, { body: body.slice(0, 300) });
      }
    });
  });
  req.on('error', (e) => log('WARN', `Discord alert network error: ${e.message}`));
  req.write(payload);
  req.end();
}

// Ensure directories
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Database & SSH Pool
let db = null;
let sshPool = null;

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  let entry = `[${timestamp}] [${level}] ${message}`;
  if (data) {
    try { entry += `\n  DATA: ${JSON.stringify(data, null, 2)}`; } catch (e) { entry += '\n  DATA: [unserializable]'; }
  }
  entry += '\n';
  try { fs.appendFileSync(LOG_FILE, entry, 'utf8'); } catch (e) {}
}

// ========================
// JSON-RPC helpers
// ========================

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

function toolResult(text) {
  return { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] };
}

function logAndReturn(toolName, args, result) {
  try {
    const summary = typeof result === 'string' ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200);
    db.logAction(toolName, JSON.stringify(args || {}), summary);
  } catch (e) {}
  return toolResult(result);
}

// ========================
// TOOL DEFINITIONS
// ========================

const TOOLS = [
  // --- Compute ---
  {
    name: 'qcc_node_status',
    description: 'Get status of all compute nodes or a specific node. Returns GPU/RAM utilization, training status, and last heartbeat. Set live_check=true to query GPU via SSH in real time.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Node name (neptune, uranus, jupiter, saturn, razer). Omit for all nodes.' },
        live_check: { type: 'boolean', description: 'If true, query GPU status via live SSH connection (slower but real-time).' }
      }
    }
  },
  {
    name: 'qcc_ssh_exec',
    description: 'Execute a command on a remote node via SSH. Uses persistent SSH connection pool with auto-reconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Target node name' },
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_ms: { type: 'number', description: 'Command timeout in milliseconds (default 30000)' }
      },
      required: ['node', 'command']
    }
  },
  {
    name: 'qcc_launch_training',
    description: 'Launch a training job on a remote node. Creates DB record; SSH launch available when pool is connected.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Target node' },
        model_id: { type: 'number', description: 'Model ID to train' },
        config_json: { type: 'string', description: 'Training config as JSON string' },
        tmux_session: { type: 'string', description: 'tmux session name' },
        description: { type: 'string', description: 'Job description' }
      },
      required: ['node']
    }
  },
  {
    name: 'qcc_stop_training',
    description: 'Stop a training job. Marks cancelled in DB.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'number', description: 'Training job ID' },
        reason: { type: 'string', description: 'Reason for stopping' }
      },
      required: ['job_id']
    }
  },
  {
    name: 'qcc_training_status',
    description: 'Get status of training jobs. Filter by status or node.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: running, completed, failed, stale, cancelled, queued' },
        node: { type: 'string', description: 'Filter by node name' }
      }
    }
  },
  // --- Models ---
  {
    name: 'qcc_register_model',
    description: 'Register a new model in the database. Returns model ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Model name (e.g. "Standard CNN WF")' },
        architecture: { type: 'string', description: 'Architecture type (e.g. "cnn", "hybrid", "transformer")' },
        params_count: { type: 'number', description: 'Parameter count' },
        horizon_bars: { type: 'number', description: 'Prediction horizon in bars (default 100)' },
        subsample: { type: 'number', description: 'Subsample factor (default 5)' },
        window_mode: { type: 'string', description: 'expanding or sliding' },
        max_train_days: { type: 'number', description: 'Max training window in days' },
        epochs: { type: 'number' },
        batch_size: { type: 'number' },
        lr: { type: 'number', description: 'Learning rate' },
        dropout: { type: 'number' },
        config_json: { type: 'string', description: 'Full config as JSON string' },
        node: { type: 'string', description: 'Node where model is being trained' },
        checkpoint_path: { type: 'string' },
        total_folds: { type: 'number' },
        notes: { type: 'string' }
      },
      required: ['name', 'architecture']
    }
  },
  {
    name: 'qcc_model_list',
    description: 'List all registered models. Optionally filter by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: training, completed, deployed, archived, failed' },
        limit: { type: 'number', description: 'Max results (default 50)' }
      }
    }
  },
  {
    name: 'qcc_model_folds',
    description: 'Get per-fold walk-forward results for a model.',
    inputSchema: {
      type: 'object',
      properties: {
        model_id: { type: 'number', description: 'Model ID' },
        limit: { type: 'number', description: 'Max folds to return (default 200)' }
      },
      required: ['model_id']
    }
  },
  {
    name: 'qcc_deploy_model',
    description: 'Mark a model as deployed and optionally link to a card.',
    inputSchema: {
      type: 'object',
      properties: {
        model_id: { type: 'number', description: 'Model ID to deploy' },
        card_name: { type: 'string', description: 'Card to link model to' }
      },
      required: ['model_id']
    }
  },
  {
    name: 'qcc_model_compare',
    description: 'Compare multiple models side-by-side (IC stats, fold counts, architecture).',
    inputSchema: {
      type: 'object',
      properties: {
        model_ids: { type: 'string', description: 'Comma-separated model IDs (e.g. "1,2,3")' }
      },
      required: ['model_ids']
    }
  },
  // --- Data ---
  {
    name: 'qcc_data_inventory',
    description: 'List tracked data files. Filter by node, type, or date.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        file_type: { type: 'string', description: 'mbo, book_tensor, prediction, checkpoint, config, other' },
        date: { type: 'string', description: 'YYYY-MM-DD' }
      }
    }
  },
  {
    name: 'qcc_data_sync',
    description: 'Trigger data sync between nodes. Creates sync task record.',
    inputSchema: {
      type: 'object',
      properties: {
        source_node: { type: 'string' },
        dest_node: { type: 'string' },
        file_type: { type: 'string' },
        file_pattern: { type: 'string' }
      },
      required: ['source_node', 'dest_node']
    }
  },
  {
    name: 'qcc_data_verify',
    description: 'Verify data integrity on a node via SSH.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Node to verify' },
        file_type: { type: 'string' }
      },
      required: ['node']
    }
  },
  {
    name: 'qcc_data_scan',
    description: 'Scan a node for new data files and register them via SSH.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        path: { type: 'string', description: 'Directory path to scan' }
      },
      required: ['node']
    }
  },
  // --- Cards ---
  {
    name: 'qcc_card_list',
    description: 'List all trading cards. Optionally filter by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: paper, live, retired, testing' }
      }
    }
  },
  {
    name: 'qcc_card_config',
    description: 'Get full configuration for a specific card.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Card name (e.g. "Card1", "Card4")' }
      },
      required: ['name']
    }
  },
  {
    name: 'qcc_card_create',
    description: 'Create a new trading card configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        model_variant: { type: 'string' },
        conviction_threshold: { type: 'number' },
        vol_percentile_gate: { type: 'number' },
        tp_ticks: { type: 'number' },
        sl_ticks: { type: 'number' },
        hold_ms: { type: 'number' },
        mae_exit_ticks: { type: 'number' },
        mae_exit_hold_sec: { type: 'number' },
        chase_entry: { type: 'number', description: '0 or 1' },
        chase_max_ticks: { type: 'number' },
        chase_max_reprices: { type: 'number' },
        ratchet_thresholds_json: { type: 'string' },
        backtest_sharpe: { type: 'number' },
        backtest_trades: { type: 'number' },
        backtest_win_rate: { type: 'number' },
        backtest_notes: { type: 'string' },
        status: { type: 'string' }
      },
      required: ['name', 'model_variant', 'conviction_threshold', 'vol_percentile_gate', 'tp_ticks']
    }
  },
  // --- Trading ---
  {
    name: 'qcc_paper_status',
    description: 'Read live paper trading engine status from live_state.json. Returns current positions, PnL, connection status.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'qcc_trade_history',
    description: 'Query trade history. Filter by card or date.',
    inputSchema: {
      type: 'object',
      properties: {
        card_name: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'number', description: 'Max results (default 100)' }
      }
    }
  },
  {
    name: 'qcc_sweep_list',
    description: 'List parameter sweeps. Optionally filter by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'running, completed, failed, cancelled' }
      }
    }
  },
  {
    name: 'qcc_sweep_results',
    description: 'Get results for a specific sweep, sorted by best metric.',
    inputSchema: {
      type: 'object',
      properties: {
        sweep_id: { type: 'number' },
        limit: { type: 'number', description: 'Max results (default 100)' }
      },
      required: ['sweep_id']
    }
  },
  // --- Research ---
  {
    name: 'qcc_research_list',
    description: 'List research projects. Optionally filter by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'proposed, active, blocked, completed, abandoned' }
      }
    }
  },
  {
    name: 'qcc_research_create',
    description: 'Create a new research project.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        hypothesis: { type: 'string' },
        priority: { type: 'number', description: '1=highest, 5=lowest' },
        tags: { type: 'string', description: 'Comma-separated tags' }
      },
      required: ['name']
    }
  },
  {
    name: 'qcc_research_update',
    description: 'Update a research project (status, findings, next_steps, etc).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Research project ID' },
        status: { type: 'string' },
        findings: { type: 'string' },
        next_steps: { type: 'string' },
        priority: { type: 'number' },
        tags: { type: 'string' }
      },
      required: ['id']
    }
  },
  // --- Research Experiments ---
  {
    name: 'qcc_experiment_create',
    description: 'Log a research experiment result (from research_harness.py). Stage: lgbm, static_cnn, mini_wf, full_wf.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: 'lgbm, static_cnn, mini_wf, full_wf' },
        config_json: { type: 'string', description: 'JSON string of experiment config' },
        hypothesis: { type: 'string' },
        horizon_bars: { type: 'number' },
        train_days: { type: 'number' },
        oot_days: { type: 'number' },
        model_type: { type: 'string' },
        ic: { type: 'number' },
        ic_std: { type: 'number' },
        overfit_ratio: { type: 'number' },
        param_count: { type: 'number' },
        elapsed_seconds: { type: 'number' },
        feature_importance_json: { type: 'string' },
        verdict: { type: 'string', description: 'promising, neutral, weak, reject, pending' },
        notes: { type: 'string' },
        result_json: { type: 'string' },
        project_id: { type: 'number' }
      },
      required: ['stage', 'config_json']
    }
  },
  {
    name: 'qcc_experiment_list',
    description: 'List research experiments. Optionally filter by stage.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: 'lgbm, static_cnn, mini_wf, full_wf' },
        limit: { type: 'number', description: 'Max results (default 50)' }
      }
    }
  },
  {
    name: 'qcc_experiment_leaderboard',
    description: 'Get experiments ranked by IC. Filter by stage and/or horizon.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string' },
        horizon_bars: { type: 'number' }
      }
    }
  },
  {
    name: 'qcc_dir_describe',
    description: 'Annotate a directory with its purpose, contents, and important files.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' },
        path: { type: 'string' },
        purpose: { type: 'string' },
        contents_description: { type: 'string' },
        important_files: { type: 'string' }
      },
      required: ['node', 'path']
    }
  },
  {
    name: 'qcc_dir_list',
    description: 'List annotated directories. Optionally filter by node.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string' }
      }
    }
  },
  // --- System ---
  {
    name: 'qcc_alert_send',
    description: 'Create a new alert.',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', description: 'critical, warning, info' },
        source: { type: 'string', description: 'Source component (e.g. "paper_engine", "neptune_gpu")' },
        message: { type: 'string' },
        node: { type: 'string' }
      },
      required: ['severity', 'source', 'message']
    }
  },
  {
    name: 'qcc_alert_list',
    description: 'List alerts. Optionally filter by resolved status.',
    inputSchema: {
      type: 'object',
      properties: {
        resolved: { type: 'boolean', description: 'true=resolved, false=unresolved, omit=all' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'qcc_session_start',
    description: 'Start a new Claude session. Returns previous session context, active jobs, unresolved alerts.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Unique session identifier' },
        context_json: { type: 'string', description: 'Optional context to store' }
      },
      required: ['session_id']
    }
  },
  {
    name: 'qcc_session_end',
    description: 'End the current session with summary and pending tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        summary: { type: 'string' },
        tasks_completed: { type: 'string' },
        tasks_pending: { type: 'string' }
      },
      required: ['session_id']
    }
  },
  {
    name: 'qcc_health_check',
    description: 'Comprehensive health check: node status, active training, paper engine, alerts, scheduled tasks.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'qcc_scheduled_tasks',
    description: 'List scheduled/recurring tasks. Optionally filter by enabled status.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' }
      }
    }
  },
  {
    name: 'qcc_migrate',
    description: 'Run arbitrary SQL migration against the QCC database. Use with caution.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL statement(s) to execute' }
      },
      required: ['sql']
    }
  },
  // --- Job Queue ---
  {
    name: 'qcc_job_submit',
    description: 'Submit a job to the Celery-style queue. The daemon dispatcher will launch it on the target node via SSH. Supports dependency chaining and auto-fold progression.',
    inputSchema: {
      type: 'object',
      properties: {
        job_type: { type: 'string', description: 'training_fold, sweep, validation, data_sync, custom' },
        job_name: { type: 'string', description: 'Human-readable job name' },
        node_name: { type: 'string', description: 'Target node (null = auto-assign based on GPU/CPU need)' },
        requires_gpu: { type: 'boolean', description: 'Whether the job needs a GPU' },
        command: { type: 'string', description: 'Shell command to execute on the target node' },
        working_dir: { type: 'string', description: 'Working directory on the target node' },
        config_json: { type: 'string', description: 'JSON blob with job-specific parameters' },
        priority: { type: 'number', description: 'Priority 1=highest, 10=lowest (default 5)' },
        depends_on: { type: 'number', description: 'Job ID that must complete before this job starts' },
        chain_next: { type: 'string', description: 'JSON: auto-create next job on completion. E.g. {"type":"training_fold","fold":6,"command_template":"python3 run.py --start-fold {fold}","max_fold":94}' },
      },
      required: ['job_name', 'command']
    }
  },
  {
    name: 'qcc_job_status',
    description: 'Get detailed status of a specific job including PID, output tail, duration, and result.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'number', description: 'Job ID to query' }
      },
      required: ['job_id']
    }
  },
  {
    name: 'qcc_job_list',
    description: 'List jobs from the queue. Filter by status (queued/running/completed/failed/cancelled) and/or node.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: queued, assigned, running, completed, failed, cancelled' },
        node: { type: 'string', description: 'Filter by node name' },
        limit: { type: 'number', description: 'Max results (default 50)' }
      }
    }
  },
  {
    name: 'qcc_job_cancel',
    description: 'Cancel a queued or assigned job (cannot cancel running jobs — use qcc_ssh_exec to kill the PID).',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'number', description: 'Job ID to cancel' }
      },
      required: ['job_id']
    }
  },
  {
    name: 'qcc_queue_depth',
    description: 'Get queue depth summary: count of queued and running jobs per node.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  // --- Node History ---
  {
    name: 'qcc_node_history',
    description: 'Query node state history. Returns time-series of status, GPU utilization, memory, temperature, and active jobs. Use action="history" for raw data, "uptime" for uptime stats, "gpu" for GPU utilization series, "gaps" for offline periods.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Node name (neptune, uranus, jupiter, saturn, razer)' },
        action: { type: 'string', description: 'history, uptime, gpu, gaps (default: history)' },
        hours: { type: 'number', description: 'Hours of history to return (default 24, for history/gpu actions)' },
        days: { type: 'number', description: 'Days for uptime calculation (default 7, for uptime action)' }
      },
      required: ['node']
    }
  },
  // --- Pipeline ---
  {
    name: 'qcc_pipeline_status',
    description: 'Check data pipeline status. Shows stages (mbo_raw -> tensor_cache -> predictions -> validated) for a specific date or overview of all dates.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD for specific date. Omit for overview of all dates.' },
        limit: { type: 'number', description: 'Max dates to return in overview (default 60)' }
      }
    }
  },
  {
    name: 'qcc_pipeline_trigger',
    description: 'Manually trigger a pipeline stage for a specific date. Enqueues a job in the job queue.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        stage: { type: 'string', description: 'Pipeline stage: mbo_raw, tensor_cache, predictions, validated' },
        node: { type: 'string', description: 'Target node (default: jupiter)' }
      },
      required: ['date', 'stage']
    }
  },
  // --- Model Versioning ---
  {
    name: 'qcc_model_versions',
    description: 'List model versions. Filter by model_name and/or status (training, validated, deployed, deprecated). Shows version history with IC stats, fold counts, and deployment status.',
    inputSchema: {
      type: 'object',
      properties: {
        model_name: { type: 'string', description: 'Filter by model name (e.g. "standard_cnn_wf_v1")' },
        status: { type: 'string', description: 'Filter: training, validated, deployed, deprecated' }
      }
    }
  },
  {
    name: 'qcc_model_version_create',
    description: 'Create a new model version. Version number auto-increments per model_name. Provide config_id and manifest_id to link to training config and data manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        model_name: { type: 'string', description: 'Model name (e.g. "standard_cnn_wf")' },
        config_id: { type: 'number', description: 'Training config ID' },
        manifest_id: { type: 'number', description: 'Data manifest ID' },
        checkpoint_path: { type: 'string' },
        checkpoint_hash: { type: 'string', description: 'SHA256 of weights file' },
        prediction_dir: { type: 'string' },
        prediction_count: { type: 'number' },
        avg_ic: { type: 'number' },
        min_ic: { type: 'number' },
        max_ic: { type: 'number' },
        total_folds: { type: 'number' },
        oot_sharpe: { type: 'number' },
        status: { type: 'string', description: 'Initial status (default: training)' }
      },
      required: ['model_name']
    }
  },
  {
    name: 'qcc_model_promote',
    description: 'Promote a model version from training to validated. Marks the version as having passed quality checks.',
    inputSchema: {
      type: 'object',
      properties: {
        version_id: { type: 'number', description: 'Model version ID to promote' }
      },
      required: ['version_id']
    }
  },
  {
    name: 'qcc_model_deploy_v2',
    description: 'Deploy a validated model version. Guard rail: refuses if there are unresolved prediction invalidations. Model must be validated first.',
    inputSchema: {
      type: 'object',
      properties: {
        version_id: { type: 'number', description: 'Model version ID to deploy' }
      },
      required: ['version_id']
    }
  },
  {
    name: 'qcc_model_deprecate',
    description: 'Deprecate a model version with a reason. Prevents future deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        version_id: { type: 'number', description: 'Model version ID to deprecate' },
        reason: { type: 'string', description: 'Reason for deprecation' }
      },
      required: ['version_id', 'reason']
    }
  },
  {
    name: 'qcc_prediction_check',
    description: 'Check if predictions are still valid for a model on a specific date. Returns validity status and any relevant invalidations.',
    inputSchema: {
      type: 'object',
      properties: {
        model_name: { type: 'string', description: 'Model name to check' },
        date: { type: 'string', description: 'Date to check (YYYY-MM-DD)' }
      },
      required: ['model_name', 'date']
    }
  },
  {
    name: 'qcc_prediction_invalidate',
    description: 'Invalidate predictions for a model version. Specify reason and optionally which dates are affected (null = all dates).',
    inputSchema: {
      type: 'object',
      properties: {
        version_id: { type: 'number', description: 'Model version ID' },
        reason: { type: 'string', description: 'Reason: retrained, config_changed, data_changed, etc.' },
        affected_dates: { type: 'string', description: 'JSON array of affected dates, or omit for all dates' }
      },
      required: ['version_id', 'reason']
    }
  },
  // --- PnL Tracking ---
  {
    name: 'qcc_pnl_status',
    description: 'Get current PnL status for all cards. Shows latest snapshots (position, cumulative PnL, z-score, conviction) and today\'s daily summary.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'qcc_pnl_history',
    description: 'Get historical PnL data for a specific card. Returns daily PnL records with trades, win rate, drawdown, and Sharpe.',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: 'string', description: 'Card name (e.g. "Card1", "Card4")' },
        days: { type: 'number', description: 'Number of days of history (default 30)' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (alternative to days)' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD' }
      },
      required: ['card']
    }
  },
  {
    name: 'qcc_pnl_summary',
    description: 'Get performance summary across all cards. Includes cumulative PnL, annualized Sharpe, max drawdown, win rate, and trade counts.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'qcc_pnl_summarize_day',
    description: 'Manually trigger daily PnL summarization. Aggregates intraday snapshots into daily_pnl record. Normally runs automatically at 4:01 PM ET.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date to summarize (YYYY-MM-DD). Defaults to today.' }
      }
    }
  },
  // --- Card Performance Profiles ---
  {
    name: 'qcc_card_profile',
    description: 'Get full card performance profile with MAE/MFE/edge decay/conviction analysis. Returns latest profile by default, or all historical profiles with history=true. Use compare=true for side-by-side comparison of all cards.',
    inputSchema: {
      type: 'object',
      properties: {
        card_name: { type: 'string', description: 'Card name (e.g. "Card1", "Card4"). Omit for compare mode.' },
        card_id: { type: 'number', description: 'Card ID (alternative to card_name)' },
        history: { type: 'boolean', description: 'Return all historical profiles (default: false)' },
        compare: { type: 'boolean', description: 'Compare all cards side-by-side (ignores card_name/card_id)' }
      }
    }
  },
  {
    name: 'qcc_card_profile_upsert',
    description: 'Insert or update a card performance profile. Requires card_id, card_name, and profile_date. All metric fields optional.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'number', description: 'Card ID' },
        card_name: { type: 'string', description: 'Card name' },
        profile_date: { type: 'string', description: 'Profile date (YYYY-MM-DD)' },
        sharpe: { type: 'number' }, n_trades: { type: 'number' }, win_rate: { type: 'number' },
        total_pnl: { type: 'number' }, avg_win: { type: 'number' }, avg_loss: { type: 'number' },
        wl_ratio: { type: 'number' }, best_trade: { type: 'number' }, worst_trade: { type: 'number' },
        mae_avg: { type: 'number' }, mae_p50: { type: 'number' }, mae_p75: { type: 'number' },
        mae_p95: { type: 'number' }, mae_worst: { type: 'number' },
        mae_winners_avg: { type: 'number' }, mae_losers_avg: { type: 'number' },
        mfe_avg: { type: 'number' }, mfe_p50: { type: 'number' }, mfe_p75: { type: 'number' },
        mfe_p95: { type: 'number' }, mfe_best: { type: 'number' },
        mfe_winners_avg: { type: 'number' }, mfe_losers_avg: { type: 'number' },
        avg_hold_sec_winners: { type: 'number' }, avg_hold_sec_losers: { type: 'number' },
        avg_hold_sec_all: { type: 'number' },
        edge_decay_json: { type: 'string', description: 'JSON array of {hold_min, sharpe} objects' },
        optimal_hold_min: { type: 'number' },
        max_drawdown: { type: 'number' }, max_consecutive_loss_days: { type: 'number' },
        exit_reasons_json: { type: 'string', description: 'JSON object of exit reason counts' },
        fill_rate: { type: 'number' },
        conviction_exit_tested: { type: 'boolean' },
        conviction_best_config: { type: 'string' },
        conviction_net_pnl_delta: { type: 'number' },
        conviction_verdict: { type: 'string', description: 'deploy, marginal, marginal-positive, not-worth, reject' },
        notes: { type: 'string' }
      },
      required: ['card_id', 'card_name', 'profile_date']
    }
  },
  // --- Training Run Stats ---
  {
    name: 'qcc_training_run_stats',
    description: 'Get or compare training run statistics. Provide job_id for a specific run, or config_id to compare all runs of same config.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'number', description: 'Training job ID to get stats for' },
        config_id: { type: 'number', description: 'Config ID to compare all runs' }
      }
    }
  },
  {
    name: 'qcc_training_run_stats_upsert',
    description: 'Insert or update training run aggregate statistics (IC distribution, loss stats, duration, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        training_job_id: { type: 'number' }, config_id: { type: 'number' },
        total_folds: { type: 'number' }, completed_folds: { type: 'number' }, failed_folds: { type: 'number' },
        ic_mean: { type: 'number' }, ic_median: { type: 'number' }, ic_std: { type: 'number' },
        ic_min: { type: 'number' }, ic_max: { type: 'number' }, ic_p25: { type: 'number' }, ic_p75: { type: 'number' },
        train_loss_mean: { type: 'number' }, val_loss_mean: { type: 'number' },
        overfitting_ratio_mean: { type: 'number' },
        ic_trend_slope: { type: 'number' }, ic_trend_r2: { type: 'number' },
        total_duration_hours: { type: 'number' }, avg_fold_duration_min: { type: 'number' },
        prev_version_ic_mean: { type: 'number' }, ic_improvement_pct: { type: 'number' }
      }
    }
  },
  // --- Training Registration ---
  {
    name: 'qcc_training_register',
    description: 'Register a new training job. Called by remote training scripts when a new process starts. Auto-creates a model entry if model_type is new. Deduplicates by node+pid.',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: 'Node running the training (neptune, uranus, jupiter, saturn, razer)' },
        model_type: { type: 'string', description: 'Model type name (e.g. "standard_cnn_wf", "wider_cnn_wf", "hybrid_v3")' },
        description: { type: 'string', description: 'Human-readable description of this training run' },
        pid: { type: 'number', description: 'Process ID of the training script' },
        total_folds: { type: 'number', description: 'Total number of walk-forward folds' },
        start_fold: { type: 'number', description: 'Starting fold (for resume runs)' }
      },
      required: ['node']
    }
  },
];

// ========================
// TOOL DISPATCH
// ========================

async function handleTool(name, args) {
  args = args || {};

  switch (name) {

    // ---- Compute ----

    case 'qcc_node_status': {
      if (args.node) {
        const node = db.getNode(args.node);
        if (!node) return logAndReturn(name, args, { error: `Node '${args.node}' not found` });
        if (args.live_check && sshPool) {
          const gpuStatus = await sshPool.getGPUStatus(args.node);
          const connStatus = sshPool.getConnectionStatus().find(c => c.name === args.node);
          return logAndReturn(name, args, { ...node, live_gpu: gpuStatus, ssh_connected: connStatus?.connected || false });
        }
        return logAndReturn(name, args, node);
      }
      const nodes = db.getNodes();
      if (args.live_check && sshPool) {
        const connStatus = sshPool.getConnectionStatus();
        const enriched = nodes.map(n => {
          const conn = connStatus.find(c => c.name === n.name);
          return { ...n, ssh_connected: conn?.connected || false, ssh_error: conn?.error || null };
        });
        return logAndReturn(name, args, enriched);
      }
      return logAndReturn(name, args, nodes);
    }

    case 'qcc_ssh_exec': {
      if (!sshPool) {
        return logAndReturn(name, args, { error: 'SSH pool not initialized' });
      }
      const timeoutMs = args.timeout_ms || 30000;
      const result = await sshPool.exec(args.node, args.command, timeoutMs);
      return logAndReturn(name, args, {
        node: args.node,
        command: args.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }

    case 'qcc_launch_training': {
      // Create the job record in DB, but actual SSH launch is Phase 3
      const job = db.createTrainingJob({
        model_id: args.model_id || null,
        node: args.node,
        job_type: 'training',
        description: args.description || 'Training job (pending SSH)',
        config_json: args.config_json || null,
        tmux_session: args.tmux_session || null,
        status: 'queued',
      });
      return logAndReturn(name, args, {
        status: 'queued',
        message: `Job ${job.id} created in queued state. SSH launch not available until Phase 3.`,
        job_id: job.id,
      });
    }

    case 'qcc_stop_training': {
      db.updateTrainingJob(args.job_id, {
        status: 'cancelled',
        error_msg: args.reason || 'Stopped by user',
        completed_at: new Date().toISOString(),
      });
      return logAndReturn(name, args, {
        status: 'stub',
        message: `Job ${args.job_id} marked cancelled in DB. SSH kill not available until Phase 3.`,
      });
    }

    case 'qcc_training_status': {
      const jobs = db.listTrainingJobs(args.status || null, args.node || null);
      return logAndReturn(name, args, { count: jobs.length, jobs });
    }

    // ---- Models ----

    case 'qcc_register_model': {
      const model = db.registerModel(args);
      return logAndReturn(name, args, { message: 'Model registered', model });
    }

    case 'qcc_model_list': {
      const models = db.listModels(args.status || null, args.limit || 50);
      return logAndReturn(name, args, { count: models.length, models });
    }

    case 'qcc_model_folds': {
      const folds = db.getModelFolds(args.model_id, args.limit || 200);
      const icValues = folds.filter(f => f.ic !== null).map(f => f.ic);
      const meanIc = icValues.length > 0 ? (icValues.reduce((a, b) => a + b, 0) / icValues.length).toFixed(6) : null;
      return logAndReturn(name, args, {
        model_id: args.model_id,
        fold_count: folds.length,
        mean_ic: meanIc,
        folds,
      });
    }

    case 'qcc_deploy_model': {
      const result = db.deployModel(args.model_id, args.card_name || null);
      return logAndReturn(name, args, result);
    }

    case 'qcc_model_compare': {
      const ids = String(args.model_ids).split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      if (ids.length === 0) return logAndReturn(name, args, { error: 'No valid model IDs provided' });
      const comparison = db.compareModels(ids);
      return logAndReturn(name, args, comparison);
    }

    // ---- Data ----

    case 'qcc_data_inventory': {
      const files = db.listDataFiles(args.node || null, args.file_type || null, args.date || null);
      return logAndReturn(name, args, { count: files.length, files });
    }

    case 'qcc_data_sync': {
      const task = db.createSyncTask({
        source_node: args.source_node,
        dest_node: args.dest_node,
        file_type: args.file_type || null,
        file_pattern: args.file_pattern || null,
      });
      return logAndReturn(name, args, {
        status: 'stub',
        message: `Sync task ${task.id} created (pending). SSH not available until Phase 3.`,
        task_id: task.id,
      });
    }

    case 'qcc_data_verify': {
      return logAndReturn(name, args, {
        status: 'stub',
        message: `Data verification on ${args.node} not available until Phase 3 (requires SSH).`,
      });
    }

    case 'qcc_data_scan': {
      return logAndReturn(name, args, {
        status: 'stub',
        message: `Data scan on ${args.node}:${args.path || '/'} not available until Phase 3 (requires SSH).`,
      });
    }

    // ---- Cards ----

    case 'qcc_card_list': {
      const cards = db.listCards(args.status || null);
      return logAndReturn(name, args, { count: cards.length, cards });
    }

    case 'qcc_card_config': {
      const card = db.getCard(args.name);
      if (!card) return logAndReturn(name, args, { error: `Card '${args.name}' not found` });
      return logAndReturn(name, args, card);
    }

    case 'qcc_card_create': {
      try {
        const result = db.createCard(args);
        return logAndReturn(name, args, { message: 'Card created', id: result.id });
      } catch (e) {
        return logAndReturn(name, args, { error: e.message });
      }
    }

    // ---- Trading ----

    case 'qcc_paper_status': {
      try {
        if (fs.existsSync(PAPER_STATE_PATH)) {
          const raw = fs.readFileSync(PAPER_STATE_PATH, 'utf8');
          const state = JSON.parse(raw);
          return logAndReturn(name, args, { status: 'running', state });
        }
        return logAndReturn(name, args, { status: 'not_found', message: `Paper state file not found at ${PAPER_STATE_PATH}` });
      } catch (e) {
        return logAndReturn(name, args, { status: 'error', message: e.message });
      }
    }

    case 'qcc_trade_history': {
      const trades = db.listTrades(args.card_name || null, args.date || null, args.limit || 100);
      return logAndReturn(name, args, { count: trades.length, trades });
    }

    case 'qcc_sweep_list': {
      const sweeps = db.listSweeps(args.status || null);
      return logAndReturn(name, args, { count: sweeps.length, sweeps });
    }

    case 'qcc_sweep_results': {
      const results = db.getSweepResults(args.sweep_id, args.limit || 100);
      return logAndReturn(name, args, { sweep_id: args.sweep_id, count: results.length, results });
    }

    // ---- Research ----

    case 'qcc_research_list': {
      const projects = db.listResearch(args.status || null);
      return logAndReturn(name, args, { count: projects.length, projects });
    }

    case 'qcc_research_create': {
      const result = db.createResearch(args);
      return logAndReturn(name, args, { message: 'Research project created', id: result.id });
    }

    case 'qcc_research_update': {
      const { id, ...fields } = args;
      const result = db.updateResearch(id, fields);
      if (!result) return logAndReturn(name, args, { error: 'No valid fields to update' });
      return logAndReturn(name, args, { message: `Research project ${id} updated`, changes: result.changes });
    }

    case 'qcc_experiment_create': {
      const result = db.createExperiment(args);
      return logAndReturn(name, args, { message: 'Experiment logged', id: result.id });
    }

    case 'qcc_experiment_list': {
      const exps = db.listExperiments(args.stage || null, args.limit || 50);
      return logAndReturn(name, args, { count: exps.length, experiments: exps });
    }

    case 'qcc_experiment_leaderboard': {
      const leaders = db.getExperimentLeaderboard(args.stage || null, args.horizon_bars || null);
      return logAndReturn(name, args, { count: leaders.length, leaderboard: leaders });
    }

    case 'qcc_dir_describe': {
      db.describeDir(args);
      return logAndReturn(name, args, { message: `Directory ${args.node}:${args.path} described` });
    }

    case 'qcc_dir_list': {
      const dirs = db.listDirs(args.node || null);
      return logAndReturn(name, args, { count: dirs.length, directories: dirs });
    }

    // ---- System ----

    case 'qcc_alert_send': {
      const alert = db.sendAlert(args.severity, args.source, args.message, args.node || null);
      // Fire-and-forget Discord notification to #system-status
      notifyDiscord(args.severity, args.source, args.message, args.node || null);
      return logAndReturn(name, args, { message: 'Alert created', id: alert.id });
    }

    case 'qcc_alert_list': {
      const resolved = args.resolved !== undefined ? args.resolved : null;
      const alerts = db.listAlerts(resolved, args.limit || 50);
      return logAndReturn(name, args, { count: alerts.length, alerts });
    }

    case 'qcc_session_start': {
      const context = db.startSession(args.session_id, args.context_json || null);
      return logAndReturn(name, args, {
        message: `Session ${args.session_id} started`,
        ...context,
      });
    }

    case 'qcc_session_end': {
      db.endSession(args.session_id, args.summary || '', args.tasks_completed || '', args.tasks_pending || '');
      return logAndReturn(name, args, { message: `Session ${args.session_id} ended` });
    }

    case 'qcc_health_check': {
      const health = db.healthCheck();

      // Also check paper engine
      let paperStatus = { status: 'unknown' };
      try {
        if (fs.existsSync(PAPER_STATE_PATH)) {
          const raw = fs.readFileSync(PAPER_STATE_PATH, 'utf8');
          paperStatus = { status: 'running', state: JSON.parse(raw) };
        } else {
          paperStatus = { status: 'not_found' };
        }
      } catch (e) {
        paperStatus = { status: 'error', message: e.message };
      }

      return logAndReturn(name, args, {
        paper_engine: paperStatus,
        nodes: health.nodes,
        active_jobs: health.active_jobs,
        stale_jobs: health.stale_jobs,
        unresolved_alerts: health.unresolved_alerts,
        scheduled_tasks: health.scheduled_tasks,
        recent_trades: health.recent_trades,
      });
    }

    case 'qcc_scheduled_tasks': {
      const enabled = args.enabled !== undefined ? args.enabled : null;
      const tasks = db.listScheduledTasks(enabled);
      return logAndReturn(name, args, { count: tasks.length, tasks });
    }

    case 'qcc_migrate': {
      try {
        db.migrate(args.sql);
        return logAndReturn(name, args, { message: 'Migration executed successfully' });
      } catch (e) {
        return logAndReturn(name, args, { error: e.message });
      }
    }

    // ---- Job Queue ----

    case 'qcc_job_submit': {
      if (!args.job_name || !args.command) {
        return logAndReturn(name, args, { error: 'job_name and command are required' });
      }
      const result = db.enqueueJob(args);
      log('INFO', `Job enqueued: ${args.job_name} (id=${result.id})`);
      return logAndReturn(name, args, { status: 'queued', job_id: result.id, job_name: args.job_name });
    }

    case 'qcc_job_status': {
      const job = db.getJobStatus(args.job_id);
      if (!job) return logAndReturn(name, args, { error: `Job ${args.job_id} not found` });
      return logAndReturn(name, args, job);
    }

    case 'qcc_job_list': {
      const jobs = db.listJobs(args.status || null, args.node || null, args.limit || 50);
      return logAndReturn(name, args, { count: jobs.length, jobs });
    }

    case 'qcc_job_cancel': {
      const result = db.cancelJob(args.job_id);
      if (result.changes === 0) return logAndReturn(name, args, { error: `Job ${args.job_id} not found or not cancellable` });
      return logAndReturn(name, args, { status: 'cancelled', job_id: args.job_id });
    }

    case 'qcc_queue_depth': {
      return logAndReturn(name, args, db.getQueueDepth());
    }

    // ---- Node History ----

    case 'qcc_node_history': {
      const action = args.action || 'history';
      const nodeName = args.node;

      switch (action) {
        case 'history': {
          const hours = args.hours || 24;
          const history = db.getNodeHistory(nodeName, hours);
          return logAndReturn(name, args, { node: nodeName, hours, count: history.length, history });
        }
        case 'uptime': {
          const days = args.days || 7;
          const uptime = db.getNodeUptime(nodeName, days);
          return logAndReturn(name, args, uptime);
        }
        case 'gpu': {
          const hours = args.hours || 24;
          const gpuHistory = db.getGPUUtilHistory(nodeName, hours);
          return logAndReturn(name, args, { node: nodeName, hours, count: gpuHistory.length, gpu_history: gpuHistory });
        }
        case 'gaps': {
          const gaps = db.getNodeGaps(nodeName);
          return logAndReturn(name, args, gaps);
        }
        default:
          return logAndReturn(name, args, { error: `Unknown action '${action}'. Use: history, uptime, gpu, gaps` });
      }
    }

    // ---- Pipeline ----

    case 'qcc_pipeline_status': {
      if (args.date) {
        const stages = db.getPipelineStatus(args.date);
        return logAndReturn(name, args, { date: args.date, stages });
      }
      const overview = db.getPipelineOverview(args.limit || 60);
      return logAndReturn(name, args, { count: overview.length, dates: overview });
    }

    case 'qcc_pipeline_trigger': {
      const validStages = ['mbo_raw', 'tensor_cache', 'predictions', 'validated'];
      if (!validStages.includes(args.stage)) {
        return logAndReturn(name, args, { error: 'Invalid stage. Must be one of: ' + validStages.join(', ') });
      }
      const targetNode = args.node || 'jupiter';
      const dateCompact = args.date.replace(/-/g, '');
      // mbo_raw is just a registration, not a job
      if (args.stage === 'mbo_raw') {
        db.updatePipelineStage(args.date, 'mbo_raw', 'completed',
          '/home/footb/Lvl3Quant/data/raw/mbo/glbx-mdp3-' + dateCompact + '.mbo.dbn.zst');
        return logAndReturn(name, args, { message: 'Marked mbo_raw as completed for ' + args.date });
      }
      const cmdMap = {
        tensor_cache: 'cd /home/footb/Lvl3Quant && python3 -m data_pipeline.build_tensors --date ' + args.date,
        predictions: 'cd /home/footb/Lvl3Quant && python3 -m data_pipeline.generate_predictions --date ' + args.date,
        validated: 'cd /home/footb/Lvl3Quant && python3 -m data_pipeline.validate_oot --date ' + args.date,
      };
      const pipeJob = db.enqueueJob({
        job_type: 'pipeline',
        job_name: args.stage + ' ' + args.date + ' (manual)',
        node_name: targetNode,
        requires_gpu: args.stage === 'predictions',
        command: cmdMap[args.stage],
        working_dir: '/home/footb/Lvl3Quant',
        config_json: JSON.stringify({ pipeline_stage: args.stage, date: args.date, manual: true }),
        priority: 3,
      });
      db.updatePipelineStage(args.date, args.stage, 'pending');
      db.linkPipelineJob(args.date, args.stage, pipeJob.id);
      return logAndReturn(name, args, {
        message: 'Triggered ' + args.stage + ' for ' + args.date,
        job_id: pipeJob.id,
        node: targetNode,
      });
    }

    // ---- Model Versioning ----

    case 'qcc_model_versions': {
      const versions = db.listModelVersions(args.model_name || null, args.status || null);
      return logAndReturn(name, args, { count: versions.length, versions });
    }

    case 'qcc_model_version_create': {
      try {
        const result = db.createModelVersion(args);
        return logAndReturn(name, args, { message: 'Model version created', ...result });
      } catch (e) {
        return logAndReturn(name, args, { error: e.message });
      }
    }

    case 'qcc_model_promote': {
      const result = db.promoteModel(args.version_id);
      if (result.error) return logAndReturn(name, args, { error: result.error });
      return logAndReturn(name, args, { message: `Model ${result.model_name} v${result.version} promoted to validated`, ...result });
    }

    case 'qcc_model_deploy_v2': {
      const result = db.deployModel_v2(args.version_id);
      if (result.error) {
        return logAndReturn(name, args, {
          error: result.error,
          unresolved_invalidations: result.unresolved_invalidations || [],
        });
      }
      return logAndReturn(name, args, { message: `Model ${result.model_name} v${result.version} deployed`, ...result });
    }

    case 'qcc_model_deprecate': {
      const result = db.deprecateModel(args.version_id, args.reason);
      if (result.error) return logAndReturn(name, args, { error: result.error });
      return logAndReturn(name, args, { message: `Model ${result.model_name} v${result.version} deprecated`, ...result });
    }

    case 'qcc_prediction_check': {
      const result = db.checkPredictionValidity(args.model_name, args.date);
      return logAndReturn(name, args, result);
    }

    case 'qcc_prediction_invalidate': {
      let dates = null;
      if (args.affected_dates) {
        try { dates = JSON.parse(args.affected_dates); } catch (e) {
          return logAndReturn(name, args, { error: 'affected_dates must be a valid JSON array of date strings' });
        }
      }
      const result = db.invalidatePredictions(args.version_id, args.reason, dates);
      if (result.error) return logAndReturn(name, args, { error: result.error });
      return logAndReturn(name, args, { message: 'Predictions invalidated', ...result });
    }

    // ---- PnL Tracking ----

    case 'qcc_pnl_status': {
      const snapshots = db.getLatestSnapshots();
      const today = new Date().toISOString().split('T')[0];
      const dailyPnl = db.getDailyPnl(today);

      // Also read live state for real-time info
      let liveState = null;
      try {
        if (fs.existsSync(PAPER_STATE_PATH)) {
          liveState = JSON.parse(fs.readFileSync(PAPER_STATE_PATH, 'utf8'));
        }
      } catch (e) { /* ignore */ }

      return logAndReturn(name, args, {
        date: today,
        live_engine: liveState ? 'running' : 'stopped',
        latest_snapshots: snapshots,
        daily_pnl: dailyPnl,
      });
    }

    case 'qcc_pnl_history': {
      const cardRow = db.getCard(args.card);
      if (!cardRow) return logAndReturn(name, args, { error: `Card '${args.card}' not found` });

      let startDate = args.start_date || null;
      const endDate = args.end_date || null;
      if (!startDate && args.days) {
        startDate = new Date(Date.now() - (args.days || 30) * 86400000).toISOString().split('T')[0];
      } else if (!startDate) {
        startDate = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      }

      const history = db.getPnlHistory(cardRow.id, startDate, endDate);
      const drawdown = db.getDrawdown(cardRow.id);

      return logAndReturn(name, args, {
        card: args.card,
        card_id: cardRow.id,
        start_date: startDate,
        end_date: endDate,
        days_returned: history.length,
        history,
        drawdown,
      });
    }

    case 'qcc_pnl_summary': {
      const summary = db.getPerformanceSummary();
      return logAndReturn(name, args, {
        cards: summary,
        total_cards: summary.length,
        total_net_pnl: summary.reduce((s, c) => s + (c.total_net_pnl || 0), 0),
        total_trades: summary.reduce((s, c) => s + (c.total_trades || 0), 0),
      });
    }

    case 'qcc_pnl_summarize_day': {
      const date = args.date || new Date().toISOString().split('T')[0];
      try {
        const results = db.summarizeDay(date);
        return logAndReturn(name, args, {
          message: `Summarized ${results.length} cards for ${date}`,
          date,
          cards: results,
          total_net_pnl: results.reduce((s, r) => s + (r.net_pnl || 0), 0),
        });
      } catch (e) {
        return logAndReturn(name, args, { error: `Summarize failed: ${e.message}` });
      }
    }

    // ---- Card Performance Profiles ----

    case 'qcc_card_profile': {
      if (args.compare) {
        const result = db.compareCards();
        return logAndReturn(name, args, result);
      }
      let cardId = args.card_id;
      if (!cardId && args.card_name) {
        const card = db.getCard(args.card_name);
        if (!card) return logAndReturn(name, args, { error: `Card '${args.card_name}' not found` });
        cardId = card.id;
      }
      if (!cardId) return logAndReturn(name, args, { error: 'Provide card_name, card_id, or compare=true' });

      if (args.history) {
        const profiles = db.getCardProfileHistory(cardId);
        return logAndReturn(name, args, { count: profiles.length, profiles });
      }
      const profile = db.getCardProfile(cardId);
      if (!profile) return logAndReturn(name, args, { error: `No performance profile found for card_id ${cardId}` });
      return logAndReturn(name, args, profile);
    }

    case 'qcc_card_profile_upsert': {
      try {
        const result = db.upsertCardProfile(args);
        return logAndReturn(name, args, { message: 'Card profile upserted', ...result });
      } catch (e) {
        return logAndReturn(name, args, { error: e.message });
      }
    }

    // ---- Training Run Stats ----

    case 'qcc_training_run_stats': {
      if (args.config_id) {
        const result = db.compareTrainingRuns(args.config_id);
        return logAndReturn(name, args, result);
      }
      if (args.job_id) {
        const stats = db.getTrainingRunStats(args.job_id);
        if (!stats) return logAndReturn(name, args, { error: `No stats found for job_id ${args.job_id}` });
        return logAndReturn(name, args, stats);
      }
      return logAndReturn(name, args, { error: 'Provide job_id or config_id' });
    }

    case 'qcc_training_run_stats_upsert': {
      try {
        const result = db.upsertTrainingRunStats(args);
        return logAndReturn(name, args, { message: 'Training run stats upserted', ...result });
      } catch (e) {
        return logAndReturn(name, args, { error: e.message });
      }
    }

    // ---- Training Registration ----

    case 'qcc_training_register': {
      const { node, model_type, description, pid, total_folds, start_fold } = args;
      if (!node) return logAndReturn(name, args, { error: 'node is required' });

      // Find or create model entry
      let modelId = null;
      if (model_type) {
        const existing = db.db.prepare(
          "SELECT id FROM models WHERE name = ? AND status = 'training' ORDER BY created_at DESC LIMIT 1"
        ).get(model_type);
        if (existing) {
          modelId = existing.id;
        } else {
          const m = db.registerModel({
            name: model_type,
            architecture: model_type.includes('wider') ? 'wider_cnn'
              : model_type.includes('hybrid') ? 'hybrid' : 'cnn',
            node,
            total_folds: total_folds || null,
            status: 'training',
          });
          modelId = m.id;
        }
      }

      // Deduplicate by node+pid
      if (pid) {
        const dup = db.db.prepare(
          "SELECT id FROM training_jobs WHERE node = ? AND pid = ? AND status = 'running'"
        ).get(node, pid);
        if (dup) return logAndReturn(name, args, { status: 'already_registered', job_id: dup.id });
      }

      const job = db.createTrainingJob({
        model_id: modelId,
        node,
        job_type: 'training',
        description: description || (model_type ? `${model_type} WF` : 'Training job'),
        pid: pid || null,
        start_fold: start_fold || null,
        total_folds: total_folds || null,
        status: 'running',
      });

      return logAndReturn(name, args, { status: 'registered', job_id: job.id, model_id: modelId });
    }

    default:
      return null;
  }
}

// ========================
// JSON-RPC MAIN LOOP
// ========================

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

log('INFO', 'QCC MCP Server starting');

// Initialize database
try {
  db = new QCCDatabase(DB_PATH);
  const seeded = db.seedIfEmpty();
  log('INFO', `Database initialized at ${DB_PATH}`, { seeded });
  if (seeded) {
    log('INFO', 'Seed data inserted (compute nodes, cards, scheduled tasks, research projects, card profiles, training stats)');
  } else {
    // Seed performance data for existing DBs that don't have it yet
    const profilesSeeded = db.seedCardProfiles();
    const statsSeeded = db.seedTrainingRunStats();
    if (profilesSeeded || statsSeeded) {
      log('INFO', 'Seeded performance metadata', { profilesSeeded, statsSeeded });
    }
  }

  // Initialize SSH connection pool
  sshPool = new QCCSSHPool(db);
  sshPool.init(); // Fix DB usernames from remote_servers.json
  sshPool.startHeartbeat(60000);
  log('INFO', 'SSH connection pool initialized with 60s heartbeat');
} catch (e) {
  log('ERROR', 'Failed to initialize database', { error: e.message, stack: e.stack });
  process.stderr.write(`QCC DB init error: ${e.message}\n`);
  process.exit(1);
}

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;

    log('DEBUG', `RPC: ${method}`, { id });

    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'qcc-server', version: '1.1.0' },
      });
    }
    else if (method === 'tools/list') {
      respond(id, { tools: TOOLS });
    }
    else if (method === 'tools/call') {
      const { name, arguments: args } = params;
      log('INFO', `Tool call: ${name}`, { args: args ? JSON.stringify(args).slice(0, 300) : null });

      handleTool(name, args).then(result => {
        if (result) {
          respond(id, result);
        } else {
          respondError(id, -32601, `Unknown tool: ${name}`);
        }
      }).catch(err => {
        log('ERROR', `Tool ${name} error`, { error: err.message, stack: err.stack });
        respondError(id, -32000, `Tool error: ${err.message}`);
      });
    }
    else if (method === 'notifications/initialized') {
      // No response needed for notifications
    }
    else {
      if (id !== undefined) {
        respondError(id, -32601, `Unknown method: ${method}`);
      }
    }
  } catch (e) {
    log('ERROR', 'Parse/dispatch error', { error: e.message, stack: e.stack, line: line.slice(0, 300) });
    process.stderr.write(`QCC parse error: ${e.message}\n`);
  }
});

rl.on('close', () => {
  log('INFO', 'QCC MCP Server stdin closed');
  if (sshPool) sshPool.destroy();
  if (db) db.close();
});

process.on('exit', (code) => log('INFO', `QCC MCP Server exiting with code ${code}`));
process.on('uncaughtException', (e) => {
  log('ERROR', 'Uncaught exception', { error: e.message, stack: e.stack });
  process.stderr.write(`QCC uncaught: ${e.message}\n`);
});

log('INFO', 'QCC MCP Server ready (v1.1.0 - SSH Pool Active)');
process.stderr.write('QCC MCP Server started (v1.1.0 - SSH Pool Active)\n');
