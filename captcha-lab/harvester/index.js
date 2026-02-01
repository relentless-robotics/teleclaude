/**
 * CAPTCHA Harvester
 *
 * Collects real CAPTCHAs from various sources for training our solver.
 *
 * Sources:
 * - Public CAPTCHA datasets
 * - Live website scraping
 * - Screenshot collection
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { chromium } = require('playwright');

// Directories
const DATA_DIR = path.join(__dirname, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const LABELS_DIR = path.join(DATA_DIR, 'labels');
const DATASETS_DIR = path.join(DATA_DIR, 'datasets');
const PENDING_DIR = path.join(DATA_DIR, 'pending_label');

// Ensure directories exist
[DATA_DIR, IMAGES_DIR, LABELS_DIR, DATASETS_DIR, PENDING_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Labels file
const LABELS_FILE = path.join(LABELS_DIR, 'labels.json');

/**
 * Load labels database
 */
function loadLabels() {
  try {
    if (fs.existsSync(LABELS_FILE)) {
      return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf-8'));
    }
  } catch (e) {}
  return { samples: [], stats: { total: 0, labeled: 0, unlabeled: 0 } };
}

/**
 * Save labels database
 */
function saveLabels(data) {
  fs.writeFileSync(LABELS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Download file from URL
 */
function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(outputPath);

    protocol.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        downloadFile(response.headers.location, outputPath).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(outputPath);
      });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

/**
 * Generate unique filename for CAPTCHA image
 */
function generateFilename(source, extension = 'png') {
  const hash = crypto.randomBytes(8).toString('hex');
  const timestamp = Date.now();
  return `${source}_${timestamp}_${hash}.${extension}`;
}

/**
 * Add a CAPTCHA sample to the dataset
 */
function addSample(imagePath, options = {}) {
  const {
    source = 'unknown',
    label = null,
    type = 'text',
    metadata = {}
  } = options;

  const labels = loadLabels();
  const filename = path.basename(imagePath);

  // Check if already exists
  if (labels.samples.find(s => s.filename === filename)) {
    return { success: false, error: 'Sample already exists' };
  }

  const sample = {
    id: crypto.randomBytes(8).toString('hex'),
    filename,
    source,
    type,
    label,
    labeled: label !== null,
    addedAt: new Date().toISOString(),
    metadata
  };

  labels.samples.push(sample);
  labels.stats.total++;
  if (label) {
    labels.stats.labeled++;
  } else {
    labels.stats.unlabeled++;
  }

  saveLabels(labels);

  return { success: true, sample };
}

/**
 * Label a CAPTCHA sample
 */
function labelSample(sampleId, label) {
  const labels = loadLabels();
  const sample = labels.samples.find(s => s.id === sampleId);

  if (!sample) {
    return { success: false, error: 'Sample not found' };
  }

  const wasLabeled = sample.labeled;
  sample.label = label;
  sample.labeled = true;
  sample.labeledAt = new Date().toISOString();

  if (!wasLabeled) {
    labels.stats.labeled++;
    labels.stats.unlabeled--;
  }

  saveLabels(labels);
  return { success: true, sample };
}

/**
 * Get unlabeled samples for manual labeling
 */
function getUnlabeledSamples(limit = 10) {
  const labels = loadLabels();
  return labels.samples.filter(s => !s.labeled).slice(0, limit);
}

/**
 * Get labeled samples for training
 */
function getLabeledSamples(type = null) {
  const labels = loadLabels();
  let samples = labels.samples.filter(s => s.labeled);
  if (type) {
    samples = samples.filter(s => s.type === type);
  }
  return samples;
}

/**
 * Download public CAPTCHA datasets
 */
const DATASETS = {
  // Kaggle CAPTCHA datasets (would need kaggle CLI or manual download)
  kaggle: [
    {
      name: 'captcha-version-2-images',
      url: 'https://www.kaggle.com/datasets/fournierp/captcha-version-2-images',
      type: 'text',
      note: 'Requires Kaggle account/CLI'
    }
  ],

  // GitHub hosted datasets
  github: [
    {
      name: 'captcha-dataset',
      url: 'https://github.com/AakashKumarNain/CaptchaCracker/tree/master/Data',
      type: 'text'
    }
  ],

  // Direct download links (sample CAPTCHAs)
  direct: [
    {
      name: 'simple-captcha-samples',
      images: [
        // These would be actual URLs to CAPTCHA images
        // For now, we'll generate them from websites
      ]
    }
  ]
};

/**
 * Scrape CAPTCHA from a website
 */
