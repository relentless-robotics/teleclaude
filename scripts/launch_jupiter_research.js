#!/usr/bin/env node
/**
 * launch_jupiter_research.js
 *
 * Uploads all research scripts to Jupiter and launches them in tmux sessions.
 * Prioritizes: expanding_window_card_sweep (most immediate value) first,
 * then prediction_quality_analysis, adverse_selection_analysis, execution_cost_modeling.
 *
 * Usage: node scripts/launch_jupiter_research.js
 */

const path = require('path');
const fs = require('fs');

// Use ssh_manager for exec, and scp for upload
const ssh = require(path.join(__dirname, '..', 'utils', 'ssh_manager'));

const JUPITER = 'jupiter';
const REMOTE_SCRIPTS_DIR = '/home/jupiter/Lvl3Quant/scripts';

const SCRIPTS = [
  {
    local: path.join(__dirname, 'expanding_window_card_sweep.py'),
    remote: `${REMOTE_SCRIPTS_DIR}/expanding_window_card_sweep.py`,
    tmux: 'ew_sweep',
    label: 'Expanding Window Card Sweep',
    priority: 1,
  },
  {
    local: path.join(__dirname, 'prediction_quality_analysis.py'),
    remote: `${REMOTE_SCRIPTS_DIR}/prediction_quality_analysis.py`,
    tmux: 'pred_quality',
    label: 'Prediction Quality Analysis',
    priority: 2,
  },
  {
    local: path.join(__dirname, 'adverse_selection_analysis.py'),
    remote: `${REMOTE_SCRIPTS_DIR}/adverse_selection_analysis.py`,
    tmux: 'adverse_sel',
    label: 'Adverse Selection Analysis',
    priority: 3,
  },
  {
    local: path.join(__dirname, 'execution_cost_modeling.py'),
    remote: `${REMOTE_SCRIPTS_DIR}/execution_cost_modeling.py`,
    tmux: 'exec_cost',
    label: 'Execution Cost Modeling',
    priority: 4,
  },
];

async function uploadFile(localPath, remotePath) {
  const content = fs.readFileSync(localPath, 'utf8');
  // Write via heredoc approach through ssh exec
  const escaped = content
    .replace(/\\/g, '\\\\')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')
    .replace(/"/g, '\\"');

  // Use Python to write the file (avoids shell escaping issues)
  const pyCmd = `python3 -c "
import base64, os
content = base64.b64decode('${Buffer.from(content).toString('base64')}').decode('utf-8')
with open('${remotePath}', 'w') as f:
    f.write(content)
os.chmod('${remotePath}', 0o755)
print('Uploaded: ${remotePath}')
"`;

  const result = await ssh.exec(JUPITER, pyCmd, { timeout: 30000 });
  if (result.stderr && result.stderr.includes('Error')) {
    throw new Error(`Upload failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function tmuxSessionExists(sessionName) {
  try {
    const r = await ssh.exec(JUPITER, `tmux has-session -t ${sessionName} 2>/dev/null && echo EXISTS || echo NONE`, { timeout: 5000 });
    return r.stdout.includes('EXISTS');
  } catch {
    return false;
  }
}

async function launchInTmux(tmuxName, remoteScript, label) {
  const exists = await tmuxSessionExists(tmuxName);
  if (exists) {
    console.log(`  [SKIP] tmux session '${tmuxName}' already exists`);
    return false;
  }

  const cmd = `tmux new-session -d -s ${tmuxName} "cd /home/jupiter/Lvl3Quant && python3 ${remoteScript} 2>&1 | tee /home/jupiter/Lvl3Quant/data/processed/${tmuxName}.log; echo DONE"`;
  const result = await ssh.exec(JUPITER, cmd, { timeout: 10000 });
  console.log(`  [LAUNCHED] ${label} -> tmux session: ${tmuxName}`);
  return true;
}

async function checkSystemStatus() {
  const r = await ssh.exec(JUPITER, 'nproc && free -h | grep Mem && uptime | awk \'{print $NF, $(NF-1), $(NF-2)}\'', { timeout: 10000 });
  console.log('Jupiter status:', r.stdout.trim());
}

async function main() {
  console.log('=== Launching Jupiter Research Suite ===\n');

  // 1. Check system
  console.log('Checking Jupiter system status...');
  await checkSystemStatus();
  console.log('');

  // 2. Upload scripts
  console.log('Uploading scripts to Jupiter...');
  for (const script of SCRIPTS) {
    if (!fs.existsSync(script.local)) {
      console.log(`  [MISSING] ${script.local}`);
      continue;
    }
    try {
      const result = await uploadFile(script.local, script.remote);
      console.log(`  [OK] ${path.basename(script.local)} -> ${script.remote}`);
    } catch (e) {
      console.error(`  [ERROR] Failed to upload ${script.local}: ${e.message}`);
    }
  }
  console.log('');

  // 3. Launch in tmux (in priority order)
  console.log('Launching research jobs in tmux...');
  const sorted = [...SCRIPTS].sort((a, b) => a.priority - b.priority);
  for (const script of sorted) {
    await launchInTmux(script.tmux, script.remote, script.label);
    // Small delay between launches to avoid hammering resources
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('');

  // 4. Show running sessions
  console.log('Active tmux sessions on Jupiter:');
  const sessions = await ssh.exec(JUPITER, 'tmux ls 2>/dev/null || echo "no sessions"', { timeout: 5000 });
  console.log(sessions.stdout);

  // 5. Show log tail for first launched session
  console.log('Waiting 10s for initial output...');
  await new Promise(r => setTimeout(r, 10000));

  for (const script of sorted) {
    const logFile = `/home/jupiter/Lvl3Quant/data/processed/${script.tmux}.log`;
    const tail = await ssh.exec(JUPITER, `tail -20 ${logFile} 2>/dev/null || echo "(no output yet)"`, { timeout: 5000 });
    console.log(`\n--- ${script.label} (${script.tmux}) ---`);
    console.log(tail.stdout || tail.stderr);
  }

  console.log('\n=== Launch Complete ===');
  console.log('Monitor with:');
  for (const script of sorted) {
    console.log(`  tail -f /home/jupiter/Lvl3Quant/data/processed/${script.tmux}.log`);
  }
  console.log('\nResults will be written to:');
  console.log('  /home/jupiter/Lvl3Quant/data/processed/expanding_window_sweep/expanding_window_sweep_summary.json');
  console.log('  /home/jupiter/Lvl3Quant/data/processed/prediction_quality_analysis/prediction_quality_report.json');
  console.log('  /home/jupiter/Lvl3Quant/data/processed/adverse_selection_analysis/adverse_selection_report.json');
  console.log('  /home/jupiter/Lvl3Quant/data/processed/execution_cost_modeling/execution_cost_report.json');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
