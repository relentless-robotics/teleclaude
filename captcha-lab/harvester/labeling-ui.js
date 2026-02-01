/**
 * CAPTCHA Labeling UI
 *
 * Web interface for manually labeling harvested CAPTCHAs.
 * Run: node labeling-ui.js
 * Open: http://localhost:3001
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const harvester = require('./index');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve CAPTCHA images
app.use('/images', express.static(harvester.IMAGES_DIR));

// Homepage - labeling interface
app.get('/', (req, res) => {
  const stats = harvester.getStats();
  const unlabeled = harvester.getUnlabeledSamples(1)[0];

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>CAPTCHA Labeling</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      background: #1a1a2e;
      color: #eee;
    }
    h1 { color: #00d4ff; }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 15px;
      margin: 20px 0;
    }
    .stat {
      background: #16213e;
      padding: 20px;
      border-radius: 10px;
      text-align: center;
    }
    .stat-value {
      font-size: 2em;
      font-weight: bold;
      color: #00d4ff;
    }
    .stat-label { color: #888; }
    .captcha-box {
      background: #16213e;
      padding: 30px;
      border-radius: 15px;
      text-align: center;
      margin: 30px 0;
    }
    .captcha-image {
      max-width: 100%;
      max-height: 200px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    input[type="text"] {
      width: 100%;
      padding: 15px;
      font-size: 24px;
      text-align: center;
      border: 2px solid #333;
      border-radius: 8px;
      background: #0f0f23;
      color: #fff;
      letter-spacing: 3px;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: #00d4ff;
    }
    .buttons {
      display: flex;
      gap: 10px;
      margin-top: 20px;
      justify-content: center;
    }
    button {
      padding: 12px 30px;
      font-size: 16px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: transform 0.1s;
    }
    button:hover { transform: scale(1.05); }
    button:active { transform: scale(0.95); }
    .btn-submit {
      background: #00d4ff;
      color: #000;
    }
    .btn-skip {
      background: #555;
      color: #fff;
    }
    .btn-invalid {
      background: #ff4757;
      color: #fff;
    }
    .message {
      padding: 15px;
      border-radius: 8px;
      margin: 20px 0;
      text-align: center;
    }
    .success { background: #00a86b; }
    .error { background: #ff4757; }
    .info { background: #16213e; color: #888; }
    .no-captcha {
      padding: 40px;
      text-align: center;
      color: #888;
    }
    .keyboard-hint {
      color: #666;
      font-size: 14px;
      margin-top: 15px;
    }
    a { color: #00d4ff; }
    .nav {
      display: flex;
      gap: 20px;
      margin-bottom: 30px;
    }
    .nav a {
      padding: 10px 20px;
      background: #16213e;
      border-radius: 8px;
      text-decoration: none;
    }
    .nav a:hover { background: #1f3460; }
  </style>
</head>
<body>
  <h1>🏷️ CAPTCHA Labeling</h1>

  <div class="nav">
    <a href="/">Label</a>
    <a href="/stats">Stats</a>
    <a href="/export">Export</a>
    <a href="/harvest">Harvest</a>
  </div>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${stats.total}</div>
      <div class="stat-label">Total</div>
    </div>
    <div class="stat">
      <div class="stat-value">${stats.labeled}</div>
      <div class="stat-label">Labeled</div>
    </div>
    <div class="stat">
      <div class="stat-value">${stats.unlabeled}</div>
      <div class="stat-label">Pending</div>
    </div>
  </div>

  ${unlabeled ? `
  <div class="captcha-box">
    <img src="/images/${unlabeled.filename}" class="captcha-image" alt="CAPTCHA">
    <form id="labelForm" action="/label" method="POST">
      <input type="hidden" name="id" value="${unlabeled.id}">
      <input type="text"
             name="label"
             id="labelInput"
             placeholder="Type the CAPTCHA text"
             autocomplete="off"
             autofocus>
      <div class="buttons">
        <button type="submit" class="btn-submit">Submit (Enter)</button>
        <button type="button" class="btn-skip" onclick="skip('${unlabeled.id}')">Skip (S)</button>
        <button type="button" class="btn-invalid" onclick="markInvalid('${unlabeled.id}')">Invalid (I)</button>
      </div>
    </form>
    <div class="keyboard-hint">
      Keyboard: Enter = Submit | S = Skip | I = Mark Invalid
    </div>
  </div>
  ` : `
  <div class="no-captcha">
    <p>No unlabeled CAPTCHAs remaining!</p>
    <p><a href="/harvest">Harvest more CAPTCHAs</a></p>
  </div>
  `}

  <script>
    document.addEventListener('keydown', (e) => {
      if (e.key === 's' && document.activeElement.tagName !== 'INPUT') {
        skip('${unlabeled?.id || ''}');
      }
      if (e.key === 'i' && document.activeElement.tagName !== 'INPUT') {
        markInvalid('${unlabeled?.id || ''}');
      }
    });

    function skip(id) {
      if (id) {
        window.location.href = '/skip/' + id;
      }
    }

    function markInvalid(id) {
      if (id) {
        fetch('/invalid/' + id, { method: 'POST' })
          .then(() => window.location.reload());
      }
    }
  </script>
</body>
</html>
  `);
});

// Submit label
app.post('/label', (req, res) => {
  const { id, label } = req.body;

  if (!label || !label.trim()) {
    return res.redirect('/?error=empty');
  }

  const result = harvester.labelSample(id, label.trim().toUpperCase());

  if (result.success) {
    res.redirect('/?labeled=' + label);
  } else {
    res.redirect('/?error=' + encodeURIComponent(result.error));
  }
});

// Skip sample (just reload for next one)
app.get('/skip/:id', (req, res) => {
  // We could move it to a "skipped" category, but for now just reload
  res.redirect('/');
});

// Mark as invalid
app.post('/invalid/:id', (req, res) => {
  const result = harvester.labelSample(req.params.id, '__INVALID__');
  res.json(result);
});

// Stats page
app.get('/stats', (req, res) => {
  const stats = harvester.getStats();
  const labels = harvester.loadLabels();

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>CAPTCHA Stats</title>
  <style>
    body { font-family: system-ui; max-width: 1000px; margin: 50px auto; padding: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #00d4ff; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #333; }
    th { background: #16213e; }
    .chart { height: 200px; background: #16213e; border-radius: 10px; padding: 20px; margin: 20px 0; }
    a { color: #00d4ff; }
  </style>
</head>
<body>
  <h1>📊 CAPTCHA Stats</h1>
  <p><a href="/">← Back to Labeling</a></p>

  <h2>Overview</h2>
  <table>
    <tr><th>Metric</th><th>Value</th></tr>
    <tr><td>Total Samples</td><td>${stats.total}</td></tr>
    <tr><td>Labeled</td><td>${stats.labeled}</td></tr>
    <tr><td>Unlabeled</td><td>${stats.unlabeled}</td></tr>
    <tr><td>Completion</td><td>${stats.total ? ((stats.labeled / stats.total) * 100).toFixed(1) : 0}%</td></tr>
  </table>

  <h2>By Source</h2>
  <table>
    <tr><th>Source</th><th>Count</th></tr>
    ${Object.entries(stats.bySource).map(([source, count]) =>
      `<tr><td>${source}</td><td>${count}</td></tr>`
    ).join('')}
  </table>

  <h2>By Type</h2>
  <table>
    <tr><th>Type</th><th>Count</th></tr>
    ${Object.entries(stats.byType).map(([type, count]) =>
      `<tr><td>${type}</td><td>${count}</td></tr>`
    ).join('')}
  </table>

  <h2>Recent Samples</h2>
  <table>
    <tr><th>ID</th><th>Source</th><th>Label</th><th>Added</th></tr>
    ${labels.samples.slice(-20).reverse().map(s =>
      `<tr>
        <td>${s.id.slice(0, 8)}</td>
        <td>${s.source}</td>
        <td>${s.label || '<em>unlabeled</em>'}</td>
        <td>${new Date(s.addedAt).toLocaleString()}</td>
      </tr>`
    ).join('')}
  </table>
</body>
</html>
  `);
});

// Export page
app.get('/export', (req, res) => {
  const stats = harvester.getStats();

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Export Dataset</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #00d4ff; }
    .card { background: #16213e; padding: 20px; border-radius: 10px; margin: 20px 0; }
    button { padding: 15px 30px; font-size: 16px; background: #00d4ff; color: #000; border: none; border-radius: 8px; cursor: pointer; }
    a { color: #00d4ff; }
    pre { background: #0f0f23; padding: 15px; border-radius: 8px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>📦 Export Dataset</h1>
  <p><a href="/">← Back to Labeling</a></p>

  <div class="card">
    <h2>Labeled Samples: ${stats.labeled}</h2>
    <p>Export all labeled CAPTCHAs for training.</p>
    <form action="/export/download" method="POST">
      <button type="submit">Export Dataset</button>
    </form>
  </div>

  <div class="card">
    <h2>Dataset Format</h2>
    <p>Exported dataset includes:</p>
    <ul>
      <li>All labeled CAPTCHA images</li>
      <li>labels.csv - CSV format labels</li>
      <li>labels.json - JSON format labels</li>
    </ul>

    <h3>Example labels.csv:</h3>
    <pre>filename,label
lab_1234567890_abc123.png,XY7K2M
lab_1234567891_def456.png,9QWE3R</pre>
  </div>
</body>
</html>
  `);
});

// Export download
app.post('/export/download', (req, res) => {
  const exportDir = path.join(harvester.DATASETS_DIR, `export_${Date.now()}`);
  const result = harvester.exportDataset(exportDir);

  if (result.success) {
    res.send(`
      <h1>Export Complete!</h1>
      <p>Exported ${result.count} samples to:</p>
      <pre>${result.outputDir}</pre>
      <p><a href="/export">Back</a></p>
    `);
  } else {
    res.send(`
      <h1>Export Failed</h1>
      <p>${result.error}</p>
      <p><a href="/export">Back</a></p>
    `);
  }
});

// Harvest page
app.get('/harvest', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Harvest CAPTCHAs</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #00d4ff; }
    .card { background: #16213e; padding: 20px; border-radius: 10px; margin: 20px 0; }
    button { padding: 15px 30px; font-size: 16px; background: #00d4ff; color: #000; border: none; border-radius: 8px; cursor: pointer; margin: 5px; }
    input { padding: 10px; font-size: 16px; width: 100px; }
    a { color: #00d4ff; }
    .loading { display: none; color: #00d4ff; }
  </style>
</head>
<body>
  <h1>🌾 Harvest CAPTCHAs</h1>
  <p><a href="/">← Back to Labeling</a></p>

  <div class="card">
    <h2>From Local Lab</h2>
    <p>Generate and collect CAPTCHAs from our local lab (auto-labeled).</p>
    <form action="/harvest/lab" method="POST">
      <label>Count: <input type="number" name="count" value="50" min="1" max="1000"></label>
      <button type="submit">Harvest from Lab</button>
    </form>
    <p><small>Note: Lab server must be running on port 3000</small></p>
  </div>

  <div class="card">
    <h2>From Demo Sites</h2>
    <p>Scrape CAPTCHAs from public demo sites (requires manual labeling).</p>
    <form action="/harvest/demo" method="POST">
      <label>Count per site: <input type="number" name="count" value="5" min="1" max="20"></label>
      <button type="submit">Harvest from Demo Sites</button>
    </form>
  </div>

  <div id="loading" class="loading">
    <p>⏳ Harvesting in progress... This may take a while.</p>
  </div>

  <script>
    document.querySelectorAll('form').forEach(form => {
      form.addEventListener('submit', () => {
        document.getElementById('loading').style.display = 'block';
      });
    });
  </script>
</body>
</html>
  `);
});

// Harvest from lab
app.post('/harvest/lab', async (req, res) => {
  const count = parseInt(req.body.count) || 50;

  try {
    const result = await harvester.harvestFromLab(count);
    res.send(`
      <h1>Harvest Complete!</h1>
      <p>Harvested ${result.count || 0} CAPTCHAs from lab.</p>
      <p><a href="/">Start Labeling</a> | <a href="/harvest">Harvest More</a></p>
    `);
  } catch (e) {
    res.send(`
      <h1>Harvest Failed</h1>
      <p>Error: ${e.message}</p>
      <p>Make sure the lab server is running on port 3000.</p>
      <p><a href="/harvest">Back</a></p>
    `);
  }
});

// Harvest from demo sites
app.post('/harvest/demo', async (req, res) => {
  const count = parseInt(req.body.count) || 5;

  try {
    const results = await harvester.harvestFromDemoSites(count);
    const successful = results.filter(r => r.success).length;

    res.send(`
      <h1>Harvest Complete!</h1>
      <p>Harvested ${successful} CAPTCHAs from demo sites.</p>
      <p><a href="/">Start Labeling</a> | <a href="/harvest">Harvest More</a></p>
    `);
  } catch (e) {
    res.send(`
      <h1>Harvest Failed</h1>
      <p>Error: ${e.message}</p>
      <p><a href="/harvest">Back</a></p>
    `);
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`CAPTCHA Labeling UI running at http://localhost:${PORT}`);
});
