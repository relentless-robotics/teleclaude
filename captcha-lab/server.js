/**
 * CAPTCHA Lab Test Server
 *
 * Serves test pages with various CAPTCHA types for practice and testing.
 * Uses Google's test keys for reCAPTCHA (always passes).
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Store generated text CAPTCHAs
const textCaptchas = new Map();

// Google reCAPTCHA TEST keys (always passes)
const RECAPTCHA_TEST_SITE_KEY = '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI';
const RECAPTCHA_TEST_SECRET_KEY = '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe';

// hCaptcha test keys
const HCAPTCHA_TEST_SITE_KEY = '10000000-ffff-ffff-ffff-000000000001';
const HCAPTCHA_TEST_SECRET_KEY = '0x0000000000000000000000000000000000000000';

// Homepage
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>CAPTCHA Lab</title>
  <style>
    body { font-family: system-ui; max-width: 800px; margin: 50px auto; padding: 20px; }
    h1 { color: #333; }
    .card { background: #f5f5f5; padding: 20px; margin: 15px 0; border-radius: 8px; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .status { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; }
    .test { background: #4caf50; color: white; }
    .practice { background: #2196f3; color: white; }
  </style>
</head>
<body>
  <h1>🔐 CAPTCHA Lab</h1>
  <p>Practice and test CAPTCHA solving in a safe environment.</p>

  <div class="card">
    <h3>reCAPTCHA v2 <span class="status test">Test Mode</span></h3>
    <p>Google's checkbox CAPTCHA. Uses test keys (always passes).</p>
    <a href="/recaptcha-v2">→ Test reCAPTCHA v2</a>
  </div>

  <div class="card">
    <h3>reCAPTCHA v2 Invisible <span class="status test">Test Mode</span></h3>
    <p>Invisible version triggered on form submit.</p>
    <a href="/recaptcha-v2-invisible">→ Test Invisible reCAPTCHA</a>
  </div>

  <div class="card">
    <h3>hCaptcha <span class="status test">Test Mode</span></h3>
    <p>Privacy-focused CAPTCHA alternative. Uses test keys.</p>
    <a href="/hcaptcha">→ Test hCaptcha</a>
  </div>

  <div class="card">
    <h3>Text CAPTCHA <span class="status practice">Practice</span></h3>
    <p>Classic distorted text image. Generated locally.</p>
    <a href="/text-captcha">→ Test Text CAPTCHA</a>
  </div>

  <div class="card">
    <h3>Math CAPTCHA <span class="status practice">Practice</span></h3>
    <p>Simple math problem as image.</p>
    <a href="/math-captcha">→ Test Math CAPTCHA</a>
  </div>

  <div class="card">
    <h3>Multi-CAPTCHA Form <span class="status practice">Practice</span></h3>
    <p>Form with multiple CAPTCHA types for comprehensive testing.</p>
    <a href="/multi-captcha">→ Test Multi-CAPTCHA</a>
  </div>

  <hr>
  <h2>API Endpoints</h2>
  <ul>
    <li><code>GET /api/text-captcha</code> - Generate text CAPTCHA image</li>
    <li><code>POST /api/verify-text</code> - Verify text CAPTCHA</li>
    <li><code>POST /api/verify-recaptcha</code> - Verify reCAPTCHA</li>
    <li><code>GET /api/stats</code> - Get solving statistics</li>
  </ul>
</body>
</html>
  `);
});

// reCAPTCHA v2 page
app.get('/recaptcha-v2', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>reCAPTCHA v2 Test</title>
  <script src="https://www.google.com/recaptcha/api.js" async defer></script>
  <style>
    body { font-family: system-ui; max-width: 500px; margin: 50px auto; padding: 20px; }
    .form-group { margin: 20px 0; }
    button { background: #4285f4; color: white; padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background: #3367d6; }
    .result { margin-top: 20px; padding: 15px; border-radius: 4px; }
    .success { background: #e8f5e9; color: #2e7d32; }
    .error { background: #ffebee; color: #c62828; }
  </style>
</head>
<body>
  <h1>reCAPTCHA v2 Test</h1>
  <p>Site Key: <code>${RECAPTCHA_TEST_SITE_KEY}</code></p>
  <p><em>This uses Google's test keys - the CAPTCHA always passes.</em></p>

  <form id="testForm" action="/api/verify-recaptcha" method="POST">
    <div class="form-group">
      <label>Email:</label><br>
      <input type="email" name="email" value="test@example.com" style="width: 100%; padding: 8px; margin-top: 5px;">
    </div>

    <div class="form-group">
      <div class="g-recaptcha" data-sitekey="${RECAPTCHA_TEST_SITE_KEY}"></div>
    </div>

    <button type="submit">Submit</button>
  </form>

  <div id="result"></div>

  <script>
    document.getElementById('testForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const response = await fetch('/api/verify-recaptcha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: formData.get('g-recaptcha-response'),
          email: formData.get('email')
        })
      });
      const result = await response.json();
      document.getElementById('result').innerHTML =
        '<div class="result ' + (result.success ? 'success' : 'error') + '">' +
        (result.success ? '✅ CAPTCHA verified!' : '❌ Verification failed: ' + result.error) +
        '</div>';
    });
  </script>

  <p style="margin-top: 40px;"><a href="/">← Back to Lab</a></p>
</body>
</html>
  `);
});

// reCAPTCHA v2 Invisible
app.get('/recaptcha-v2-invisible', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Invisible reCAPTCHA Test</title>
  <script src="https://www.google.com/recaptcha/api.js" async defer></script>
  <style>
    body { font-family: system-ui; max-width: 500px; margin: 50px auto; padding: 20px; }
    .form-group { margin: 20px 0; }
    button { background: #4285f4; color: white; padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Invisible reCAPTCHA Test</h1>
  <p><em>CAPTCHA triggers automatically on submit.</em></p>

  <form id="testForm">
    <div class="form-group">
      <label>Username:</label><br>
      <input type="text" name="username" value="testuser" style="width: 100%; padding: 8px;">
    </div>

    <button class="g-recaptcha"
            data-sitekey="${RECAPTCHA_TEST_SITE_KEY}"
            data-callback="onSubmit"
            data-action="submit">
      Submit
    </button>
  </form>

  <div id="result"></div>

  <script>
    function onSubmit(token) {
      document.getElementById('result').innerHTML =
        '<div style="margin-top: 20px; padding: 15px; background: #e8f5e9; border-radius: 4px;">' +
        '✅ Invisible CAPTCHA passed!<br><small>Token: ' + token.slice(0, 50) + '...</small></div>';
    }
  </script>

  <p style="margin-top: 40px;"><a href="/">← Back to Lab</a></p>
</body>
</html>
  `);
});

// hCaptcha page
app.get('/hcaptcha', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>hCaptcha Test</title>
  <script src="https://js.hcaptcha.com/1/api.js" async defer></script>
  <style>
    body { font-family: system-ui; max-width: 500px; margin: 50px auto; padding: 20px; }
    .form-group { margin: 20px 0; }
    button { background: #0074bf; color: white; padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>hCaptcha Test</h1>
  <p>Site Key: <code>${HCAPTCHA_TEST_SITE_KEY}</code></p>
  <p><em>Uses hCaptcha test keys.</em></p>

  <form id="testForm">
    <div class="form-group">
      <label>Name:</label><br>
      <input type="text" name="name" value="Test User" style="width: 100%; padding: 8px;">
    </div>

    <div class="form-group">
      <div class="h-captcha" data-sitekey="${HCAPTCHA_TEST_SITE_KEY}"></div>
    </div>

    <button type="submit">Submit</button>
  </form>

  <div id="result"></div>

  <script>
    document.getElementById('testForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = document.querySelector('[name="h-captcha-response"]').value;
      if (token) {
        document.getElementById('result').innerHTML =
          '<div style="margin-top: 20px; padding: 15px; background: #e8f5e9; border-radius: 4px;">' +
          '✅ hCaptcha passed!</div>';
      } else {
        document.getElementById('result').innerHTML =
          '<div style="margin-top: 20px; padding: 15px; background: #ffebee; border-radius: 4px;">' +
          '❌ Please complete the CAPTCHA</div>';
      }
    });
  </script>

  <p style="margin-top: 40px;"><a href="/">← Back to Lab</a></p>
</body>
</html>
  `);
});

// Text CAPTCHA page
app.get('/text-captcha', (req, res) => {
  const captchaId = crypto.randomUUID();
  const text = generateRandomText(6);
  textCaptchas.set(captchaId, { text, created: Date.now() });

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Text CAPTCHA Test</title>
  <style>
    body { font-family: system-ui; max-width: 500px; margin: 50px auto; padding: 20px; }
    .captcha-box { background: #f0f0f0; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px; }
    .captcha-image { font-family: monospace; font-size: 32px; letter-spacing: 8px;
                     background: linear-gradient(45deg, #667, #889);
                     -webkit-background-clip: text; -webkit-text-fill-color: transparent;
                     text-decoration: line-through; font-style: italic; }
    input { width: 100%; padding: 10px; font-size: 18px; text-align: center; margin-top: 10px; }
    button { background: #4caf50; color: white; padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; margin-top: 15px; }
  </style>
</head>
<body>
  <h1>Text CAPTCHA Test</h1>
  <p>Enter the text shown in the image.</p>

  <div class="captcha-box">
    <div class="captcha-image">${obfuscateText(text)}</div>
    <small>CAPTCHA ID: ${captchaId.slice(0, 8)}...</small>
  </div>

  <form id="testForm">
    <input type="hidden" name="captchaId" value="${captchaId}">
    <input type="text" name="answer" placeholder="Enter CAPTCHA text" autocomplete="off">
    <button type="submit">Verify</button>
  </form>

  <div id="result"></div>

  <script>
    document.getElementById('testForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const response = await fetch('/api/verify-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          captchaId: formData.get('captchaId'),
          answer: formData.get('answer')
        })
      });
      const result = await response.json();
      document.getElementById('result').innerHTML =
        '<div style="margin-top: 20px; padding: 15px; border-radius: 4px; background: ' +
        (result.success ? '#e8f5e9' : '#ffebee') + ';">' +
        (result.success ? '✅ Correct!' : '❌ Wrong answer. Expected: ' + result.expected) +
        '</div>';
    });
  </script>

  <p style="margin-top: 40px;"><a href="/text-captcha">🔄 New CAPTCHA</a> | <a href="/">← Back to Lab</a></p>
</body>
</html>
  `);
});

// Math CAPTCHA page
app.get('/math-captcha', (req, res) => {
  const captchaId = crypto.randomUUID();
  const a = Math.floor(Math.random() * 10) + 1;
  const b = Math.floor(Math.random() * 10) + 1;
  const operators = ['+', '-', '*'];
  const op = operators[Math.floor(Math.random() * operators.length)];
  const answer = eval(`${a} ${op} ${b}`);

  textCaptchas.set(captchaId, { text: String(answer), created: Date.now() });

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Math CAPTCHA Test</title>
  <style>
    body { font-family: system-ui; max-width: 500px; margin: 50px auto; padding: 20px; }
    .captcha-box { background: #f0f0f0; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px; }
    .math { font-size: 28px; font-weight: bold; }
    input { width: 100%; padding: 10px; font-size: 18px; text-align: center; margin-top: 10px; }
    button { background: #2196f3; color: white; padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; margin-top: 15px; }
  </style>
</head>
<body>
  <h1>Math CAPTCHA Test</h1>
  <p>Solve the math problem.</p>

  <div class="captcha-box">
    <div class="math">${a} ${op === '*' ? '×' : op} ${b} = ?</div>
  </div>

  <form id="testForm">
    <input type="hidden" name="captchaId" value="${captchaId}">
    <input type="number" name="answer" placeholder="Enter answer" autocomplete="off">
    <button type="submit">Verify</button>
  </form>

  <div id="result"></div>

  <script>
    document.getElementById('testForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const response = await fetch('/api/verify-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          captchaId: formData.get('captchaId'),
          answer: formData.get('answer')
        })
      });
      const result = await response.json();
      document.getElementById('result').innerHTML =
        '<div style="margin-top: 20px; padding: 15px; border-radius: 4px; background: ' +
        (result.success ? '#e8f5e9' : '#ffebee') + ';">' +
        (result.success ? '✅ Correct!' : '❌ Wrong. Answer was: ' + result.expected) +
        '</div>';
    });
  </script>

  <p style="margin-top: 40px;"><a href="/math-captcha">🔄 New Problem</a> | <a href="/">← Back to Lab</a></p>
</body>
</html>
  `);
});

// API: Verify reCAPTCHA
app.post('/api/verify-recaptcha', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.json({ success: false, error: 'No token provided' });
  }

  // With test keys, always succeeds
  // In production, you'd verify with Google's API
  res.json({ success: true, message: 'reCAPTCHA verified (test mode)' });
});

// API: Verify text CAPTCHA
app.post('/api/verify-text', (req, res) => {
  const { captchaId, answer } = req.body;

  const captcha = textCaptchas.get(captchaId);
  if (!captcha) {
    return res.json({ success: false, error: 'CAPTCHA expired or invalid' });
  }

  const success = answer?.toLowerCase() === captcha.text.toLowerCase();
  textCaptchas.delete(captchaId); // One-time use

  res.json({
    success,
    expected: success ? undefined : captcha.text
  });
});

// API: Generate text CAPTCHA image
app.get('/api/text-captcha', (req, res) => {
  const captchaId = crypto.randomUUID();
  const text = generateRandomText(6);
  textCaptchas.set(captchaId, { text, created: Date.now() });

  res.json({
    captchaId,
    // In production, this would be an actual image
    // For now, return obfuscated text
    text: obfuscateText(text),
    hint: 'Solve the text CAPTCHA'
  });
});

// Helper: Generate random text
function generateRandomText(length) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars
  let text = '';
  for (let i = 0; i < length; i++) {
    text += chars[Math.floor(Math.random() * chars.length)];
  }
  return text;
}

// Helper: Obfuscate text for display
function obfuscateText(text) {
  return text.split('').map(c =>
    Math.random() > 0.5 ? c : `<span style="transform: rotate(${Math.random() * 20 - 10}deg); display: inline-block;">${c}</span>`
  ).join('');
}

// Cleanup old CAPTCHAs every 5 minutes
setInterval(() => {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  for (const [id, captcha] of textCaptchas) {
    if (captcha.created < fiveMinutesAgo) {
      textCaptchas.delete(id);
    }
  }
}, 5 * 60 * 1000);

// Start server
app.listen(PORT, () => {
  console.log(`CAPTCHA Lab running at http://localhost:${PORT}`);
  console.log('');
  console.log('Available test pages:');
  console.log(`  - reCAPTCHA v2: http://localhost:${PORT}/recaptcha-v2`);
  console.log(`  - reCAPTCHA v2 Invisible: http://localhost:${PORT}/recaptcha-v2-invisible`);
  console.log(`  - hCaptcha: http://localhost:${PORT}/hcaptcha`);
  console.log(`  - Text CAPTCHA: http://localhost:${PORT}/text-captcha`);
  console.log(`  - Math CAPTCHA: http://localhost:${PORT}/math-captcha`);
});
