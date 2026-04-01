#!/usr/bin/env node
/**
 * index.js — Compute Dispatcher CLI + Programmatic API
 *
 * CLI:
 *   node compute/index.js status                        — show all machines + tasks
 *   node compute/index.js gaming on                     — enable gaming mode
 *   node compute/index.js gaming off                    — disable gaming mode
 *   node compute/index.js templates                     — list available task templates
 *   node compute/index.js queue <template> [params...]  — add task to queue
 *   node compute/index.js dispatch                      — route queued tasks to machines
 *   node compute/index.js check                         — check all running tasks
 *   node compute/index.js log <taskId>                  — tail log for a task
 *   node compute/index.js kill <taskId>                 — kill a running task
 *   node compute/index.js results <taskId>              — pull results from server
 *   node compute/index.js clear completed               — clear completed/failed history
 *   node compute/index.js reset                         — reset all state (dangerous!)
 *
 * Programmatic API (for Claude):
 *   const dispatcher = require('./compute');
 *
 *   dispatcher.addTask({ name: 'ret_10s scan', template: 'multi_alpha_scan', params: { horizon: 'ret_10s', targetType: 'mfe_net', nDays: 70 } });
 *   dispatcher.addTask({ name: 'GPU test', template: 'multi_alpha_scan_gpu', params: { horizon: 'ret_10s', targetType: 'mfe_net', nDays: 70 } });
 *   await dispatcher.dispatch();
 *   dispatcher.setGamingMode(true);
 *   const status = dispatcher.getStatus();
 *   console.log(dispatcher.formatStatus());
 *
 * Examples:
 *   node compute/index.js status
 *   node compute/index.js gaming on
 *   node compute/index.js queue multi_alpha_scan --horizon ret_10s --target-type mfe_net --n-days 70
 *   node compute/index.js queue multi_alpha_scan_gpu --horizon ret_10s --target-type mfe_net --n-days 70
 *   node compute/index.js dispatch
 *   node compute/index.js check
 *   node compute/index.js log <taskId>
 *   node compute/index.js results <taskId>
 */

'use strict';

const dispatcher = require('./dispatcher');
const { TASK_TEMPLATES, listTemplates } = require('./tasks');

// ===========================================================================
// Argument Parsing
// ===========================================================================

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { positional, flags };
}

// ===========================================================================
// Output Helpers
// ===========================================================================

function p(msg)      { process.stdout.write(msg + '\n'); }
function err(msg)    { process.stderr.write(`ERROR: ${msg}\n`); }
function pj(obj)     { p(JSON.stringify(obj, null, 2)); }
function section(t)  { p(`\n=== ${t} ===`); }

// ===========================================================================
// Command Handlers
// ===========================================================================

async function cmdStatus(flags) {
  p(dispatcher.formatStatus());

  if (flags.json) {
    section('JSON');
    pj(dispatcher.getStatus());
  }
}

async function cmdGaming(positional, flags) {
  const toggle = (positional[1] || '').toLowerCase();
  if (!toggle || (toggle !== 'on' && toggle !== 'off')) {
    err('Usage: gaming on | off');
    process.exit(1);
  }

  const enabled = toggle === 'on';
  dispatcher.setGamingMode(enabled);
  p(`Gaming mode: ${enabled ? 'ON (all tasks route to Jupiter server)' : 'OFF (PC available again)'}`);
}

function cmdTemplates() {
  const tmpl = listTemplates();
  p('\nAvailable task templates:\n');
  const rows = tmpl.map(t => [
    t.name.padEnd(28),
    t.type.padEnd(8),
    `${t.estimatedRam}GB`.padEnd(6),
    t.estimatedTime.padEnd(14),
    t.hasPcCommand ? 'Y' : '-',
    t.hasServerCmd ? 'Y' : '-',
    t.description,
  ]);

  const header = ['TEMPLATE'.padEnd(28), 'TYPE'.padEnd(8), 'RAM'.padEnd(6), 'EST TIME'.padEnd(14), 'PC', 'SRV', 'DESCRIPTION'];
  p('  ' + header.join('  '));
  p('  ' + header.map(h => '-'.repeat(h.length)).join('  '));
  rows.forEach(r => p('  ' + r.join('  ')));
  p('');
}

async function cmdQueue(positional, flags) {
  const template = positional[1];
  if (!template) {
    err('Usage: queue <template> [--param value ...]');
    p('Run: node compute/index.js templates');
    process.exit(1);
  }

  if (!TASK_TEMPLATES[template]) {
    err(`Unknown template: "${template}". Run: node compute/index.js templates`);
    process.exit(1);
  }

  // Collect params from flags
  const knownFlags = ['name', 'depends-on', 'priority'];
  const params = {};
  for (const [k, v] of Object.entries(flags)) {
    if (!knownFlags.includes(k)) {
      // Convert kebab-case flag to camelCase param
      const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      params[camel] = isNaN(v) ? v : Number(v);
    }
  }

  const dependsOn = flags['depends-on']
    ? flags['depends-on'].split(',').map(s => s.trim())
    : [];

  const taskId = dispatcher.addTask({
    name:     flags.name || `${template}`,
    template,
    params,
    priority: flags.priority != null ? Number(flags.priority) : undefined,
    dependsOn,
  });

  p(`Queued: "${flags.name || template}" (ID: ${taskId})`);
  if (Object.keys(params).length > 0) {
    p(`Params: ${JSON.stringify(params)}`);
  }
  if (dependsOn.length > 0) {
    p(`Depends on: ${dependsOn.join(', ')}`);
  }
}

