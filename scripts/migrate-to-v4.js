#!/usr/bin/env node
/**
 * Migration Script: Memory Server v3 -> v4
 *
 * Migrates data from JSON files to SQLite + Chroma hybrid system.
 *
 * Features:
 * - Full backup before migration
 * - Validates existing data
 * - Migrates memories with embeddings
 * - Migrates projects with steps and blockers
 * - Rollback support
 *
 * Usage:
 *   node scripts/migrate-to-v4.js [options]
 *
 * Options:
 *   --dry-run     Show what would be migrated without making changes
 *   --force       Overwrite existing v4 data
 *   --verbose     Show detailed progress
 *   --no-backup   Skip backup creation (not recommended)
 */

const fs = require('fs');
const path = require('path');

// Paths
const BASE_DIR = path.join(__dirname, '..');
const MEMORY_DIR = path.join(BASE_DIR, 'memory');
const BACKUP_DIR = path.join(MEMORY_DIR, 'backup-v3');
const LOGS_DIR = path.join(BASE_DIR, 'logs');

// Source files (v3)
const V3_MEMORIES_FILE = path.join(MEMORY_DIR, 'memories.json');
const V3_PROJECTS_FILE = path.join(MEMORY_DIR, 'projects.json');
const V3_INDEX_FILE = path.join(MEMORY_DIR, 'semantic-index.json');

// Target files (v4)
const V4_SQLITE_FILE = path.join(MEMORY_DIR, 'memory.db');
const V4_CHROMA_DIR = path.join(MEMORY_DIR, 'chroma');

// Parse CLI arguments
const args = process.argv.slice(2);
const options = {
  dryRun: args.includes('--dry-run'),
  force: args.includes('--force'),
  verbose: args.includes('--verbose'),
  noBackup: args.includes('--no-backup')
};

// Logger
function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  let output = `[${timestamp}] [${level}] ${message}`;
  if (data && options.verbose) {
    output += '\n  ' + JSON.stringify(data, null, 2);
  }
  console.log(output);

  // Also write to log file
  try {
    const logFile = path.join(LOGS_DIR, `migration-${new Date().toISOString().split('T')[0]}.log`);
    fs.appendFileSync(logFile, output + '\n');
  } catch (e) { }
}

function logInfo(msg, data) { log('INFO', msg, data); }
function logWarn(msg, data) { log('WARN', msg, data); }
function logError(msg, data) { log('ERROR', msg, data); }
function logSuccess(msg, data) { log('SUCCESS', msg, data); }

/**
 * Read JSON file safely
 */
function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    logError(`Failed to read ${filePath}`, { error: e.message });
  }
  return null;
}

/**
 * Create backup of v3 files
 */
function createBackup() {
  logInfo('Creating backup of v3 data...');

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const files = [
    { src: V3_MEMORIES_FILE, name: 'memories.json' },
    { src: V3_PROJECTS_FILE, name: 'projects.json' },
    { src: V3_INDEX_FILE, name: 'semantic-index.json' }
  ];

  for (const file of files) {
    if (fs.existsSync(file.src)) {
      const backupPath = path.join(BACKUP_DIR, `${timestamp}_${file.name}`);
      fs.copyFileSync(file.src, backupPath);
      logInfo(`Backed up: ${file.name} -> ${path.basename(backupPath)}`);
    }
  }

  return timestamp;
}

/**
 * Validate v3 data structure
 */
function validateV3Data(memories, projects) {
  const issues = [];

  // Validate memories
  if (memories && memories.memories) {
    for (const m of memories.memories) {
      if (!m.id) issues.push(`Memory missing ID: ${JSON.stringify(m).slice(0, 100)}`);
      if (!m.content) issues.push(`Memory ${m.id} missing content`);
      if (!m.priority) issues.push(`Memory ${m.id} missing priority`);
    }
  }

  // Validate projects
  if (projects && projects.projects) {
    for (const p of projects.projects) {
      if (!p.id) issues.push(`Project missing ID: ${JSON.stringify(p).slice(0, 100)}`);
      if (!p.name) issues.push(`Project ${p.id} missing name`);
      if (!Array.isArray(p.steps)) issues.push(`Project ${p.id} has invalid steps`);
    }
  }

  return issues;
}

/**
 * Check if v4 system already has data
 */
function checkExistingV4Data() {
  const exists = {
    sqlite: fs.existsSync(V4_SQLITE_FILE),
    chroma: fs.existsSync(V4_CHROMA_DIR) && fs.readdirSync(V4_CHROMA_DIR).length > 0
  };

  if (exists.sqlite || exists.chroma) {
    logWarn('V4 data already exists', exists);
  }

  return exists;
}

/**
 * Main migration function
 */
