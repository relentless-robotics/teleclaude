# TeleClaude (Enhanced)

Control Claude Code CLI from your phone via **Telegram** or **Discord**, or chat locally in your terminal.

This is an enhanced fork of [gatordevin/teleclaude](https://github.com/gatordevin/teleclaude) with significant additions:

## What's New in This Fork

- **Discord Integration** - Full Discord support alongside Telegram
- **Persistent Memory System** - SQLite + Chroma vector database with semantic search
- **Model Routing** - Automatic model selection (Claude Opus/Sonnet/Haiku + Kimi K2.5)
- **Browser Automation** - Unified browser module with stealth, auth state management
- **GitHub CLI Integration** - Full GitHub workflow support
- **Image Generation** - DALL-E 3 integration
- **Text-to-Speech** - OpenAI TTS with multiple voices
- **Cybersecurity Tools** - WSL2 Kali integration for security testing
- **CAPTCHA Handling** - Multi-provider CAPTCHA detection and solving

## Features

- **Multi-Platform Messaging** - Telegram and Discord support
- **Semantic Memory** - Vector-based search finds related memories by concept
- **Background Agents** - Non-blocking task execution with progress updates
- **Smart Model Routing** - Cost optimization across Claude and Kimi models
- **Persistent Auth** - Browser session management for automated logins
- **Comprehensive Logging** - Debug logs for all components
- **MCP Server Support** - Extensible architecture

## Quick Start

### Prerequisites

- **Node.js 18+** - [Download](https://nodejs.org/)
- **Claude Code CLI** - [Installation](https://www.anthropic.com/claude-code)

### Installation

```bash
git clone https://github.com/relentless-robotics/teleclaude.git
cd teleclaude
npm install
```

### Configuration

1. **Copy templates:**
```bash
cp .mcp.template.json .mcp.json
cp API_KEYS.template.md API_KEYS.md
cp utils/gh_auth.template.js utils/gh_auth.js
```

2. **Edit `.mcp.json`** - Update paths to your installation directory

3. **Edit `API_KEYS.md`** - Add your API keys (OpenAI, etc.)

4. **Create `config.json`:**
```json
{
  "mode": "discord",
  "discordToken": "your-bot-token",
  "allowedUsers": ["your-discord-user-id"]
}
```

### Running

```bash
# Discord mode
npm start

# Local CLI mode
npm run chat
```

## Architecture

```
+-------------+     +-------------+     +-------------+
|  Discord/   |---->|  TeleClaude |---->| Claude Code |
|  Telegram   |<----|   Bridge    |<----|     CLI     |
+-------------+     +-------------+     +-------------+
                           |
              +------------+------------+
              |                         |
       +------+------+          +-------+-------+
       | MCP Servers |          | Memory System |
       | - discord   |          | - SQLite      |
       | - memory    |          | - Chroma      |
       +-------------+          +---------------+
```

## Memory System

The enhanced memory system uses SQLite for structured storage and Chroma for vector embeddings:

```javascript
// Store a memory
remember("Important task completed", "DAILY", ["project", "milestone"]);

// Semantic search - finds related concepts!
recall("code repository");  // Finds memories about "github", "git", etc.

// Check pending items
check_pending();  // Returns URGENT and DAILY priority items
```

**Priority Levels:**
- `URGENT` - Check every conversation
- `DAILY` - Check once per day
- `WEEKLY` - Check weekly
- `ARCHIVE` - Long-term storage

## Project Structure

```
teleclaude/
├── index.js                 # Main bridge application
├── CLAUDE.md                # Instructions for Claude (comprehensive)
├── lib/
│   ├── discord.js           # Discord integration
│   ├── chroma-engine.js     # Vector database engine
│   ├── sqlite-engine.js     # SQLite storage engine
│   ├── embedding-service.js # Local embeddings
│   └── query-fusion.js      # Hybrid search fusion
├── mcp/
│   ├── discord-bridge.js    # Discord MCP server
│   ├── memory-server-v4.js  # Memory MCP server
│   └── telegram-bridge.js   # Telegram MCP server
├── utils/
│   ├── browser.js           # Unified browser automation
│   ├── kimi_client.js       # Kimi K2.5 integration
│   ├── model_router.js      # Smart model selection
│   └── gh_auth.template.js  # GitHub auth template
├── scripts/
│   ├── migrate-to-v4.js     # Migration script
│   └── rollback-to-v3.js    # Rollback script
├── memory/                  # Memory storage (gitignored)
├── logs/                    # Log files (gitignored)
├── secure/                  # Credentials (gitignored)
└── browser_state/           # Auth sessions (gitignored)
```

## Sensitive Files

These files contain credentials and are **gitignored**:

| File | Purpose | Template |
|------|---------|----------|
| `.mcp.json` | MCP server config | `.mcp.template.json` |
| `API_KEYS.md` | API keys | `API_KEYS.template.md` |
| `utils/gh_auth.js` | GitHub PAT | `utils/gh_auth.template.js` |
| `config.json` | Bot tokens | `config.example.json` |
| `memory/` | Personal memories | - |
| `secure/` | Credentials | - |
| `browser_state/` | Login sessions | - |

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create New Application
3. Go to Bot → Add Bot
4. Enable "Message Content Intent"
5. Copy the bot token to `config.json`
6. Invite bot with OAuth2 URL Generator (scopes: bot, applications.commands)

## Model Routing

The system can automatically choose the best model:

```javascript
const { route } = require('./utils/model_router');

// Automatic selection based on task
const result = await route('Generate a React component');

// With preferences
const result = await route('Task', { preferCost: true });
```

| Model | Best For | Cost |
|-------|----------|------|
| Haiku | File searches, simple lookups | $ |
| Sonnet | Browser automation, code analysis | $$ |
| Opus | Complex reasoning, architecture | $$$ |
| Kimi K2.5 | Frontend code, bulk coding | $ |

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## Upstream

This is a fork of [gatordevin/teleclaude](https://github.com/gatordevin/teleclaude).
Watch upstream for updates.

## License

MIT
