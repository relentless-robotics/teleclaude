# Polymarket Setup & API Access Guide

## Account Setup

**Account Email**: relentlessrobotics@gmail.com
**Password**: YOUR_PASSWORD_HERE
**Authentication Method**: Magic Link (magic.link) or Wallet Connection

### Setup Steps

1. **Visit**: https://polymarket.com
2. **Click**: "Sign Up" button
3. **Enter Email**: relentlessrobotics@gmail.com
4. **Authenticate**:
   - Magic Link: Complete email verification
   - OR Wallet: Connect MetaMask/WalletConnect
   - Available Solana wallet: `Emae59zuAprVLBi1XL9aAfMmzKfuhvWq8Y4ZCRafG5MQ`

---

## API Key Generation

### Step 1: Access Builder Settings

**Direct URL**: https://polymarket.com/settings?tab=builder

**OR Navigate**:
1. Click profile image (top right)
2. Select "Builders"
3. Go to "Builder Keys" section

### Step 2: Create New API Key

1. Click **"+ Create New"** button
2. System generates 3 credentials:
   - `apiKey`: Your unique builder identifier
   - `secret`: Used for signing requests
   - `passphrase`: Additional authentication layer

3. **SAVE THESE IMMEDIATELY** - Cannot be recovered later!

### Step 3: Export Private Key (For Trading)

Required for programmatic trading via API:

1. Navigate to **"Cash"** section in account
2. Click **3 dots** menu (⋮)
3. Select **"Export Private Key"**
4. Copy the private key
5. **Remove "0x" prefix** when using in code

---

## API Credentials Storage

Once generated, add to `API_KEYS.md`:

```markdown
---

## Polymarket API

| Field | Value |
|-------|-------|
| Service | Polymarket Prediction Markets |
| Account Email | relentlessrobotics@gmail.com |
| API Key | `your-api-key-here` |
| API Secret | `your-secret-here` |
| API Passphrase | `your-passphrase-here` |
| Private Key | `your-private-key-no-0x` |
| Builder Profile | https://polymarket.com/settings?tab=builder |
| API Docs | https://docs.polymarket.com/ |
| Created | YYYY-MM-DD |

**Notes:**
- Private key required for trading operations
- Free tier: 1,000 calls/hour
- Premium tier: $99/month (WebSocket, historical data)
```

---

## API Usage

### Python Client Library

**Official Library**: `py-clob-client`

```bash
pip install py-clob-client
```

### Basic Setup

```python
from py_clob_client.client import ClobClient

# Initialize client
client = ClobClient(
    host="https://clob.polymarket.com",
    key="YOUR_API_KEY",
    secret="YOUR_SECRET",
    passphrase="YOUR_PASSPHRASE",
    chain_id=137  # Polygon Mainnet
)

# For trading (requires private key)
from py_clob_client.clob_types import ApiCreds

creds = ApiCreds(
    api_key="YOUR_API_KEY",
    api_secret="YOUR_SECRET",
    api_passphrase="YOUR_PASSPHRASE"
)

client = ClobClient(
    host="https://clob.polymarket.com",
    key="YOUR_PRIVATE_KEY_NO_0x",
    chain_id=137,
    creds=creds,
    signature_type=1  # For browser wallet
)
```

### Example: Get Markets

```python
# Get all active markets
markets = client.get_markets()

# Get specific market
market = client.get_market("market-id")

# Get market prices
orderbook = client.get_order_book("market-id")
```

---

## API Endpoints

### Public Endpoints (No Auth Required)

- **Markets**: `GET https://gamma-api.polymarket.com/markets`
- **Market by ID**: `GET https://gamma-api.polymarket.com/markets/{id}`
- **Events**: `GET https://gamma-api.polymarket.com/events`
- **Prices**: `GET https://clob.polymarket.com/prices`

### Authenticated Endpoints (API Key Required)

- **Place Order**: `POST /order`
- **Cancel Order**: `DELETE /order`
- **Get Orders**: `GET /orders`
- **Get Trades**: `GET /trades`

---

## Rate Limits

### Free Tier
- **Non-trading queries**: 1,000 calls/hour
- **Trading operations**: Lower limits apply
- **WebSocket**: Not available

### Premium Tier ($99/month)
- **Higher limits**: Enterprise-level rate limits
- **WebSocket feeds**: Real-time market data
- **Historical data**: Beyond 30 days
- **Priority support**: Dedicated support channel

---

## Resources

- **Documentation**: https://docs.polymarket.com/
- **Builder Profile**: https://docs.polymarket.com/developers/builders/builder-profile
- **Python Client**: https://github.com/Polymarket/py-clob-client
- **GitHub Examples**: https://github.com/Polymarket/agents
- **API Blog Post**: https://jeremywhittaker.com/index.php/2024/08/28/generating-api-keys-for-polymarket-com/

---

## Troubleshooting

### Magic Link Not Working
- Check spam folder for verification email
- Try wallet connection instead (MetaMask recommended)
- Ensure popup blockers are disabled

### API Key Not Working
- Verify all 3 credentials (key, secret, passphrase) are correct
- Check rate limits haven't been exceeded
- Ensure private key has "0x" prefix removed

### Trading Errors
- Confirm private key is exported and configured
- Verify wallet has funds for gas fees (MATIC on Polygon)
- Check market is still active and accepting orders

---

## Security Notes

⚠️ **NEVER share or commit**:
- Private key
- API secret
- API passphrase

🔒 **Best practices**:
- Store credentials in environment variables
- Use separate keys for dev/test/prod
- Rotate keys periodically
- Monitor API usage for anomalies
