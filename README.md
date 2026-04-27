# Atrex AI

**Autonomous Task Runner & Execution AI** — a personal AI agent that lives in Telegram. Powered by Claude, with a personality, memory, scheduled tasks, a web admin dashboard, and a self-serve plugin system.

## Quick Start

### Prerequisites

- Node.js >= 20
- A Telegram bot token — create one via [@BotFather](https://t.me/BotFather) on Telegram
- An Anthropic API key — get one at [console.anthropic.com](https://console.anthropic.com/)

### 1. Install dependencies

```bash
npm install
```

### 2. Start the server

```bash
npm run dev
```

On first run, the bot won't start yet — it opens in **setup mode** and waits for you to complete onboarding.

### 3. Complete onboarding

Open [http://localhost:3000](http://localhost:3000) in your browser. The setup wizard walks you through four steps:

---

#### Step 1 — Welcome

Introduction screen. Click **Get started**.

---

#### Step 2 — Core Credentials

| Field | Required | Description |
|---|---|---|
| Telegram Bot Token | Yes | From [@BotFather](https://t.me/BotFather) — `/newbot` → copy the token |
| Anthropic API Key | Yes | From [console.anthropic.com](https://console.anthropic.com/) → API Keys |
| Your Telegram User ID | Recommended | Restricts access to your account. Get it from [@userinfobot](https://t.me/userinfobot) |

Click **Save & Continue**. Credentials are written to `.env` immediately.

---

#### Step 3 — Connect Services

All integrations are optional. Expand any section to enter an API key. You can skip this step and configure integrations later from the dashboard.

| Integration | Keys needed | Where to get them |
|---|---|---|
| **Google** (Gmail, Calendar, Drive) | Client ID + Client Secret | [console.cloud.google.com](https://console.cloud.google.com/) → APIs & Services → Credentials → OAuth 2.0 |
| **Notion** (Pages, Databases) | API Key | [notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration |
| **Todoist** (Tasks, Projects) | API Key | todoist.com → Settings → Integrations → Developer |
| **Brave Search** | API Key | [api.search.brave.com](https://api.search.brave.com/app/keys) |
| **OpenAI Whisper** (voice transcription) | API Key | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

Click **Finish Setup** (or **Skip** to configure later).

---

#### Step 4 — Done

A summary of what was saved. If core credentials were written, you'll see a restart prompt.

---

### 4. Restart the agent

After saving credentials, restart to apply them:

```bash
# Stop the current process (Ctrl+C), then:
npm run dev
```

You should see `Atrexai online.` in the terminal. Open your bot in Telegram and send it a message.

---

## Web Admin Dashboard

The dashboard runs at [http://localhost:3000](http://localhost:3000) (localhost only — never exposed publicly).

| Page | Description |
|---|---|
| **Dashboard** | Live status: model, active integrations, schedule count, uptime |
| **Skills** | Manage skills — create, edit focus instructions, set active (manual override), delete |
| **Soul** | Edit `soul.md` — the agent's personality, tone, and behavior rules |
| **User Profile** | Edit `user.md` — your profile, auto-updated by the agent as it learns about you |
| **Memory** | View and edit long-term memory (`memory.md`) and daily short-term memory files |
| **Integrations** | Manage all connected services — connect/disconnect, view status, toggle on/off |
| **Schedules** | View and delete scheduled tasks |
| **Secrets** | View which API keys are stored (values never shown) |
| **Settings** | Edit `settings.json` — model, token limits, timezone |
| **Logs** | Browse daily log files with color-coded output |

The dashboard always requires the admin token. On first run, one is generated automatically and printed to the terminal. Run `atrex token` at any time to display it again.

---

## How It Works

### Identity

The agent's personality and behavior are defined in two markdown files:

| File | Purpose |
|---|---|
| `config/soul.md` | Personality, tone, communication rules. The agent can rewrite this itself when asked. |
| `config/user.md` | Your profile — name, job, projects, habits. Auto-updated as the agent learns about you. |

Both files can be edited directly in the dashboard under **Soul** and **User Profile**.

### Memory

The agent has no persistent conversation history — when it restarts, the chat context is gone. Memory is how it retains information across sessions.

| Type | File | In context | Purpose |
|---|---|---|---|
| Long-term | `memory/memory.md` | Always | Preferences, decisions, key facts |
| Short-term | `memory/YYYY-MM-DD.md` | Today + yesterday | Daily notes, what happened, temporary context |

The agent saves memories automatically during conversations. Short-term files accumulate over time and can be browsed in the dashboard.

### Skills

Skills are specialized modes the agent can activate automatically. Each skill has a name, description, and focus instructions — when a message matches a skill's domain, the agent calls `use_skill` to load the skill's instructions and memory before responding.

For example: if you create a "Web Developer" skill focused on HTML/CSS/JS, the agent will automatically activate it when you ask about building a website.

**How it works:**

1. You define a skill with a name, description, and focus instructions in the dashboard or via Telegram.
2. Every message includes a list of available skills in the system prompt.
3. When the agent detects a match, it calls `use_skill` which loads the skill's instructions + skill-specific memory.
4. The skill stays active for subsequent messages until a different one is more relevant.

**Manage from the dashboard:** Skills → create, edit focus instructions, set active (manual override), delete.

**Manage from Telegram:**

| Command | Description |
|---|---|
| `/skills` | List all available skills |
| `/skill` | Show the currently active skill |
| `/skill <name>` | Manually force-activate a skill |

**Memory:** Each skill has its own long-term memory file (`memory/skills/<id>.md`). The agent saves skill-specific facts using the `skill` memory type (e.g. workout logs in a Personal Trainer skill).

---

### Integrations

Built-in integrations are managed from the **Integrations** page in the dashboard. API keys are stored in `config/secrets.json` (gitignored).

| Integration | Capabilities |
|---|---|
| Google | Read/send Gmail, manage Calendar events, browse Drive |
| Notion | Search, read, create, and update pages and databases |
| Todoist | Manage tasks, projects, and labels |
| Brave Search | Web search |
| OpenAI Whisper | Transcribe voice messages sent in Telegram (~$0.006/min) |

#### Setting up Google OAuth

Google requires an OAuth 2.0 client ID and secret. The dashboard handles the full flow, including on remote/VPS setups.

**1. Create OAuth credentials**

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Under **Authorized redirect URIs**, add: `http://localhost:3000/auth/google/callback`
5. Click **Create** → copy the **Client ID** and **Client Secret**

**2. Store the credentials**

Enter the Client ID and Client Secret during the onboarding wizard (Step 3 — Connect Services), or add them later via the Integrations page → **Set key**.

**3. Connect your Google account**

Go to **Integrations** → click **Connect** next to Google. A modal appears with two steps:

- **Step 1** — Copy or open the OAuth URL and sign in with your Google account in your browser.
- **Step 2** — After Google redirects to `localhost:3000/auth/google/callback`, copy the **full URL** from your browser's address bar (even if the page shows an error — this is expected on a VPS) and paste it into the modal. Click **Complete Connection**.

> **`redirect_uri_mismatch` error?** The redirect URI `http://localhost:3000/auth/google/callback` is not in your Google Cloud Console. Go to your OAuth 2.0 Client ID → **Authorized redirect URIs** → add `http://localhost:3000/auth/google/callback` → Save. Wait a minute, then try again.

### Voice Messages

If `OPENAI_API_KEY` is configured, the agent automatically transcribes Telegram voice notes using Whisper and processes them as regular text.

### Plugins

The agent can create its own tool plugins at runtime. Tell it "I want a Hacker News tool" and it will:

1. Write the plugin code (`plugins/<name>/index.ts`)
2. Compile it with esbuild
3. Hot-load it — no restart needed

Each plugin lives in `plugins/<name>/index.ts` and exports a setup function:

```typescript
interface PluginContext {
  getSecret: (key: string) => string | null;
}

export default function setup(ctx: PluginContext) {
  return {
    tools: [
      {
        name: "pluginname_action",
        description: "What this tool does",
        input_schema: {
          type: "object" as const,
          properties: {
            param: { type: "string", description: "..." },
          },
          required: ["param"],
        },
      },
    ],
    handlers: {
      pluginname_action: async (input: Record<string, unknown>) => {
        return "result string";
      },
    },
  };
}
```

### Scheduling

The agent supports cron-based scheduled tasks. Two types:

- **Message** — sends a static text at a scheduled time (reminders, daily check-ins)
- **Prompt** — runs a prompt through Claude at a scheduled time and sends the response (briefings, summaries)

All times use the timezone from `config/settings.json`. Manage schedules in the dashboard or via Telegram.

### Telegram Commands

| Command | Description |
|---|---|
| `/skills` | List all skills |
| `/skill` | Show the currently active skill |
| `/skill <name>` | Manually activate a skill (clears conversation history) |
| `/btw <question>` | One-shot isolated query — no history read or write |
| `/clear` | Reset conversation history and escalation state |
| `/plugins` | Show installed plugins and stored secret keys |
| `/schedules` | List active scheduled tasks |
| `/purgelogs` | Delete log files older than yesterday |
| `/debug` | Toggle live log forwarding to this chat |
| `/help` | Show available commands |

---

## Configuration

### Environment Variables (`.env`)

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `ALLOWED_USER_IDS` | Recommended | Comma-separated Telegram user IDs. Empty = open access. |
| `WEB_ADMIN_PORT` | No | Dashboard port (default: `3000`) |
| `WEB_ADMIN_TOKEN` | Auto | Generated on first run. Run `atrex token` to display it. |

These are set during onboarding or by editing `.env` manually.

### `config/settings.json`

```json
{
  "model": "claude-haiku-4-5-20251001",
  "subagent_model": "claude-haiku-4-5-20251001",
  "escalation_model": "claude-sonnet-4-6",
  "ask_for_escalation": true,
  "max_tokens": 4096,
  "max_history": 50,
  "timezone": "UTC",
  "quiet_hours_start": 23,
  "quiet_hours_end": 7
}
```

| Setting | Description |
|---|---|
| `model` | Claude model for conversations |
| `subagent_model` | Claude model for background sub-agent tasks |
| `escalation_model` | Stronger model to switch to when the agent requests more power |
| `ask_for_escalation` | When `true`, the agent can ask permission to switch to `escalation_model` via inline buttons |
| `max_tokens` | Maximum tokens per Claude response |
| `max_history` | Messages kept in conversation context (50 = 25 turns) |
| `timezone` | Timezone for scheduled tasks, heartbeat, and log timestamps |
| `quiet_hours_start` | Hour (0–23) when the heartbeat goes silent. Set equal to `quiet_hours_end` to disable. |
| `quiet_hours_end` | Hour (0–23) when the heartbeat resumes |

Changes take effect after restarting the agent.

---

## Project Structure

```
atrexai/
├── src/
│   ├── index.ts              # Entry point — setup mode if credentials missing
│   ├── config.ts             # Env + settings parsing
│   ├── logger.ts             # Terminal, file, and Telegram debug logging
│   ├── bot/
│   │   ├── bot.ts            # grammY bot setup
│   │   ├── handlers.ts       # Telegram command & message handlers (incl. voice)
│   │   └── instance.ts       # Bot singleton for scheduler/plugins
│   ├── agent/
│   │   ├── agent.ts          # Claude conversation loop with tool use
│   │   ├── context.ts        # Per-user conversation history
│   │   ├── escalation.ts     # Model escalation state + tool
│   │   └── tools/
│   │       ├── index.ts      # Merges built-in + plugin tools
│   │       ├── profile.ts    # soul.md and user.md management
│   │       ├── memory.ts     # Long-term + short-term memory
│   │       ├── heartbeat.ts  # Proactive reminder file management
│   │       ├── fetch.ts      # URL fetching via Jina Reader
│   │       ├── code.ts       # Sandboxed code execution
│   │       ├── buttons.ts    # Inline Telegram reply buttons
│   │       ├── schedule.ts   # Cron schedule management
│   │       └── plugins.ts    # Plugin and secret management
│   ├── google/
│   │   ├── auth.ts           # OAuth token management + auto-refresh
│   │   └── oauth.ts          # OAuth HTTP routes (/auth/google/*)
│   ├── plugins/
│   │   ├── loader.ts         # Compiles & hot-loads plugin TS files
│   │   ├── registry.ts       # plugins.json CRUD
│   │   └── secrets.ts        # secrets.json CRUD
│   ├── scheduler/
│   │   ├── runner.ts         # Cron job execution
│   │   ├── heartbeat.ts      # 30-min proactive reminder pulse
│   │   └── store.ts          # schedules.json CRUD
│   └── web/
│       ├── server.ts         # Express admin server + setup endpoints
│       └── public/
│           └── index.html    # Admin SPA (dashboard + onboarding wizard)
├── plugins/                  # Plugin source files (tracked in git)
│   ├── google/index.ts       # Gmail, Calendar, Drive tools
│   ├── notion/index.ts       # Notion pages and databases
│   ├── todoist/index.ts      # Todoist tasks and projects
│   └── brave-search/index.ts # Web search
├── config/                   # Runtime config (gitignored except templates)
│   ├── settings.json         # Model, tokens, timezone, escalation, quiet hours
│   ├── plugins.json          # Plugin registry
│   ├── secrets.json          # API keys (never committed)
│   ├── soul.md               # Agent personality
│   ├── soul.initial.md       # Starter template
│   ├── user.md               # User profile
│   ├── user.initial.md       # Starter template
│   ├── heartbeat.md          # Live proactive reminders (gitignored)
│   └── heartbeat.initial.md  # Heartbeat template
├── memory/                   # Memory files (gitignored)
│   ├── memory.md             # Long-term memory
│   └── YYYY-MM-DD.md         # Daily short-term memory
├── logs/                     # Daily log files (gitignored)
├── .env                      # Core credentials (gitignored)
├── .env.example              # Template for .env
├── Dockerfile
└── docker-compose.yml
```

---

## Production Deployment

### How the startup sequence works

1. The web server always starts first (port 3000)
2. `ensureConfigDefaults()` creates `config/settings.json` and `config/plugins.json` if they don't exist
3. If `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY` are present → bot starts, plugins load, scheduler starts → **online**
4. If either is missing → **setup mode**: web server runs, bot is skipped, dashboard shows the onboarding wizard

### Build

`npm run build` compiles TypeScript and copies the dashboard's static files into `dist/`:

```
dist/
├── index.js          ← compiled entry point
├── ...               ← other compiled modules
└── web/
    └── public/
        └── index.html  ← dashboard SPA (copied from src/web/public/)
```

### Docker

```bash
# 1. Create .env with your credentials
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, ALLOWED_USER_IDS
# WEB_ADMIN_TOKEN is generated automatically on first run

# 2. Build and start
docker compose up -d

# 3. Follow logs
docker compose logs -f atrexai
```

On first boot, `config/settings.json` and `config/plugins.json` are created automatically in the mounted `config/` volume if they don't exist yet.

**Volumes mounted by docker-compose:**

| Host path | Container path | Purpose |
|---|---|---|
| `./config` | `/app/config` | Settings, plugins registry, secrets — persists across restarts |
| `./plugins` | `/app/plugins` | Plugin source files — agent writes new plugins here |
| `./memory` | `/app/memory` | Long-term and short-term memory files |
| `./logs` | `/app/logs` | Daily log files |

The dashboard is bound to `127.0.0.1:3000` — never reachable directly from the internet. Use an SSH tunnel or reverse proxy (nginx/Caddy) if you need remote access.

### Environment

Set credentials directly on your hosting platform instead of `.env`:

```bash
# Railway / Fly.io / DigitalOcean / any VPS
TELEGRAM_BOT_TOKEN=...
ANTHROPIC_API_KEY=...
ALLOWED_USER_IDS=...
WEB_ADMIN_PORT=3000
# WEB_ADMIN_TOKEN is generated automatically on first run — check startup logs or run 'atrex token'
```

---

## Logging

- **Terminal** — color-coded output while running
- **File** — `logs/YYYY-MM-DD.log`, one file per day
- **Telegram** — send `/debug` to your bot to receive live logs in chat; send `/debug` again to stop

---

## Security

- `ALLOWED_USER_IDS` restricts who can send messages to the bot — leave empty only for private deployments
- `WEB_ADMIN_TOKEN` is generated automatically on first run and always enforced — run `atrex token` to display it
- All API keys live in `.env` and `config/secrets.json`, both gitignored
- The dashboard only binds to `0.0.0.0` — use a firewall or SSH tunnel if running on a VPS
- Plugins run in the same Node.js process — review any generated plugin code before enabling

---

## CLI

After installing via `install.sh`, the `atrex` command is available globally.

```bash
atrex <command>
```

| Command | Description |
|---|---|
| `atrex start` | Start the agent in the background (uses PM2 if available, otherwise `nohup`) |
| `atrex stop` | Stop the running agent |
| `atrex restart` | Restart the agent |
| `atrex status` | Show running status, uptime, PID, and dashboard URL |
| `atrex logs` | Tail live log output |
| `atrex update` | Pull latest code from git, reinstall dependencies, rebuild, and restart |
| `atrex open` | Open the web dashboard in your browser |
| `atrex setup` | Start the agent (if not running) and open the onboarding wizard |
| `atrex token` | Display the web dashboard admin token |
| `atrex help` | Show available commands |

### Examples

```bash
# First-time setup
atrex setup

# Day-to-day
atrex status
atrex restart
atrex logs

# Keep the agent up to date
atrex update
```

### How the CLI finds the installation

On first install, `install.sh` writes the install path to `~/.atrex/config`. If that file is missing, the CLI follows the `atrex` symlink back to the real script location. If neither works, re-run the installer.

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with hot reload (tsx watch) — serves dashboard from `src/web/public/` |
| `npm run build` | Compile TypeScript to `dist/` and copy dashboard assets to `dist/web/public/` |
| `npm start` | Run compiled JS — requires `npm run build` first |
