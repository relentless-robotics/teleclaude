/**
 * IP Traceability Module
 *
 * Tracks and logs all IP addresses for:
 * - Incoming connections
 * - Outgoing connections
 * - ColorHat operations
 * - Container network activity
 *
 * Provides:
 * - IP geolocation
 * - Connection history
 * - Threat intelligence lookups
 * - Audit trails
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Paths
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const IP_LOG_FILE = path.join(LOGS_DIR, 'ip_trace.json');
const IP_CACHE_FILE = path.join(LOGS_DIR, 'ip_cache.json');

// Ensure directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// IP cache for geolocation (avoid repeated lookups)
let ipCache = {};
if (fs.existsSync(IP_CACHE_FILE)) {
  try {
    ipCache = JSON.parse(fs.readFileSync(IP_CACHE_FILE, 'utf-8'));
  } catch (e) {
    ipCache = {};
  }
}

/**
 * Log IP event
 * @param {string} ip - IP address
 * @param {string} direction - 'inbound' or 'outbound'
 * @param {string} action - What action occurred
 * @param {Object} metadata - Additional data
 */
function logIPEvent(ip, direction, action, metadata = {}) {
  const event = {
    timestamp: new Date().toISOString(),
    ip,
    direction,
    action,
    metadata,
    hostname: process.env.COMPUTERNAME || 'unknown'
  };

  // Append to log file
  let logs = [];
  if (fs.existsSync(IP_LOG_FILE)) {
    try {
      logs = JSON.parse(fs.readFileSync(IP_LOG_FILE, 'utf-8'));
    } catch (e) {
      logs = [];
    }
  }

  logs.push(event);

  // Keep only last 10000 entries
  if (logs.length > 10000) {
    logs = logs.slice(-10000);
  }

  fs.writeFileSync(IP_LOG_FILE, JSON.stringify(logs, null, 2));

  return event;
}

/**
 * Get IP geolocation info
 * @param {string} ip - IP address
 * @returns {Promise<Object>}
 */
async function getIPInfo(ip) {
  // Check cache first
  if (ipCache[ip] && (Date.now() - ipCache[ip].cachedAt) < 86400000) { // 24 hour cache
    return ipCache[ip].data;
  }

  // Skip private IPs
  if (isPrivateIP(ip)) {
    return {
      ip,
      type: 'private',
      country: 'Local Network',
      city: 'N/A',
      org: 'Private Network'
    };
  }

  return new Promise((resolve) => {
    // Use ip-api.com (free, no API key needed)
    const url = `http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query`;

    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          const result = {
            ip: info.query || ip,
            country: info.country || 'Unknown',
            countryCode: info.countryCode || 'XX',
            region: info.regionName || 'Unknown',
            city: info.city || 'Unknown',
            lat: info.lat,
            lon: info.lon,
            isp: info.isp || 'Unknown',
            org: info.org || 'Unknown',
            asn: info.as || 'Unknown',
            timezone: info.timezone
          };

          // Cache the result
          ipCache[ip] = {
            data: result,
            cachedAt: Date.now()
          };
          fs.writeFileSync(IP_CACHE_FILE, JSON.stringify(ipCache, null, 2));

          resolve(result);
        } catch (e) {
          resolve({ ip, error: 'Failed to parse response' });
        }
      });
    }).on('error', (e) => {
      resolve({ ip, error: e.message });
    });
  });
}

/**
 * Check if IP is private
 * @param {string} ip - IP address
 * @returns {boolean}
 */
function isPrivateIP(ip) {
  const privateRanges = [
    /^127\./,                     // Loopback
    /^10\./,                      // Class A private
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Class B private
    /^192\.168\./,                // Class C private
    /^100\.(6[4-9]|[7-9][0-9]|1[0-2][0-7])\./, // CGNAT / Tailscale
    /^169\.254\./,                // Link-local
    /^::1$/,                      // IPv6 loopback
    /^fc00:/,                     // IPv6 private
    /^fe80:/,                     // IPv6 link-local
  ];

  return privateRanges.some(range => range.test(ip));
}

/**
 * Check if IP is Tailscale
 * @param {string} ip - IP address
 * @returns {boolean}
 */
function isTailscaleIP(ip) {
  return /^100\.(6[4-9]|[7-9][0-9]|1[0-2][0-7])\./.test(ip);
}

/**
 * Get all active connections with geolocation
 * @returns {Promise<Array>}
 */
