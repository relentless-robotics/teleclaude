# Moltbot/Clawdbot vs TeleClaude - Comprehensive Architecture Comparison

**Last Updated:** 2026-02-01

This document compares the original Moltbot (formerly Clawdbot, now OpenClaw) architecture with our current TeleClaude implementation to identify gaps, improvements, and adoption opportunities.

---

## Executive Summary

| Aspect | OpenClaw (Moltbot) | Our TeleClaude | Gap Analysis |
|--------|-------------------|----------------|--------------|
| **Maturity** | Enterprise-grade (100K+ stars) | Custom fork with extensions | We have unique features they don't |
| **Platforms** | 12+ (WhatsApp, Signal, Teams, etc.) | 2 (Discord + Telegram) | We focus on quality over quantity |
| **Session Mgmt** | WebSocket Gateway | Direct PTY/CLI | Theirs is more scalable |
| **Unique Value** | Canvas UI, Voice Wake, Apps | Cyber tools, Browser automation | Different target users |

---

## 1. Architecture Comparison

### OpenClaw/Moltbot Architecture

```
+------------------+
|  Native Apps     |  (macOS/iOS/Android/Windows)
+--------+---------+
         |
         v
+------------------+     +------------------+
| WebSocket Gateway| <-> | Message Adapters |
| ws://127.0.0.1:  |     | (12+ platforms)  |
|     18789        |     +------------------+
+--------+---------+
         |
         v
+------------------+     +------------------+
|  Claude Agent    | <-> |  MCP Ecosystem   |
|  (Multi-session) |     | (Skill plugins)  |
+------------------+     +------------------+
         |
         v
+------------------+
|  Canvas UI       |  (Visual workspace)
+------------------+
```

**Key Components:**
- Centralized WebSocket gateway for all platforms
- Native desktop/mobile apps
- Multi-agent session management
- Visual Canvas workspace
- Voice wake activation
- Docker sandbox mode
- Enterprise deployment options

### Our TeleClaude Architecture

```
+-------------+     +-------------+     +-------------+
|  Discord/   |---->|  TeleClaude |---->| Claude Code |
|  Telegram   |<----|   Bridge    |<----|     CLI     |
+-------------+     +-------------+     +-------------+
                           |
            +--------------+---------------+
            |              |               |
      +-----+----+  +------+-----+  +------+------+
      | MCP      |  | Utils      |  | Cyber       |
      | Servers  |  | (Browser,  |  | Tools       |
      | (5+)     |  | Gmail,etc) |  | (WSL/Kali)  |
      +----------+  +------------+  +-------------+
```

**Key Components:**
- Direct PTY bridge to Claude Code CLI
- Dual platform support (Discord + Telegram)
- 5 custom MCP servers (discord, telegram, cyber, media, memory)
- Extensive utility library (35+ modules)
- WSL2 Kali Linux integration
- Browser automation with state persistence
- CAPTCHA handling infrastructure

---

## 2. Feature-by-Feature Comparison

### Core Messaging

| Feature | OpenClaw | TeleClaude | Notes |
|---------|----------|------------|-------|
| Discord | ✅ | ✅ | Both support |
| Telegram | ✅ | ✅ | Both support |
| WhatsApp | ✅ | ❌ | Could add via API |
| Slack | ✅ | ❌ | Easy to add |
| Signal | ✅ | ❌ | Privacy-focused |
| iMessage | ✅ | ❌ | macOS only |
| Teams | ✅ | ❌ | Enterprise |
| Matrix | ✅ | ❌ | Open protocol |
| SMS | ✅ | ❌ | Via Twilio |
| Email | ✅ | ⚠️ Partial | Gmail API ready |
| Image Support | ✅ | ✅ | Both support |
| File Upload | ✅ 50MB | ⚠️ Via Telegram | Need Discord impl |
| Multi-user | ✅ | ✅ | Whitelist based |

### Session Management

| Feature | OpenClaw | TeleClaude | Notes |
|---------|----------|------------|-------|
| Multi-session agents | ✅ | ❌ | Single session per platform |
| Session persistence | ✅ | ⚠️ Partial | Claude handles this |
| Session switching | ✅ | ❌ | Could implement |
| Background agents | ✅ | ✅ | Via Task tool |
| Session isolation | ✅ Docker | ❌ | Runs in same context |

### Browser & Automation

| Feature | OpenClaw | TeleClaude | Notes |
|---------|----------|------------|-------|
| Browser control | ✅ | ✅ | We have Playwright |
| Auth state persistence | ❌ Unknown | ✅ | We save cookies |
| Multi-profile auth | ❌ Unknown | ✅ | browser_profiles.js |
| CAPTCHA detection | ❌ Unknown | ✅ | captcha_handler.js |
| CAPTCHA solving | ❌ Unknown | ✅ | With user assistance |
| Human-like typing | ❌ Unknown | ✅ | Stealth features |

### Security & Cyber Tools

| Feature | OpenClaw | TeleClaude | Notes |
|---------|----------|------------|-------|
| WSL2 Integration | ❌ | ✅ | Full Kali Linux |
| Network scanning | ❌ | ✅ | nmap, masscan |
| Web security testing | ❌ | ✅ | nikto, gobuster |
| Reverse engineering | ❌ | ✅ | Ghidra bridge |
| Sysinternals | ❌ | ✅ | 70+ Windows tools |
| Docker containers | ✅ Sandbox | ✅ | WSL2 Docker |
| Password management | ❌ | ✅ | KeePass integration |
| Credential storage | ❌ | ✅ | Encrypted backup |

### AI & Media

