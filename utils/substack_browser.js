/**
 * Substack Browser Automation
 *
 * Uses Playwright to:
 * - Login to Substack
 * - Fetch posts from publications
 * - Save auth state for reuse
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const AUTH_STATE_FILE = path.join(__dirname, '..', 'browser_state', 'substack_auth.json');
const reader = require('./substack_reader');

/**
 * Check if we have valid auth state
 */
function hasValidAuth() {
  if (!fs.existsSync(AUTH_STATE_FILE)) return false;
  const stats = fs.statSync(AUTH_STATE_FILE);
  const ageInDays = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
  return ageInDays < 30; // Auth valid for 30 days
}

/**
 * Login to Substack and save auth state
 */
async function login(email, password, options = {}) {
  const { headless = false } = options;

  console.log('Launching browser for Substack login...');
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Go to Substack login
    await page.goto('https://substack.com/sign-in');
    await page.waitForLoadState('networkidle');

    // Enter email
    console.log('Entering email...');
    await page.fill('input[type="email"]', email);
    await page.click('button:has-text("Continue")');

    // Wait for password field
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });

    // Enter password
    console.log('Entering password...');
    await page.fill('input[type="password"]', password);
    await page.click('button:has-text("Sign in")');

    // Wait for successful login
    await page.waitForURL('**/inbox**', { timeout: 30000 }).catch(() => {
      // Might redirect elsewhere, check if logged in
    });

    // Verify logged in by checking for user menu
    await page.waitForTimeout(3000);

    // Save auth state
    const state = await context.storageState();
    fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(state, null, 2));
    console.log('Auth state saved successfully');

    // Save config
    reader.saveConfig({ email, lastLogin: new Date().toISOString() });

    await browser.close();
    return { success: true, message: 'Logged in successfully' };

  } catch (error) {
    console.error('Login error:', error.message);
    await browser.close();
    return { success: false, error: error.message };
  }
}

/**
 * Fetch posts from a Substack publication
 */
async function fetchPosts(publicationUrl, options = {}) {
  const { limit = 10, headless = true } = options;

  if (!hasValidAuth()) {
    return { success: false, error: 'Not logged in. Call login() first.' };
  }

  console.log(`Fetching posts from ${publicationUrl}...`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    storageState: AUTH_STATE_FILE
  });
  const page = await context.newPage();

  try {
    // Navigate to publication archive
    const archiveUrl = publicationUrl.endsWith('/')
      ? `${publicationUrl}archive`
      : `${publicationUrl}/archive`;

    await page.goto(archiveUrl);
    await page.waitForLoadState('networkidle');

    // Get all post links
    const posts = await page.evaluate((maxPosts) => {
      const postElements = document.querySelectorAll('a[data-testid="post-preview-title"]');
      const results = [];

      for (let i = 0; i < Math.min(postElements.length, maxPosts); i++) {
        const el = postElements[i];
        const container = el.closest('[class*="post-preview"]') || el.parentElement?.parentElement;

        results.push({
          title: el.textContent?.trim() || '',
          url: el.href || '',
          // Date might be in a sibling element
          dateText: container?.querySelector('time')?.textContent || ''
        });
      }

      return results;
    }, limit);

    console.log(`Found ${posts.length} posts`);

    // Fetch full content for each post
    const fullPosts = [];
    for (const post of posts.slice(0, limit)) {
      if (!post.url) continue;

      console.log(`Fetching: ${post.title.slice(0, 50)}...`);
      await page.goto(post.url);
      await page.waitForLoadState('networkidle');

      const content = await page.evaluate(() => {
        const articleBody = document.querySelector('.body') ||
                           document.querySelector('[class*="post-content"]') ||
                           document.querySelector('article');
        return articleBody?.textContent?.trim() || '';
      });

      const dateStr = await page.evaluate(() => {
        const timeEl = document.querySelector('time');
        return timeEl?.getAttribute('datetime') || timeEl?.textContent || '';
      });

      fullPosts.push({
        title: post.title,
        url: post.url,
        date: dateStr,
        content: content,
        fetchedAt: new Date().toISOString()
      });

      // Rate limit
      await page.waitForTimeout(1000);
    }

    await browser.close();

    // Parse and archive posts
    const publication = new URL(publicationUrl).hostname.split('.')[0];
    const parsed = fullPosts.map(post => {
      const analysis = reader.parsePost(post);
      reader.archivePost({ ...post, ...analysis }, publication);
      return { ...post, ...analysis };
    });

    return { success: true, posts: parsed, count: parsed.length };

  } catch (error) {
    console.error('Fetch error:', error.message);
    await browser.close();
    return { success: false, error: error.message };
  }
}

/**
 * Get latest post content
 */
async function getLatestPost(publicationUrl, options = {}) {
  const result = await fetchPosts(publicationUrl, { ...options, limit: 1 });
  if (!result.success) return result;
  return { success: true, post: result.posts[0] };
}

/**
 * Quick analysis of a publication
 */
async function analyzePublication(publicationUrl, options = {}) {
  const result = await fetchPosts(publicationUrl, { ...options, limit: 10 });
  if (!result.success) return result;

  const posts = result.posts;
  const allTickers = {};
  let bullishCount = 0;
  let bearishCount = 0;
  let optionsCount = 0;

  posts.forEach(post => {
    post.tickers.forEach(t => {
      allTickers[t] = (allTickers[t] || 0) + 1;
    });
    if (post.sentiment === 'BULLISH') bullishCount++;
    if (post.sentiment === 'BEARISH') bearishCount++;
    if (post.hasOptions) optionsCount++;
  });

  // Sort tickers by frequency
  const topTickers = Object.entries(allTickers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return {
    success: true,
    analysis: {
      postCount: posts.length,
      topTickers,
      sentiment: {
        bullish: bullishCount,
        bearish: bearishCount,
        neutral: posts.length - bullishCount - bearishCount
      },
      optionsContent: optionsCount,
      latestPost: posts[0]?.title || 'None'
    }
  };
}

module.exports = {
  hasValidAuth,
  login,
  fetchPosts,
  getLatestPost,
  analyzePublication,
  AUTH_STATE_FILE
};

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'login') {
    const email = args[1];
    const password = args[2];
    if (!email || !password) {
      console.log('Usage: node substack_browser.js login <email> <password>');
      process.exit(1);
    }
    login(email, password).then(console.log);
  } else if (command === 'fetch') {
    const url = args[1];
    if (!url) {
      console.log('Usage: node substack_browser.js fetch <publication-url>');
      process.exit(1);
    }
    fetchPosts(url).then(r => console.log(JSON.stringify(r, null, 2)));
  } else {
    console.log('Commands: login, fetch');
  }
}
