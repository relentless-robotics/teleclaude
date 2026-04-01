/**
 * One-time cleanup script for corrupted pick tracker data
 */

const pickTracker = require('./research/pick_tracker');

console.log('🧹 Starting pick tracker cleanup...\n');

const result = pickTracker.cleanupCorruptedData();

console.log('\n📊 Cleanup complete:');
console.log(`  Original picks: ${result.originalCount}`);
console.log(`  Removed: ${result.removed}`);
console.log(`  Remaining: ${result.remaining}`);
