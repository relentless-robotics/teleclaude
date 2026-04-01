/**
 * QCC Log Streaming — Real-time log streaming via SSE (Server-Sent Events)
 *
 * Provides three SSE endpoints:
 *   1. /sse/logs/:jobId    — Stream a remote job's log file in real-time
 *   2. /sse/training/:node — Stream the active training log for a node
 *   3. /sse/events         — Stream all QCC events (job start/complete/fail, node up/down, alerts)
 *
 * Also provides:
 *   /logs/:jobId           — HTML terminal-style log viewer page
 *
 * Uses SSE instead of WebSocket to avoid external dependencies (no `ws` module needed).
 */

const { spawn } = require('child_process');
const { execSync } = require('child_process');
const EventEmitter = require('events');

// ========================
// EVENT BUS — Central event emitter for all QCC events
// ========================

class QCCEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // Allow many SSE clients
  }

  /** Emit a typed event to all /sse/events subscribers */
  emitEvent(type, data) {
    const event = {
      type,
      timestamp: new Date().toISOString(),
      ...data,
    };
    this.emit('qcc_event', event);
  }

  jobStarted(jobId, jobName, nodeName, pid) {
    this.emitEvent('job_started', { job_id: jobId, job_name: jobName, node: nodeName, pid });
  }

  jobCompleted(jobId, jobName, nodeName, exitCode, resultSummary) {
    this.emitEvent('job_completed', { job_id: jobId, job_name: jobName, node: nodeName, exit_code: exitCode, result: resultSummary });
  }

  jobFailed(jobId, jobName, nodeName, exitCode, error) {
    this.emitEvent('job_failed', { job_id: jobId, job_name: jobName, node: nodeName, exit_code: exitCode, error });
  }

  nodeUp(nodeName) {
    this.emitEvent('node_up', { node: nodeName });
  }

  nodeDown(nodeName, error) {
    this.emitEvent('node_down', { node: nodeName, error });
  }

  alert(severity, source, message, nodeName) {
    this.emitEvent('alert', { severity, source, message, node: nodeName });
  }

  trainingProgress(jobId, nodeName, fold, totalFolds, progressPct) {
    this.emitEvent('training_progress', { job_id: jobId, node: nodeName, fold, total_folds: totalFolds, progress_pct: progressPct });
  }
}

// Singleton event bus
const eventBus = new QCCEventBus();

// ========================
// ACTIVE STREAM TRACKING
// ========================

// Track active SSH tail processes so we can clean them up
// Map: streamId -> { process, nodeName, type }
const activeStreams = new Map();
let streamIdCounter = 0;

// ========================
// SSE HELPERS
// ========================

function initSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no', // Disable nginx buffering if proxied
  });
  // Send initial comment to establish connection
  res.write(':ok\n\n');
}

function sendSSE(res, data, eventName) {
  try {
    if (eventName) {
      res.write(`event: ${eventName}\n`);
    }
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
    // SSE data lines: split on newlines
    for (const line of jsonStr.split('\n')) {
      res.write(`data: ${line}\n`);
    }
    res.write('\n');
    return true;
  } catch (e) {
    return false; // Client disconnected
  }
}

function sendSSEText(res, text) {
  try {
    for (const line of text.split('\n')) {
      res.write(`data: ${line}\n`);
    }
    res.write('\n');
    return true;
  } catch (e) {
    return false;
  }
}

// ========================
// STREAM: /sse/logs/:jobId — Job log tail via SSH
// ========================

