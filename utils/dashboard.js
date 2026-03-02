/**
 * TeleClaude Status Dashboard
 *
 * Local web dashboard showing system status, active tasks, memory, and usage.
 * Run with: node utils/dashboard.js
 * Access at: http://localhost:3847
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.DASHBOARD_PORT || 3847;

// File paths
const MEMORY_FILE = path.join(__dirname, '..', 'memory', 'memories.json');
const USAGE_FILE = path.join(__dirname, '..', 'logs', 'token_usage.json');
const STATUS_FILE = path.join(__dirname, '..', 'logs', 'system_status.json');

/**
 * Load JSON file safely
 */
function loadJson(filepath) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    }
  } catch (e) {
    console.error(`Error loading ${filepath}:`, e.message);
  }
  return null;
}

/**
 * Get memory status
 */
function getMemoryStatus() {
  const data = loadJson(MEMORY_FILE);
  if (!data || !data.memories) {
    return { total: 0, byPriority: {}, recent: [] };
  }

  const memories = data.memories.filter(m => m.status === 'active');
  const byPriority = {};

  for (const mem of memories) {
    byPriority[mem.priority] = (byPriority[mem.priority] || 0) + 1;
  }

  return {
    total: memories.length,
    byPriority,
    recent: memories.slice(-5).reverse().map(m => ({
      id: m.id.slice(0, 8),
      content: m.content.slice(0, 100) + (m.content.length > 100 ? '...' : ''),
      priority: m.priority,
      created: m.created_at
    }))
  };
}

/**
 * Get token usage status
 */
function getTokenStatus() {
  const data = loadJson(USAGE_FILE);
  if (!data) {
    return { spent: 0, budget: 10, percent: 0, status: 'NO DATA' };
  }

  const today = new Date().toISOString().split('T')[0];
  const todayData = data.daily?.[today] || { totalCost: 0, requests: 0 };
  const budget = data.config?.dailyBudget || 10;
  const spent = todayData.totalCost || 0;
  const percent = (spent / budget) * 100;

  let status = 'OK';
  if (percent >= 95) status = 'CRITICAL';
  else if (percent >= 80) status = 'WARNING';

  return {
    spent: spent.toFixed(4),
    budget: budget.toFixed(2),
    percent: percent.toFixed(1),
    status,
    requests: todayData.requests || 0,
    byModel: todayData.byModel || {}
  };
}

/**
 * Get system status
 */
function getSystemStatus() {
  const data = loadJson(STATUS_FILE);
  return data || {
    lastActive: null,
    activeTasks: [],
    recentCompletedTasks: []
  };
}

/**
 * Update system status (call this from main bridge)
 */
