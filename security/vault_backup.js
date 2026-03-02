/**
 * Vault Backup System
 *
 * CRITICAL: Ensures vault data is NEVER lost
 * - Auto-backup before any write
 * - Multiple backup generations
 * - Recovery from backup
 */

const fs = require('fs');
const path = require('path');

const VAULT_FILE = path.join(__dirname, 'vault.enc');
const BACKUP_DIR = path.join(__dirname, 'vault_backups');
const MAX_BACKUPS = 10; // Keep last 10 backups

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * Create timestamped backup of vault
 */
function backupVault() {
  if (!fs.existsSync(VAULT_FILE)) {
    console.log('[Vault Backup] No vault file to backup');
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `vault_${timestamp}.enc`);

  fs.copyFileSync(VAULT_FILE, backupPath);
  console.log(`[Vault Backup] Created: ${backupPath}`);

  // Cleanup old backups (keep only MAX_BACKUPS)
  cleanupOldBackups();

  return backupPath;
}

/**
 * Remove old backups beyond MAX_BACKUPS
 */
function cleanupOldBackups() {
  const backups = listBackups();

  if (backups.length > MAX_BACKUPS) {
    const toDelete = backups.slice(MAX_BACKUPS);
    toDelete.forEach(backup => {
      fs.unlinkSync(backup.path);
      console.log(`[Vault Backup] Deleted old backup: ${backup.name}`);
    });
  }
}

/**
 * List all backups sorted by date (newest first)
 */
function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('vault_') && f.endsWith('.enc'))
    .map(f => ({
      name: f,
      path: path.join(BACKUP_DIR, f),
      created: fs.statSync(path.join(BACKUP_DIR, f)).mtime
    }))
    .sort((a, b) => b.created - a.created);

  return files;
}

/**
 * Restore vault from most recent backup
 */
function restoreLatestBackup() {
  const backups = listBackups();

  if (backups.length === 0) {
    console.error('[Vault Backup] No backups available!');
    return false;
  }

  const latest = backups[0];
  console.log(`[Vault Backup] Restoring from: ${latest.name}`);

  // Backup current (corrupted?) vault first
  if (fs.existsSync(VAULT_FILE)) {
    const corruptedPath = path.join(BACKUP_DIR, `vault_corrupted_${Date.now()}.enc`);
    fs.copyFileSync(VAULT_FILE, corruptedPath);
  }

  fs.copyFileSync(latest.path, VAULT_FILE);
  console.log('[Vault Backup] Vault restored successfully');
  return true;
}

/**
 * Restore from specific backup
 */
function restoreFromBackup(backupName) {
  const backupPath = path.join(BACKUP_DIR, backupName);

  if (!fs.existsSync(backupPath)) {
    console.error(`[Vault Backup] Backup not found: ${backupName}`);
    return false;
  }

  // Backup current vault first
  if (fs.existsSync(VAULT_FILE)) {
    const corruptedPath = path.join(BACKUP_DIR, `vault_before_restore_${Date.now()}.enc`);
    fs.copyFileSync(VAULT_FILE, corruptedPath);
  }

  fs.copyFileSync(backupPath, VAULT_FILE);
  console.log(`[Vault Backup] Restored from: ${backupName}`);
  return true;
}

/**
 * Get backup status
 */
function getBackupStatus() {
  const backups = listBackups();
  return {
    totalBackups: backups.length,
    latestBackup: backups[0] ? backups[0].name : null,
    latestBackupDate: backups[0] ? backups[0].created : null,
    backupDir: BACKUP_DIR
  };
}

module.exports = {
  backupVault,
  listBackups,
  restoreLatestBackup,
  restoreFromBackup,
  getBackupStatus,
  cleanupOldBackups
};