async function handleJobLogStream(req, res, jobId, db, sshPool, logFn) {
  const job = db.getJobStatus(jobId);
  if (!job) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Job ${jobId} not found` }));
    return;
  }

  const nodeName = job.node_name;
  if (!nodeName) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Job ${jobId} has no assigned node` }));
    return;
  }

  const node = db.getNode(nodeName);
  if (!node) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Node '${nodeName}' not found` }));
    return;
  }

  const isWindows = node.os === 'windows';
  const logPath = isWindows
    ? `C:\\temp\\qcc_job_${jobId}.log`
    : `/tmp/qcc_job_${jobId}.log`;

  initSSE(res);
  sendSSE(res, { status: 'connected', job_id: jobId, node: nodeName, log_path: logPath }, 'meta');

  const streamId = ++streamIdCounter;

  // Determine how to tail based on node type
  if (node.name === 'neptune' || node.name === 'localhost') {
    // Local tail
    await tailLocal(res, logPath, isWindows, streamId, logFn);
  } else {
    // Remote tail via SSH
    await tailRemote(res, sshPool, nodeName, logPath, isWindows, streamId, logFn);
  }
}

// ========================
// STREAM: /sse/training/:node — Active training log tail
// ========================

async function handleTrainingLogStream(req, res, nodeName, db, sshPool, logFn) {
  const node = db.getNode(nodeName);
  if (!node) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Node '${nodeName}' not found` }));
    return;
  }

  // Find the latest training job on this node
  const runningJobs = db.listTrainingJobs('running', nodeName);
  let logPath = null;
  let jobId = null;
  const isWindows = node.os === 'windows';

  if (runningJobs && runningJobs.length > 0) {
    jobId = runningJobs[0].id;
    logPath = isWindows
      ? `C:\\temp\\qcc_job_${jobId}.log`
      : `/tmp/qcc_job_${jobId}.log`;
  } else {
    // No running training job — try to find the latest log file
    const findCmd = isWindows
      ? `powershell -Command "Get-ChildItem C:\\temp\\qcc_job_*.log -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName"`
      : `ls -t /tmp/qcc_job_*.log 2>/dev/null | head -1`;

    const result = await sshPool.exec(nodeName, findCmd, 10000);
    if (result.exitCode === 0 && result.stdout.trim()) {
      logPath = result.stdout.trim();
    }
  }

  if (!logPath) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No training log found on ${nodeName}` }));
    return;
  }

  initSSE(res);
  sendSSE(res, { status: 'connected', node: nodeName, job_id: jobId, log_path: logPath }, 'meta');

  const streamId = ++streamIdCounter;

  if (node.name === 'neptune' || node.name === 'localhost') {
    await tailLocal(res, logPath, isWindows, streamId, logFn);
  } else {
    await tailRemote(res, sshPool, nodeName, logPath, isWindows, streamId, logFn);
  }
}

// ========================
// STREAM: /sse/events — QCC event bus
// ========================

function handleEventStream(req, res) {
  initSSE(res);
  sendSSE(res, { status: 'connected', message: 'Listening for QCC events' }, 'meta');

  const listener = (event) => {
    if (!sendSSE(res, event, event.type)) {
      // Client disconnected — remove listener
      eventBus.removeListener('qcc_event', listener);
    }
  };

  eventBus.on('qcc_event', listener);

  // Send keepalive every 30s
  const keepalive = setInterval(() => {
    try {
      res.write(':keepalive\n\n');
    } catch (e) {
      clearInterval(keepalive);
      eventBus.removeListener('qcc_event', listener);
    }
  }, 30000);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    eventBus.removeListener('qcc_event', listener);
  });

  req.on('error', () => {
    clearInterval(keepalive);
    eventBus.removeListener('qcc_event', listener);
  });
}

// ========================
// LOCAL TAIL (for Neptune / localhost)
// ========================

async function tailLocal(res, logPath, isWindows, streamId, logFn) {
  let proc;

  if (isWindows) {
    // Use PowerShell Get-Content -Wait (equivalent to tail -f)
    proc = spawn('powershell', [
      '-Command',
      `if (Test-Path '${logPath}') { Get-Content '${logPath}' -Tail 100 -Wait } else { Write-Host 'Waiting for log file...'; while (!(Test-Path '${logPath}')) { Start-Sleep -Seconds 1 }; Get-Content '${logPath}' -Tail 100 -Wait }`,
    ], { windowsHide: true });
  } else {
    proc = spawn('bash', ['-c', `tail -n 100 -f '${logPath}' 2>/dev/null || (echo 'Waiting for log file...' && while [ ! -f '${logPath}' ]; do sleep 1; done && tail -n 100 -f '${logPath}')`]);
  }

  activeStreams.set(streamId, { process: proc, nodeName: 'local', type: 'tail' });

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    if (!sendSSEText(res, text)) {
      cleanup();
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    sendSSE(res, { error: text }, 'error');
  });

  proc.on('exit', (code) => {
    sendSSE(res, { status: 'stream_ended', exit_code: code }, 'meta');
    try { res.end(); } catch (e) {}
    activeStreams.delete(streamId);
  });

  function cleanup() {
    try { proc.kill(); } catch (e) {}
    activeStreams.delete(streamId);
  }

  // Clean up when client disconnects
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// ========================
// REMOTE TAIL (via SSH)
// ========================

async function tailRemote(res, sshPool, nodeName, logPath, isWindows, streamId, logFn) {
  const entry = sshPool.connections.get(nodeName);

  // Ensure connected
  if (!entry?.connected || !entry?.client) {
    const ok = await sshPool.connect(nodeName);
    if (!ok) {
      sendSSE(res, { error: `Cannot connect to ${nodeName}` }, 'error');
      try { res.end(); } catch (e) {}
      return;
    }
  }

  const conn = sshPool.connections.get(nodeName);
  if (!conn?.client) {
    sendSSE(res, { error: `No SSH client for ${nodeName}` }, 'error');
    try { res.end(); } catch (e) {}
    return;
  }

  let tailCmd;
  if (isWindows) {
    // PowerShell tail -f equivalent
    tailCmd = `powershell -Command "if (Test-Path '${logPath}') { Get-Content '${logPath}' -Tail 100 -Wait } else { Write-Host 'Waiting for log file...'; while (!(Test-Path '${logPath}')) { Start-Sleep -Seconds 1 }; Get-Content '${logPath}' -Tail 100 -Wait }"`;
  } else {
    tailCmd = `tail -n 100 -f '${logPath}' 2>/dev/null || (echo 'Waiting for log file...' && while [ ! -f '${logPath}' ]; do sleep 1; done && tail -n 100 -f '${logPath}')`;
  }

  conn.client.exec(tailCmd, (err, stream) => {
    if (err) {
      sendSSE(res, { error: `SSH exec error: ${err.message}` }, 'error');
      try { res.end(); } catch (e) {}
      return;
    }

    activeStreams.set(streamId, { stream, nodeName, type: 'ssh_tail' });

    stream.on('data', (chunk) => {
      const text = chunk.toString();
      if (!sendSSEText(res, text)) {
        cleanup();
      }
    });

    stream.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      sendSSE(res, { error: text }, 'error');
    });

    stream.on('close', (code) => {
      sendSSE(res, { status: 'stream_ended', exit_code: code }, 'meta');
      try { res.end(); } catch (e) {}
      activeStreams.delete(streamId);
    });

    stream.on('error', (streamErr) => {
      sendSSE(res, { error: streamErr.message }, 'error');
      cleanup();
    });

    function cleanup() {
      try { stream.close(); } catch (e) {}
      try { stream.destroy(); } catch (e) {}
      activeStreams.delete(streamId);
    }

    // Clean up when client disconnects
    res.on('close', cleanup);
    res.on('error', cleanup);
  });
}

// ========================
// HTML LOG VIEWER PAGE
// ========================

function serveLogViewer(res, jobId) {
  const html = buildLogViewerHTML(jobId);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
}

function buildLogViewerHTML(jobId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QCC Log Viewer — Job ${jobId}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0d1117;
      color: #c9d1d9;
      font-family: 'Cascadia Code', 'Fira Code', 'Consolas', 'Monaco', monospace;
      font-size: 13px;
      line-height: 1.5;
    }
    #header {
      position: fixed; top: 0; left: 0; right: 0; z-index: 10;
      background: #161b22;
      border-bottom: 1px solid #30363d;
      padding: 8px 16px;
      display: flex; align-items: center; justify-content: space-between;
    }
    #header h1 {
      font-size: 14px; font-weight: 600; color: #8b5cf6;
    }
    #header .meta {
      font-size: 12px; color: #8b949e;
    }
    #status {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 11px; font-weight: 600;
    }
    #status.connecting { background: #1f2937; color: #fbbf24; }
    #status.connected { background: #064e3b; color: #34d399; }
    #status.disconnected { background: #7f1d1d; color: #f87171; }
    #status.ended { background: #1e3a5f; color: #60a5fa; }
    #controls {
      display: flex; gap: 8px; align-items: center;
    }
    #controls button {
      background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
      padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
    }
    #controls button:hover { background: #30363d; }
    #controls button.active { background: #238636; border-color: #2ea043; }
    #terminal {
      margin-top: 48px;
      padding: 12px 16px 60px 16px;
      white-space: pre-wrap;
      word-break: break-all;
      overflow-y: auto;
      min-height: calc(100vh - 48px);
    }
    #terminal .line {
      padding: 1px 0;
    }
    #terminal .line:hover {
      background: #161b22;
    }
    #terminal .line-num {
      display: inline-block;
      width: 50px;
      color: #484f58;
      text-align: right;
      padding-right: 12px;
      user-select: none;
    }
    #terminal .error {
      color: #f85149;
    }
    #terminal .meta-msg {
      color: #8b5cf6;
      font-style: italic;
    }
    #line-count {
      position: fixed; bottom: 8px; right: 16px;
      background: #161b22; border: 1px solid #30363d;
      padding: 4px 10px; border-radius: 6px;
      font-size: 11px; color: #8b949e;
    }
    /* Highlight patterns */
    .hl-error { color: #f85149; font-weight: bold; }
    .hl-warn { color: #d29922; }
    .hl-success { color: #3fb950; }
    .hl-fold { color: #58a6ff; font-weight: bold; }
    .hl-ic { color: #bc8cff; font-weight: bold; }
  </style>
</head>
<body>
  <div id="header">
    <div>
      <h1>QCC Log Viewer</h1>
      <span class="meta">Job #${jobId}</span>
      <span id="status" class="connecting">Connecting...</span>
      <span id="node-info" class="meta"></span>
    </div>
    <div id="controls">
      <button id="btn-autoscroll" class="active" onclick="toggleAutoscroll()">Auto-scroll</button>
      <button onclick="clearTerminal()">Clear</button>
      <button onclick="downloadLog()">Download</button>
    </div>
  </div>
  <div id="terminal"></div>
  <div id="line-count">0 lines</div>

  <script>
    const terminal = document.getElementById('terminal');
    const statusEl = document.getElementById('status');
    const nodeInfoEl = document.getElementById('node-info');
    const lineCountEl = document.getElementById('line-count');
    const btnAutoscroll = document.getElementById('btn-autoscroll');
    let lineNumber = 0;
    let autoscroll = true;
    let allLines = [];
    let reconnectTimer = null;
    let evtSource = null;

    function connect() {
      if (evtSource) {
        try { evtSource.close(); } catch(e) {}
      }

      statusEl.textContent = 'Connecting...';
      statusEl.className = 'connecting';

      evtSource = new EventSource('/sse/logs/${jobId}');

      evtSource.addEventListener('meta', function(e) {
        const data = JSON.parse(e.data);
        if (data.status === 'connected') {
          statusEl.textContent = 'Connected';
          statusEl.className = 'connected';
          if (data.node) nodeInfoEl.textContent = ' | Node: ' + data.node;
          if (data.log_path) nodeInfoEl.textContent += ' | ' + data.log_path;
        } else if (data.status === 'stream_ended') {
          statusEl.textContent = 'Stream ended (exit: ' + (data.exit_code || '?') + ')';
          statusEl.className = 'ended';
        }
      });

      evtSource.addEventListener('error_event', function(e) {
        const data = JSON.parse(e.data);
        appendLine(data.error || 'Unknown error', 'error');
      });

      evtSource.onmessage = function(e) {
        // Default data events = log lines
        appendLine(e.data, null);
      };

      evtSource.onerror = function() {
        statusEl.textContent = 'Disconnected';
        statusEl.className = 'disconnected';
        evtSource.close();
        // Auto-reconnect after 3s
        reconnectTimer = setTimeout(connect, 3000);
      };
    }

    function appendLine(text, cssClass) {
      lineNumber++;
      allLines.push(text);
      const div = document.createElement('div');
      div.className = 'line';
      const numSpan = '<span class="line-num">' + lineNumber + '</span>';
      const highlighted = cssClass ? '<span class="' + cssClass + '">' + escapeHtml(text) + '</span>'
                                    : highlightLine(escapeHtml(text));
      div.innerHTML = numSpan + highlighted;
      terminal.appendChild(div);
      lineCountEl.textContent = lineNumber + ' lines';
      if (autoscroll) {
        window.scrollTo(0, document.body.scrollHeight);
      }
    }

    function highlightLine(text) {
      // Apply syntax highlighting for common patterns
      text = text.replace(/(error|Error|ERROR|exception|Exception|EXCEPTION|traceback|Traceback|FATAL|fatal)/g,
        '<span class="hl-error">$1</span>');
      text = text.replace(/(warning|Warning|WARN)/g,
        '<span class="hl-warn">$1</span>');
      text = text.replace(/(complete|Complete|COMPLETE|success|SUCCESS|done|Done)/g,
        '<span class="hl-success">$1</span>');
      text = text.replace(/(fold|Fold)\\s*(\\d+)/g,
        '<span class="hl-fold">$1 $2</span>');
      text = text.replace(/(IC|ic)[=:\\s]+(-?[\\d.]+)/g,
        '<span class="hl-ic">$1=$2</span>');
      return text;
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function toggleAutoscroll() {
      autoscroll = !autoscroll;
      btnAutoscroll.className = autoscroll ? 'active' : '';
      if (autoscroll) window.scrollTo(0, document.body.scrollHeight);
    }

    function clearTerminal() {
      terminal.innerHTML = '';
      lineNumber = 0;
      allLines = [];
      lineCountEl.textContent = '0 lines';
    }

    function downloadLog() {
      const blob = new Blob([allLines.join('\\n')], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'qcc_job_${jobId}.log';
      a.click();
    }

    // Detect manual scroll to disable autoscroll
    let ticking = false;
    window.addEventListener('scroll', function() {
      if (!ticking) {
        window.requestAnimationFrame(function() {
          const atBottom = (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 50);
          if (!atBottom && autoscroll) {
            autoscroll = false;
            btnAutoscroll.className = '';
          } else if (atBottom && !autoscroll) {
            autoscroll = true;
            btnAutoscroll.className = 'active';
          }
          ticking = false;
        });
        ticking = true;
      }
    });

    connect();
  </script>
</body>
</html>`;
}

