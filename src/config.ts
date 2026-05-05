// Loads and validates all configuration: settings.json, env vars, and the dynamic system prompt.
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

dotenv.config();

const settingsSchema = z.object({
  model: z.string().default("claude-sonnet-4-6"),
  // Models tried in order if the primary fails with a 5xx/429 error.
  fallbacks: z.array(z.string()).default([]),
  // Heartbeat won't fire between quiet_hours_start and quiet_hours_end (24h, e.g. 23 and 7).
  // Set both to the same value to disable quiet hours.
  quiet_hours_start: z.number().int().min(0).max(23).default(23),
  quiet_hours_end: z.number().int().min(0).max(23).default(7),
  max_tokens: z.number().int().positive().default(1024),
  max_history: z.number().int().positive().default(50),
  timezone: z.string().default("UTC"),
  // LLM provider. "anthropic" uses ANTHROPIC_API_KEY; "openai" uses OAuth bearer token.
  provider: z.enum(["anthropic", "openai", "moonshot"]).default("anthropic"),
  // Tool-loop detection: warn after N identical (tool, input) calls, abort at M.
  tool_loop_warn: z.number().int().positive().default(3),
  tool_loop_max: z.number().int().positive().default(6),
  // Replace bulky tool_result content with "[pruned]" once the message is older than
  // this many turns (counting from the end of history). 0 disables pruning.
  prune_tool_results_after: z.number().int().min(0).default(20),
  // Enable in-memory trajectory recording (used by /export).
  enable_trajectory: z.boolean().default(true),
  // Compact conversation history when it exceeds this many messages by summarising
  // the oldest turns with Haiku. 0 disables compaction (default).
  compaction_threshold: z.number().int().min(0).default(0),
});

// Strip `//` line comments and `/* ... */` block comments before JSON.parse, so
// settings.json can be commented (JSONC-style) without silently falling back to
// defaults. Strings are preserved — the regex skips anything inside double quotes.
function stripJsonComments(raw: string): string {
  return raw.replace(
    /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match) => (match.startsWith('"') ? match : "")
  );
}

function loadSettings() {
  try {
    const raw = readFileSync(join(process.cwd(), "config/settings.json"), "utf-8");
    return settingsSchema.parse(JSON.parse(stripJsonComments(raw)));
  } catch (err) {
    // Can't use log here (circular dep) — console.warn is fine for startup
    console.warn(
      `config/settings.json not found or invalid — using defaults. (${err instanceof Error ? err.message : String(err)})`
    );
    return settingsSchema.parse({});
  }
}

export const settings = loadSettings();

// Core env vars — optional so the app can start in setup mode without them
const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  ANTHROPIC_API_KEY:  z.string().default(""),
  ALLOWED_USER_IDS: z
    .string()
    .optional()
    .transform((val: string | undefined) =>
      val ? val.split(",").map((id: string) => parseInt(id.trim(), 10)) : []
    ),
});

const env = envSchema.parse(process.env);

const hasLLM = !!env.ANTHROPIC_API_KEY || settings.provider === "openai" || !!process.env.MOONSHOT_API_KEY;
const hasTelegram = !!env.TELEGRAM_BOT_TOKEN && hasLLM;

if (!hasTelegram) {
  console.warn(
    "Not configured — running in setup mode.\n" +
    "Set TELEGRAM_BOT_TOKEN and configure an AI provider.\n" +
    "Visit http://localhost:3000 to complete setup."
  );
} else if (env.ALLOWED_USER_IDS.length === 0) {
  console.warn("WARNING: ALLOWED_USER_IDS is not set — anyone can talk to the agent.");
}

/** True when Telegram and the AI key are both configured. */
export const isConfigured = hasTelegram;

// Reads a file from the project root, returning "" if it doesn't exist
function loadFile(filename: string): string {
  try {
    return readFileSync(join(process.cwd(), filename), "utf-8");
  } catch {
    return "";
  }
}

