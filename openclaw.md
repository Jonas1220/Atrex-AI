# Features we could borrow from OpenClaw

OpenClaw (`openclaw/`) is a much larger multi-channel personal-assistant gateway. Most of it is out of scope for Atrex-AI's Telegram-focused design, but several of its concepts map cleanly onto what we already have. Listed roughly by impact-to-effort ratio.

## High value, low effort

### 1. `/btw` ephemeral side questions
OpenClaw's `/btw` snapshots the current session, runs a **tool-less** one-shot model call, and answers without persisting the Q&A to history. We already have `chatOnce()` in `src/agent/agent.ts` — the plumbing is basically done. We just need:
- A `/btw` Telegram command in `src/bot/handlers.ts` that calls `chatOnce()` with tools disabled (or a reduced toolset).
- Visibly mark the response as a side-result (different prefix / emoji).
- Do not read from or write to the user's conversation history.

Ref: `openclaw/docs/tools/btw.md`.

### 2. Hooks / lifecycle events
OpenClaw fires events like `command:new`, `session:compact:before`, `agent:bootstrap`, `message:received`, `message:sent`, `gateway:startup`. Users register scripts that listen to them. For us this could be a small event bus (EventEmitter) in `src/agent/agent.ts` and `src/bot/handlers.ts` that plugins and skills can subscribe to. Enables things like "run this when a new chat starts" or "clean up state after /reset" without touching core.

Ref: `openclaw/docs/automation/hooks.md`.

### 3. Trajectory / flight-recorder export
A per-session structured timeline of: system prompt, tools sent, model, thinking level, tool calls + results, timings, token usage, errors. Exposed as `/export` that returns a redacted bundle. Enormously useful for debugging weird tool loops and for users to share support artefacts.

Ref: `openclaw/docs/tools/trajectory.md`.

### 4. Tool-loop detection
Guard against agents that call the same tool with the same inputs in circles. Simple ring buffer of recent tool+input hashes; warn at N repeats, hard-stop at M. Cheap insurance when adding new tools.

Ref: `openclaw/docs/tools/loop-detection.md`.

### 5. Thinking directives (`/t low|medium|high`)
Inline user directive that sets the reasoning/thinking budget for the next run (or session). Mirrors our existing escalation button pattern but finer-grained. Maps well onto Claude's `thinking` API parameter.

Ref: `openclaw/docs/tools/thinking.md`.

### 6. Session pruning of old tool results
Before each LLM call, trim the oldest tool-result payloads (exec/file-read/search outputs) from context — keep the tool_use blocks but drop the bulky results once they've aged past the cache TTL. In-memory only; disk transcript stays intact. Direct cost/latency win, especially with Anthropic prompt caching which we already use.

Ref: `openclaw/docs/concepts/session-pruning.md`.

### 7. Typing-indicator modes
We already send chat-action "typing" implicitly. OpenClaw has explicit `never | instant | thinking | streaming` modes. Adding a `thinking` mode (starts typing on first reasoning delta) would make long requests feel less dead.

Ref: `openclaw/docs/concepts/typing-indicators.md`.

## High value, medium effort

### 8. Standing orders (persistent autonomous programs)
Our heartbeat already runs `chatOnce()` on a cron pulse with items parsed from `heartbeat.md`. Standing orders extend this: named programs in `config/soul.md` (or a new `standing-orders.md`) with **scope**, **trigger**, **approval gate**, and **escalation rule** blocks. The agent executes autonomously within those boundaries — much more structured than free-form heartbeat entries. Maps nicely onto what we already ship.

Ref: `openclaw/docs/automation/standing-orders.md`.

### 9. Active memory sub-agent
A small blocking sub-agent that runs **before** the main reply on eligible turns, decides whether memory is relevant, and injects a bounded snippet into the prompt. Today the main agent must remember to call `memory_search`. Active memory makes recall proactive without every turn paying the cost. Config-gated (DM-only, with cheap fallback model like Haiku).

Ref: `openclaw/docs/concepts/active-memory.md`.

### 10. Dreaming — background memory consolidation
Three-phase (Light → Deep → REM) offline pass over recent notes that promotes durable signals into `MEMORY.md` and writes a human-readable `DREAMS.md` sweep. Opt-in, runs during quiet hours (we already have that setting). Complements our auto-memory system well — the existing system writes memories on the fly; dreaming would consolidate, dedupe, and score them.

Ref: `openclaw/docs/concepts/dreaming.md`.

### 11. Cron jobs as first-class scheduler (not just heartbeat)
Our scheduler only does the 30-min pulse. OpenClaw has a proper cron system: one-shot `--at`, recurring `--cron`, per-job session target, delete-after-run, persistent `jobs.json` + runtime-state split, execution history. Would let users say "remind me Thursday 4pm" and have it fire exactly once. `src/scheduler/` already has the skeleton (`store.ts`, `runner.ts`).

Ref: `openclaw/docs/automation/cron-jobs.md`.