async function cmdDispatch(flags) {
  p('Dispatching queued tasks...\n');

  const dispatched = await dispatcher.dispatch();

  if (dispatched.length === 0) {
    p('Nothing dispatched. (All queued tasks waiting on dependencies or capacity full.)');
  } else {
    p(`Dispatched ${dispatched.length} task(s):`);
    for (const d of dispatched) {
      p(`  ${d.taskId} → ${d.machine.toUpperCase()}`);
    }
  }

  p('');
  p(dispatcher.formatStatus());
}

async function cmdCheck(flags) {
  p('Checking all running tasks...\n');

  const results = await dispatcher.checkAll();

  if (results.checked === 0) {
    p('No running tasks to check.');
  } else {
    p(`Checked ${results.checked} task(s).`);
    if (results.completed.length > 0) {
      p(`  Completed: ${results.completed.join(', ')}`);
    }
    if (results.failed.length > 0) {
      p(`  Failed: ${results.failed.join(', ')}`);
    }
    if (results.dispatched.length > 0) {
      p(`  New dispatched: ${results.dispatched.join(', ')}`);
    }
  }

  p('');
  p(dispatcher.formatStatus());
}

async function cmdLog(positional, flags) {
  const taskId = positional[1];
  if (!taskId) {
    err('Usage: log <taskId> [--lines N]');
    process.exit(1);
  }

  const lines = parseInt(flags.lines) || 50;

  // Find task in running or completed
  const status = dispatcher.getStatus();
  const all = [
    ...status.running,
    ...status.completed,
    ...status.failed,
    ...status.queue,
  ];
  const taskSummary = all.find(t => t.id === taskId || t.id.startsWith(taskId));

  if (!taskSummary) {
    err(`Task not found: ${taskId}`);
    process.exit(1);
  }

  // Get full task from dispatcher internals
  const fullTask = dispatcher.running[taskSummary.id]
    || dispatcher.completed[taskSummary.id]
    || dispatcher.failed[taskSummary.id];

  if (!fullTask) {
    err(`Task state not available for: ${taskId}`);
    process.exit(1);
  }

  const executor = require('./executor');
  const log = await executor.getLog(fullTask, lines);

  p(`=== Log: ${taskSummary.name} (${taskSummary.id}) ===`);
  p(log || '(empty log)');
}

async function cmdKill(positional, flags) {
  const taskId = positional[1];
  if (!taskId) {
    err('Usage: kill <taskId>');
    process.exit(1);
  }

  const task = dispatcher.running[taskId]
    || Object.values(dispatcher.running).find(t => t.id.startsWith(taskId));

  if (!task) {
    err(`No running task found: ${taskId}`);
    process.exit(1);
  }

  p(`Killing task "${task.name}" on ${task.machine}...`);

  const executor = require('./executor');
  const result = await executor.killTask(task);

  if (result.killed) {
    p(`Killed: ${result.message}`);
    // Mark as failed in dispatcher
    task.status = 'failed';
    task.error  = 'Killed by user';
    delete dispatcher.running[task.id];
    dispatcher.failed[task.id] = task;
    dispatcher._freeMachineSlot(task.machine, task.id);
    dispatcher._saveState();
  } else {
    p(`Not killed: ${result.message}`);
  }
}

async function cmdResults(positional, flags) {
  const taskId = positional[1];
  if (!taskId) {
    err('Usage: results <taskId>');
    process.exit(1);
  }

  const task = dispatcher.completed[taskId]
    || dispatcher.running[taskId]
    || Object.values(dispatcher.completed).find(t => t.id.startsWith(taskId));

  if (!task) {
    err(`Task not found: ${taskId}`);
    p('Run: node compute/index.js status');
    process.exit(1);
  }

  if (task.machine !== 'server') {
    err(`Task "${task.name}" ran on PC — results already local`);
    process.exit(1);
  }

  p(`Pulling results for "${task.name}"...`);

  const syncer = require('./sync');
  const result = await syncer.syncTaskResults(task, { forceOverwrite: !!flags.force });

  if (result.success) {
    p(`Done! ${result.files} files, ${result.skipped} skipped, ${result.bytesKB}KB downloaded`);
    p(`Local: ${result.localDir}`);
    if (result.errors.length > 0) {
      p(`Errors:`);
      result.errors.forEach(e => p(`  ${e.file}: ${e.error}`));
    }
  } else {
    err(`Sync failed: ${result.error}`);
    process.exit(1);
  }
}