| Feature | OpenClaw | TeleClaude | Notes |
|---------|----------|------------|-------|
| Image generation | ❌ Unknown | ✅ | DALL-E 3 |
| Text-to-speech | ❌ Unknown | ✅ | OpenAI TTS |
| Image analysis | ✅ | ✅ | Claude multimodal |
| Cursor CLI | ❌ | ✅ | Parallel AI coding |
| Voice wake | ✅ | ❌ | They have this |
| Canvas workspace | ✅ | ❌ | Visual dev UI |

### Infrastructure

| Feature | OpenClaw | TeleClaude | Notes |
|---------|----------|------------|-------|
| Native apps | ✅ All platforms | ❌ | CLI only |
| Web dashboard | ✅ | ✅ | Vercel deployed |
| Memory system | ❌ Unknown | ✅ | MCP memory server |
| GitHub CLI | ❌ Unknown | ✅ | Integrated |
| Gmail API | ❌ Unknown | ⚠️ Ready | Scripts complete |
| Logging system | ✅ | ✅ | Both comprehensive |

---

## 3. MCP Servers Comparison

### OpenClaw MCP Ecosystem
- Extensive skill plugin system
- Community-contributed skills
- Skill marketplace
- Enterprise skill management

### Our MCP Servers

| Server | File | Purpose |
|--------|------|---------|
| `telegram-bridge.js` | mcp/ | Telegram messaging |
| `discord-bridge.js` | mcp/ | Discord messaging |
| `cyber-tools.js` | mcp/ | Security tools |
| `media-tools.js` | mcp/ | Image gen, TTS |
| `memory-server.js` | mcp/ | Persistent memory |

### Gap: Skill Plugin System
OpenClaw has a modular skill system that allows:
- Easy skill installation
- Skill versioning
- Skill marketplace
- Hot reloading

**Recommendation:** Consider implementing a similar plugin architecture.

---

## 4. Unique TeleClaude Advantages

### Features OpenClaw Doesn't Have

1. **Cybersecurity Suite**
   - WSL2 Kali Linux integration
   - Ghidra reverse engineering
   - Sysinternals integration
   - Network scanning tools
   - Web security testing

2. **Browser Automation**
   - Persistent auth state
   - Multi-profile management
   - CAPTCHA handling
   - Human-like behavior simulation

3. **Developer Tools**
   - Cursor CLI integration
   - GitHub CLI wrapper
   - Gmail API automation
   - OAuth setup automation

4. **Security Features**
   - KeePass integration
   - Encrypted credential backup
   - Account management system
   - API key tracking

5. **Memory System**
   - Priority-based memories (URGENT/DAILY/WEEKLY/ARCHIVE)
   - Tag-based search
   - Expiration dates
   - Persistent across sessions

---

## 5. Recommended Adoptions from OpenClaw/Other Projects

### High Priority

| Feature | Source | Effort | Value |
|---------|--------|--------|-------|
| File upload/download | zertac/TeleClaude | Medium | High |
| Directory commands (/cd, /pwd) | zertac/TeleClaude | Low | Medium |
| Multi-session per channel | yamkz/claude-discord-bridge | Medium | High |
| Stop hook for response capture | hanxiao/claudecode-telegram | Low | Medium |

### Medium Priority

| Feature | Source | Effort | Value |
|---------|--------|--------|-------|
| WebSocket gateway | OpenClaw | High | High |
| Canvas workspace | OpenClaw | High | Medium |
| Voice wake activation | OpenClaw | Medium | Low |
| MCP orchestration | InstruktAI/TeleClaude | Medium | High |

### Low Priority (Nice to Have)

| Feature | Source | Effort | Value |
|---------|--------|--------|-------|
| WhatsApp support | OpenClaw | Medium | Medium |
| Native apps | OpenClaw | Very High | Medium |
| Skill marketplace | OpenClaw | High | Medium |

---

## 6. Implementation Roadmap

### Phase 1: Quick Wins (1-2 days each)
- [x] Add `/cd` and `/pwd` commands ✅ Implemented 2026-02-01
- [x] Implement file download via `/getfile` ✅ Implemented 2026-02-01
- [ ] Add stop hook mechanism for better response capture
- [x] Implement multi-image handling ✅ Implemented 2026-02-01

### Phase 2: Medium Effort (1 week each)
- [ ] Multi-session support per Discord channel
- [ ] WebSocket-based architecture for better scaling
- [ ] Skill/plugin system

### Phase 3: Major Features (2+ weeks each)
- [ ] Canvas-like visual workspace
- [ ] MCP orchestration across multiple machines
- [ ] Additional platform adapters (Slack, Matrix)

---

## 7. Conclusion

### Our Strengths
- **Cybersecurity focus** - Unique in the Claude bot ecosystem
- **Browser automation** - Most advanced auth handling
- **Developer integration** - Cursor, GitHub CLI, Gmail API
- **Security** - KeePass, encrypted credentials

### Their Strengths
- **Scale** - 12+ platforms, native apps
- **Enterprise** - WebSocket gateway, Docker sandboxing
- **UX** - Canvas workspace, Voice wake
- **Community** - Skill marketplace, 100K+ users

### Strategic Direction
Continue leveraging our cybersecurity and developer tool strengths while selectively adopting quality-of-life features from OpenClaw that align with our use case.

---

## References

- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- [Moltbot GitHub](https://github.com/moltbot/moltbot)
- [zertac/TeleClaude](https://github.com/zertac/TeleClaude)
- [InstruktAI/TeleClaude](https://github.com/InstruktAI/TeleClaude)
- [hanxiao/claudecode-telegram](https://github.com/hanxiao/claudecode-telegram)
- [yamkz/claude-discord-bridge](https://github.com/yamkz/claude-discord-bridge)
