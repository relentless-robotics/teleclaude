/**
 * Test New Discord Channels
 *
 * Tests that macrostrategy-v9 and iasm-signals channels work correctly
 */

const discordChannels = require('./discord_channels');

async function testChannels() {
  console.log('=== Testing New Discord Channels ===\n');

  // Reload config to ensure latest channel IDs are loaded
  discordChannels.reload();

  // Get status
  const status = discordChannels.getStatus();
  console.log('Discord Channels Status:');
  console.log(`- Has Token: ${status.hasToken}`);
  console.log(`- Channels Loaded: ${status.channelsLoaded}`);
  console.log(`- Available Channels: ${status.channels.join(', ')}`);
  console.log();

  // Check if new channels are in the list
  const hasMacro = status.channels.includes('macrostrategyV9');
  const hasIasm = status.channels.includes('iasmSignals');

  console.log('New Channel Detection:');
  console.log(`- macrostrategyV9: ${hasMacro ? '✅ Found' : '❌ Missing'}`);
  console.log(`- iasmSignals: ${hasIasm ? '✅ Found' : '❌ Missing'}`);
  console.log();

  // Test sending messages to the new channels
  console.log('Sending test messages...\n');

  try {
    // Test MacroStrategy V9 channel
    console.log('Sending to macrostrategy-v9...');
    const result1 = await discordChannels.macrostrategyV9(
      '🧬 **MacroStrategy V9 Test Message**\n\n' +
      'This is a test message from the channel setup script.\n\n' +
      '**Status:** Channel creation successful ✅\n' +
      '**Channel ID:** 1471437662480109620\n' +
      '**Created:** ' + new Date().toISOString()
    );
    console.log(`Result: ${result1.success ? '✅' : '❌'} (method: ${result1.method})`);

    // Wait a bit to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test IASM Signals channel
    console.log('Sending to iasm-signals...');
    const result2 = await discordChannels.iasmSignals(
      '⚡ **IASM Signals Test Message**\n\n' +
      'This is a test message from the channel setup script.\n\n' +
      '**Status:** Channel creation successful ✅\n' +
      '**Channel ID:** 1471437663742722143\n' +
      '**Created:** ' + new Date().toISOString()
    );
    console.log(`Result: ${result2.success ? '✅' : '❌'} (method: ${result2.method})`);

    console.log('\n=== Test Complete ===');
    console.log('Check your Discord server to verify the messages appeared in the correct channels.');

  } catch (error) {
    console.error('Error during test:', error.message);
    console.error(error.stack);
  }
}

testChannels();
