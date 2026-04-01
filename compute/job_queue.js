#!/usr/bin/env node
/**
 * Job Queue Module — Per-node experiment queue for the quant HFT research cluster.
 *
 * Each node gets a dedicated queue file: compute/job_queue_{node}.json
 * Provides atomic read-modify-write operations, priority sorting, and status tracking.
 *
 * Schema for each job object:
 *   {
 *     id           : string  — unique job ID (job_<timestamp_base36>_<rand>)
 *     priority     : number  — 1=highest, 10=lowest
 *     name         : string  — short identifier (snake_case)
 *     description  : string  — human-readable description
 *     command      : string  — shell command to run on the node
 *     node         : string  — target node name
 *     status       : 'queued'|'running'|'done'|'failed'
 *     created_at   : ISO8601
 *     started_at   : ISO8601|null
 *     completed_at : ISO8601|null
 *     result_summary: string|null
 *     cwd          : string|null — working directory override
 *     tags         : string[]   — optional labels (e.g. ['fill_sim', 'lgbm'])
 *   }
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ============================================================================
// CONSTANTS
// ============================================================================

const QUEUE_DIR = path.join(__dirname);  // compute/

const NODES = ['neptune', 'uranus', 'razer', 'jupiter', 'saturn'];

// ============================================================================
// NODE CAPABILITY METADATA
// ============================================================================

/**
 * Hardware profiles and workload affinities for each compute node.
 * Used by bestNode() to route job types to the most appropriate machine.
 *
 *   strengths : job types this node is well-suited for
 *   avoid     : job types this node should NOT run
 */
const NODE_CAPABILITIES = {
  neptune: {
    gpu:       'RTX 3090 24GB',
    cpu_cores: 16,
    ram_gb:    64,
    os:        'Windows',
    strengths: ['cnn_training', 'inference', 'paper_engine', 'production'],
    avoid:     ['heavy_cpu_sweep'],
  },
  uranus: {
    gpu:       'RTX 5090 32GB',
    cpu_cores: 32,
    ram_gb:    128,
    os:        'Windows',
    strengths: ['heavy_training', 'large_models', 'multi_horizon', 'wf_folds', 'mfe_mae'],
    avoid:     ['cpu_only_tasks'],
  },
  razer: {
    gpu:       'RTX 3070 8GB',
    cpu_cores: 8,
    ram_gb:    16,
    os:        'Windows',
    strengths: ['fast_backtest', 'lgbm', 'gpu_sim', 'small_models', 'math_strategy', 'gbm'],
    avoid:     ['large_cnn', 'heavy_memory'],
  },
  jupiter: {
    gpu:       null,
    cpu_cores: 16,
    ram_gb:    64,
    os:        'Linux (WSL2)',
    strengths: ['fill_sim', 'lgbm', 'data_processing', 'large_sweeps', 'montecarlo', 'oot'],
    avoid:     ['gpu_training'],
  },
  saturn: {
    gpu:       null,
    cpu_cores: 8,
    ram_gb:    32,
    os:        'Linux',
    strengths: ['sweeps', 'aggregation', 'monte_carlo', 'optuna_sweep', 'parameter_search'],
    avoid:     ['gpu_training', 'heavy_memory'],
  },
};

/**
 * Recommend the best node for a given job type.
 *
 * Scoring:
 *   +2 for each strength match
 *   -5 for each avoid match (hard penalty)
 *
 * Returns the highest-scoring node name.
 *
 * @param {string} jobType  — e.g. 'fill_sim', 'cnn_training', 'lgbm'
 * @returns {string}        — node name (e.g. 'jupiter')
 *
 * @example
 *   bestNode('fill_sim')       // → 'jupiter'
 *   bestNode('cnn_training')   // → 'neptune'
 *   bestNode('heavy_training') // → 'uranus'
 *   bestNode('lgbm')           // → 'razer' or 'jupiter' (tied)
 *   bestNode('sweeps')         // → 'saturn'
 */
