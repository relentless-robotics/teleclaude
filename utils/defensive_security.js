/**
 * Defensive Security Module
 *
 * Provides defensive cybersecurity capabilities:
 * - Host system hardening
 * - Intrusion detection
 * - File integrity monitoring
 * - Network monitoring
 * - Audit logging
 * - Anomaly detection
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Paths
const SECURITY_DIR = path.join(__dirname, '..', 'security');
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const BASELINE_FILE = path.join(SECURITY_DIR, 'file_baseline.json');
const ALERTS_FILE = path.join(SECURITY_DIR, 'security_alerts.json');
const AUDIT_LOG = path.join(LOGS_DIR, 'security_audit.log');

// Ensure directories exist
[SECURITY_DIR, LOGS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ============================================
// AUDIT LOGGING
// ============================================

/**
 * Log security event
 * @param {string} type - Event type
 * @param {string} message - Event message
 * @param {Object} data - Additional data
 */
function logSecurityEvent(type, message, data = {}) {
  const event = {
    timestamp: new Date().toISOString(),
    type,
    message,
    data,
    hostname: process.env.COMPUTERNAME || 'unknown',
    user: process.env.USERNAME || 'unknown'
  };

  const logLine = JSON.stringify(event) + '\n';
  fs.appendFileSync(AUDIT_LOG, logLine);

  // Also log to console for visibility
  console.log(`[SECURITY ${type.toUpperCase()}] ${message}`);

  return event;
}

/**
 * Get recent security events
 * @param {number} count - Number of events to retrieve
 * @returns {Array}
 */
function getRecentEvents(count = 100) {
  if (!fs.existsSync(AUDIT_LOG)) {
    return [];
  }

  const lines = fs.readFileSync(AUDIT_LOG, 'utf-8').trim().split('\n');
  return lines.slice(-count).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  });
}

// ============================================
// FILE INTEGRITY MONITORING
// ============================================

/**
 * Calculate file hash
 * @param {string} filePath - Path to file
 * @returns {string} - SHA256 hash
 */
function hashFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (e) {
    return null;
  }
}

/**
 * Create baseline of critical files
 * @param {Array} paths - Paths to monitor
 * @returns {Object} - Baseline data
 */
function createBaseline(paths = []) {
  const defaultPaths = [
    // Critical teleclaude files
    path.join(__dirname, '..', 'CLAUDE.md'),
    path.join(__dirname, '..', 'package.json'),
    path.join(__dirname, '..', 'mcp', 'discord-bridge.js'),
    path.join(__dirname, '..', 'config.json'),
    // Security config
    path.join(__dirname, '..', 'config', 'cyber_authorized_targets.json'),
    path.join(__dirname, '..', 'SECURITY_POLICY.md'),
  ];

  const allPaths = [...new Set([...defaultPaths, ...paths])];
  const baseline = {
    created: new Date().toISOString(),
    files: {}
  };

  for (const filePath of allPaths) {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      baseline.files[filePath] = {
        hash: hashFile(filePath),
        size: stats.size,
        modified: stats.mtime.toISOString(),
        permissions: stats.mode.toString(8)
      };
    }
  }

  fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));
  logSecurityEvent('baseline', `Created file integrity baseline with ${Object.keys(baseline.files).length} files`);

  return baseline;
}

/**
 * Check file integrity against baseline
 * @returns {Object} - Integrity check results
 */
function checkIntegrity() {
  if (!fs.existsSync(BASELINE_FILE)) {
    return { error: 'No baseline exists. Run createBaseline() first.' };
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'));
  const results = {
    checked: new Date().toISOString(),
    status: 'ok',
    modified: [],
    deleted: [],
    newFiles: []
  };

  for (const [filePath, expected] of Object.entries(baseline.files)) {
    if (!fs.existsSync(filePath)) {
      results.deleted.push(filePath);
      results.status = 'alert';
      logSecurityEvent('alert', `File deleted: ${filePath}`, { type: 'file_deleted' });
    } else {
      const currentHash = hashFile(filePath);
      if (currentHash !== expected.hash) {
        results.modified.push({
          path: filePath,
          expectedHash: expected.hash,
          currentHash
        });
        results.status = 'alert';
        logSecurityEvent('alert', `File modified: ${filePath}`, { type: 'file_modified', expected: expected.hash, current: currentHash });
      }
    }
  }

  return results;
}

// ============================================
// NETWORK MONITORING
// ============================================

/**
 * Get active network connections
 * @returns {Array} - List of connections
 */
function getNetworkConnections() {
  try {
    const output = execSync('netstat -ano', { encoding: 'utf-8' });
    const lines = output.split('\n').slice(4); // Skip headers

    return lines
      .filter(line => line.trim())
      .map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          protocol: parts[0],
          localAddress: parts[1],
          foreignAddress: parts[2],
          state: parts[3],
          pid: parts[4]
        };
      });
  } catch (e) {
    return [];
  }
}

