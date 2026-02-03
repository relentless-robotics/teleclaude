#!/usr/bin/env node
/**
 * Rollback Script: Memory Server v4 -> v3
 *
 * Restores v3 JSON files from backups and removes v4 data.
 */

const fs = require('fs');
const path = require('path');

const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const BACKUP_DIR = path.join(MEMORY_DIR, 'backup-v3');

const V3_MEMORIES_FILE = path.join(MEMORY_DIR, 'memories.json');
const V3_PROJECTS_FILE = path.join(MEMORY_DIR, 'projects.json');
const V3_INDEX_FILE = path.join(MEMORY_DIR, 'semantic-index.json');
const V4_SQLITE_FILE = path.join(MEMORY_DIR, 'memory.db');
const V4_CHROMA_DIR = path.join(MEMORY_DIR, 'chroma');

console.log('\n=== Rollback v4 -> v3 ===\n');

// Check for .bak files
const bakFiles = [
  { bak: V3_MEMORIES_FILE + '.bak', dst: V3_MEMORIES_FILE },
  { bak: V3_PROJECTS_FILE + '.bak', dst: V3_PROJECTS_FILE },
  { bak: V3_INDEX_FILE + '.bak', dst: V3_INDEX_FILE }
];

let restored = 0;
for (const file of bakFiles) {
  if (fs.existsSync(file.bak)) {
    if (fs.existsSync(file.dst)) {
      fs.unlinkSync(file.dst);
    }
    fs.renameSync(file.bak, file.dst);
    console.log(`Restored: ${path.basename(file.dst)}`);
    restored++;
  }
}

// Remove v4 data
if (fs.existsSync(V4_SQLITE_FILE)) {
  fs.unlinkSync(V4_SQLITE_FILE);
  console.log('Removed: memory.db');
}

if (fs.existsSync(V4_CHROMA_DIR)) {
  fs.rmSync(V4_CHROMA_DIR, { recursive: true, force: true });
  console.log('Removed: chroma/');
}

console.log(`\nRollback complete. Restored ${restored} files.\n`);
