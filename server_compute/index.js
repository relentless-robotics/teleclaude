#!/usr/bin/env node
/**
 * index.js — CLI Interface for Lvl3Quant Server Compute
 *
 * Quick command-line tool for managing the Jupiter server.
 *
 * Usage:
 *   node server_compute/index.js <command> [options]
 *
 * Commands:
 *   status                     Server health + active jobs
 *   test                       Test SSH connection
 *   deploy [--minimal] [--force]  Run bootstrap script on server
 *   sync-code [--force]        Upload alpha_discovery/ to server
 *   sync-data [--batch N]      Upload feature cache to server (slow!)
 *   sync-status                Show local vs remote file counts
 *   jobs                       List active tmux jobs on server
 *   launch-scan                Launch a scan job
 *     --horizon <h>              e.g. ret_10s, ret_30s, ret_1m
 *     --target <t>               e.g. mfe_net, ret
 *     --days <n>                 Number of days (default: 70)
 *     --no-execution             Dry run (default: true)
 *   launch <script> [args...]  Launch a custom Python script
 *   log <jobId> [--lines N]    Tail job log
 *   progress <jobId>           Get job progress
 *   check <jobId>              Check job status
 *   kill <jobId>               Kill a running job
 *   pull <jobId> [dest]        Pull results from server
 *   pull-all [dest]            Pull all results
 *
 * Examples:
 *   node server_compute/index.js status
 *   node server_compute/index.js deploy
 *   node server_compute/index.js sync-code
 *   node server_compute/index.js launch-scan --horizon ret_10s --target mfe_net --days 70
 *   node server_compute/index.js jobs
 *   node server_compute/index.js log lzk4p_a3f2 --lines 100
 *   node server_compute/index.js kill lzk4p_a3f2
 *   node server_compute/index.js pull lzk4p_a3f2 ./results/
 */

'use strict';

const orchestrator = require('./orchestrator');

// =============================================================================
// Argument Parsing
// =============================================================================

function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      // Check if next arg is a value (not another flag)
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

// =============================================================================
// Output Helpers
// =============================================================================

function print(msg) {
  process.stdout.write(msg + '\n');
}

function printError(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
}

function printSection(title) {
  print(`\n=== ${title} ===`);
}

function printJSON(obj) {
  print(JSON.stringify(obj, null, 2));
}

function printTable(rows, headers) {
  if (rows.length === 0) {
    print('  (none)');
    return;
  }

  // Calculate column widths
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] || '').length)));

  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  const separator = widths.map(w => '-'.repeat(w)).join('  ');

  print('  ' + headerLine);
  print('  ' + separator);
  for (const row of rows) {
    print('  ' + headers.map((h, i) => String(row[i] || '').padEnd(widths[i])).join('  '));
  }
}

// =============================================================================
// Command Handlers
// =============================================================================

async function cmdStatus(flags) {
  print('Fetching server status...');
  const server = flags.server || 'jupiter';

  const summary = await orchestrator.getStatusSummary(server);
  print(summary);
}

async function cmdTest(flags) {
  const server = flags.server || 'jupiter';
  print(`Testing connection to ${server}...`);

  const result = await orchestrator.testConnection(server);

  if (result.connected) {
    print(`Connected to ${server}`);
    print(`  Hostname: ${result.hostname}`);
    print(`  Uptime:   ${result.uptime}`);
    print(`  Latency:  ${result.latencyMs}ms`);
  } else {
    printError(`Cannot connect: ${result.error}`);
    if (result.hint) print(`Hint: ${result.hint}`);
    process.exit(1);
  }
}

async function cmdDeploy(flags) {
  const server = flags.server || 'jupiter';
  const minimal = !!flags.minimal;
  const force = !!flags.force;

  print(`Deploying to ${server}${minimal ? ' (minimal mode)' : ''}${force ? ' (force reinstall)' : ''}...`);
  print('This may take 10-15 minutes. Output will stream below:\n');

  const result = await orchestrator.deploy({
    serverName: server,
    minimal,
    force,
    onOutput: (str) => process.stdout.write(str),
  });

  print('');
  if (result.success) {
    print('Deploy complete!');
  } else {
    printError(`Deploy failed (exit code ${result.exitCode})`);
    process.exit(1);
  }
}

