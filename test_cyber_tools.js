/**
 * Test script for cyber tools integration
 * Run this to verify WSL2 and security tools are properly configured
 */

const { checkStatus } = require('./mcp/cyber-tools');
const { isWSLAvailable, getWSLInfo } = require('./utils/wsl_bridge');

async function testCyberTools() {
  console.log('========================================');
  console.log('Cyber Tools Integration Test');
  console.log('========================================\n');

  // Test 1: Check WSL availability
  console.log('[1/3] Testing WSL availability...');
  const wslAvailable = await isWSLAvailable();

  if (!wslAvailable) {
    console.error('❌ WSL is not available or Kali Linux is not installed');
    console.log('\nTo fix this:');
    console.log('1. Run PowerShell as Administrator');
    console.log('2. Execute: .\\setup_wsl_kali.ps1');
    console.log('3. Follow setup instructions');
    process.exit(1);
  }

  console.log('✓ WSL is available\n');

  // Test 2: Get WSL info
  console.log('[2/3] Getting WSL distribution info...');
  try {
    const wslInfo = await getWSLInfo();
    if (wslInfo.available) {
      console.log('✓ WSL Info:');
      console.log(wslInfo.info);
      console.log();
    } else {
      console.error('❌ Could not get WSL info:', wslInfo.error);
    }
  } catch (error) {
    console.error('❌ Error getting WSL info:', error.message);
  }

  // Test 3: Check tools status
  console.log('[3/3] Checking security tools status...');
  try {
    const status = await checkStatus();

    console.log('\n✓ Cyber Tools Status:');
    console.log('  WSL Available:', status.wsl);

    if (status.tools) {
      console.log('\n  Security Tools:');
      Object.entries(status.tools).forEach(([tool, installed]) => {
        const icon = installed ? '✓' : '✗';
        const color = installed ? '\x1b[32m' : '\x1b[31m';
        console.log(`    ${color}${icon}\x1b[0m ${tool}: ${installed ? 'installed' : 'NOT INSTALLED'}`);
      });
    }

    if (status.config) {
      console.log('\n  Configuration:');
      console.log('    Authorized targets:', status.config.authorized_targets.join(', '));
      console.log('    Require confirmation:', status.config.require_confirmation);
      console.log('    Logging enabled:', status.config.logging_enabled);
    }

    // Check for missing tools
    const missingTools = Object.entries(status.tools || {})
      .filter(([tool, installed]) => !installed)
      .map(([tool]) => tool);

    if (missingTools.length > 0) {
      console.log('\n⚠️  Missing tools:', missingTools.join(', '));
      console.log('\nTo install missing tools:');
      console.log('  wsl -d kali-linux');
      console.log('  sudo apt update');
      console.log(`  sudo apt install ${missingTools.join(' ')}`);
    }

  } catch (error) {
    console.error('❌ Error checking status:', error.message);
    console.error(error.stack);
  }

  console.log('\n========================================');
  console.log('Test Complete!');
  console.log('========================================');
}

// Run tests
testCyberTools().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