// Lazy imports to avoid circular dependencies
let _getMemory: (() => string) | null = null;
let _listSkills: (() => import("./agent/skills").AgentSkill[]) | null = null;
let _getActiveSkill: (() => import("./agent/skills").AgentSkill) | null = null;
let _readHeartbeat: (() => string) | null = null;

function getMemory(): string {
  if (!_getMemory) {
    try {
      _getMemory = require("./agent/tools/memory").getMemoryForSystemPrompt;
    } catch {
      return "";
    }
  }
  return _getMemory!();
}

function getHeartbeatSection(): string {
  if (!_readHeartbeat) {
    try {
      _readHeartbeat = require("./agent/tools/heartbeat").readHeartbeat;
    } catch {
      return "";
    }
  }
  const raw = _readHeartbeat!().trim();
  if (!raw) return "";
  return `## Heartbeat\n\n${raw}`;
}

function getSkillsSection(): string {
  if (!_listSkills) {
    try {
      _listSkills = require("./agent/skills").listSkills;
      _getActiveSkill = require("./agent/skills").getActiveSkill;
    } catch {
      return "";
    }
  }

  const allSkills = _listSkills!();
  // Non-main skills are the ones the agent can switch into
  const switchable = allSkills.filter((s) => s.id !== "main");
  if (switchable.length === 0) return "";

  const active = _getActiveSkill!();

  const lines: string[] = ["## Skills"];

  if (active.id !== "main" && active.systemPrompt?.trim()) {
    lines.push(
      `\nCurrently active: **${active.name}** — ${active.description}\n\n${active.systemPrompt.trim()}`
    );
    const others = switchable.filter((s) => s.id !== active.id);
    if (others.length > 0) {
      lines.push("\nOther available skills:");
      others.forEach((s) => lines.push(`- **${s.id}** (${s.name}): ${s.description}`));
    }
  } else {
    lines.push(
      "\nWhen a user's request clearly matches one of these skills, call `use_skill` with its id before responding to load focused instructions and memory."
    );
    lines.push("\nAvailable skills:");
    switchable.forEach((s) => lines.push(`- **${s.id}** (${s.name}): ${s.description}`));
  }

  return lines.join("\n");
}

// Loaded fresh on every request so edits take effect without a restart.
// Returns the system prompt as a two-block array so the stable prefix (soul + user +
// memory + skills + heartbeat) can be marked with `cache_control: ephemeral`. The
// volatile date/time line sits after the cache breakpoint — it changes every minute
// but doesn't invalidate the cached prefix.
export function getSystemPrompt(): Anthropic.TextBlockParam[] {
  const now  = new Date().toLocaleDateString("en-CA", { timeZone: settings.timezone }); // YYYY-MM-DD
  const time = new Date().toLocaleTimeString("en-GB", {
    timeZone: settings.timezone, hour: "2-digit", minute: "2-digit",
  });
  const dateLine = `Current date: ${now}, time: ${time}, timezone: ${settings.timezone}`;

  const identity  = loadFile("config/identity.md");
  const soul      = loadFile("config/soul.md");
  const agents    = loadFile("config/agents.md");
  const tools     = loadFile("config/tools.md");
  const user      = loadFile("config/user.md");
  const memory    = getMemory();
  const skills    = getSkillsSection();
  const heartbeat = getHeartbeatSection();

  const stable = [identity, soul, agents, tools, user, memory, skills, heartbeat]
    .filter(Boolean)
    .join("\n\n---\n\n");

  const blocks: Anthropic.TextBlockParam[] = [];
  if (stable) {
    blocks.push({ type: "text", text: stable, cache_control: { type: "ephemeral" } });
  }
  blocks.push({ type: "text", text: dateLine });
  return blocks;
}

export const config = {
  telegramToken:  env.TELEGRAM_BOT_TOKEN,
  anthropicKey:   env.ANTHROPIC_API_KEY,
  allowedUserIds: env.ALLOWED_USER_IDS,
};
