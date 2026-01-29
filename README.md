# Claude Telegram Bridge

Control Claude Code CLI from your phone via Telegram. This bridge allows you to send messages to Claude through a Telegram bot and receive responses back.

## Features

- Interactive setup wizard for first-time configuration
- Full Claude Code CLI access via Telegram messages
- Process management commands (/status, /restart, /kill, /reset)
- MCP server for seamless send_to_telegram tool
- Chunked message handling for long responses
- User authentication via Telegram user IDs

## Prerequisites

### Required

1. **Node.js 18+** - [Download](https://nodejs.org/)
2. **Claude Code CLI** - Must be installed and authenticated
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```
3. **Telegram Bot Token** - Create via [@BotFather](https://t.me/BotFather)

### Optional

- **Playwright** - For browser automation features
- **System Chromium** - For headless browsing

## Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/claude-telegram-bridge.git
   cd claude-telegram-bridge
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run the setup**
   ```bash
   npm start
   ```

   On first run, the interactive setup wizard will guide you through configuration.

## Getting a Telegram Bot Token

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Choose a name for your bot (e.g., "My Claude Bot")
4. Choose a username (must end in "bot", e.g., "my_claude_bot")
5. BotFather will give you a token like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`
6. Save this token for the setup process

## Finding Your Telegram User ID

1. Open Telegram and search for [@userinfobot](https://t.me/userinfobot)
2. Send any message to the bot
3. It will reply with your user ID (a number like `123456789`)
4. Use this ID during setup to authorize yourself

## Bootstrap Process

When you run the bridge for the first time (no `config.json` exists):

1. **Enter Telegram Bot Token** - The bot validates the token is correct
2. **Enter Allowed User IDs** - Comma-separated list of Telegram user IDs
3. **Enter Working Directory** - Where Claude will have file access (defaults to home)
4. **Optional Credentials** - Default email/password for browser automation

Configuration is saved to `config.json` and the bridge starts automatically.

## Usage

### Bot Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Check if Claude is running |
| `/restart` | Restart Claude session |
| `/kill` | Kill all Claude processes |
| `/reset` | Full reset and restart |
| `/ping` | Check bridge responsiveness |

### Sending Messages

Simply send any text message to your bot - it will be forwarded to Claude. Claude's responses come back through the same chat.

## Configuration

### config.json

```json
{
  "telegramToken": "your-bot-token",
  "allowedUsers": [123456789],
  "workdir": "/home/user",
  "credentials": {
    "email": null,
    "password": null
  }
}
```

### Environment Variables (Alternative)

You can also use `.env` file (copy from `.env.example`):

```env
TELEGRAM_TOKEN=your_token
ALLOWED_USERS=123456789,987654321
WORKDIR=/home/user
```

## Project Structure

```
claude-telegram-bridge/
├── index.js              # Main bridge application
├── mcp/
│   ├── telegram-bridge.js  # MCP server for send_to_telegram
│   └── config.json         # MCP configuration
├── CLAUDE.md             # Instructions for Claude
├── SKILLS.md             # Workflow documentation template
├── API_KEYS.md           # API key storage template
├── config.json           # Your configuration (created on setup)
├── config.example.json   # Example configuration
├── .env.example          # Example environment variables
├── package.json          # Node.js dependencies
└── README.md             # This file
```

## Adding MCP Servers

The bridge supports additional MCP servers. Edit `mcp/config.json`:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["./mcp/telegram-bridge.js"]
    },
    "another-server": {
      "command": "node",
      "args": ["./path/to/server.js"]
    }
  }
}
```

## How It Works

1. **Telegram Bot** receives your message
2. **Bridge** forwards the message to Claude Code CLI via PTY
3. **Claude** processes the request using its tools
4. **MCP Server** provides `send_to_telegram` tool
5. **Claude** uses `send_to_telegram` to respond
6. **Bridge** watches output file and sends to Telegram

The `CLAUDE.md` file instructs Claude to always use the `send_to_telegram` tool for responses, since terminal output is not visible to the user.

## Troubleshooting

### Claude not responding
- Use `/status` to check if Claude is running
- Try `/restart` to restart the session
- Use `/reset` for a full process cleanup

### "Access denied" message
- Your Telegram user ID is not in the allowed list
- Edit `config.json` to add your user ID
- Restart the bridge

### Bot not receiving messages
- Verify the bot token is correct
- Ensure the bot is not blocked
- Check for polling errors in the console

### Long responses getting cut off
- Responses over 4000 characters are automatically chunked
- This is a Telegram limitation

## Running as a Service

### Using systemd (Linux)

Create `/etc/systemd/system/claude-telegram.service`:

```ini
[Unit]
Description=Claude Telegram Bridge
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/claude-telegram-bridge
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable claude-telegram
sudo systemctl start claude-telegram
```

### Using PM2

```bash
npm install -g pm2
pm2 start index.js --name claude-telegram
pm2 save
pm2 startup
```

## Security Considerations

- Never commit `config.json` (contains bot token)
- Keep `API_KEYS.md` private if storing real keys
- Only add trusted user IDs to the allowed list
- The bridge runs Claude with `--dangerously-skip-permissions`
- Consider running in a sandboxed environment

## License

MIT

## Contributing

Contributions welcome! Please open an issue or pull request.