async function scrapeCaptcha(url, selector, options = {}) {
  const {
    waitFor = 2000,
    source = 'scraped'
  } = options;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url);
    await page.waitForTimeout(waitFor);

    // Find CAPTCHA image
    const element = await page.$(selector);
    if (!element) {
      throw new Error(`Element not found: ${selector}`);
    }

    // Take screenshot of CAPTCHA
    const filename = generateFilename(source);
    const outputPath = path.join(IMAGES_DIR, filename);

    await element.screenshot({ path: outputPath });

    // Add to samples
    const result = addSample(outputPath, {
      source,
      type: 'text',
      metadata: { url, selector }
    });

    await browser.close();
    return { success: true, path: outputPath, ...result };

  } catch (e) {
    await browser.close();
    return { success: false, error: e.message };
  }
}

/**
 * Generate CAPTCHAs from our local lab
 */
async function harvestFromLab(count = 100, labUrl = 'http://localhost:3000') {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const harvested = [];

  try {
    for (let i = 0; i < count; i++) {
      // Go to text CAPTCHA page (generates new one each time)
      await page.goto(`${labUrl}/text-captcha`);
      await page.waitForTimeout(500);

      // Get the CAPTCHA text (for labeling)
      const captchaText = await page.$eval('.captcha-image', el => {
        return el.textContent.replace(/<[^>]*>/g, '').trim();
      });

      // Screenshot just the CAPTCHA image element (not the whole box with CAPTCHA ID)
      const captchaElement = await page.$('.captcha-image');
      const filename = generateFilename('lab');
      const outputPath = path.join(IMAGES_DIR, filename);

      await captchaElement.screenshot({ path: outputPath });

      // Add with label (we know the answer from our lab)
      const result = addSample(outputPath, {
        source: 'lab',
        type: 'text',
        label: captchaText,
        metadata: { labUrl }
      });

      harvested.push({ filename, label: captchaText });

      // Progress
      if ((i + 1) % 10 === 0) {
        console.log(`Harvested ${i + 1}/${count} CAPTCHAs`);
      }
    }

    await browser.close();
    return { success: true, count: harvested.length, samples: harvested };

  } catch (e) {
    await browser.close();
    return { success: false, error: e.message, harvested };
  }
}

/**
 * Harvest CAPTCHAs from real websites (for practice/research only)
 */
const CAPTCHA_SOURCES = [
  {
    name: 'captcha-test',
    url: 'https://captcha.com/demos/features/captcha-demo.aspx',
    selector: '#captchaImage',
    type: 'text'
  },
  {
    name: 'recaptcha-demo',
    url: 'https://www.google.com/recaptcha/api2/demo',
    selector: 'iframe[src*="recaptcha"]',
    type: 'recaptcha'
  }
];

/**
 * Harvest from known CAPTCHA demo sites
 */
async function harvestFromDemoSites(count = 10) {
  const results = [];

  for (const source of CAPTCHA_SOURCES) {
    try {
      console.log(`Harvesting from ${source.name}...`);

      for (let i = 0; i < count; i++) {
        const result = await scrapeCaptcha(source.url, source.selector, {
          source: source.name
        });

        results.push(result);

        // Small delay to be polite
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error(`Error harvesting from ${source.name}:`, e.message);
    }
  }

  return results;
}

/**
 * Get harvesting stats
 */
function getStats() {
  const labels = loadLabels();
  return {
    total: labels.stats.total,
    labeled: labels.stats.labeled,
    unlabeled: labels.stats.unlabeled,
    bySource: labels.samples.reduce((acc, s) => {
      acc[s.source] = (acc[s.source] || 0) + 1;
      return acc;
    }, {}),
    byType: labels.samples.reduce((acc, s) => {
      acc[s.type] = (acc[s.type] || 0) + 1;
      return acc;
    }, {})
  };
}

/**
 * Export labeled dataset for training
 */
function exportDataset(outputDir, type = null) {
  const samples = getLabeledSamples(type);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const exported = [];

  for (const sample of samples) {
    const srcPath = path.join(IMAGES_DIR, sample.filename);
    if (fs.existsSync(srcPath)) {
      const destPath = path.join(outputDir, sample.filename);
      fs.copyFileSync(srcPath, destPath);

      exported.push({
        filename: sample.filename,
        label: sample.label
      });
    }
  }

  // Write labels CSV
  const csv = 'filename,label\n' + exported.map(e => `${e.filename},${e.label}`).join('\n');
  fs.writeFileSync(path.join(outputDir, 'labels.csv'), csv);

  // Write labels JSON
  fs.writeFileSync(path.join(outputDir, 'labels.json'), JSON.stringify(exported, null, 2));

  return { success: true, count: exported.length, outputDir };
}

module.exports = {
  // Harvesting
  scrapeCaptcha,
  harvestFromLab,
  harvestFromDemoSites,

  // Labeling
  addSample,
  labelSample,
  getUnlabeledSamples,
  getLabeledSamples,

  // Export
  exportDataset,

  // Stats
  getStats,
  loadLabels,

  // Paths
  DATA_DIR,
  IMAGES_DIR,
  LABELS_DIR,
  DATASETS_DIR,

  // Sources
  CAPTCHA_SOURCES,
  DATASETS
};
