# Atrex AI

**Autonomous Task Runner & Execution AI** — a personal AI agent that lives in Telegram. Powered by Claude (or NVIDIA NIM / OpenAI), with a personality, long-term memory, scheduled tasks, sub-agents, a web admin dashboard, and a self-serve plugin system.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Jonas1220/atrex-ai/main/install.sh | bash
```

Requires Node.js ≥ 20. After install, run `atrex setup` to open the onboarding wizard.

---

## Quick Start (development)

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — the setup wizard runs automatically if credentials are missing.

---

## Onboarding Wizard

The wizard walks through two steps:

**Step 1 — Core Credentials**

| Field | Required | Description |
|---|---|---|
| Telegram Bot Token | Yes | From [@BotFather](https://t.me/BotFather) — `/newbot` → copy the token |
| AI Provider | Yes | Choose Anthropic, NVIDIA, or OpenAI and enter the corresponding API key |
| Your Telegram User ID | Recommended | Restricts access to your account only. Get it from [@userinfobot](https://t.me/userinfobot) |

**Step 2 — Connect Services (optional)**

All integrations are optional and can be added later from the dashboard.

| Integration | What it does |
|---|---|
| Google | Gmail, Calendar, Drive |
| Notion | Pages and databases |
| Todoist | Tasks and projects |
| Brave Search | Web search |
| OpenAI Voice | Whisper voice transcription |

After saving core credentials, the wizard restarts the agent automatically and opens the dashboard.

---

## AI Providers

Atrex supports three providers, switchable without restart from **Settings** in the dashboard.

| Provider | Models | Notes |
|---|---|---|
| **Anthropic** | Claude Haiku / Sonnet / Opus | Default. API key from [console.anthropic.com](https://console.anthropic.com/) |
| **NVIDIA NIM** | Llama 4 Maverick, Nemotron, and others | Free tier available. API key from [build.nvidia.com](https://build.nvidia.com) |
| **OpenAI** | GPT-4o, o3, o4-mini | OAuth — connect your ChatGPT account, no API key needed |

Model lists are fetched live from each provider's API so they stay current.

---

## Web Admin Dashboard

| Page | Description |
|---|---|
| **Dashboard** | Live status: model, active integrations, uptime |
| **Skills** | Manage skills — create, edit focus instructions, set active, delete |
| **Agents** | Manage sub-agent roles — configure model and provider per role |
| **Soul** | Edit `soul.md` — personality, tone, and behavior rules |
| **User Profile** | Edit `user.md` — your profile, auto-updated by the agent |
| **Memory** | View and edit long-term memory |
| **Integrations** | Manage connected services — connect/disconnect, toggle on/off |
| **Heartbeat** | Timed reminders and recurring tasks |
| **Secrets** | View stored API keys (values never shown) |
| **Settings** | Provider / model selection, raw `settings.json` editor |
| **Logs** | Browse daily log files |

The dashboard requires an admin token. On first run, one is generated automatically and printed to the terminal. Run `atrex token` at any time to display it again.

---

## How It Works

### Identity

The agent's personality and behavior are defined in markdown files under `config/`:

| File | Purpose |
|---|---|
| `config/soul.md` | Personality, tone, behavior rules. Agent can rewrite this itself. |
| `config/identity.md` | Agent name and core identity. |
| `config/agents.md` | Sub-agent session rules and routing table. |
| `config/tools.md` | Reference for connected services and tool notes. |
| `config/user.md` | Your profile — auto-updated as the agent learns about you. |

### Memory

The agent keeps only long-term memory across sessions.

| File | Purpose |
|---|---|
| `memory/memory.md` | Long-term facts, preferences, decisions |
| `memory/skills/<id>.md` | Per-skill memory |

### Sub-agents

The agent can spawn specialized sub-agents for focused tasks. Each sub-agent is configured in `agents/<role>.md` with a model and provider:

```markdown
---
model: codex-mini-latest
provider: openai
---
You are a coding agent. Use run_codex to execute coding tasks.
```

Available roles out of the box: `coder` (Codex CLI), `researcher` (Claude Sonnet).

### Skills

Skills are specialized modes with their own focus instructions and memory. The agent activates them automatically based on context, or you can force one with `/skill <name>`.

### Plugins

The agent can write its own plugins at runtime. Tell it to create a new tool and it will write the plugin code, compile it, and hot-load it — no restart needed.

---

## Telegram Commands

| Command | Description |
|---|---|
| `/skills` | List all skills |
| `/skill` | Show the currently active skill |
| `/skill <name>` | Force-activate a skill |
| `/btw <question>` | One-shot isolated query — no history read or write |
| `/clear` | Reset conversation history |
| `/plugins` | Show installed plugins and stored keys |
| `/schedules` | List active scheduled tasks |
| `/purgelogs` | Delete log files older than yesterday |
| `/debug` | Toggle live log forwarding to this chat |
| `/help` | Show available commands |

---

## CLI

After installing via `install.sh`, the `atrex` command is available globally.

| Command | Description |
|---|---|
| `atrex start` | Start the agent in the background (PM2 if available) |
| `atrex stop` | Stop the running agent |
| `atrex restart` | Restart the agent |
| `atrex status` | Show running status, uptime, PID, and dashboard URL |
| `atrex logs` | Tail live log output |
| `atrex update` | Pull latest, reinstall, rebuild, and restart |
| `atrex open` | Open the web dashboard in your browser |
| `atrex setup` | Start the agent and open the onboarding wizard |
| `atrex token` | Display the web dashboard admin token |
| `atrex help` | Show available commands |

---

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key (*or NVIDIA/OpenAI) |
| `NVIDIA_API_KEY` | Yes* | NVIDIA NIM API key (*if using NVIDIA) |
| `ALLOWED_USER_IDS` | Recommended | Comma-separated Telegram user IDs. Empty = open access. |
| `WEB_ADMIN_PORT` | No | Dashboard port (default: `3000`) |
| `WEB_ADMIN_TOKEN` | Auto | Generated on first run. Run `atrex token` to display it. |

### `config/settings.json`

| Setting | Description |
|---|---|
| `model` | Active model |
| `provider` | Active provider (`anthropic`, `nvidia`, `openai`) |
| `max_tokens` | Maximum tokens per response |
| `max_history` | Messages kept in conversation context |
| `timezone` | Timezone for scheduled tasks and heartbeat |
| `quiet_hours_start` | Hour (0–23) when the heartbeat goes silent |
| `quiet_hours_end` | Hour (0–23) when the heartbeat resumes |

---

## Project Structure

```
atrexai/
├── src/
│   ├── index.ts              # Entry point — setup mode if credentials missing
│   ├── config.ts             # Env + settings parsing, system prompt builder
│   ├── agent/
│   │   ├── agent.ts          # Conversation loop with tool use
│   │   ├── providers/        # Anthropic / OpenAI / NVIDIA provider adapters
│   │   └── tools/            # Built-in tools (memory, files, shell, etc.)
│   ├── bot/
│   │   └── handlers.ts       # Telegram command & message handlers
│   ├── plugins/              # Plugin loader, registry, secrets
│   ├── scheduler/            # Cron runner and heartbeat pulse
│   └── web/
│       ├── server.ts         # Express admin API + setup endpoints
│       └── public/index.html # Admin SPA (dashboard + onboarding wizard)
├── agents/                   # Sub-agent persona files (role.md)
├── plugins/                  # Plugin source files
├── config/                   # Runtime config (gitignored except templates)
│   ├── settings.json
│   ├── soul.md / soul.initial.md
│   ├── identity.md / identity.initial.md
│   ├── agents.md / agents.initial.md
│   └── tools.md / tools.initial.md
├── memory/                   # Memory files (gitignored)
└── logs/                     # Daily log files (gitignored)
```

---

## Security

- `ALLOWED_USER_IDS` restricts who can message the bot — leave empty only for private deployments
- `WEB_ADMIN_TOKEN` is always enforced — run `atrex token` to display it
- All API keys live in `.env` and `config/secrets.json`, both gitignored
- Plugins run in the same Node.js process — review generated plugin code before enabling