async function migrate() {
  console.log('\n========================================');
  console.log('  Memory System Migration: v3 -> v4');
  console.log('========================================\n');

  if (options.dryRun) {
    console.log('*** DRY RUN MODE - No changes will be made ***\n');
  }

  // Ensure logs directory exists
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  // Step 1: Read existing data
  logInfo('Reading v3 data...');

  const memoriesData = readJSON(V3_MEMORIES_FILE);
  const projectsData = readJSON(V3_PROJECTS_FILE);

  if (!memoriesData && !projectsData) {
    logError('No v3 data found to migrate');
    console.log('\nNo data to migrate. Exiting.');
    return false;
  }

  const memoryCount = memoriesData?.memories?.length || 0;
  const projectCount = projectsData?.projects?.length || 0;

  logInfo(`Found ${memoryCount} memories and ${projectCount} projects`);

  // Step 2: Validate data
  logInfo('Validating v3 data...');
  const issues = validateV3Data(memoriesData, projectsData);

  if (issues.length > 0) {
    logWarn(`Found ${issues.length} validation issues:`);
    issues.forEach(i => console.log(`  - ${i}`));
    if (!options.force) {
      console.log('\nUse --force to continue despite issues');
      return false;
    }
  } else {
    logSuccess('Validation passed');
  }

  // Step 3: Check existing v4 data
  const existingV4 = checkExistingV4Data();
  if ((existingV4.sqlite || existingV4.chroma) && !options.force) {
    logError('V4 data already exists. Use --force to overwrite.');
    return false;
  }

  // Step 4: Create backup
  let backupTimestamp = null;
  if (!options.noBackup && !options.dryRun) {
    backupTimestamp = createBackup();
    logSuccess(`Backup created with timestamp: ${backupTimestamp}`);
  }

  if (options.dryRun) {
    console.log('\n--- DRY RUN SUMMARY ---');
    console.log(`Would migrate ${memoryCount} memories`);
    console.log(`Would migrate ${projectCount} projects`);
    console.log('No changes made.\n');
    return true;
  }

  // Step 5: Initialize v4 engines
  logInfo('Initializing v4 engines...');

  // Clean up existing v4 data if force
  if (options.force) {
    if (fs.existsSync(V4_SQLITE_FILE)) {
      fs.unlinkSync(V4_SQLITE_FILE);
      logInfo('Removed existing SQLite database');
    }
    if (fs.existsSync(V4_CHROMA_DIR)) {
      fs.rmSync(V4_CHROMA_DIR, { recursive: true, force: true });
      logInfo('Removed existing Chroma data');
    }
  }

  const { SQLiteEngine } = require('../lib/sqlite-engine');
  const { getEmbeddingService } = require('../lib/embedding-service');
  const { ChromaEngine } = require('../lib/chroma-engine');

  const sqliteEngine = new SQLiteEngine(V4_SQLITE_FILE);
  await sqliteEngine.init();
  logSuccess('SQLite engine initialized');

  let embeddingService = null;
  try {
    embeddingService = await getEmbeddingService();
    logSuccess(`Embedding service initialized: ${embeddingService.getInfo().provider}`);
  } catch (e) {
    logWarn(`Embedding service unavailable: ${e.message}`);
    logInfo('Will use TF-IDF fallback for search');
  }

  const chromaEngine = new ChromaEngine(V4_CHROMA_DIR);
  await chromaEngine.init(embeddingService);
  logSuccess('Chroma engine initialized');

  // Step 6: Migrate memories
  logInfo('Migrating memories...');
  let migratedMemories = 0;
  let failedMemories = 0;

  if (memoriesData?.memories) {
    for (const memory of memoriesData.memories) {
      try {
        // Insert into SQLite
        sqliteEngine.insertMemory({
          id: memory.id,
          content: memory.content,
          priority: memory.priority || 'DAILY',
          status: memory.status || 'active',
          tags: memory.tags || [],
          created: memory.created,
          expires: memory.expires,
          lastChecked: memory.lastChecked
        });

        // Handle completed memories
        if (memory.status === 'completed' && memory.completedAt) {
          sqliteEngine.updateMemory(memory.id, {
            status: 'completed',
            completedAt: memory.completedAt
          });
        }

        // Insert into Chroma (only active memories)
        if (memory.status !== 'completed' && chromaEngine) {
          try {
            let embedding = null;
            if (embeddingService) {
              embedding = await embeddingService.embed(memory.content);
            }
            await chromaEngine.upsertMemory(memory.id, memory.content, {
              priority: memory.priority,
              status: memory.status || 'active',
              created: memory.created
            }, embedding);
          } catch (chromaError) {
            logWarn(`Chroma upsert failed for ${memory.id}`, { error: chromaError.message });
          }
        }

        migratedMemories++;
        if (options.verbose) {
          logInfo(`Migrated memory: ${memory.id}`);
        }
      } catch (e) {
        failedMemories++;
        logError(`Failed to migrate memory ${memory.id}`, { error: e.message });
      }
    }
  }

  logSuccess(`Migrated ${migratedMemories} memories (${failedMemories} failed)`);

  // Step 7: Migrate projects
  logInfo('Migrating projects...');
  let migratedProjects = 0;
  let failedProjects = 0;

  if (projectsData?.projects) {
    for (const project of projectsData.projects) {
      try {
        // Insert project with steps
        sqliteEngine.insertProject({
          id: project.id,
          name: project.name,
          description: project.description || '',
          status: project.status || 'planning',
          priority: project.priority || 'DAILY',
          tags: project.tags || [],
          steps: project.steps || [],
          created: project.created
        });

        // Update individual step details
        if (project.steps) {
          for (const step of project.steps) {
            if (step.status !== 'pending' || step.notes) {
              sqliteEngine.updateStep(project.id, step.id, {
                status: step.status,
                notes: step.notes
              });
            }
          }
        }

        // Add blockers
        if (project.blockers) {
          for (const blocker of project.blockers) {
            if (!blocker.resolved) {
              // Re-add active blockers
              sqliteEngine.addBlocker(project.id, blocker.description, blocker.stepId);
            }
          }
        }

        // Index in Chroma
        if (chromaEngine && project.status !== 'completed' && project.status !== 'abandoned') {
          try {
            const stepsText = (project.steps || []).map(s => typeof s === 'string' ? s : s.task).join(' ');
            const content = `${project.name} ${project.description || ''} ${stepsText}`;
            let embedding = null;
            if (embeddingService) {
              embedding = await embeddingService.embed(content);
            }
            await chromaEngine.upsertProject(project.id, project.name, project.description, project.steps, {
              priority: project.priority,
              status: project.status
            }, embedding);
          } catch (chromaError) {
            logWarn(`Chroma project index failed for ${project.id}`, { error: chromaError.message });
          }
        }

        migratedProjects++;
        if (options.verbose) {
          logInfo(`Migrated project: ${project.id} - ${project.name}`);
        }
      } catch (e) {
        failedProjects++;
        logError(`Failed to migrate project ${project.id}`, { error: e.message });
      }
    }
  }

  logSuccess(`Migrated ${migratedProjects} projects (${failedProjects} failed)`);

  // Step 8: Verify migration
  logInfo('Verifying migration...');

  const sqliteStats = sqliteEngine.getStats();
  const chromaStats = await chromaEngine.getStats();

  console.log('\n--- Migration Verification ---');
  console.log(`SQLite: ${sqliteStats.memories} memories, ${sqliteStats.projects} projects`);
  console.log(`Chroma: ${chromaStats.memories} memory vectors, ${chromaStats.projects} project vectors`);

  const expectedMemories = memoryCount;
  const expectedProjects = projectCount;

  if (sqliteStats.memories === expectedMemories && sqliteStats.projects === expectedProjects) {
    logSuccess('Migration counts match!');
  } else {
    logWarn('Migration counts differ from source', {
      expected: { memories: expectedMemories, projects: expectedProjects },
      actual: { memories: sqliteStats.memories, projects: sqliteStats.projects }
    });
  }

  // Step 9: Close engines
  sqliteEngine.close();

  // Step 10: Rename old files
  logInfo('Renaming v3 files to .bak...');

  const filesToRename = [
    { src: V3_MEMORIES_FILE, dst: V3_MEMORIES_FILE + '.bak' },
    { src: V3_PROJECTS_FILE, dst: V3_PROJECTS_FILE + '.bak' },
    { src: V3_INDEX_FILE, dst: V3_INDEX_FILE + '.bak' }
  ];

  for (const file of filesToRename) {
    if (fs.existsSync(file.src)) {
      // Don't overwrite existing .bak files
      if (!fs.existsSync(file.dst)) {
        fs.renameSync(file.src, file.dst);
        logInfo(`Renamed: ${path.basename(file.src)} -> ${path.basename(file.dst)}`);
      } else {
        logWarn(`Backup already exists, keeping original: ${path.basename(file.src)}`);
      }
    }
  }

  // Final summary
  console.log('\n========================================');
  console.log('       Migration Complete!');
  console.log('========================================');
  console.log(`\nMigrated:`);
  console.log(`  - ${migratedMemories} memories`);
  console.log(`  - ${migratedProjects} projects`);
  if (backupTimestamp) {
    console.log(`\nBackup created: ${BACKUP_DIR}`);
  }
  console.log(`\nTo rollback, run: node scripts/rollback-to-v3.js`);
  console.log('\n');

  return true;
}

/**
 * Create rollback script
 */
function createRollbackScript() {
  const rollbackPath = path.join(__dirname, 'rollback-to-v3.js');

  const rollbackContent = `#!/usr/bin/env node
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

console.log('\\n=== Rollback v4 -> v3 ===\\n');

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
    console.log(\`Restored: \${path.basename(file.dst)}\`);
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

console.log(\`\\nRollback complete. Restored \${restored} files.\\n\`);
`;

  fs.writeFileSync(rollbackPath, rollbackContent, 'utf8');
  logInfo('Created rollback script: scripts/rollback-to-v3.js');
}

// Run migration
(async () => {
  try {
    createRollbackScript();
    const success = await migrate();
    process.exit(success ? 0 : 1);
  } catch (e) {
    logError('Migration failed with exception', { error: e.message, stack: e.stack });
    process.exit(1);
  }
})();
