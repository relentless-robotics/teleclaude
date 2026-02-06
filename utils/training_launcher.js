/**
 * Training Task Launcher
 *
 * Specialized launcher for ML/quant training jobs.
 * Handles Python environments, GPU monitoring, progress parsing.
 */

const path = require('path');
const fs = require('fs');
const {
  launchTask,
  getTask,
  checkTaskStatus,
  getTaskLogTail,
  saveCheckpoint,
  logTaskEvent,
  listTasks,
  LOGS_DIR
} = require('./persistent_tasks');

/**
 * Launch a Python training task
 *
 * @param {Object} options
 * @param {string} options.name - Training job name (e.g., "Lvl3Quant Hard Mode")
 * @param {string} options.script - Python script path
 * @param {string[]} options.args - Script arguments
 * @param {string} options.workingDir - Project directory
 * @param {string} options.pythonEnv - Python environment (conda env name or venv path)
 * @param {string} options.priority - URGENT, DAILY, WEEKLY
 * @param {Object} options.metadata - Additional metadata
 * @returns {Object} Task info
 */
function launchTraining(options) {
  const {
    name,
    script,
    args = [],
    workingDir,
    pythonEnv,
    priority = 'URGENT',
    metadata = {}
  } = options;

  // Build command
  let command;
  if (pythonEnv) {
    // Conda environment
    command = `conda activate ${pythonEnv} && python "${script}" ${args.join(' ')}`;
  } else {
    // Default Python
    command = `python "${script}" ${args.join(' ')}`;
  }

  // Add training-specific metadata
  const trainingMetadata = {
    ...metadata,
    script,
    args,
    pythonEnv,
    trainingType: 'ml',
    gpuExpected: true
  };

  return launchTask({
    name,
    type: 'training',
    command,
    workingDir,
    priority,
    metadata: trainingMetadata
  });
}

/**
 * Launch a Lvl3Quant training run
 */
function launchLvl3Quant(options = {}) {
  const {
    mode = 'light',
    epochs,
    priority = 'URGENT'
  } = options;

  const workingDir = 'C:\\Users\\Footb\\Documents\\Github\\Lvl3Quant';
  const args = [`--mode=${mode}`];
  if (epochs) args.push(`--epochs=${epochs}`);

  return launchTraining({
    name: `Lvl3Quant ${mode} mode`,
    script: 'run_training.py',
    args,
    workingDir,
    priority,
    metadata: {
      project: 'Lvl3Quant',
      mode,
      epochs
    }
  });
}

/**
 * Launch a MacroStrategy GA run
 */
function launchMacroStrategy(options = {}) {
  const {
    script = 'run.py',
    priority = 'URGENT'
  } = options;

  const workingDir = 'C:\\Users\\Footb\\Documents\\Github\\MacroStrategy';

  return launchTraining({
    name: `MacroStrategy ${script}`,
    script,
    workingDir,
    priority,
    metadata: {
      project: 'MacroStrategy',
      script
    }
  });
}

/**
 * Parse training progress from log content
 * Extracts epochs, loss, metrics etc.
 */
function parseTrainingProgress(logContent) {
  const progress = {
    currentEpoch: null,
    totalEpochs: null,
    currentLoss: null,
    metrics: {},
    lastLine: null
  };

  const lines = logContent.split('\n').filter(l => l.trim());
  if (lines.length === 0) return progress;

  progress.lastLine = lines[lines.length - 1];

  // Parse epoch progress (various formats)
  // Format: "Epoch 5/100" or "epoch: 5" or "[5/100]"
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].toLowerCase();

    // Epoch X/Y format
    const epochMatch = line.match(/epoch\s*[:\s]*(\d+)\s*[\/of]\s*(\d+)/i);
    if (epochMatch) {
      progress.currentEpoch = parseInt(epochMatch[1]);
      progress.totalEpochs = parseInt(epochMatch[2]);
      break;
    }

    // Just epoch number
    const simpleEpochMatch = line.match(/epoch\s*[:\s]*(\d+)/i);
    if (simpleEpochMatch && !progress.currentEpoch) {
      progress.currentEpoch = parseInt(simpleEpochMatch[1]);
    }
  }

  // Parse loss values
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];

    const lossMatch = line.match(/loss[:\s]*([0-9.]+)/i);
    if (lossMatch) {
      progress.currentLoss = parseFloat(lossMatch[1]);
      break;
    }
  }

  // Parse common metrics
  const metricPatterns = [
    { name: 'accuracy', pattern: /accuracy[:\s]*([0-9.]+)/i },
    { name: 'val_loss', pattern: /val[_\s]?loss[:\s]*([0-9.]+)/i },
    { name: 'val_accuracy', pattern: /val[_\s]?acc(?:uracy)?[:\s]*([0-9.]+)/i },
    { name: 'sharpe', pattern: /sharpe[:\s]*([0-9.-]+)/i },
    { name: 'r2', pattern: /r2[:\s]*([0-9.-]+)/i },
    { name: 'ic', pattern: /\bic[:\s]*([0-9.-]+)/i }
  ];

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    for (const { name, pattern } of metricPatterns) {
      if (!progress.metrics[name]) {
        const match = line.match(pattern);
        if (match) {
          progress.metrics[name] = parseFloat(match[1]);
        }
      }
    }
  }

  return progress;
}

/**
 * Get training status with parsed progress
 */
function getTrainingStatus(taskId) {
  const task = checkTaskStatus(taskId);
  if (!task) return null;

  const logTail = getTaskLogTail(taskId, 100);
  const progress = parseTrainingProgress(logTail);

  return {
    ...task,
    progress,
    logTail: logTail.split('\n').slice(-20).join('\n') // Last 20 lines
  };
}

/**
 * List all training tasks
 */
function listTrainingTasks(options = {}) {
  return listTasks({ ...options, type: 'training' });
}

/**
 * Get active training tasks with progress
 */
function getActiveTrainings() {
  const tasks = listTasks({ status: 'running', type: 'training' });
  return tasks.map(task => getTrainingStatus(task.id));
}

/**
 * Format training status for Discord message
 */
function formatTrainingForDiscord(status) {
  if (!status) return 'Task not found';

  const lines = [
    `**${status.name}** (${status.id})`,
    `Status: ${status.status.toUpperCase()}`,
    `Started: ${status.startedAt}`
  ];

  if (status.progress) {
    const p = status.progress;
    if (p.currentEpoch !== null) {
      const epochStr = p.totalEpochs
        ? `${p.currentEpoch}/${p.totalEpochs}`
        : `${p.currentEpoch}`;
      lines.push(`Epoch: ${epochStr}`);
    }
    if (p.currentLoss !== null) {
      lines.push(`Loss: ${p.currentLoss.toFixed(6)}`);
    }
    if (Object.keys(p.metrics).length > 0) {
      const metricsStr = Object.entries(p.metrics)
        .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(4) : v}`)
        .join(', ');
      lines.push(`Metrics: ${metricsStr}`);
    }
    if (p.lastLine) {
      lines.push(`Last: ${p.lastLine.slice(0, 100)}`);
    }
  }

  if (status.completedAt) {
    lines.push(`Completed: ${status.completedAt}`);
    if (status.exitCode !== null) {
      lines.push(`Exit Code: ${status.exitCode}`);
    }
  }

  lines.push(`Log: ${status.logFile}`);

  return lines.join('\n');
}

module.exports = {
  launchTraining,
  launchLvl3Quant,
  launchMacroStrategy,
  parseTrainingProgress,
  getTrainingStatus,
  listTrainingTasks,
  getActiveTrainings,
  formatTrainingForDiscord
};
