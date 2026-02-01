const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

// Generate a new keypair
const keypair = Keypair.generate();

// Get the public key (wallet address)
const publicKey = keypair.publicKey.toBase58();

// Get the secret key as array
const secretKey = Array.from(keypair.secretKey);

// Create keys directory if it doesn't exist
const keysDir = path.join(__dirname, '.keys');
if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
}

// Save the keypair to a JSON file (Solana CLI format)
const keypairPath = path.join(keysDir, 'solana-wallet.json');
fs.writeFileSync(keypairPath, JSON.stringify(secretKey));

// Also save a readable version
const walletInfo = {
    publicKey: publicKey,
    created: new Date().toISOString(),
    network: 'mainnet-beta',
    note: 'AI Autonomy Wallet - Claude'
};
fs.writeFileSync(path.join(keysDir, 'wallet-info.json'), JSON.stringify(walletInfo, null, 2));

console.log('WALLET_CREATED');
console.log('PUBLIC_KEY:' + publicKey);
console.log('KEYPAIR_PATH:' + keypairPath);