function bestNode(jobType) {
  const jt = jobType.toLowerCase().replace(/[-\s]/g, '_');

  let best = null;
  let bestScore = -Infinity;

  for (const [node, caps] of Object.entries(NODE_CAPABILITIES)) {
    let score = 0;
    for (const s of caps.strengths) {
      if (jt.includes(s) || s.includes(jt)) score += 2;
    }
    for (const a of caps.avoid) {
      if (jt.includes(a) || a.includes(jt)) score -= 5;
    }
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }

  // Fallback: if no match at all (score still -Inf or 0 tie), prefer jupiter for CPU, neptune for GPU
  if (bestScore <= 0) {
    const gpuTypes = ['train', 'cnn', 'model', 'inference', 'gpu'];
    const isGpu = gpuTypes.some(t => jt.includes(t));
    best = isGpu ? 'neptune' : 'jupiter';
  }

  return best;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Return the path to the per-node queue file.
 */
function queuePath(node) {
  return path.join(QUEUE_DIR, `job_queue_${node}.json`);
}

/**
 * Generate a unique job ID.
 */
function genId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Atomically load a queue file. Returns [] if file is missing or corrupt.
 * @param {string} node
 * @returns {object[]}
 */
function loadQueue(node) {
  const fp = queuePath(node);
  try {
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.error(`[job_queue] Failed to load queue for ${node}: ${e.message}`);
  }
  return [];
}

/**
 * Atomically save a queue file (write to .tmp then rename for atomicity).
 * @param {string} node
 * @param {object[]} queue
 */
function saveQueue(node, queue) {
  const fp   = queuePath(node);
  const tmp  = fp + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
  } catch (e) {
    // Fallback: direct write if rename fails (e.g., cross-device)
    try {
      fs.writeFileSync(fp, JSON.stringify(queue, null, 2), 'utf8');
    } catch (e2) {
      console.error(`[job_queue] Failed to save queue for ${node}: ${e2.message}`);
    }
    // Clean up tmp if it exists
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * Sort a queue array in place: by priority asc, then created_at asc.
 * Running/done/failed jobs are kept at the top of the array (chronological)
 * but below queued jobs for display purposes. Sort order: queued first (by priority),
 * then running, then done/failed.
 */
function sortQueue(queue) {
  const ORDER = { queued: 0, running: 1, done: 2, failed: 2 };
  queue.sort((a, b) => {
    const sa = ORDER[a.status] ?? 3;
    const sb = ORDER[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    // Both same status category: sort by priority, then creation time
    if (sa === 0) { // queued
      if (a.priority !== b.priority) return a.priority - b.priority;
    }
    return new Date(a.created_at) - new Date(b.created_at);
  });
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Read the full queue for a node.
 * @param {string} node
 * @returns {object[]} — full queue array (all statuses)
 */
function getQueue(node) {
  _ensureQueueFile(node);
  return loadQueue(node);
}

/**
 * Add a job to a node's queue.
 * The job is sorted by priority after insertion.
 *
 * @param {string} node
 * @param {object} job — may omit id/status/timestamps (will be auto-populated)
 * @returns {object} — the completed job object that was enqueued
 */
function addJob(node, job) {
  _ensureQueueFile(node);
  const queue = loadQueue(node);

  const entry = {
    id:             job.id             || genId(),
    priority:       typeof job.priority === 'number' ? job.priority : 5,
    name:           job.name           || job.id      || 'unnamed',
    description:    job.description    || 'No description',
    command:        job.command        || '',
    node:           node,
    status:         'queued',
    created_at:     job.created_at     || new Date().toISOString(),
    started_at:     null,
    completed_at:   null,
    result_summary: null,
    cwd:            job.cwd            || null,
    tags:           Array.isArray(job.tags) ? job.tags : [],
  };

  // Prevent duplicate IDs
  if (queue.some(j => j.id === entry.id)) {
    entry.id = genId();
  }

  queue.push(entry);
  sortQueue(queue);
  saveQueue(node, queue);
  return entry;
}

/**
 * Pop the next queued job, mark it as running, and return it.
 * Returns null if no queued jobs exist.
 *
 * @param {string} node
 * @returns {object|null}
 */
function popNext(node) {
  _ensureQueueFile(node);
  const queue = loadQueue(node);

  const idx = queue.findIndex(j => j.status === 'queued');
  if (idx === -1) return null;

  queue[idx].status     = 'running';
  queue[idx].started_at = new Date().toISOString();

  saveQueue(node, queue);
  return queue[idx];
}

/**
 * Mark a running job as done with an optional result summary.
 *
 * @param {string} node
 * @param {string} jobId
 * @param {string} [result] — short result text (e.g. 'IC=0.178, Sortino=2.1')
 * @returns {object|null} — updated job or null if not found
 */
function completeJob(node, jobId, result = null) {
  _ensureQueueFile(node);
  const queue = loadQueue(node);

  const job = queue.find(j => j.id === jobId);
  if (!job) return null;

  job.status         = 'done';
  job.completed_at   = new Date().toISOString();
  job.result_summary = result || 'Completed';

  sortQueue(queue);
  saveQueue(node, queue);
  return job;
}

/**
 * Mark a running or queued job as failed.
 *
 * @param {string} node
 * @param {string} jobId
 * @param {string} [error] — error message
 * @returns {object|null}
 */
function failJob(node, jobId, error = null) {
  _ensureQueueFile(node);
  const queue = loadQueue(node);

  const job = queue.find(j => j.id === jobId);
  if (!job) return null;

  job.status         = 'failed';
  job.completed_at   = new Date().toISOString();
  job.result_summary = error ? `FAILED: ${error}` : 'FAILED';

  sortQueue(queue);
  saveQueue(node, queue);
  return job;
}

/**
 * Return the count of jobs in 'queued' status (not running/done/failed).
 *
 * @param {string} node
 * @returns {number}
 */
function queueDepth(node) {
  const queue = loadQueue(node);
  return queue.filter(j => j.status === 'queued').length;
}

/**
 * Return a summary of all node queues:
 *   { node: { depth, running_job, last_completed } }
 *
 * @returns {object}
 */
function allQueues() {
  const summary = {};
  for (const node of NODES) {
    _ensureQueueFile(node);
    const queue = loadQueue(node);

    const queued  = queue.filter(j => j.status === 'queued');
    const running = queue.find(j => j.status === 'running') || null;

    // Last completed or failed
    const finished = queue
      .filter(j => j.status === 'done' || j.status === 'failed')
      .sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
    const lastCompleted = finished[0] || null;

    summary[node] = {
      depth:          queued.length,
      running_job:    running ? { id: running.id, name: running.name, started_at: running.started_at } : null,
      last_completed: lastCompleted ? {
        id:            lastCompleted.id,
        name:          lastCompleted.name,
        status:        lastCompleted.status,
        completed_at:  lastCompleted.completed_at,
        result_summary: lastCompleted.result_summary,
      } : null,
      next_in_queue: queued.length > 0 ? { id: queued[0].id, name: queued[0].name, priority: queued[0].priority } : null,
    };
  }
  return summary;
}

/**
 * Re-queue a failed job (reset status to 'queued', clear timestamps).
 * @param {string} node
 * @param {string} jobId
 * @returns {object|null}
 */
function retryJob(node, jobId) {
  _ensureQueueFile(node);
  const queue = loadQueue(node);

  const job = queue.find(j => j.id === jobId);
  if (!job) return null;

  job.status         = 'queued';
  job.started_at     = null;
  job.completed_at   = null;
  job.result_summary = null;

  sortQueue(queue);
  saveQueue(node, queue);
  return job;
}

/**
 * Remove a job from the queue entirely.
 * @param {string} node
 * @param {string} jobId
 * @returns {boolean}
 */
function removeJob(node, jobId) {
  _ensureQueueFile(node);
  const queue = loadQueue(node);
  const idx = queue.findIndex(j => j.id === jobId);
  if (idx === -1) return false;

  queue.splice(idx, 1);
  saveQueue(node, queue);
  return true;
}

/**
 * Mark a specific job as 'running' by its ID (used by researcher agents when
 * they directly launch a job via launchExperiment rather than using popNext).
 * @param {string} node
 * @param {string} jobId
 * @returns {object|null} — updated job or null if not found
 */
function markJobRunning(node, jobId) {
  _ensureQueueFile(node);
  const queue = loadQueue(node);
  const job   = queue.find(j => j.id === jobId);
  if (!job) return null;

  job.status     = 'running';
  job.started_at = new Date().toISOString();

  saveQueue(node, queue);
  return job;
}

/**
 * Drain all queued (not running/done) jobs from a node's queue.
 * @param {string} node
 * @returns {number} number of jobs removed
 */
function drainQueue(node) {
  _ensureQueueFile(node);
  const queue = loadQueue(node);
  const before = queue.length;
  const kept = queue.filter(j => j.status !== 'queued');
  saveQueue(node, kept);
  return before - kept.length;
}

// ============================================================================
// INTERNAL
// ============================================================================

/**
 * Ensure the queue file exists (creates empty array if missing).
 */
function _ensureQueueFile(node) {
  const fp = queuePath(node);
  if (!fs.existsSync(fp)) {
    try {
      fs.writeFileSync(fp, '[]', 'utf8');
    } catch (e) {
      console.error(`[job_queue] Could not create queue file for ${node}: ${e.message}`);
    }
  }
}

// Initialize all queue files on require
for (const node of NODES) {
  _ensureQueueFile(node);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  NODES,
  NODE_CAPABILITIES,
  bestNode,
  queuePath,
  getQueue,
  addJob,
  popNext,
  markJobRunning,
  completeJob,
  failJob,
  queueDepth,
  allQueues,
  retryJob,
  removeJob,
  drainQueue,
};
