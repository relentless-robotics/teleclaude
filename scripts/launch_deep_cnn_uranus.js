/**
 * Transfer data and launch Deep CNN experiment on Uranus (RTX 5090).
 *
 * Steps:
 * 1. Create directories on Uranus
 * 2. Upload the training script
 * 3. Upload ~100 days of book tensor data
 * 4. Launch training in background
 * 5. Monitor GPU utilization
 */

const ssh = require('../utils/ssh_manager');
const path = require('path');
const fs = require('fs');

const URANUS = 'uranus';
const LOCAL_DATA_DIR = path.join(__dirname, '..', '..', 'Lvl3Quant', 'data', 'processed', 'dl_book_cache');
const SCRIPT_PATH = path.join(__dirname, 'deep_cnn_experiment.py');
const REMOTE_BASE = 'C:/Users/Nick/deep_cnn_experiment';
const REMOTE_DATA = `${REMOTE_BASE}/data`;
const REMOTE_RESULTS = `${REMOTE_BASE}/results`;
const REMOTE_SCRIPT = `${REMOTE_BASE}/deep_cnn_experiment.py`;

// How many days to transfer (first N trading days)
const N_DAYS = 100;

async function run() {
    console.log('=== Deep CNN Experiment Launcher ===\n');

    // 1. Create remote directories
    console.log('Step 1: Creating directories on Uranus...');
    try {
        const mkdirResult = await ssh.exec(URANUS,
            `mkdir "${REMOTE_BASE}" 2>nul & mkdir "${REMOTE_DATA}" 2>nul & mkdir "${REMOTE_RESULTS}" 2>nul & echo DIRS_OK`,
            { timeout: 15000 }
        );
        console.log('  ', mkdirResult.stdout.trim());
    } catch (e) {
        console.error('  Failed to create dirs:', e.message);
        return;
    }

    // 2. Upload training script
    console.log('\nStep 2: Uploading training script...');
    try {
        // Convert Windows path to SFTP-friendly path
        const remotePath = REMOTE_SCRIPT.replace(/\\/g, '/');
        const result = await ssh.uploadFile(URANUS, SCRIPT_PATH, remotePath);
        console.log('  Script uploaded:', result.success ? 'OK' : result.error);
    } catch (e) {
        console.error('  Upload failed:', e.message);
        return;
    }

    // 3. Upload data files
    console.log(`\nStep 3: Uploading ${N_DAYS} days of book tensor data...`);
    const suffix = '_book_tensors.npz';
    const allFiles = fs.readdirSync(LOCAL_DATA_DIR)
        .filter(f => f.endsWith(suffix))
        .sort();

    const filesToUpload = allFiles.slice(0, N_DAYS);
    console.log(`  Found ${allFiles.length} total files, uploading first ${filesToUpload.length}`);
    console.log(`  Date range: ${filesToUpload[0]} .. ${filesToUpload[filesToUpload.length - 1]}`);

    let uploaded = 0;
    let failed = 0;

    // Upload one at a time to avoid SSH channel exhaustion
    for (let i = 0; i < filesToUpload.length; i++) {
        const fname = filesToUpload[i];
        const localPath = path.join(LOCAL_DATA_DIR, fname);
        const remotePath = `${REMOTE_DATA}/${fname}`.replace(/\\/g, '/');

        let success = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                // Force new connection if previous failed
                if (attempt > 0) {
                    ssh.closeAll && ssh.closeAll();
                    await new Promise(r => setTimeout(r, 1000));
                }
                const result = await ssh.uploadFile(URANUS, localPath, remotePath);
                if (result.success) {
                    uploaded++;
                    success = true;
                    break;
                } else {
                    if (attempt < 2) await new Promise(r => setTimeout(r, 500));
                }
            } catch (e) {
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        if (!success) {
            failed++;
            console.error(`  FAIL: ${fname} (after 3 attempts)`);
        }

        if ((i + 1) % 10 === 0 || i + 1 === filesToUpload.length) {
            console.log(`  Progress: ${i + 1}/${filesToUpload.length} files (${uploaded} OK, ${failed} fail)`);
        }
    }

    console.log(`\n  Upload complete: ${uploaded} OK, ${failed} failed`);

    if (uploaded < 50) {
        console.error('  Too few files uploaded, aborting launch');
        return;
    }

    // 4. Verify data and launch
    console.log('\nStep 4: Verifying upload...');
    try {
        const verifyResult = await ssh.exec(URANUS,
            `dir /b "${REMOTE_DATA}" | find /c ".npz"`,
            { timeout: 15000 }
        );
        console.log(`  Remote files count: ${verifyResult.stdout.trim()}`);
    } catch (e) {
        console.log('  Verify check:', e.message);
    }

    // 5. Launch training
    console.log('\nStep 5: Launching training on Uranus...');
    const pythonCmd = 'python';
    const trainCmd = `${pythonCmd} "${REMOTE_SCRIPT}" --data-dir "${REMOTE_DATA}" --output-dir "${REMOTE_RESULTS}" --days ${N_DAYS} --epochs 5 --batch-size 256 --window-size 50 --lr 2e-4 --subsample-train 3 --dropout 0.15`;

    // Use 'start' to run in background, redirect output to log file
    const logFile = `${REMOTE_BASE}/training.log`;
    const launchCmd = `start /b cmd /c "${trainCmd} > "${logFile}" 2>&1"`;

    try {
        const launchResult = await ssh.exec(URANUS, launchCmd, { timeout: 30000 });
        console.log('  Launch result:', launchResult.stdout.trim() || 'Process started');
        console.log('  Log file:', logFile);
    } catch (e) {
        console.error('  Launch failed:', e.message);
        // Try alternative launch method
        console.log('  Trying alternative launch...');
        try {
            const alt = await ssh.exec(URANUS,
                `powershell -Command "Start-Process python -ArgumentList '${REMOTE_SCRIPT}','--data-dir','${REMOTE_DATA}','--output-dir','${REMOTE_RESULTS}','--days','${N_DAYS}','--epochs','5','--batch-size','256','--window-size','50','--lr','2e-4','--subsample-train','3','--dropout','0.15' -RedirectStandardOutput '${logFile}' -RedirectStandardError '${REMOTE_BASE}/training_err.log' -NoNewWindow"`,
                { timeout: 30000 }
            );
            console.log('  Alt launch:', alt.stdout.trim() || 'Process started');
        } catch (e2) {
            console.error('  Alt launch also failed:', e2.message);
        }
    }

    // 6. Wait a moment and check GPU
    console.log('\nStep 6: Checking GPU utilization (waiting 15s for model to load)...');
    await new Promise(r => setTimeout(r, 15000));

    try {
        const gpuResult = await ssh.exec(URANUS,
            'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader',
            { timeout: 15000 }
        );
        console.log('  GPU status:', gpuResult.stdout.trim());
    } catch (e) {
        console.log('  GPU check:', e.message);
    }

    // Check if training log has output
    try {
        const logResult = await ssh.exec(URANUS,
            `type "${logFile}" 2>nul | findstr /n "."`,
            { timeout: 15000 }
        );
        const lines = (logResult.stdout || '').trim().split('\n');
        console.log(`\n  Training log (${lines.length} lines):`);
        lines.slice(-10).forEach(l => console.log('  ', l));
    } catch (e) {
        console.log('  Log check:', e.message);
    }

    console.log('\n=== Launch sequence complete ===');
    console.log(`Monitor with: ssh uranus "type ${logFile}"`);
    console.log(`Check GPU: ssh uranus "nvidia-smi"`);

    // Close connections
    setTimeout(() => process.exit(0), 2000);
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
