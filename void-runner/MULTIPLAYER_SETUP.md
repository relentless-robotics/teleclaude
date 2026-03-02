# Void Runner - Multiplayer Setup Guide

## Current Status

The game is deployed with **multiplayer UI ready** but requires server setup for full functionality.

## Quick Setup Options

### Option 1: Deploy PartyKit Server (Recommended)

1. **Install PartyKit CLI:**
   ```bash
   npm install -g partykit
   ```

2. **Login to PartyKit:**
   ```bash
   npx partykit login
   ```

3. **Deploy the multiplayer server:**
   ```bash
   cd void-runner
   npm run deploy:party
   ```

4. **Update the connection URL:**
   - Open `js/multiplayer.js`
   - Replace the host URL with your deployed PartyKit URL
   - Example: `your-app.your-username.partykit.dev`

5. **Update HTML:**
   - Change `js/multiplayer-simple.js` to `js/multiplayer.js` in `index.html`

6. **Redeploy to Vercel:**
   ```bash
   npx vercel --prod --yes
   ```

### Option 2: Local Development Testing

1. **Run PartyKit dev server:**
   ```bash
   npm run dev
   ```

2. **In another terminal, serve the game:**
   ```bash
   npm start
   ```

3. **Open http://localhost:3000** (or the port shown by serve)

4. Create/join rooms and test locally!

### Option 3: Use Alternative Backend

Instead of PartyKit, you can use:
- **Firebase Realtime Database** - Free tier available
- **Socket.io** - Self-hosted WebSocket server
- **WebRTC with PeerJS** - Peer-to-peer (no server needed)

Update `js/multiplayer.js` to connect to your chosen backend.

## Features Ready

✅ Room creation with shareable codes
✅ Lobby system with player list
✅ Real-time position synchronization
✅ Synchronized obstacle generation (seeded RNG)
✅ Multiplayer leaderboard
✅ Player death notifications
✅ Final standings and winner announcement
✅ URL-based room joining (`?room=ABCD12`)

## Files Structure

```
void-runner/
├── party/
│   └── server.js          # PartyKit multiplayer server
├── js/
│   ├── multiplayer.js     # Full multiplayer client (needs server)
│   └── multiplayer-simple.js  # Fallback (shows setup message)
├── partykit.json          # PartyKit configuration
└── MULTIPLAYER_SETUP.md   # This file
```

## How Multiplayer Works

1. **Room Creation:**
   - Host creates room → Gets 6-character code (e.g., VOID-ABC123)
   - Share URL with friends: `https://your-game.vercel.app/?room=ABC123`

2. **Synchronized Gameplay:**
   - All players get same obstacles (seeded random generation)
   - Positions broadcast 20 times per second
   - Real-time leaderboard shows all players

3. **Competitive Elements:**
   - Race to survive longest
   - See other players crash in real-time
   - Winner announced when all but one player dies

## Costs

- **PartyKit Free Tier:** 100k requests/month (plenty for small games)
- **Vercel Free Tier:** Unlimited for personal projects
- **Total:** FREE for hobby/testing use

## Support

For issues, check:
- PartyKit docs: https://docs.partykit.io
- Vercel docs: https://vercel.com/docs

## Current Deployment

Game is live at: https://void-runner-tau.vercel.app
Status: Solo mode only (multiplayer requires server setup)
