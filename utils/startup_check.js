/**
 * Startup Check Module
 *
 * Called at the beginning of each Claude session to:
 * 1. Check status of all persistent tasks
 * 2. Report any active or recently completed tasks
 * 3. Clean up old completed tasks
 * 4. Integrate with memory system
 */

const {
  checkAllActiveTasks,
  getTaskSummary,
  archiveCompletedTasks,
  listTasks,
  getTaskLogTail
} = require('./persistent_tasks');

const {
  getActiveTrainings,
  formatTrainingForDiscord
} = require('./training_launcher');

/**
 * Perform full startup check
 * Returns formatted report for Discord
 */
async function runStartupCheck() {
  const report = {
    activeTasks: [],
    recentlyCompleted: [],
    warnings: [],
    archived: 0
  };

  try {
    // Check all active tasks and update their status
    const activeTasks = checkAllActiveTasks();

    // Get training tasks with progress
    const trainings = getActiveTrainings();
    report.activeTasks = trainings.filter(t => t && t.status === 'running');

    // Get recently completed (last 24 hours)
    const allTasks = listTasks({ includeCompleted: true });
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    report.recentlyCompleted = allTasks.filter(t => {
      if (t.status !== 'completed' && t.status !== 'failed') return false;
      if (!t.completedAt) return false;
      return new Date(t.completedAt) > oneDayAgo;
    });

    // Check for tasks that went from running to unknown (crashed?)
    const unknownTasks = allTasks.filter(t => t.status === 'unknown');
    if (unknownTasks.length > 0) {
      report.warnings.push(`${unknownTasks.length} task(s) ended with unknown status (possible crash)`);
    }

    // Archive old completed tasks (older than 7 days)
    const archiveResult = archiveCompletedTasks(7);
    report.archived = archiveResult.archived;

  } catch (error) {
    report.warnings.push(`Error during startup check: ${error.message}`);
  }

  return report;
}

/**
 * Format startup report for Discord
 */
function formatStartupReport(report) {
  const lines = ['**Persistent Tasks Status:**', ''];

  // Active tasks
  if (report.activeTasks.length > 0) {
    lines.push(`**Active Tasks (${report.activeTasks.length}):**`);
    for (const task of report.activeTasks) {
      lines.push(formatTrainingForDiscord(task));
      lines.push('');
    }
  } else {
    lines.push('No active persistent tasks running.');
    lines.push('');
  }

  // Recently completed
  if (report.recentlyCompleted.length > 0) {
    lines.push(`**Recently Completed (last 24h):**`);
    for (const task of report.recentlyCompleted) {
      const status = task.status === 'completed' ? '✅' : '❌';
      lines.push(`${status} ${task.name} - ${task.status} at ${task.completedAt}`);
    }
    lines.push('');
  }

  // Warnings
  if (report.warnings.length > 0) {
    lines.push('**Warnings:**');
    for (const warning of report.warnings) {
      lines.push(`⚠️ ${warning}`);
    }
    lines.push('');
  }

  // Cleanup info
  if (report.archived > 0) {
    lines.push(`Archived ${report.archived} old task(s).`);
  }

  return lines.join('\n');
}

/**
 * Quick check - just returns summary stats
 */
function quickCheck() {
  try {
    const summary = getTaskSummary();
    return {
      running: summary.stats.running || 0,
      completed: summary.stats.completed || 0,
      failed: summary.stats.failed || 0,
      activeTasks: summary.activeTasks
    };
  } catch (error) {
    return {
      error: error.message,
      running: 0,
      completed: 0,
      failed: 0,
      activeTasks: []
    };
  }
}

/**
 * Get status of a specific task for quick lookup
 */
function getQuickStatus(taskId) {
  try {
    const { getTrainingStatus } = require('./training_launcher');
    return getTrainingStatus(taskId);
  } catch (error) {
    return { error: error.message };
  }
}

module.exports = {
  runStartupCheck,
  formatStartupReport,
  quickCheck,
  getQuickStatus
};
