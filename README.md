# TeleClaude

Control Claude Code CLI from your phone via Telegram, or chat locally in your terminal.

TeleClaude is a bridge that connects Telegram to [Claude Code CLI](https://www.anthropic.com/claude-code), letting you interact with Claude from anywhere. Send messages from your phone and receive AI-powered responses with full access to Claude's coding capabilities.

## Features

- **Telegram Integration** - Chat with Claude from your phone via a Telegram bot
- **Local CLI Mode** - Use the terminal interface without Telegram setup
- **Image Support** - Send images to Claude via Telegram for visual analysis
- **Comprehensive Logging** - Debug logs for bridge, Claude, MCP, and agent activity
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

### API Keys Setup

If you need to store API keys for various services:

```bash
# Run the setup script (creates API_KEYS.md from template)
./setup.sh

# Or manually copy the template
cp API_KEYS.template.md API_KEYS.md

# Edit API_KEYS.md and fill in your actual keys
# This file is gitignored and won't be committed
```

The template includes placeholders and instructions for:
- OpenAI, Anthropic, Google AI, xAI APIs
- Cloudflare, Stripe, Resend
- Twitter/X, Alpaca Trading, Gumroad
- Google Calendar/Gmail OAuth
- Telegram Bot tokens

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
| `/status` | Check if Claude is running + view log files |
| `/restart` | Restart Claude session |
| `/kill` | Stop all Claude processes |
| `/reset` | Full reset and restart |
| `/ping` | Test bridge responsiveness |
| `/logs` | Show recent bridge logs |
| `/logs [category]` | Show logs for specific category (bridge, claude, mcp, agent, system) |
| `/logs [category] [lines]` | Show specific number of log lines |

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
│   ├── platform.js       # Cross-platform utilities
│   └── logger.js         # Comprehensive logging system
├── mcp/
│   ├── telegram-bridge.js  # MCP server implementation (with logging)
│   └── config.json         # MCP configuration
├── logs/                 # Log files (created automatically)
│   ├── bridge-YYYY-MM-DD.log   # Bridge activity logs
│   ├── claude-YYYY-MM-DD.log   # Claude PTY output logs
│   ├── mcp-YYYY-MM-DD.log      # MCP tool call logs
│   ├── agent-YYYY-MM-DD.log    # Background agent logs
│   └── system-YYYY-MM-DD.log   # System event logs
├── images/               # Downloaded Telegram images (created automatically)
├── CLAUDE.md             # Instructions for Claude
├── SKILLS.md             # Workflow documentation
├── API_KEYS.md           # Your API keys (gitignored, create from template)
├── API_KEYS.template.md  # API keys template with placeholders
├── config.example.json   # Example configuration
└── .env.example          # Example environment variables
```

## Image Support

Send images to Claude via Telegram for visual analysis:

1. **Send as Photo** - Compress and send via Telegram's photo feature
2. **Send as File** - Send original quality as document

Images are automatically:
- Downloaded to the `images/` directory
- Passed to Claude with the file path
- Accessible via Claude's Read tool for multimodal analysis

Supported formats: JPG, PNG, GIF, WebP, and other common image formats.

## Logging System

The bridge includes comprehensive logging for debugging:

### Log Categories

| Category | Description |
|----------|-------------|
| `bridge` | User messages, Telegram sends, authorization |
| `claude` | Claude PTY input/output, process lifecycle |
| `mcp` | MCP tool calls (send_to_telegram) |
| `agent` | Background agent spawning and completion |
| `system` | Process lifecycle, errors, crashes |

### Viewing Logs

**Via Telegram:**
```
/logs              # Show recent bridge logs
/logs claude       # Show Claude PTY logs
/logs mcp 50       # Show 50 lines of MCP logs
/status            # Shows log file sizes
```

**Via Terminal:**
```bash
# View today's bridge logs
cat logs/bridge-$(date +%Y-%m-%d).log

# Follow logs in real-time
tail -f logs/bridge-*.log
```

### Log Format

```
[2024-01-15T10:30:45.123Z] [INFO] USER_MESSAGE received
  DATA: {
    "userId": 123456789,
    "chatId": 123456789,
    "message": "Hello Claude!",
    "messageLength": 13
  }
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

### Windows-Specific Issues

#### node-pty build errors
If you get node-pty build errors, install Windows Build Tools:
```cmd
npm install -g windows-build-tools
```

Or install Visual Studio Build Tools manually:
1. Download [Build Tools for Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. Install "Desktop development with C++" workload
3. Restart your terminal and try `npm install` again

#### Path issues on Windows
- The bridge uses forward slashes internally but normalizes paths for Windows
- If you see path errors, ensure your working directory uses valid Windows paths
- Environment variables like `%USERPROFILE%` are supported

#### Process termination on Windows
- Use `Ctrl+C` to gracefully stop the bridge
- If Claude processes hang, use the `/kill` command or Task Manager
- The `pkill` commands shown in logs only apply to Unix systems

### Authentication issues
Make sure Claude Code CLI is authenticated:
```bash
claude
# Follow the login prompts
```

## Cross-Platform Notes

TeleClaude is designed to work on Windows, macOS, and Linux with the same codebase:

| Feature | Windows | macOS/Linux |
|---------|---------|-------------|
| Installation | `install.bat` or `install.ps1` | `npm run setup` |
| Terminal | Command Prompt, PowerShell, or Windows Terminal | bash, zsh, etc. |
| Home Directory | `%USERPROFILE%` | `$HOME` |
| Temp Files | `%TEMP%\tg-response.txt` | `/tmp/tg-response.txt` |
| Process Signals | Limited SIGINT support | Full signal support |
| Path Separators | Handled automatically | Handled automatically |

### Windows-Specific Installation Methods

**Option 1: Batch File (Recommended)**
```cmd
:: Double-click install.bat or run:
install.bat
```

**Option 2: PowerShell**
```powershell
# Right-click install.ps1 -> Run with PowerShell
# Or run in terminal:
powershell -ExecutionPolicy Bypass -File install.ps1
```

**Option 3: Manual npm**
```cmd
npm install
npm run setup
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