async function cmdClear(positional) {
  const what = positional[1] || 'completed';

  if (what === 'completed' || what === 'all') {
    const cCount = Object.keys(dispatcher.completed).length;
    const fCount = Object.keys(dispatcher.failed).length;
    dispatcher.completed = {};
    dispatcher.failed    = {};
    dispatcher._saveState();
    p(`Cleared ${cCount} completed + ${fCount} failed tasks from history.`);
  } else if (what === 'queue') {
    const count = dispatcher.queue.length;
    dispatcher.queue = [];
    dispatcher._saveState();
    p(`Cleared ${count} queued tasks.`);
  } else {
    err(`Unknown: clear ${what}. Use: clear completed | queue | all`);
  }
}

async function cmdReset(flags) {
  if (!flags.confirm) {
    p('This will RESET ALL dispatcher state (queue, running, completed, failed).');
    p('Pass --confirm to proceed.');
    return;
  }

  dispatcher.queue     = [];
  dispatcher.running   = {};
  dispatcher.completed = {};
  dispatcher.failed    = {};
  dispatcher.gamingMode = false;
  dispatcher.machines.pc.activeJobs     = [];
  dispatcher.machines.server.activeJobs = [];
  dispatcher.machines.pc.status     = 'available';
  dispatcher.machines.server.status = 'available';
  dispatcher._saveState();

  p('Dispatcher state reset.');
}

// ===========================================================================
// Help
// ===========================================================================

function printHelp() {
  p(`
Compute Dispatcher CLI — Manage work between PC (GPU) and Jupiter server (CPU)

Usage: node compute/index.js <command> [options]

Machine Control:
  status                          Show all machines + queued/running/completed tasks
  gaming on | off                 Toggle gaming mode (all tasks → server when ON)

Task Management:
  templates                       List available task templates
  queue <template> [params]       Add a task to the queue
    --name <name>                   Human-readable name (optional)
    --horizon <h>                   e.g. ret_10s, ret_30s, ret_1m
    --target-type <t>               e.g. mfe_net, ret
    --n-days <n>                    Number of days (e.g. 70)
    --depends-on <id1,id2>          Wait for these task IDs to complete
    --priority <n>                  Lower number = runs first (default: 5)
  dispatch                        Route all ready queued tasks to machines
  check                           Check all running tasks + auto-dispatch freed capacity

Monitoring:
  log <taskId> [--lines N]        Show last N lines of task log (default: 50)
  kill <taskId>                   Kill a running task

Results:
  results <taskId> [--force]      Pull results from server to local PC

Maintenance:
  clear completed                 Remove completed/failed from history
  clear queue                     Remove all queued (not running) tasks
  clear all                       Clear everything from history
  reset --confirm                 Full reset (dangerous!)

Options:
  --json                          Include JSON output (with status command)

Examples:
  node compute/index.js status
  node compute/index.js gaming on
  node compute/index.js templates
  node compute/index.js queue multi_alpha_scan --horizon ret_10s --target-type mfe_net --n-days 70
  node compute/index.js queue multi_alpha_scan_gpu --horizon ret_10s --target-type mfe_net --n-days 70
  node compute/index.js queue realistic_sim --horizon ret_10s --n-days 70 --depends-on <scanTaskId>
  node compute/index.js dispatch
  node compute/index.js check
  node compute/index.js log <taskId> --lines 100
  node compute/index.js results <taskId>
`);
}

// ===========================================================================
// Main
// ===========================================================================

async function main() {
  const { positional, flags } = parseArgs(process.argv);
  const command = positional[0];

  if (!command || command === 'help' || flags.help || flags.h) {
    printHelp();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'status':     await cmdStatus(flags);                break;
      case 'gaming':     await cmdGaming(positional, flags);    break;
      case 'templates':  cmdTemplates();                        break;
      case 'queue':      await cmdQueue(positional, flags);     break;
      case 'dispatch':   await cmdDispatch(flags);              break;
      case 'check':      await cmdCheck(flags);                 break;
      case 'log':        await cmdLog(positional, flags);       break;
      case 'kill':       await cmdKill(positional, flags);      break;
      case 'results':    await cmdResults(positional, flags);   break;
      case 'clear':      await cmdClear(positional);            break;
      case 'reset':      await cmdReset(flags);                 break;
      default:
        err(`Unknown command: ${command}`);
        p('Run: node compute/index.js help');
        process.exit(1);
    }
  } catch (e) {
    err(`Unhandled error: ${e.message}`);
    if (process.env.DEBUG) p(e.stack);
    process.exit(1);
  }
}

// ===========================================================================
// Programmatic API Exports
// ===========================================================================

// When required as a module, expose dispatcher directly for Claude's use
module.exports = dispatcher;
module.exports.dispatcher = dispatcher;
module.exports.TASK_TEMPLATES = TASK_TEMPLATES;
module.exports.listTemplates  = listTemplates;

// Run CLI when called directly
if (require.main === module) {
  main();
}