async function cmdSyncCode(flags) {
  const server = flags.server || 'jupiter';
  const force = !!flags.force;

  print(`Syncing codebase to ${server}${force ? ' (force overwrite)' : ''}...`);

  let lastFile = '';
  const result = await orchestrator.syncCode({
    serverName: server,
    force,
    onProgress: (p) => {
      if (p.file && p.file !== lastFile) {
        lastFile = p.file;
        process.stdout.write(`\r  Uploading: ${p.file.padEnd(50)} ${p.pct}%`);
      }
    },
  });

  print('');
  if (result.success) {
    print(`Done! ${result.files} files uploaded, ${result.skipped} skipped, ${result.errors.length} errors`);
    if (result.errors.length > 0) {
      print('Errors:');
      result.errors.forEach(e => print(`  ${e.file}: ${e.error}`));
    }
  } else {
    printError(`Sync failed: ${result.error}`);
    process.exit(1);
  }
}

async function cmdSyncData(flags) {
  const server = flags.server || 'jupiter';
  const batchSize = parseInt(flags.batch) || 5;
  const force = !!flags.force;

  print(`Syncing feature cache to ${server} (batch size: ${batchSize})...`);
  print('This can take a long time for large caches. Resume is supported.\n');

  const result = await orchestrator.syncData({
    serverName: server,
    batchSize,
    force,
  });

  if (result.success) {
    print(`\nDone! ${result.files} uploaded, ${result.skipped} already synced, ${result.bytesGB}GB transferred`);
    if (result.errors.length > 0) {
      print(`${result.errors.length} errors:`);
      result.errors.forEach(e => print(`  ${e.file}: ${e.error}`));
    }
  } else {
    printError(`Sync failed: ${result.error}`);
    process.exit(1);
  }
}

async function cmdSyncStatus(flags) {
  const server = flags.server || 'jupiter';
  print(`Checking sync status vs ${server}...`);

  const { getSyncStatus } = require('./sync');
  const status = await getSyncStatus({ serverName: server });

  if (!status.success) {
    printError(`Could not check status: ${status.error}`);
    return;
  }

  printSection('Feature Cache');
  print(`  Local NPZ files:  ${status.featureCache.local}`);
  print(`  Remote NPZ files: ${status.featureCache.remote}`);
  print(`  Status:           ${status.featureCache.synced ? 'IN SYNC' : `OUT OF SYNC (${status.featureCache.missing} missing on server)`}`);

  printSection('Codebase (alpha_discovery)');
  print(`  Remote files:  ${status.codebase.remoteFiles}`);
  print(`  Status:        ${status.codebase.exists ? 'PRESENT' : 'NOT SYNCED YET'}`);
}

async function cmdJobs(flags) {
  const server = flags.server || 'jupiter';
  print(`Active jobs on ${server}:\n`);

  const jobs = await orchestrator.listActiveJobs(server);

  if (jobs.length === 0) {
    print('No active jobs.');
    return;
  }

  const rows = jobs.map(j => [
    j.jobId,
    j.meta?.name || '-',
    j.running ? 'RUNNING' : 'DONE',
    j.created || '-',
    j.meta?.script?.split('/').pop() || '-',
  ]);

  printTable(rows, ['JOB ID', 'NAME', 'STATUS', 'STARTED', 'SCRIPT']);
}

