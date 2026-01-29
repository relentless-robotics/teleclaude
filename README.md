# TeleClaude

Control Claude Code CLI from your phone via Telegram, or chat locally in your terminal.

TeleClaude is a bridge that connects Telegram to [Claude Code CLI](https://www.anthropic.com/claude-code), letting you interact with Claude from anywhere. Send messages from your phone and receive AI-powered responses with full access to Claude's coding capabilities.

## Features

- **Telegram Integration** - Chat with Claude from your phone via a Telegram bot
- **Local CLI Mode** - Use the terminal interface without Telegram setup
- **One-Click Windows Installer** - Double-click `install.bat` to get started
- **Interactive Setup Wizard** - Guided configuration for both modes
- **MCP Server Support** - Extensible with additional MCP servers
- **Process Management** - Built-in commands for monitoring and control
- **Cross-Platform** - Works on Windows, macOS, and Linux

## Quick Start

### Windows

1. Download or clone this repository
2. Double-click `install.bat`
3. Follow the setup wizard

### macOS / Linux

```bash
git clone https://github.com/gatordevin/teleclaude.git
cd teleclaude
npm run setup
```

The setup wizard will guide you through:
- Installing dependencies
- Choosing CLI or Telegram mode
- Configuring your Telegram bot (if selected)
- Setting up user access

## Requirements

- **Node.js 18+** - [Download](https://nodejs.org/)
- **Claude Code CLI** - The setup wizard can install this for you
- **Telegram Account** - Only needed for Telegram mode

## Usage

### NPM Scripts

| Command | Description |
|---------|-------------|
| `npm run setup` | Run the setup wizard |
| `npm start` | Start Telegram bridge mode |
| `npm run chat` | Start local CLI chat mode |
| `npm run setup-telegram` | Add Telegram to existing setup |

### Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Check if Claude is running |
| `/restart` | Restart Claude session |
| `/kill` | Stop all Claude processes |
| `/reset` | Full reset and restart |
| `/ping` | Test bridge responsiveness |

## Configuration

### Setup Wizard (Recommended)

Run `npm run setup` for an interactive configuration experience.

### Manual Configuration

Copy `config.example.json` to `config.json`:

```json
{
  "mode": "telegram",
  "telegramToken": "your-bot-token",
  "allowedUsers": [123456789],
  "workdir": "/home/user"
}
```

Or use environment variables via `.env`:

```bash
cp .env.example .env
# Edit .env with your settings
```

## Creating a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Save the API token you receive
4. Get your user ID from [@userinfobot](https://t.me/userinfobot)

## Architecture

```
+-------------+     +-------------+     +-------------+
|  Telegram   |---->|  TeleClaude |---->| Claude Code |
|    User     |<----|   Bridge    |<----|     CLI     |
+-------------+     +-------------+     +-------------+
                           |
                    +------+------+
                    | MCP Server  |
                    | (telegram-  |
                    |  bridge.js) |
                    +-------------+
```

1. Telegram bot receives your message
2. Bridge forwards it to Claude Code CLI via PTY
3. Claude processes the request
4. MCP server provides `send_to_telegram` tool
5. Responses are sent back to Telegram

## Project Structure

```
teleclaude/
├── index.js              # Main bridge application
├── setup.js              # Interactive setup wizard
├── chat.js               # Local CLI chat mode
├── setup-telegram.js     # Add Telegram to existing setup
├── install.bat           # Windows batch installer
├── install.ps1           # Windows PowerShell installer
├── lib/
│   └── platform.js       # Cross-platform utilities
├── mcp/
│   ├── telegram-bridge.js  # MCP server implementation
│   └── config.json         # MCP configuration
├── CLAUDE.md             # Instructions for Claude
├── SKILLS.md             # Workflow documentation
├── API_KEYS.md           # API key storage template
├── config.example.json   # Example configuration
└── .env.example          # Example environment variables
```

## Running as a Service

### systemd (Linux)

Create `/etc/systemd/system/teleclaude.service`:

```ini
[Unit]
Description=TeleClaude Bridge
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/teleclaude
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable teleclaude
sudo systemctl start teleclaude
```

### PM2

```bash
npm install -g pm2
pm2 start index.js --name teleclaude
pm2 save
pm2 startup
```

## Adding MCP Servers

Edit `mcp/config.json` to add additional MCP servers:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["./mcp/telegram-bridge.js"]
    },
    "browser": {
      "command": "npx",
      "args": ["@anthropic-ai/mcp-server-puppeteer"]
    }
  }
}
```

## Troubleshooting

### Claude not responding
1. Send `/status` to check if Claude is running
2. Try `/restart` to restart the session
3. Use `/reset` for a full reset

### Access denied
Your Telegram user ID is not in the allowed list. Add it to `config.json` in the `allowedUsers` array.

### Windows build errors
If you get node-pty build errors, install Windows Build Tools:
```cmd
npm install -g windows-build-tools
```

### Authentication issues
Make sure Claude Code CLI is authenticated:
```bash
claude
# Follow the login prompts
```

## Security Notes

- Never commit `config.json` (contains your bot token)
- Only authorize trusted Telegram user IDs
- The bridge runs Claude with `--dangerously-skip-permissions`
- Consider running in a sandboxed environment for untrusted use

## License

MIT

## Contributing

Contributions welcome! Please open an issue or submit a pull request.