/**
 * Check for suspicious connections
 * @returns {Object} - Analysis results
 */
function analyzeConnections() {
  const connections = getNetworkConnections();

  // Known safe patterns
  const safePatterns = [
    /127\.0\.0\.1/,
    /\[::1\]/,
    /0\.0\.0\.0/,
    /100\.\d+\.\d+\.\d+/,  // Tailscale
    /192\.168\./,
    /10\.\d+\./,
  ];

  const suspicious = connections.filter(conn => {
    if (!conn.foreignAddress || conn.foreignAddress === '*:*') return false;
    return !safePatterns.some(pattern => pattern.test(conn.foreignAddress));
  });

  if (suspicious.length > 0) {
    logSecurityEvent('warning', `Found ${suspicious.length} connections to external IPs`, { connections: suspicious });
  }

  return {
    total: connections.length,
    suspicious: suspicious.length,
    details: suspicious
  };
}

// ============================================
// PROCESS MONITORING
// ============================================

/**
 * Get running processes
 * @returns {Array}
 */
function getProcessList() {
  try {
    const output = execSync('tasklist /FO CSV /NH', { encoding: 'utf-8' });
    return output.split('\n')
      .filter(line => line.trim())
      .map(line => {
        const parts = line.split('","').map(p => p.replace(/"/g, ''));
        return {
          name: parts[0],
          pid: parts[1],
          sessionName: parts[2],
          sessionNum: parts[3],
          memUsage: parts[4]
        };
      });
  } catch (e) {
    return [];
  }
}

/**
 * Check for suspicious processes
 * @returns {Object}
 */
function analyzeProcesses() {
  const processes = getProcessList();

  // Known suspicious process names (basic list)
  const suspiciousNames = [
    /mimikatz/i,
    /psexec/i,
    /nc\.exe/i,  // netcat
    /ncat/i,
    /cobaltstrike/i,
    /meterpreter/i,
    /powershell.*-enc/i,
    /certutil.*-decode/i,
  ];

  const suspicious = processes.filter(proc =>
    suspiciousNames.some(pattern => pattern.test(proc.name))
  );

  if (suspicious.length > 0) {
    logSecurityEvent('alert', `Suspicious process detected`, { processes: suspicious });
  }

  return {
    total: processes.length,
    suspicious: suspicious.length,
    details: suspicious
  };
}

// ============================================
// SECURITY ALERTS
// ============================================

/**
 * Create security alert
 * @param {string} severity - low, medium, high, critical
 * @param {string} title - Alert title
 * @param {string} description - Alert description
 * @param {Object} data - Additional data
 */
function createAlert(severity, title, description, data = {}) {
  const alert = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    severity,
    title,
    description,
    data,
    acknowledged: false
  };

  // Load existing alerts
  let alerts = [];
  if (fs.existsSync(ALERTS_FILE)) {
    alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8'));
  }

  alerts.push(alert);
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));

  logSecurityEvent('alert', `[${severity.toUpperCase()}] ${title}`, data);

  return alert;
}

/**
 * Get unacknowledged alerts
 * @returns {Array}
 */
function getActiveAlerts() {
  if (!fs.existsSync(ALERTS_FILE)) {
    return [];
  }

  const alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8'));
  return alerts.filter(a => !a.acknowledged);
}

/**
 * Acknowledge alert
 * @param {string} alertId - Alert ID
 */
function acknowledgeAlert(alertId) {
  if (!fs.existsSync(ALERTS_FILE)) return false;

  const alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8'));
  const alert = alerts.find(a => a.id === alertId);

  if (alert) {
    alert.acknowledged = true;
    alert.acknowledgedAt = new Date().toISOString();
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
    return true;
  }

  return false;
}