async function cmdLaunchScan(flags) {
  const server = flags.server || 'jupiter';

  const scanConfig = {
    horizon:    flags.horizon || 'ret_10s',
    targetType: flags.target || flags['target-type'] || 'mfe_net',
    nDays:      parseInt(flags.days) || 70,
    noExecution: flags['no-execution'] !== false, // default true
    serverName: server,
  };

  print(`Launching scan on ${server}:`);
  print(`  Horizon:    ${scanConfig.horizon}`);
  print(`  Target:     ${scanConfig.targetType}`);
  print(`  Days:       ${scanConfig.nDays}`);
  print(`  Execution:  ${scanConfig.noExecution ? 'disabled (dry run)' : 'enabled'}`);
  print('');

  const result = await orchestrator.runScan(scanConfig, {
    syncCode: !flags['no-sync'],
    syncData: !!flags['sync-data'],
    serverName: server,
  });

  if (result.success) {
    print(`Job launched!`);
    print(`  Job ID:  ${result.id}`);
    print(`  Name:    ${result.job.name}`);
    print(`  Log:     ${result.job.logFile}`);
    print(`  Session: ${result.job.sessionName}`);
    print('');
    print(`To monitor: node server_compute/index.js log ${result.id}`);
    print(`To check:   node server_compute/index.js check ${result.id}`);
  } else {
    printError(`Failed to launch: ${result.error}`);
    if (result.hint) print(`Hint: ${result.hint}`);
    process.exit(1);
  }
}

async function cmdLaunchScript(positional, flags) {
  const server = flags.server || 'jupiter';
  const script = positional[1];

  if (!script) {
    printError('Usage: index.js launch <script_path> [args...]');
    process.exit(1);
  }

  const args = positional.slice(2);

  print(`Launching ${script} on ${server}...`);

  const result = await orchestrator.launchScript({
    script,
    args,
    serverName: server,
    name: flags.name,
  });

  print(`Job launched: ${result.id}`);
  print(`  Log: ${result.logFile}`);
}

async function cmdLog(positional, flags) {
  const server = flags.server || 'jupiter';
  const jobId = positional[1];
  const lines = parseInt(flags.lines) || 50;

  if (!jobId) {
    printError('Usage: index.js log <jobId> [--lines N]');
    process.exit(1);
  }

  const result = await orchestrator.getLog(jobId, lines, server);
  print(`=== Log: ${result.logFile} (last ${lines} lines) ===`);
  print(result.raw || '(empty)');
}

async function cmdProgress(positional, flags) {
  const server = flags.server || 'jupiter';
  const jobId = positional[1];

  if (!jobId) {
    printError('Usage: index.js progress <jobId>');
    process.exit(1);
  }

  const result = await orchestrator.getJobProgressStatus(jobId, server);

  print(`Job: ${jobId}`);
  print(`  Status:   ${result.status}`);
  print(`  Running:  ${result.running}`);
  print(`  Elapsed:  ${result.elapsed}`);
  print(`  Progress: ${result.progress}`);
  if (result.progressDetail?.current && result.progressDetail?.total) {
    print(`  Step:     ${result.progressDetail.current} / ${result.progressDetail.total}`);
  }
  print('');
  print('Recent log:');
  (result.recentLog || []).forEach(l => print(`  ${l}`));
}

async function cmdCheck(positional, flags) {
  const server = flags.server || 'jupiter';
  const jobId = positional[1];

  if (!jobId) {
    printError('Usage: index.js check <jobId>');
    process.exit(1);
  }

  const { checkJob } = require('./runner');
  const result = await checkJob(jobId, server);
  printJSON(result);
}

async function cmdKill(positional, flags) {
  const server = flags.server || 'jupiter';
  const jobId = positional[1];

  if (!jobId) {
    printError('Usage: index.js kill <jobId>');
    process.exit(1);
  }

  print(`Killing job ${jobId} on ${server}...`);
  const result = await orchestrator.kill(jobId, server);

  if (result.killed) {
    print(`Killed: ${result.message}`);
  } else {
    print(`Not killed: ${result.message}`);
  }
}

async function cmdPull(positional, flags) {
  const server = flags.server || 'jupiter';
  const jobId = positional[1];
  const dest = positional[2] || null;

  if (!jobId) {
    printError('Usage: index.js pull <jobId> [dest]');
    process.exit(1);
  }

  print(`Pulling results for job ${jobId}...`);
  const result = await orchestrator.pullResults(jobId, dest, { serverName: server });

  if (result.success) {
    print(`Done! ${result.files || 0} files downloaded`);
    if (dest) print(`  Saved to: ${dest}`);
  } else {
    printError(`Pull failed: ${result.error}`);
    process.exit(1);
  }
}