// ========================
// ROUTE HANDLER — Called from daemon.js HTTP server
// ========================

/**
 * Try to handle a streaming/log request.
 * Returns true if handled, false if the route doesn't match.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} pathname
 * @param {object} db - QCCDatabase instance
 * @param {object} sshPool - QCCSSHPool instance
 * @param {function} logFn - Logging function
 * @returns {boolean} Whether the route was handled
 */
function handleStreamRoute(req, res, pathname, db, sshPool, logFn) {
  // /sse/logs/:jobId
  const jobLogMatch = pathname.match(/^\/sse\/logs\/(\d+)$/);
  if (jobLogMatch) {
    const jobId = parseInt(jobLogMatch[1], 10);
    handleJobLogStream(req, res, jobId, db, sshPool, logFn).catch(e => {
      logFn('ERROR', `Job log stream error: ${e.message}`);
      try { res.end(); } catch (ex) {}
    });
    return true;
  }

  // /sse/training/:nodeName
  const trainingMatch = pathname.match(/^\/sse\/training\/([a-zA-Z0-9_-]+)$/);
  if (trainingMatch) {
    const nodeName = trainingMatch[1];
    handleTrainingLogStream(req, res, nodeName, db, sshPool, logFn).catch(e => {
      logFn('ERROR', `Training log stream error: ${e.message}`);
      try { res.end(); } catch (ex) {}
    });
    return true;
  }

  // /sse/events
  if (pathname === '/sse/events') {
    handleEventStream(req, res);
    return true;
  }

  // /logs/:jobId — HTML log viewer
  const logViewerMatch = pathname.match(/^\/logs\/(\d+)$/);
  if (logViewerMatch) {
    const jobId = parseInt(logViewerMatch[1], 10);
    serveLogViewer(res, jobId);
    return true;
  }

  return false;
}

/**
 * Get the count of active streams for status reporting.
 */
function getActiveStreamCount() {
  return activeStreams.size;
}

/**
 * Clean up all active streams (call on shutdown).
 */
function destroyAllStreams() {
  for (const [id, entry] of activeStreams) {
    try {
      if (entry.process) entry.process.kill();
      if (entry.stream) { entry.stream.close(); entry.stream.destroy(); }
    } catch (e) {}
  }
  activeStreams.clear();
}

module.exports = {
  eventBus,
  handleStreamRoute,
  getActiveStreamCount,
  destroyAllStreams,
};
