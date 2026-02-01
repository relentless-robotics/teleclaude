// Helper script to update .env.local with Clerk keys
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

if (args.length !== 2) {
  console.error('Usage: node update-clerk-env.js <publishable_key> <secret_key>');
  console.error('Example: node update-clerk-env.js pk_test_abc123 sk_test_xyz789');
  process.exit(1);
}

const [publishableKey, secretKey] = args;

// Validate keys
if (!publishableKey.startsWith('pk_test_') && !publishableKey.startsWith('pk_live_')) {
  console.error('Error: Publishable key must start with pk_test_ or pk_live_');
  process.exit(1);
}

if (!secretKey.startsWith('sk_test_') && !secretKey.startsWith('sk_live_')) {
  console.error('Error: Secret key must start with sk_test_ or sk_live_');
  process.exit(1);
}

const envPath = path.join(__dirname, 'dashboard-app', '.env.local');

if (!fs.existsSync(envPath)) {
  console.error(`Error: .env.local not found at ${envPath}`);
  process.exit(1);
}

let envContent = fs.readFileSync(envPath, 'utf-8');

// Replace the placeholder keys
envContent = envContent.replace(
  /NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=.*/,
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${publishableKey}`
);

envContent = envContent.replace(
  /CLERK_SECRET_KEY=.*/,
  `CLERK_SECRET_KEY=${secretKey}`
);

fs.writeFileSync(envPath, envContent);

console.log('✅ Successfully updated .env.local with Clerk keys');
console.log(`   Publishable Key: ${publishableKey}`);
console.log(`   Secret Key: ${secretKey.substring(0, 15)}...`);

// Also save to API_KEYS.md
const apiKeysPath = path.join(__dirname, 'API_KEYS.md');
let apiKeysContent = fs.readFileSync(apiKeysPath, 'utf-8');

const clerkEntry = `
---

## Clerk (Authentication Platform)

| Field | Value |
|-------|-------|
| Service | Clerk |
| Email | relentlessrobotics@gmail.com |
| Application | TeleClaude Dashboard |
| Publishable Key | \`${publishableKey}\` |
| Secret Key | \`${secretKey}\` |
| Dashboard | https://dashboard.clerk.com |
| Created | ${new Date().toISOString().split('T')[0]} |

**Notes:** Used for authentication in the TeleClaude Dashboard (Next.js app).

---
`;

// Append to API_KEYS.md
apiKeysContent += clerkEntry;
fs.writeFileSync(apiKeysPath, apiKeysContent);

console.log('✅ Added Clerk keys to API_KEYS.md');
