/**
 * Persistent Autonomous Monitor
 * ==============================
 * PM2-managed process that:
 * 1. Every 15 min: sends deep evaluation prompt to Claude via Discord
 * 2. Every 60s: polls MLflow for fold completions, notifies on new results
 * 3. Every 2 min: checks GPU util, alerts if idle >5 min
 *
 * Survives Claude crashes, Neptune restarts (via PM2).
 * Launches automatically with npm start via ecosystem.config.js.
 */

const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// Config
const MLFLOW_URL = 'http://localhost:5000';
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MLFLOW_POLL_MS = 60 * 1000; // 60 seconds
const GPU_CHECK_MS = 5 * 60 * 1000; // 5 minutes (not 2 — avoid spam)

// Discord bot config — send to #system-status channel so Claude sees alerts
const fs = require('fs');
const path = require('path');
let DISCORD_BOT_TOKEN = '';
let DISCORD_USER_ID = '';
// Channel IDs from Discord server
const SYSTEM_STATUS_CHANNEL_ID = '1469187609837174989';  // #system-status
const ALERTS_CHANNEL_ID = '1469187608700518602';          // #alerts
const GENERAL_CHANNEL_ID = '1469178834313019414';         // #general — bridge watches this, alerts go to Claude
try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    DISCORD_BOT_TOKEN = cfg.discordToken || '';
    DISCORD_USER_ID = (cfg.discordAllowedUsers || [])[0] || '';
} catch (e) { console.log('[MONITOR] Failed to load config:', e.message); }

// Track state
let lastKnownFolds = {};  // run_id -> fold count
let gpuIdleSince = {};     // node -> timestamp when GPU went idle
let lastGpuAlertTime = {}; // node -> last time we sent an alert (throttle)
const GPU_IDLE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes before first alert
const GPU_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between repeat alerts per node

