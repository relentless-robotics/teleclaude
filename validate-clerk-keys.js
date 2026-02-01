// Validate Clerk API keys format
const args = process.argv.slice(2);

if (args.length !== 2) {
  console.error('❌ Usage: node validate-clerk-keys.js <publishable_key> <secret_key>');
  process.exit(1);
}

const [publishableKey, secretKey] = args;

console.log('Validating Clerk API keys...\n');

let valid = true;

// Check publishable key
console.log('Publishable Key:', publishableKey);
if (publishableKey.startsWith('pk_test_')) {
  console.log('  ✅ Format: Test mode (pk_test_)');
} else if (publishableKey.startsWith('pk_live_')) {
  console.log('  ✅ Format: Live mode (pk_live_)');
} else {
  console.log('  ❌ Invalid format! Must start with pk_test_ or pk_live_');
  valid = false;
}

if (publishableKey.length < 30) {
  console.log('  ⚠️  Warning: Key seems too short');
  valid = false;
}

console.log();

// Check secret key
console.log('Secret Key:', secretKey.substring(0, 15) + '...');
if (secretKey.startsWith('sk_test_')) {
  console.log('  ✅ Format: Test mode (sk_test_)');
} else if (secretKey.startsWith('sk_live_')) {
  console.log('  ✅ Format: Live mode (sk_live_)');
} else {
  console.log('  ❌ Invalid format! Must start with sk_test_ or sk_live_');
  valid = false;
}

if (secretKey.length < 30) {
  console.log('  ⚠️  Warning: Key seems too short');
  valid = false;
}

console.log();

// Check mode match
const pubMode = publishableKey.startsWith('pk_test_') ? 'test' : 'live';
const secMode = secretKey.startsWith('sk_test_') ? 'test' : 'live';

if (pubMode !== secMode) {
  console.log('❌ Mode mismatch! Publishable is in', pubMode, 'mode but Secret is in', secMode, 'mode');
  console.log('   Both keys must be from the same environment (test or live)');
  valid = false;
} else {
  console.log('✅ Mode match:', pubMode === 'test' ? 'Test mode' : 'Live mode');
}

console.log();

if (valid) {
  console.log('✅ Keys are valid! Ready to proceed with deployment.');
  process.exit(0);
} else {
  console.log('❌ Keys validation failed. Please check the keys and try again.');
  process.exit(1);
}
