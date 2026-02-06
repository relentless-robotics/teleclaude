#!/usr/bin/env node
/**
 * Substack Manager CLI
 *
 * Commands:
 *   login <email> <password>     - Login to Substack
 *   add <url>                    - Add a publication to follow
 *   fetch [publication]          - Fetch latest posts
 *   analyze [publication]        - Analyze a publication
 *   latest [publication]         - Get latest post
 *   picks                        - Show tracked picks
 *   status                       - Show status
 */

const substackBrowser = require('../utils/substack_browser');
const substackReader = require('../utils/substack_reader');
const fs = require('fs');
const path = require('path');

const PUBLICATIONS_FILE = path.join(substackReader.DATA_DIR, 'publications.json');

function getPublications() {
  if (!fs.existsSync(PUBLICATIONS_FILE)) return [];
  return JSON.parse(fs.readFileSync(PUBLICATIONS_FILE, 'utf8'));
}

function addPublication(url, name) {
  const pubs = getPublications();
  if (pubs.find(p => p.url === url)) {
    console.log('Publication already exists');
    return;
  }
  pubs.push({ url, name: name || new URL(url).hostname, addedAt: new Date().toISOString() });
  fs.writeFileSync(PUBLICATIONS_FILE, JSON.stringify(pubs, null, 2));
  console.log(`Added: ${url}`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'login': {
      const email = args[1];
      const password = args[2];
      if (!email || !password) {
        console.log('Usage: node substack_manager.js login <email> <password>');
        return;
      }
      console.log('Logging into Substack...');
      const result = await substackBrowser.login(email, password);
      console.log(result.success ? '✅ Login successful!' : `❌ Login failed: ${result.error}`);
      break;
    }

    case 'add': {
      const url = args[1];
      const name = args[2];
      if (!url) {
        console.log('Usage: node substack_manager.js add <url> [name]');
        return;
      }
      addPublication(url, name);
      break;
    }

    case 'fetch': {
      const pubArg = args[1];
      const pubs = getPublications();

      if (!pubs.length && !pubArg) {
        console.log('No publications configured. Add one first or specify URL.');
        return;
      }

      const url = pubArg || pubs[0]?.url;
      console.log(`Fetching from ${url}...`);
      const result = await substackBrowser.fetchPosts(url, { limit: 5 });

      if (result.success) {
        console.log(`\n✅ Fetched ${result.count} posts:\n`);
        result.posts.forEach((post, i) => {
          console.log(`${i + 1}. ${post.title}`);
          console.log(`   📅 ${post.date || 'Unknown date'}`);
          console.log(`   🎯 Tickers: ${post.tickers.join(', ') || 'None'}`);
          console.log(`   ${post.sentiment === 'BULLISH' ? '🟢' : post.sentiment === 'BEARISH' ? '🔴' : '⚪'} ${post.sentiment}`);
          console.log('');
        });
      } else {
        console.log(`❌ Error: ${result.error}`);
      }
      break;
    }

    case 'analyze': {
      const pubArg = args[1];
      const pubs = getPublications();
      const url = pubArg || pubs[0]?.url;

      if (!url) {
        console.log('No publication specified');
        return;
      }

      console.log(`Analyzing ${url}...`);
      const result = await substackBrowser.analyzePublication(url);

      if (result.success) {
        const a = result.analysis;
        console.log('\n📊 PUBLICATION ANALYSIS\n');
        console.log(`Posts analyzed: ${a.postCount}`);
        console.log(`\nTop tickers mentioned:`);
        a.topTickers.forEach(([ticker, count]) => {
          console.log(`  ${ticker}: ${count}x`);
        });
        console.log(`\nSentiment breakdown:`);
        console.log(`  🟢 Bullish: ${a.sentiment.bullish}`);
        console.log(`  🔴 Bearish: ${a.sentiment.bearish}`);
        console.log(`  ⚪ Neutral: ${a.sentiment.neutral}`);
        console.log(`\nOptions content: ${a.optionsContent} posts`);
        console.log(`Latest post: ${a.latestPost}`);
      } else {
        console.log(`❌ Error: ${result.error}`);
      }
      break;
    }

    case 'latest': {
      const pubArg = args[1];
      const pubs = getPublications();
      const url = pubArg || pubs[0]?.url;

      if (!url) {
        console.log('No publication specified');
        return;
      }

      console.log(`Getting latest from ${url}...`);
      const result = await substackBrowser.getLatestPost(url);

      if (result.success && result.post) {
        const p = result.post;
        console.log(`\n📰 ${p.title}\n`);
        console.log(`Date: ${p.date}`);
        console.log(`Tickers: ${p.tickers.join(', ') || 'None'}`);
        console.log(`Sentiment: ${p.sentiment}`);
        console.log(`\nContent preview:\n${p.summary || p.content?.slice(0, 500)}...`);
      } else {
        console.log(`❌ Error: ${result.error}`);
      }
      break;
    }

    case 'picks': {
      const picks = substackReader.getPicks();
      const record = substackReader.analyzeTrackRecord();

      console.log('\n📋 TRACKED PICKS\n');
      console.log(`Total: ${record.total} | Completed: ${record.completed} | Pending: ${record.pending}`);
      console.log(`Win rate: ${record.winRate}% (${record.wins}W / ${record.losses}L)\n`);

      picks.slice(-10).forEach((pick, i) => {
        const status = pick.outcome === 'WIN' ? '✅' : pick.outcome === 'LOSS' ? '❌' : '⏳';
        console.log(`${status} ${pick.ticker} - ${pick.direction} @ ${pick.entryPrice || 'N/A'}`);
        console.log(`   Source: ${pick.source || 'Unknown'} | ${pick.savedAt}`);
      });
      break;
    }

    case 'status': {
      const hasAuth = substackBrowser.hasValidAuth();
      const pubs = getPublications();
      const config = substackReader.loadConfig();

      console.log('\n📊 SUBSTACK STATUS\n');
      console.log(`Auth: ${hasAuth ? '✅ Valid' : '❌ Not logged in'}`);
      console.log(`Last login: ${config?.lastLogin || 'Never'}`);
      console.log(`Publications: ${pubs.length}`);
      pubs.forEach(p => console.log(`  - ${p.name}: ${p.url}`));

      const record = substackReader.analyzeTrackRecord();
      console.log(`\nPicks tracked: ${record.total} (${record.winRate}% win rate)`);
      break;
    }

    default:
      console.log(`
Substack Manager

Commands:
  login <email> <password>     Login to Substack
  add <url> [name]             Add a publication to follow
  fetch [url]                  Fetch latest posts
  analyze [url]                Analyze a publication
  latest [url]                 Get latest post details
  picks                        Show tracked picks
  status                       Show status

Example:
  node substack_manager.js login user@email.com password123
  node substack_manager.js add https://example.substack.com "Example Newsletter"
  node substack_manager.js fetch
`);
  }
}

main().catch(console.error);
