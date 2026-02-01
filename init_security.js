#!/usr/bin/env node
/**
 * Security Initialization Script
 *
 * Initializes all defensive security features:
 * - File integrity baseline
 * - IP traceability
 * - Security monitoring
 * - Audit logging
 *
 * Run this after initial setup or when resetting security state.
 */

const defensiveSecurity = require('./utils/defensive_security');
const ipTrace = require('./utils/ip_traceability');
const fs = require('fs');
const path = require('path');

async function initializeSecurity() {
  console.log('=== TeleClaude Security Initialization ===\n');

  // Step 1: Create file integrity baseline
  console.log('1. Creating file integrity baseline...');
  try {
    const baseline = defensiveSecurity.createBaseline();
    console.log(`   ✓ Baseline created with ${Object.keys(baseline.files).length} files\n`);
  } catch (e) {
    console.log(`   ✗ Failed: ${e.message}\n`);
  }

  // Step 2: Check host security
  console.log('2. Checking host security...');
  try {
    const defender = defensiveSecurity.checkDefenderStatus();
    console.log(`   Windows Defender: ${defender.AntivirusEnabled ? '✓ Enabled' : '✗ Disabled'}`);
    console.log(`   Real-time Protection: ${defender.RealTimeProtectionEnabled ? '✓ Enabled' : '✗ Disabled'}`);

    const firewall = defensiveSecurity.checkFirewallStatus();
    if (Array.isArray(firewall)) {
      const enabled = firewall.filter(f => f.Enabled).length;
      console.log(`   Firewall: ${enabled}/${firewall.length} profiles enabled\n`);
    }
  } catch (e) {
    console.log(`   Could not check: ${e.message}\n`);
  }

  // Step 3: Get network info
  console.log('3. Getting network information...');
  try {
    const publicIP = await ipTrace.getPublicIP();
    const tailscaleIP = ipTrace.getTailscaleIP();
    console.log(`   Public IP: ${publicIP}`);
    console.log(`   Tailscale IP: ${tailscaleIP}\n`);
  } catch (e) {
    console.log(`   Could not get: ${e.message}\n`);
  }

  // Step 4: Initial security scan
  console.log('4. Running initial security scan...');
  try {
    const scan = await defensiveSecurity.runSecurityScan();
    console.log(`   Status: ${scan.overallStatus.toUpperCase()}`);
    console.log(`   Active connections: ${scan.networkAnalysis.total}`);
    console.log(`   Suspicious connections: ${scan.networkAnalysis.suspicious}`);
    console.log(`   Active alerts: ${scan.alerts.length}\n`);
  } catch (e) {
    console.log(`   Scan failed: ${e.message}\n`);
  }

  // Step 5: Get recommendations
  console.log('5. Security recommendations...');
  try {
    const recommendations = await defensiveSecurity.getSecurityRecommendations();
    if (recommendations.length === 0) {
      console.log('   ✓ No critical recommendations\n');
    } else {
      for (const rec of recommendations) {
        console.log(`   [${rec.severity.toUpperCase()}] ${rec.title}`);
        console.log(`      → ${rec.recommendation}`);
      }
      console.log('');
    }
  } catch (e) {
    console.log(`   Could not get: ${e.message}\n`);
  }

  // Step 6: Log initialization
  defensiveSecurity.logSecurityEvent('init', 'Security system initialized');

  console.log('=== Security Initialization Complete ===');
  console.log('\nLog files:');
  console.log(`  Audit: ${defensiveSecurity.AUDIT_LOG}`);
  console.log(`  IP Trace: ${ipTrace.IP_LOG_FILE}`);
  console.log(`  Baseline: ${defensiveSecurity.BASELINE_FILE}`);
  console.log(`  Alerts: ${defensiveSecurity.ALERTS_FILE}`);
}

// Run if called directly
if (require.main === module) {
  initializeSecurity().catch(console.error);
}

module.exports = { initializeSecurity };