async function getTracedConnections() {
  try {
    const output = execSync('netstat -ano', { encoding: 'utf-8' });
    const lines = output.split('\n').slice(4);

    const connections = [];
    const seenIPs = new Set();

    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      const foreignAddr = parts[2];
      if (!foreignAddr || foreignAddr === '*:*') continue;

      const ip = foreignAddr.split(':')[0];
      if (ip === '0.0.0.0' || ip === '*') continue;

      // Get unique IPs
      if (!seenIPs.has(ip)) {
        seenIPs.add(ip);
        const info = await getIPInfo(ip);
        connections.push({
          ip,
          port: foreignAddr.split(':')[1],
          protocol: parts[0],
          state: parts[3],
          pid: parts[4],
          ...info
        });
      }
    }

    return connections;
  } catch (e) {
    return [];
  }
}

/**
 * Get IP trace history
 * @param {string} ip - Optional specific IP to filter
 * @param {number} limit - Max entries to return
 * @returns {Array}
 */
function getIPHistory(ip = null, limit = 100) {
  if (!fs.existsSync(IP_LOG_FILE)) {
    return [];
  }

  let logs = JSON.parse(fs.readFileSync(IP_LOG_FILE, 'utf-8'));

  if (ip) {
    logs = logs.filter(entry => entry.ip === ip);
  }

  return logs.slice(-limit);
}

/**
 * Check IP against threat intelligence (basic)
 * @param {string} ip - IP address
 * @returns {Promise<Object>}
 */
async function checkThreatIntel(ip) {
  // Skip private IPs
  if (isPrivateIP(ip)) {
    return {
      ip,
      threat: 'none',
      reason: 'Private IP address'
    };
  }

  // Basic checks (could integrate with AbuseIPDB, VirusTotal, etc.)
  const result = {
    ip,
    isPrivate: isPrivateIP(ip),
    isTailscale: isTailscaleIP(ip),
    geoInfo: await getIPInfo(ip),
    threat: 'unknown',
    checks: []
  };

  // Check if from high-risk countries (basic heuristic)
  const highRiskCountries = ['CN', 'RU', 'KP', 'IR'];
  if (highRiskCountries.includes(result.geoInfo.countryCode)) {
    result.checks.push({
      check: 'high_risk_country',
      result: 'warning',
      detail: `IP is from ${result.geoInfo.country}`
    });
  }

  // Determine overall threat level
  const warnings = result.checks.filter(c => c.result === 'warning').length;
  const dangers = result.checks.filter(c => c.result === 'danger').length;

  if (dangers > 0) {
    result.threat = 'high';
  } else if (warnings > 0) {
    result.threat = 'medium';
  } else {
    result.threat = 'low';
  }

  return result;
}

/**
 * Monitor and log ColorHat target
 * @param {string} target - Target IP/hostname
 * @param {string} tool - Tool being used
 * @param {string} operation - Operation description
 */
function logColorHatTarget(target, tool, operation) {
  const event = logIPEvent(target, 'outbound', 'colorhat_scan', {
    tool,
    operation,
    authorized: true,  // Assuming authorization was checked before
    timestamp: new Date().toISOString()
  });

  console.log(`[IP TRACE] ColorHat ${tool} -> ${target}: ${operation}`);

  return event;
}

/**
 * Get summary of all traced IPs
 * @returns {Object}
 */
function getIPSummary() {
  if (!fs.existsSync(IP_LOG_FILE)) {
    return { total: 0, byDirection: {}, byCountry: {} };
  }

  const logs = JSON.parse(fs.readFileSync(IP_LOG_FILE, 'utf-8'));

  const summary = {
    total: logs.length,
    uniqueIPs: [...new Set(logs.map(l => l.ip))].length,
    byDirection: {},
    byAction: {},
    recentActivity: logs.slice(-10)
  };

  for (const log of logs) {
    summary.byDirection[log.direction] = (summary.byDirection[log.direction] || 0) + 1;
    summary.byAction[log.action] = (summary.byAction[log.action] || 0) + 1;
  }

  return summary;
}

/**
 * Get our public IP
 * @returns {Promise<string>}
 */
async function getPublicIP() {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org?format=json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).ip);
        } catch (e) {
          resolve('unknown');
        }
      });
    }).on('error', () => resolve('unknown'));
  });
}

/**
 * Get Tailscale IP
 * @returns {string}
 */
function getTailscaleIP() {
  try {
    return execSync('tailscale ip -4', { encoding: 'utf-8' }).trim();
  } catch (e) {
    return 'unknown';
  }
}

module.exports = {
  logIPEvent,
  getIPInfo,
  isPrivateIP,
  isTailscaleIP,
  getTracedConnections,
  getIPHistory,
  checkThreatIntel,
  logColorHatTarget,
  getIPSummary,
  getPublicIP,
  getTailscaleIP,
  IP_LOG_FILE,
  IP_CACHE_FILE
};
