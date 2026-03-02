/**
 * Stealth Browser Module
 *
 * Provides browser contexts configured to evade automation detection.
 * Uses stealth plugins and realistic browser fingerprinting.
 */

const { chromium } = require('playwright');

/**
 * Launch a stealth browser context
 *
 * @param {object} options - Browser options
 * @param {boolean} options.headless - Run in headless mode (default: false)
 * @param {string} options.userDataDir - Persistent profile directory
 * @param {object} options.proxy - Proxy configuration
 * @param {boolean} options.persistent - Use persistent context
 * @returns {Promise<{browser, context, page}>}
 */
async function launchStealthBrowser(options = {}) {
  const {
    headless = false,
    userDataDir = null,
    proxy = null,
    persistent = false
  } = options;

  // Stealth configuration
  const stealthConfig = {
    // Launch args to reduce detection
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--no-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      '--disable-features=BlockInsecurePrivateNetworkRequests'
    ],
    headless,
    // Use Edge browser profile for better fingerprint
    channel: 'msedge'
  };

  // Add proxy if provided
  if (proxy) {
    stealthConfig.proxy = proxy;
  }

  // Launch browser
  let browser, context;

  if (persistent && userDataDir) {
    // Launch persistent context
    context = await chromium.launchPersistentContext(userDataDir, {
      ...stealthConfig,
      viewport: getRealisticViewport(),
      userAgent: getRealisticUserAgent(),
      locale: 'en-US',
      timezoneId: 'America/New_York',
      permissions: ['geolocation', 'notifications'],
      geolocation: { latitude: 40.7128, longitude: -74.0060 }, // NYC
      colorScheme: 'light',
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      javaScriptEnabled: true
    });
    browser = context.browser();
  } else {
    // Launch regular browser
    browser = await chromium.launch(stealthConfig);
    context = await browser.newContext({
      viewport: getRealisticViewport(),
      userAgent: getRealisticUserAgent(),
      locale: 'en-US',
      timezoneId: 'America/New_York',
      permissions: ['geolocation', 'notifications'],
      geolocation: { latitude: 40.7128, longitude: -74.0060 },
      colorScheme: 'light',
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      javaScriptEnabled: true
    });
  }

  // Apply additional stealth techniques
  await applyStealthScripts(context);

  // Create initial page
  const page = await context.newPage();

  // Apply page-level stealth
  await applyPageStealth(page);

  return { browser, context, page };
}

/**
 * Get realistic viewport dimensions
 */
function getRealisticViewport() {
  // Common desktop resolutions
  const resolutions = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 2560, height: 1440 }
  ];

  return resolutions[Math.floor(Math.random() * resolutions.length)];
}

/**
 * Get realistic user agent string
 */
function getRealisticUserAgent() {
  // Modern Chrome/Edge user agents
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0'
  ];

  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

/**
 * Apply stealth scripts to context
 */
async function applyStealthScripts(context) {
  // Add init script to mask automation
  await context.addInitScript(() => {
    // Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });

    // Override chrome object
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {}
    };

    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // Add plugin array
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        {
          0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: Plugin },
          description: "Portable Document Format",
          filename: "internal-pdf-viewer",
          length: 1,
          name: "Chrome PDF Plugin"
        }
      ]
    });

    // Add languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });

    // WebGL vendor
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) {
        return 'Intel Inc.';
      }
      if (parameter === 37446) {
        return 'Intel Iris OpenGL Engine';
      }
      return getParameter(parameter);
    };

    // Canvas fingerprint randomization (slight noise)
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const context = this.getContext('2d');
      if (context) {
        const imageData = context.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          // Add minimal noise to avoid exact fingerprint matching
          imageData.data[i] = imageData.data[i] + Math.floor(Math.random() * 3) - 1;
        }
        context.putImageData(imageData, 0, 0);
      }
      return originalToDataURL.apply(this, arguments);
    };

    // Audio context fingerprint randomization
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      const originalCreateOscillator = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function() {
        const oscillator = originalCreateOscillator.apply(this, arguments);
        const originalStart = oscillator.start;
        oscillator.start = function() {
          // Add tiny random frequency offset
          oscillator.frequency.value += Math.random() * 0.0001;
          return originalStart.apply(this, arguments);
        };
        return oscillator;
      };
    }

    // Battery API
    if (navigator.getBattery) {
      const originalGetBattery = navigator.getBattery;
      navigator.getBattery = async function() {
        const battery = await originalGetBattery.apply(this, arguments);
        Object.defineProperty(battery, 'charging', { get: () => true });
        Object.defineProperty(battery, 'chargingTime', { get: () => 0 });
        Object.defineProperty(battery, 'dischargingTime', { get: () => Infinity });
        Object.defineProperty(battery, 'level', { get: () => 1 });
        return battery;
      };
    }

    // Screen resolution consistency
    Object.defineProperty(screen, 'availWidth', {
      get: () => window.screen.width
    });
    Object.defineProperty(screen, 'availHeight', {
      get: () => window.screen.height
    });

    // Hardware concurrency (CPU cores)
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8
    });

    // Device memory
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8
    });

    // Connection
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 100,
        downlink: 10,
        saveData: false
      })
    });
  });
}

