/**
 * Insider Trading Scanner
 * Sources: SEC EDGAR API (free, no key needed) + OpenInsider scraping
 */

const https = require('https');
const http = require('http');

const USER_AGENT = 'TeleClaude Research Bot (relentlessrobotics@gmail.com)';

/**
 * Fetch recent insider purchases from SEC EDGAR
 * Focuses on BUYS (Form 4 filings with acquisition codes)
 */
async function getRecentInsiderBuys(days = 3) {
  return new Promise((resolve) => {
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22A%22&dateRange=custom&startdt=${getDateStr(-days)}&enddt=${getDateStr(0)}&forms=4&from=0&size=40`;

    // Use EDGAR full-text search for recent Form 4s
    const edgarUrl = `https://efts.sec.gov/LATEST/search-index?q=%22acquisition%22+%22purchase%22&forms=4&dateRange=custom&startdt=${getDateStr(-days)}&enddt=${getDateStr(0)}`;

    // Simpler approach: use EDGAR company search RSS
    const rssUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&dateb=&owner=only&count=40&search_text=&start=0&output=atom`;

    https.get(rssUrl, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/atom+xml' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Parse Atom feed entries
          const entries = [];
          const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
          let match;
          while ((match = entryRegex.exec(data)) !== null && entries.length < 20) {
            const entry = match[1];
            const title = entry.match(/<title[^>]*>(.*?)<\/title>/)?.[1] || '';
            const link = entry.match(/<link[^>]*href="([^"]*)"[^>]*\/>/)?.[1] || '';
            const updated = entry.match(/<updated>(.*?)<\/updated>/)?.[1] || '';
            const summary = entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] || '';

            if (title.includes('4 -')) {
              entries.push({
                title: title.replace(/&amp;/g, '&').replace(/&#39;/g, "'"),
                link,
                date: updated,
                summary: summary.substring(0, 200).replace(/<[^>]*>/g, ''),
              });
            }
          }
          resolve({ source: 'SEC EDGAR', filings: entries, count: entries.length });
        } catch (e) {
          resolve({ source: 'SEC EDGAR', filings: [], count: 0, error: e.message });
        }
      });
    }).on('error', () => resolve({ source: 'SEC EDGAR', filings: [], count: 0, error: 'fetch failed' }));
  });
}

/**
 * Scrape OpenInsider for notable insider buys (>$100K)
 */
async function getOpenInsiderBuys() {
  return new Promise((resolve) => {
    const url = 'http://openinsider.com/screener?s=&o=&pl=100&ph=&ll=&lh=&fd=7&fdr=&td=0&tdr=&feession=&cession=&sidTicker=&sidOwner=&sicIndustry=&isTicker=on&cnt=30&page=1';

    http.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const trades = [];
          // Parse table rows from OpenInsider HTML
          const rowRegex = /<tr[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
          const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
          let rowMatch;

          while ((rowMatch = rowRegex.exec(data)) !== null && trades.length < 20) {
            const cells = [];
            let cellMatch;
            const row = rowMatch[1];
            while ((cellMatch = cellRegex.exec(row)) !== null) {
              cells.push(cellMatch[1].replace(/<[^>]*>/g, '').trim());
            }

            if (cells.length >= 10) {
              const ticker = cells[3];
              const value = cells[9];
              if (ticker && ticker.length <= 5 && ticker.length > 0) {
                trades.push({
                  date: cells[1],
                  ticker,
                  owner: cells[4]?.substring(0, 40),
                  title: cells[5],
                  type: cells[6],
                  value: cells[9],
                  shares: cells[8],
                  price: cells[7],
                });
              }
            }
          }
          resolve({ source: 'OpenInsider', trades, count: trades.length });
        } catch (e) {
          resolve({ source: 'OpenInsider', trades: [], count: 0, error: e.message });
        }
      });
    }).on('error', () => resolve({ source: 'OpenInsider', trades: [], count: 0, error: 'fetch failed' }));
  });
}

function getDateStr(daysOffset) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().split('T')[0];
}

async function run() {
  const [edgar, openInsider] = await Promise.all([
    getRecentInsiderBuys(5),
    getOpenInsiderBuys(),
  ]);
  return { edgar, openInsider };
}

module.exports = { run, getRecentInsiderBuys, getOpenInsiderBuys };
