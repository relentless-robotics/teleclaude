const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');

// Generate a new random keypair
const keypair = Keypair.generate();

// Get the public key (wallet address)
const publicKey = keypair.publicKey.toBase58();

// Get the secret key (private key) in different formats
const secretKeyArray = Array.from(keypair.secretKey);
const secretKeyBase58 = bs58.encode(keypair.secretKey);

// Create the .keys directory if it doesn't exist
const keysDir = path.join(__dirname, '.keys');
if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
}

// Save the keypair in JSON format (Solana CLI compatible)
const keypairPath = path.join(keysDir, 'solana-wallet.json');
fs.writeFileSync(keypairPath, JSON.stringify(secretKeyArray));

// Also save a human-readable backup with the Base58 private key
const backupPath = path.join(keysDir, 'solana-wallet-backup.txt');
const backupContent = `Solana Wallet Backup
====================
Created: ${new Date().toISOString()}

Public Address (Wallet Address):
${publicKey}

Private Key (Base58 - KEEP SECRET):
${secretKeyBase58}

Private Key (JSON Array - Solana CLI compatible):
Stored in: solana-wallet.json

IMPORTANT: Never share your private key with anyone!
This wallet is for AI financial autonomy purposes.
`;
fs.writeFileSync(backupPath, backupContent);

// Output the results
console.log('WALLET_ADDRESS=' + publicKey);
console.log('KEYPAIR_PATH=' + keypairPath);
console.log('BACKUP_PATH=' + backupPath);
console.log('PRIVATE_KEY_BASE58=' + secretKeyBase58);