async function cmdPullAll(positional, flags) {
  const server = flags.server || 'jupiter';
  const dest = positional[1] || null;

  print('Pulling all results from server...');
  const result = await orchestrator.pullAllResults(dest, { serverName: server });

  if (result.success) {
    print(`Done! ${result.files || 0} files downloaded`);
  } else {
    printError(`Pull failed: ${result.error}`);
    process.exit(1);
  }
}

// =============================================================================
// Help
// =============================================================================

function printHelp() {
  print(`
Lvl3Quant Remote Compute CLI
Usage: node server_compute/index.js <command> [options]

Connection:
  test                          Test SSH connection to server
  status                        Server health, resources, active jobs

Setup:
  deploy [--minimal] [--force]  Run bootstrap script on server

File Sync:
  sync-code [--force]           Upload alpha_discovery/ codebase
  sync-data [--batch N]         Upload feature cache NPZ files
  sync-status                   Check local vs remote file counts

Jobs:
  jobs                          List active tmux jobs
  launch-scan                   Launch a Lvl3Quant scan
    --horizon <h>               Target horizon (ret_10s, ret_30s, ret_1m, ...)
    --target <t>                Target type (mfe_net, ret, ...)
    --days <n>                  Number of days (default: 70)
    --no-sync                   Skip code sync before launch
  launch <script> [args...]     Launch a custom Python script

Monitoring:
  log <jobId> [--lines N]       Show last N lines of job log
  progress <jobId>              Parse progress from log
  check <jobId>                 Get raw job status JSON

Control:
  kill <jobId>                  Kill a running job

Results:
  pull <jobId> [dest]           Download results for a job
  pull-all [dest]               Download all results

Global Options:
  --server <name>               Server to target (default: jupiter)

Examples:
  node server_compute/index.js test
  node server_compute/index.js status
  node server_compute/index.js deploy
  node server_compute/index.js sync-code
  node server_compute/index.js launch-scan --horizon ret_10s --target mfe_net --days 70
  node server_compute/index.js jobs
  node server_compute/index.js log lzk4p_a3f2
  node server_compute/index.js progress lzk4p_a3f2
  node server_compute/index.js kill lzk4p_a3f2
  node server_compute/index.js pull lzk4p_a3f2 ./local_results/
`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const { positional, flags } = parseArgs(process.argv);
  const command = positional[0];

  if (!command || command === 'help' || flags.help || flags.h) {
    printHelp();
    process.exit(0);
  }

  try {
    switch (command) {
      case 'status':       await cmdStatus(flags); break;
      case 'test':         await cmdTest(flags); break;
      case 'deploy':       await cmdDeploy(flags); break;
      case 'sync-code':    await cmdSyncCode(flags); break;
      case 'sync-data':    await cmdSyncData(flags); break;
      case 'sync-status':  await cmdSyncStatus(flags); break;
      case 'jobs':         await cmdJobs(flags); break;
      case 'launch-scan':  await cmdLaunchScan(flags); break;
      case 'launch':       await cmdLaunchScript(positional, flags); break;
      case 'log':          await cmdLog(positional, flags); break;
      case 'progress':     await cmdProgress(positional, flags); break;
      case 'check':        await cmdCheck(positional, flags); break;
      case 'kill':         await cmdKill(positional, flags); break;
      case 'pull':         await cmdPull(positional, flags); break;
      case 'pull-all':     await cmdPullAll(positional, flags); break;
      default:
        printError(`Unknown command: ${command}`);
        print('Run: node server_compute/index.js help');
        process.exit(1);
    }
  } catch (err) {
    printError(`Unhandled error: ${err.message}`);
    if (process.env.DEBUG) print(err.stack);
    process.exit(1);
  } finally {
    orchestrator.disconnect();
  }
}

main();