### 12. Webhook triggers
External HTTP endpoints that can inject a message into a session (signed URL). We have the Express admin server already — wiring `/hook/:id` routes that enqueue a `chat()` call is small and opens up huge integration potential (GitHub, Zapier, IFTTT, n8n).

Ref: `openclaw/docs/automation/cron-jobs.md#webhooks`.

### 13. Compaction with tool-pair safety
We have no compaction at all — we rely on Claude's context window and hope. OpenClaw summarises older turns when approaching the limit, but is careful to never split an assistant `tool_use` from its paired `tool_result`. We need this the moment any user has a long-running session; retrofitting later is painful.

Ref: `openclaw/docs/concepts/compaction.md`.

### 14. Model failover chain
Auth-profile rotation within a provider, then model fallback across a configured `fallbacks` list. Today an Anthropic 529 surfaces as a user-visible error. A small retry layer around the SDK call with configurable fallbacks (Opus → Sonnet → Haiku) would make the bot far more resilient.

Ref: `openclaw/docs/concepts/model-failover.md`.

## Larger scope (worth considering, not urgent)

### 15. Multi-agent routing / named delegates
One gateway process, multiple isolated agents, each with its own workspace + auth profile + memory. Bindings map a channel (a specific Telegram bot token, or group) to an agent. For Atrex-AI this would mean: one process can serve both "my personal assistant" and "the work-account assistant" without forking. Big refactor but a clear future direction — today everything in `src/` assumes a single agent.

Ref: `openclaw/docs/concepts/multi-agent.md`, `delegate-architecture.md`.

### 16. Sub-agents as announcing background tasks
We have `src/agent/tools/subagent.ts` already. OpenClaw's version is richer: each sub-agent runs in its own session (`agent:<id>:subagent:<uuid>`), is tracked as a background task, and **announces** its result back to the requester chat when done — push-based, no polling. Also supports `/subagents list|kill|steer|send`. Would make long-running tasks ("summarise these 50 PRs") usable from Telegram without blocking the chat.

Ref: `openclaw/docs/tools/subagents.md`.

### 17. Command queue with steer/collect/followup modes
Today a new Telegram message mid-run does… what, exactly? OpenClaw has explicit per-channel queue modes: `steer` (inject mid-run), `followup` (run after current finishes), `collect` (merge pending into one), `interrupt` (abort + restart). This is the right framing for "user sent a correction 2 seconds after their first message." We'd need this once we add streaming.

Ref: `openclaw/docs/concepts/queue.md`, `messages.md`.

### 18. Streaming assistant output
OpenClaw streams responses by editing the outbound message in chunks. For long replies this is night-and-day UX. Requires careful handling of Telegram's edit-rate limits. Independent of the queue work but pairs naturally with it.

Ref: `openclaw/docs/concepts/streaming.md`.

### 19. Reactions as a first-class tool
A `message.react` tool that lets the agent emoji-react to user messages (✅ for "got it", 👀 for "working on it", ❌ for "can't do that"). Cheap affordance, per-channel semantics. Telegram supports bot reactions.

Ref: `openclaw/docs/tools/reactions.md`.

### 20. Rich workspace file layout
OpenClaw auto-injects `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md` at session start. We have `soul.md`, `memory/`, `heartbeat.md`, `skills/` — but no `USER.md` (who is this user, how to address them, timezone, locale) or `IDENTITY.md` (the agent's own name/role). Adding `USER.md` is a quick win that removes a class of "the agent keeps forgetting basic facts about me" bugs.

Ref: `openclaw/docs/concepts/agent-workspace.md`.

### 21. Memory Wiki companion
Durable knowledge compiled into a structured wiki vault with claims, evidence, contradiction tracking, freshness signals, and tools like `wiki_search`/`wiki_apply`/`wiki_lint`. Sits beside our flat `MEMORY.md`. Overkill for a casual user but interesting for power users with years of notes.

Ref: `openclaw/docs/concepts/memory-wiki.md` (referenced from `memory.md`).

## Explicitly out of scope

These exist in OpenClaw but do not fit Atrex-AI's shape:
- 20+ channel adapters (we are Telegram-only by design)
- Native macOS/iOS/Android node apps + Canvas rendering
- Sandbox runtime (Docker/Podman) for arbitrary code execution
- 35+ model provider plugins (we use Anthropic exclusively)
- Gateway RPC protocol / WebSocket pairing

## Suggested order if we pick any of these up

1. `/btw` (1) — trivial, immediate UX win.
2. Model failover (14) — resilience, invisible until it matters.
3. Session pruning (6) — direct cost reduction given we cache aggressively.
4. Thinking directives (5) — composes with our existing escalation.
5. Tool-loop detection (4) — safety net before we add more tools.
6. Trajectory export (3) — debugging multiplier.
7. Hooks (2) — unlocks cleaner plugin boundaries before the plugin surface gets bigger.
8. Cron jobs (11) + webhooks (12) — turns the bot from reactive into a real automation hub.
9. Compaction (13) — mandatory before long-session use cases land.
10. Standing orders (8) + dreaming (10) — bigger behavioural shifts, build on the above.
