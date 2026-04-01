/**
 * Create New Discord Channels
 *
 * Adds macrostrategy-v9 and iasm-signals to the Trading Agents server
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load config
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');
const CHANNELS_FILE = path.join(__dirname, 'data', 'discord_channels.json');

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const channelsData = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));

const botToken = config.discordToken;
const guildId = channelsData.guildId;

console.log(`Guild ID: ${guildId}`);
console.log(`Bot Token: ${botToken ? 'Loaded' : 'MISSING'}`);

/**
 * Discord REST API call
 */
function discordAPI(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'discord.com',
      path: `/api/v10${endpoint}`,
      method,
      headers: {
        'Authorization': `Bot ${botToken}`,
        'User-Agent': 'TradingAgent/1.0',
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      const payload = JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`Discord API ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Get all channels in the guild
 */
async function getGuildChannels() {
  return discordAPI('GET', `/guilds/${guildId}/channels`);
}

/**
 * Create a new channel
 */
async function createChannel(name, topic, categoryId) {
  const body = {
    name,
    type: 0, // Text channel
    topic,
    parent_id: categoryId
  };

  return discordAPI('POST', `/guilds/${guildId}/channels`, body);
}

/**
 * Main execution
 */
async function main() {
  try {
    console.log('\n=== Fetching Guild Channels ===');
    const channels = await getGuildChannels();

    // Find Trading Agents category
    const category = channels.find(c => c.name === 'Trading Agents' && c.type === 4);
    if (!category) {
      console.error('ERROR: Trading Agents category not found!');
      console.log('Available categories:', channels.filter(c => c.type === 4).map(c => c.name));
      return;
    }

    console.log(`Found Trading Agents category: ${category.id}`);

    // Check if channels already exist
    const existingMacro = channels.find(c => c.name === 'macrostrategy-v9');
    const existingIasm = channels.find(c => c.name === 'iasm-signals');

    if (existingMacro) {
      console.log(`⚠️  Channel 'macrostrategy-v9' already exists (ID: ${existingMacro.id})`);
    }
    if (existingIasm) {
      console.log(`⚠️  Channel 'iasm-signals' already exists (ID: ${existingIasm.id})`);
    }

    const newChannels = {};

    // Create macrostrategy-v9 if it doesn't exist
    if (!existingMacro) {
      console.log('\n=== Creating macrostrategy-v9 ===');
      const macroChannel = await createChannel(
        'macrostrategy-v9',
        'MacroStrategy v9 genetic algorithm trading signals',
        category.id
      );
      console.log(`✅ Created macrostrategy-v9 (ID: ${macroChannel.id})`);
      newChannels.macrostrategyV9 = macroChannel.id;
    } else {
      newChannels.macrostrategyV9 = existingMacro.id;
    }

    // Create iasm-signals if it doesn't exist
    if (!existingIasm) {
      console.log('\n=== Creating iasm-signals ===');
      const iasmChannel = await createChannel(
        'iasm-signals',
        'IASM (Intraday Adaptive Strategy Manager) trading signals',
        category.id
      );
      console.log(`✅ Created iasm-signals (ID: ${iasmChannel.id})`);
      newChannels.iasmSignals = iasmChannel.id;
    } else {
      newChannels.iasmSignals = existingIasm.id;
    }

    // Update discord_channels.json
    console.log('\n=== Updating discord_channels.json ===');
    channelsData.channels = {
      ...channelsData.channels,
      ...newChannels
    };

    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channelsData, null, 2));
    console.log('✅ Updated discord_channels.json');

    // Show final state
    console.log('\n=== Final Channel Configuration ===');
    console.log(JSON.stringify(channelsData.channels, null, 2));

    console.log('\n✅ All done! Channels created and configuration updated.');
    console.log('\nNext: Update discord_channels.js to add convenience methods for the new channels.');

  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
  }
}

main();