// ============================================
// SECURITY SCAN
// ============================================

/**
 * Run comprehensive security scan
 * @returns {Object} - Scan results
 */
async function runSecurityScan() {
  logSecurityEvent('scan', 'Starting comprehensive security scan');

  const results = {
    timestamp: new Date().toISOString(),
    fileIntegrity: checkIntegrity(),
    networkAnalysis: analyzeConnections(),
    processAnalysis: analyzeProcesses(),
    alerts: getActiveAlerts(),
    overallStatus: 'ok'
  };

  // Determine overall status
  if (results.fileIntegrity.status === 'alert' ||
      results.networkAnalysis.suspicious > 0 ||
      results.processAnalysis.suspicious > 0) {
    results.overallStatus = 'warning';
  }

  const criticalAlerts = results.alerts.filter(a => a.severity === 'critical');
  if (criticalAlerts.length > 0) {
    results.overallStatus = 'critical';
  }

  logSecurityEvent('scan', `Security scan complete. Status: ${results.overallStatus}`, {
    fileIssues: results.fileIntegrity.modified?.length || 0,
    suspiciousConnections: results.networkAnalysis.suspicious,
    suspiciousProcesses: results.processAnalysis.suspicious,
    activeAlerts: results.alerts.length
  });

  return results;
}

// ============================================
// HOST HARDENING CHECKS
// ============================================

/**
 * Check Windows Defender status
 * @returns {Object}
 */
function checkDefenderStatus() {
  try {
    const output = execSync('powershell -Command "Get-MpComputerStatus | Select-Object AntivirusEnabled,RealTimeProtectionEnabled,IoavProtectionEnabled | ConvertTo-Json"', { encoding: 'utf-8' });
    return JSON.parse(output);
  } catch (e) {
    return { error: 'Could not check Defender status' };
  }
}

/**
 * Check firewall status
 * @returns {Object}
 */
function checkFirewallStatus() {
  try {
    const output = execSync('powershell -Command "Get-NetFirewallProfile | Select-Object Name,Enabled | ConvertTo-Json"', { encoding: 'utf-8' });
    return JSON.parse(output);
  } catch (e) {
    return { error: 'Could not check firewall status' };
  }
}

/**
 * Get security recommendations
 * @returns {Array}
 */
async function getSecurityRecommendations() {
  const recommendations = [];

  // Check Defender
  const defender = checkDefenderStatus();
  if (defender.AntivirusEnabled === false) {
    recommendations.push({
      severity: 'critical',
      title: 'Windows Defender Disabled',
      recommendation: 'Enable Windows Defender antivirus protection'
    });
  }
  if (defender.RealTimeProtectionEnabled === false) {
    recommendations.push({
      severity: 'high',
      title: 'Real-time Protection Disabled',
      recommendation: 'Enable Windows Defender real-time protection'
    });
  }

  // Check Firewall
  const firewall = checkFirewallStatus();
  if (Array.isArray(firewall)) {
    const disabledProfiles = firewall.filter(f => !f.Enabled);
    if (disabledProfiles.length > 0) {
      recommendations.push({
        severity: 'high',
        title: 'Firewall Profile Disabled',
        recommendation: `Enable firewall for: ${disabledProfiles.map(f => f.Name).join(', ')}`
      });
    }
  }

  // Check for baseline
  if (!fs.existsSync(BASELINE_FILE)) {
    recommendations.push({
      severity: 'medium',
      title: 'No File Integrity Baseline',
      recommendation: 'Run createBaseline() to establish file integrity monitoring'
    });
  }

  return recommendations;
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Audit logging
  logSecurityEvent,
  getRecentEvents,

  // File integrity
  createBaseline,
  checkIntegrity,
  hashFile,

  // Network monitoring
  getNetworkConnections,
  analyzeConnections,

  // Process monitoring
  getProcessList,
  analyzeProcesses,

  // Alerts
  createAlert,
  getActiveAlerts,
  acknowledgeAlert,

  // Scanning
  runSecurityScan,

  // Hardening
  checkDefenderStatus,
  checkFirewallStatus,
  getSecurityRecommendations,

  // Paths
  SECURITY_DIR,
  AUDIT_LOG,
  BASELINE_FILE,
  ALERTS_FILE
};