function updateSystemStatus(updates) {
  const current = getSystemStatus();
  const updated = { ...current, ...updates, lastUpdated: new Date().toISOString() };

  const dir = path.dirname(STATUS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(STATUS_FILE, JSON.stringify(updated, null, 2));
  return updated;
}

/**
 * Generate HTML dashboard
 */
function generateDashboard() {
  const memory = getMemoryStatus();
  const tokens = getTokenStatus();
  const system = getSystemStatus();

  const statusColor = {
    'OK': '#4ade80',
    'WARNING': '#fbbf24',
    'CRITICAL': '#ef4444',
    'NO DATA': '#6b7280'
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="30">
  <title>TeleClaude Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 20px;
      min-height: 100vh;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 {
      font-size: 2rem;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    h1::before { content: '🤖'; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
      gap: 20px;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 20px;
      border: 1px solid #334155;
    }
    .card h2 {
      font-size: 1.1rem;
      color: #94a3b8;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .stat {
      font-size: 2.5rem;
      font-weight: bold;
      color: #f1f5f9;
    }
    .stat-label {
      color: #64748b;
      font-size: 0.9rem;
      margin-top: 5px;
    }
    .progress-bar {
      height: 12px;
      background: #334155;
      border-radius: 6px;
      overflow: hidden;
      margin: 15px 0;
    }
    .progress-fill {
      height: 100%;
      border-radius: 6px;
      transition: width 0.3s;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 600;
    }
    .memory-item {
      background: #334155;
      padding: 10px 15px;
      border-radius: 8px;
      margin-bottom: 10px;
      font-size: 0.9rem;
    }
    .memory-item .priority {
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 10px;
      background: #475569;
      margin-right: 8px;
    }
    .priority-URGENT { background: #dc2626; }
    .priority-DAILY { background: #2563eb; }
    .priority-WEEKLY { background: #7c3aed; }
    .priority-ARCHIVE { background: #475569; }
    .model-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #334155;
    }
    .model-row:last-child { border-bottom: none; }
    .timestamp {
      color: #64748b;
      font-size: 0.8rem;
      margin-top: 15px;
    }
    .refresh-note {
      text-align: center;
      color: #64748b;
      font-size: 0.85rem;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>TeleClaude Dashboard</h1>

    <div class="grid">
      <!-- Token Usage Card -->
      <div class="card">
        <h2>💰 Token Usage (Today)</h2>
        <div class="stat">$${tokens.spent}</div>
        <div class="stat-label">of $${tokens.budget} daily budget</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${Math.min(tokens.percent, 100)}%; background: ${statusColor[tokens.status]}"></div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span>${tokens.percent}% used</span>
          <span class="status-badge" style="background: ${statusColor[tokens.status]}">${tokens.status}</span>
        </div>
        <div style="margin-top: 15px; color: #94a3b8;">
          ${tokens.requests} requests today
        </div>
        ${tokens.byModel && Object.keys(tokens.byModel).length > 0 ? `
        <div style="margin-top: 15px;">
          <div style="color: #64748b; font-size: 0.85rem; margin-bottom: 8px;">By Model:</div>
          ${Object.entries(tokens.byModel).map(([model, data]) => `
            <div class="model-row">
              <span>${model}</span>
              <span>$${data.cost?.toFixed(4) || '0.0000'} (${data.requests || 0})</span>
            </div>
          `).join('')}
        </div>
        ` : ''}
      </div>

      <!-- Memory Status Card -->
      <div class="card">
        <h2>🧠 Memory System</h2>
        <div class="stat">${memory.total}</div>
        <div class="stat-label">active memories</div>
        <div style="margin-top: 15px; display: flex; gap: 10px; flex-wrap: wrap;">
          ${Object.entries(memory.byPriority).map(([priority, count]) => `
            <span class="status-badge priority-${priority}">${priority}: ${count}</span>
          `).join('')}
        </div>
        ${memory.recent.length > 0 ? `
        <div style="margin-top: 20px;">
          <div style="color: #64748b; font-size: 0.85rem; margin-bottom: 10px;">Recent:</div>
          ${memory.recent.map(m => `
            <div class="memory-item">
              <span class="priority priority-${m.priority}">${m.priority}</span>
              ${m.content}
            </div>
          `).join('')}
        </div>
        ` : ''}
      </div>

      <!-- System Status Card -->
      <div class="card">
        <h2>⚡ System Status</h2>
        <div style="margin-bottom: 15px;">
          <span style="color: #4ade80; font-size: 1.5rem;">●</span>
          <span style="margin-left: 8px; font-size: 1.1rem;">Online</span>
        </div>
        <div style="color: #94a3b8;">
          <div style="margin-bottom: 8px;">Platform: Discord Bridge</div>
          <div style="margin-bottom: 8px;">Model: Claude Opus 4.5</div>
          ${system.lastActive ? `<div>Last Active: ${new Date(system.lastActive).toLocaleString()}</div>` : ''}
        </div>
        ${system.activeTasks?.length > 0 ? `
        <div style="margin-top: 20px;">
          <div style="color: #fbbf24; font-size: 0.85rem; margin-bottom: 10px;">Active Tasks:</div>
          ${system.activeTasks.map(t => `
            <div class="memory-item">${t}</div>
          `).join('')}
        </div>
        ` : '<div style="margin-top: 20px; color: #64748b;">No active background tasks</div>'}
      </div>

      <!-- Quick Stats Card -->
      <div class="card">
        <h2>📊 Quick Stats</h2>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
          <div>
            <div style="font-size: 1.8rem; font-weight: bold;">${memory.byPriority.URGENT || 0}</div>
            <div style="color: #ef4444; font-size: 0.9rem;">Urgent Items</div>
          </div>
          <div>
            <div style="font-size: 1.8rem; font-weight: bold;">${memory.byPriority.DAILY || 0}</div>
            <div style="color: #3b82f6; font-size: 0.9rem;">Daily Tasks</div>
          </div>
          <div>
            <div style="font-size: 1.8rem; font-weight: bold;">${tokens.requests}</div>
            <div style="color: #94a3b8; font-size: 0.9rem;">API Calls Today</div>
          </div>
          <div>
            <div style="font-size: 1.8rem; font-weight: bold;">$${(tokens.budget - tokens.spent).toFixed(2)}</div>
            <div style="color: #4ade80; font-size: 0.9rem;">Budget Left</div>
          </div>
        </div>
      </div>
    </div>

    <p class="timestamp">Last updated: ${new Date().toLocaleString()}</p>
    <p class="refresh-note">Auto-refreshes every 30 seconds</p>
  </div>
</body>
</html>`;
}

/**
 * Generate JSON API response
 */
function generateApiResponse() {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    memory: getMemoryStatus(),
    tokens: getTokenStatus(),
    system: getSystemStatus()
  }, null, 2);
}

/**
 * HTTP request handler
 */
function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/api' || url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(generateApiResponse());
  } else if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(generateDashboard());
  }
}

/**
 * Start the dashboard server
 */
function startServer() {
  const server = http.createServer(handleRequest);

  server.listen(PORT, () => {
    console.log(`TeleClaude Dashboard running at http://localhost:${PORT}`);
    console.log(`API endpoint: http://localhost:${PORT}/api`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });

  return server;
}

// Export for use as module
module.exports = {
  startServer,
  getMemoryStatus,
  getTokenStatus,
  getSystemStatus,
  updateSystemStatus,
  generateDashboard,
  PORT
};

// Run server if called directly
if (require.main === module) {
  startServer();
}