/**
 * Apply page-level stealth techniques
 */
async function applyPageStealth(page) {
  // Set extra HTTP headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1'
  });

  // Enable JavaScript
  await page.setViewportSize(getRealisticViewport());
}

/**
 * Perform pre-challenge behavioral simulation
 * Simulate human-like behavior before a challenge appears
 */
async function simulateHumanBehavior(page, duration = 5000) {
  const startTime = Date.now();

  // Random mouse movements
  const moveCount = 5 + Math.floor(Math.random() * 10);
  for (let i = 0; i < moveCount && Date.now() - startTime < duration; i++) {
    const x = Math.random() * 1200;
    const y = Math.random() * 800;

    // Move in steps
    const steps = 10 + Math.floor(Math.random() * 20);
    for (let j = 0; j < steps; j++) {
      const progress = j / steps;
      const currentX = x * progress;
      const currentY = y * progress;

      await page.mouse.move(currentX, currentY);
      await page.waitForTimeout(10 + Math.random() * 30);
    }

    await page.waitForTimeout(200 + Math.random() * 500);
  }

  // Random scrolling
  const scrollCount = 2 + Math.floor(Math.random() * 5);
  for (let i = 0; i < scrollCount && Date.now() - startTime < duration; i++) {
    const scrollY = Math.random() * 500 - 250;
    await page.evaluate((y) => {
      window.scrollBy({
        top: y,
        behavior: 'smooth'
      });
    }, scrollY);

    await page.waitForTimeout(500 + Math.random() * 1000);
  }

  // Random clicks in safe areas (not on buttons)
  const clickCount = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < clickCount && Date.now() - startTime < duration; i++) {
    const x = 100 + Math.random() * 500;
    const y = 100 + Math.random() * 300;

    await page.mouse.click(x, y);
    await page.waitForTimeout(500 + Math.random() * 1000);
  }
}

/**
 * Add random delays with human-like timing
 */
async function humanDelay(page, baseMs = 1000) {
  // Humans don't wait in exact intervals
  const variation = baseMs * 0.3;
  const delay = baseMs + (Math.random() * variation * 2 - variation);
  await page.waitForTimeout(delay);
}

/**
 * Check if browser is likely detected as bot
 */
async function checkBotDetection(page) {
  const detectionSignals = await page.evaluate(() => {
    const signals = {
      webdriver: navigator.webdriver === true,
      noLanguages: navigator.languages.length === 0,
      noPlugins: navigator.plugins.length === 0,
      noChrome: !window.chrome,
      noPermissions: !navigator.permissions,
      hasWebgl: false
    };

    // Check WebGL (GOOD signal if true)
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      signals.hasWebgl = !!gl;
    } catch (e) {
      signals.hasWebgl = false;
    }

    return signals;
  });

  // Count red flags (bad signals)
  const redFlags = [
    detectionSignals.webdriver,
    detectionSignals.noLanguages,
    detectionSignals.noPlugins,
    detectionSignals.noChrome,
    detectionSignals.noPermissions,
    !detectionSignals.hasWebgl // No WebGL is bad
  ].filter(v => v === true).length;

  return {
    isLikelyBot: redFlags > 2,
    signals: detectionSignals,
    redFlags
  };
}

module.exports = {
  launchStealthBrowser,
  applyStealthScripts,
  applyPageStealth,
  simulateHumanBehavior,
  humanDelay,
  checkBotDetection,
  getRealisticViewport,
  getRealisticUserAgent
};