// ─── Discord Channel Sending ───────────────────────────────
// Sends to #system-status channel directly via Discord API
// Claude reads this channel via MCP tools — this IS the prompt mechanism
async function sendToChannel(channelId, message) {
    try {
        const truncated = message.length > 1950 ? message.slice(0, 1950) + '...' : message;
        const data = JSON.stringify({ content: truncated });
        return new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'discord.com',
                path: `/api/v10/channels/${channelId}/messages`,
                method: 'POST',
                headers: {
                    'Authorization': `Bot ${DISCORD_BOT_TOKEN}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data)
                }
            }, (res) => {
                let body = '';
                res.on('data', c => body += c);
                res.on('end', () => resolve(body));
            });
            req.on('error', reject);
            req.write(data);
            req.end();
        });
    } catch (e) {
        console.log('[MONITOR] Channel send failed:', e.message);
    }
}

function sendToDiscord(message, channel = 'status') {
    // 1. Write to jsonl file (backup/audit trail)
    const msgFile = path.join(__dirname, '..', 'monitor_messages.jsonl');
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), message }) + '\n';
    try { fs.appendFileSync(msgFile, entry); } catch (e) { /* ignore */ }
    // 2. Send to appropriate Discord channel
    const channelId = channel === 'alerts' ? ALERTS_CHANNEL_ID : SYSTEM_STATUS_CHANNEL_ID;
    sendToChannel(channelId, message).catch(() => {});
    // 3. CRITICAL: Also send alerts to #general so the bridge forwards them to Claude
    //    This ensures Claude receives GPU idle, training crash, and fold completion alerts
    //    as if the user sent them — Claude must ACT on these immediately.
    if (channel === 'alerts') {
        sendToChannel(GENERAL_CHANNEL_ID, `[ALERT→CLAUDE] ${message}`).catch(() => {});
    }
    console.log(`[MONITOR] ${new Date().toISOString()} [#${channel}] ${message.substring(0, 100)}...`);
}

// ─── MLflow Polling ─────────────────────────────────────────
async function checkMLflow() {
    try {
        const data = await httpPost(`${MLFLOW_URL}/api/2.0/mlflow/runs/search`, {
            experiment_ids: ["15", "16", "17", "18", "19", "20"],
            max_results: 10,
            filter: "status = 'RUNNING'",
            order_by: ["start_time DESC"]
        });

        const runs = data.runs || [];
        for (const run of runs) {
            const runId = run.info.run_id;
            const metrics = {};
            for (const m of (run.data?.metrics || [])) {
                metrics[m.key] = m.value;
            }
            const params = {};
            for (const p of (run.data?.params || [])) {
                params[p.key] = p.value;
            }

            const folds = Object.keys(metrics).filter(k => k.startsWith('fold') && k.includes('train_loss')).length;
            const prevFolds = lastKnownFolds[runId] || 0;

            if (folds > prevFolds) {
                // New fold completed!
                const node = params.node || '?';
                const expId = run.info.experiment_id;
                const expName = { '15': 'Transformer', '16': 'CNN', '17': 'Mamba', '18': 'Hawkes', '19': '3DCNN', '20': 'NeuralODE' }[expId] || `exp${expId}`;

                // Get OOT IC for the new fold
                const foldNum = folds - 1;
                const ic10s = metrics[`oot_ic_10s_fold${String(foldNum).padStart(2, '0')}`];
                const icStr = ic10s !== undefined ? `IC_10s=${ic10s.toFixed(3)}` : 'IC pending';

                const concat = metrics.concat_ic_10s;
                const concatStr = concat ? ` | CONCAT=${concat.toFixed(4)}` : '';

                sendToDiscord(
                    `📊 **FOLD ${foldNum} COMPLETE** | ${expName} on ${node} | ${icStr}${concatStr} | ` +
                    `Run ${runId.substring(0, 8)} | ${folds} folds total`
                );

                // Check if IC is below benchmark — flag it
                if (ic10s !== undefined && folds >= 2) {
                    if (expName === 'CNN' && ic10s < 0.08) {
                        sendToDiscord(`⚠️ ${expName} on ${node} fold${foldNum} IC=${ic10s.toFixed(3)} — BELOW CNN benchmark (0.13). Consider killing.`);
                    }
                    if (expName === 'Transformer' && ic10s < 0.05) {
                        sendToDiscord(`⚠️ ${expName} on ${node} fold${foldNum} IC=${ic10s.toFixed(3)} — BELOW TF benchmark (0.10). Consider killing.`);
                    }
                }
            }

            lastKnownFolds[runId] = folds;
        }

        // Check for finished runs
        const finishedData = await httpPost(`${MLFLOW_URL}/api/2.0/mlflow/runs/search`, {
            experiment_ids: ["15", "16", "17", "18", "19", "20"],
            max_results: 5,
            filter: "status = 'FINISHED'",
            order_by: ["end_time DESC"]
        });

        // Could notify on recently finished runs too

    } catch (e) {
        // MLflow might be down — don't spam
        if (Math.random() < 0.1) console.log(`[MONITOR] MLflow check failed: ${e.message}`);
    }
}

// ─── GPU Idle Check ─────────────────────────────────────────
function checkGPUs() {
    try {
        // Neptune
        const neptuneGpu = execSync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits',
            { timeout: 10000, windowsHide: true, encoding: 'utf8' }).trim();
        const neptuneUtil = parseInt(neptuneGpu);

        if (neptuneUtil < 10) {
            if (!gpuIdleSince.neptune) gpuIdleSince.neptune = Date.now();
            const idleMs = Date.now() - gpuIdleSince.neptune;
            const lastAlert = lastGpuAlertTime.neptune || 0;
            const sinceLastAlert = Date.now() - lastAlert;
            if (idleMs > GPU_IDLE_THRESHOLD_MS && sinceLastAlert > GPU_ALERT_COOLDOWN_MS) {
                sendToDiscord(`🔴 **Neptune GPU IDLE for ${Math.round(idleMs/60000)}min!** Util=${neptuneUtil}%. Launch next experiment from queue NOW.`, 'alerts');
                lastGpuAlertTime.neptune = Date.now();
            }
        } else {
            gpuIdleSince.neptune = null;
        }
    } catch (e) {
        // nvidia-smi failed
    }

    // Uranus via ssh_exec
    try {
        const uranusGpu = execSync(
            'python3 utils/ssh_exec.py --server uranus --timeout 10 "nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits"',
            { timeout: 20000, windowsHide: true, encoding: 'utf8', cwd: process.env.TELECLAUDE_DIR || '.' }
        ).trim();
        const uranusUtil = parseInt(uranusGpu);

        if (uranusUtil < 10) {
            if (!gpuIdleSince.uranus) gpuIdleSince.uranus = Date.now();
            const idleMs = Date.now() - gpuIdleSince.uranus;
            const lastAlert = lastGpuAlertTime.uranus || 0;
            const sinceLastAlert = Date.now() - lastAlert;
            if (idleMs > GPU_IDLE_THRESHOLD_MS && sinceLastAlert > GPU_ALERT_COOLDOWN_MS) {
                sendToDiscord(`🔴 **Uranus GPU IDLE for ${Math.round(idleMs/60000)}min!** Util=${uranusUtil}%. Launch next experiment from queue NOW.`, 'alerts');
                lastGpuAlertTime.uranus = Date.now();
            }
        } else {
            gpuIdleSince.uranus = null;
        }
    } catch (e) {
        // SSH failed
    }
}

// ─── Deep Evaluation Prompt (15 min) ────────────────────────
function sendDeepCheckPrompt() {
    sendToDiscord(
`CRITICAL AUTONOMOUS CHECK — Head of Quant. DEEP EVALUATION required.

Read memory file feedback_critical_autonomous_checks.md FIRST.

## STEP 1: Check ALL nodes (GPU util + WHAT is training)
- Neptune: nvidia-smi + check MLflow for Neptune RUNNING runs (experiment IDs 15-18+)
- Uranus: ssh_exec nvidia-smi + check MLflow for Admin RUNNING runs
- Razer: Ray job status for latest job
- Jupiter/Saturn CPU: Any Ray jobs running?

## STEP 2: DEEP EVALUATION per node (not just GPU %)
For EACH active node:
1. "What SPECIFIC experiment and fold is this?" — check MLflow run ID, fold count, IC so far
2. "Is this producing VALUE?" — compare IC to our benchmarks (CNN concat=0.131, TF=0.104). If significantly worse after 2 folds, KILL IT.
3. "Is this a DUPLICATE?" — check if another node runs the same thing
4. "How long has this been running?" — if >3h with no fold completion, investigate (Mamba lesson)
5. "What UNTESTED experiment should replace it if killed?"

## STEP 3: Check logs for errors/stalls
- tail training logs for recent output
- Check for OOM, NaN loss, or stalled training
- If no log output for >30 min on an active run, something may be wrong

## STEP 4: Research queue — pick from UNTESTED ideas only
- TF MFE prediction, TF binary "big move?", CNN w=750, 2D/3D event CNN
- Orderflow LGBM confluence, vol-gated execution, combined signal pipeline
- NEVER relaunch default CNN (10+ runs exist, concat=0.131 established)

## STEP 5: Act and report
- Report to #system-status: WHAT each node runs, its IC PROGRESS, and WHY it should continue
- Kill underperformers. Launch new experiments. Keep CPU nodes busy.
- "All nodes productive" means DIFFERENT experiments producing NEW INFORMATION with MEASURABLE PROGRESS.`
    );
}

// ─── HTTP Helper ────────────────────────────────────────────
function httpPost(url, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
            timeout: 10000,
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { reject(new Error('Invalid JSON')); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
    });
}

// ─── Main Loop ──────────────────────────────────────────────
console.log('[MONITOR] Persistent Autonomous Monitor starting...');
console.log(`[MONITOR] Deep check every ${CHECK_INTERVAL_MS/60000}min, MLflow poll every ${MLFLOW_POLL_MS/1000}s, GPU check every ${GPU_CHECK_MS/1000}s`);

// Immediate first check
setTimeout(checkMLflow, 5000);
setTimeout(checkGPUs, 10000);

// Set intervals
setInterval(sendDeepCheckPrompt, CHECK_INTERVAL_MS);
setInterval(checkMLflow, MLFLOW_POLL_MS);
setInterval(checkGPUs, GPU_CHECK_MS);

// First deep check after 1 minute
setTimeout(sendDeepCheckPrompt, 60000);

console.log('[MONITOR] All intervals set. Running autonomously.');
