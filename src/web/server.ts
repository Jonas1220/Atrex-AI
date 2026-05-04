// Web admin server — exposes a local REST API and serves the admin SPA.
// Generates a random WEB_ADMIN_TOKEN on first run and saves it to .env.
import express from "express";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { setSecret } from "../plugins/secrets";
import { getRegistry, setPluginEnabled, unregisterPlugin } from "../plugins/registry";
import { getSecret, deleteSecret, listSecretKeys } from "../plugins/secrets";
import { createOAuthRouter } from "../google/oauth";
import { isGoogleConnected } from "../google/auth";
import { createOpenAIRouter } from "../openai/oauth";
import { isOpenAIConnected } from "../openai/auth";
import { createAnthropicRouter } from "../anthropic/oauth";
import { isAnthropicOAuthConnected } from "../anthropic/auth";
import { setRuntimeProvider, getActiveProvider, setRuntimeModel, getActiveModel } from "../agent/providers";
import {
  listSkills,
  loadSkill,
  saveSkill,
  getActiveSkillId,
  setActiveSkillId,
  ensureMainSkill,
  createSkill,
  AgentSkill,
} from "../agent/skills";
import { log } from "../logger";

const ROOT = process.cwd();
const cfgPath = (f: string) => join(ROOT, "config", f);
const memPath = (f: string) => join(ROOT, "config", f);

function getOllamaBaseUrl(): string {
  return (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
}

async function isOllamaReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${getOllamaBaseUrl()}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = parseInt(process.env.WEB_ADMIN_PORT || "3000", 10);

// ── .env writer ───────────────────────────────────────────────────────────────
// Reads the existing .env (or .env.example as template), patches the given keys,
// and writes it back. Falls back gracefully if neither file exists.
function updateEnvFile(updates: Record<string, string>): void {
  const envPath = join(ROOT, ".env");
  let content = "";
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    try { content = readFileSync(join(ROOT, ".env.example"), "utf-8"); } catch {}
  }

  const lines = content.split("\n");
  const written = new Set<string>();

  const patched = lines.map((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
    if (m && updates[m[1]] !== undefined && updates[m[1]] !== "") {
      written.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key) && value !== "") patched.push(`${key}=${value}`);
  }

  writeFileSync(envPath, patched.join("\n"), "utf-8");
}

// ── Admin token ───────────────────────────────────────────────────────────────
// Generate a random token on first run and persist it to .env.
let TOKEN = process.env.WEB_ADMIN_TOKEN || "";
if (!TOKEN) {
  TOKEN = randomBytes(32).toString("hex");
  process.env.WEB_ADMIN_TOKEN = TOKEN;
  updateEnvFile({ WEB_ADMIN_TOKEN: TOKEN });
  log.warn("┌─────────────────────────────────────────────────────────┐");
  log.warn("│  Admin token generated (first run)                      │");
  log.warn(`│  ${TOKEN}  │`);
  log.warn("│  Run 'atrex token' to display it again.                 │");
  log.warn("└─────────────────────────────────────────────────────────┘");
}

// ── Auth middleware ───────────────────────────────────────────────────────────
app.use("/api", (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${TOKEN}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// ── Bootstrap missing config files ───────────────────────────────────────────
// Runs once at startup so onboarding always has a working baseline to work with.
function ensureConfigDefaults(): void {
  mkdirSync(join(ROOT, "config"), { recursive: true });

  if (!existsSync(cfgPath("settings.json"))) {
    writeFileSync(cfgPath("settings.json"), JSON.stringify({
      model:          "claude-sonnet-4-6",
      max_tokens:     1024,
      max_history:    50,
      timezone:       "UTC",
    }, null, 2), "utf-8");
    log.info("Created default config/settings.json");
  }

  // Seed *.initial.md → *.md if the live file doesn't exist yet
  try {
    const configDir = join(ROOT, "config");
    for (const f of readdirSync(configDir)) {
      if (!f.endsWith(".initial.md")) continue;
      const dest = join(configDir, f.replace(".initial.md", ".md"));
      if (!existsSync(dest)) {
        copyFileSync(join(configDir, f), dest);
        log.info(`Seeded ${f.replace(".initial.md", ".md")} from template`);
      }
    }
  } catch {}

  if (!existsSync(cfgPath("plugins.json"))) {
    writeFileSync(cfgPath("plugins.json"), JSON.stringify({
      google: {
        enabled: true,
        description: "Gmail, Google Calendar, and Google Drive via OAuth.",
        createdAt: new Date().toISOString(),
        integration: { type: "oauth", displayName: "Google", services: ["Gmail", "Calendar", "Drive"], authService: "google" },
      },
      notion: {
        enabled: true,
        description: "Search, read, create, and update Notion pages and databases.",
        createdAt: new Date().toISOString(),
        integration: { type: "apikey", displayName: "Notion", services: ["Pages", "Databases"], secretKey: "NOTION_API_KEY" },
      },
      todoist: {
        enabled: true,
        description: "Interact with Todoist — manage tasks, projects, and labels.",
        createdAt: new Date().toISOString(),
        integration: { type: "apikey", displayName: "Todoist", services: ["Tasks", "Projects"], secretKey: "TODOIST_API_KEY" },
      },
      "brave-search": {
        enabled: true,
        description: "Web search using the Brave Search API.",
        createdAt: new Date().toISOString(),
        integration: { type: "apikey", displayName: "Brave Search", services: ["Web Search"], secretKey: "BRAVE_SEARCH_API_KEY" },
      },
      "openai-voice": {
        enabled: true,
        description: "Voice message transcription via OpenAI Whisper. Send voice notes in Telegram and they will be transcribed automatically.",
        createdAt: new Date().toISOString(),
        integration: { type: "apikey", displayName: "OpenAI Whisper", services: ["Voice Transcription"], secretKey: "OPENAI_API_KEY" },
      },
    }, null, 2), "utf-8");
    log.info("Created default config/plugins.json");
  }
}

ensureConfigDefaults();
ensureMainSkill();

// ── Setup endpoints (always accessible — registered before auth middleware) ──
app.get("/setup/status", async (_req, res) => {
  const ollamaOk = await isOllamaReachable();
  let cfgProvider = "anthropic";
  try { cfgProvider = (JSON.parse(readText(cfgPath("settings.json"))) as Record<string, string>).provider ?? "anthropic"; } catch {}
  res.json({
    needsSetup: !process.env.TELEGRAM_BOT_TOKEN ||
      (!process.env.ANTHROPIC_API_KEY && !isOpenAIConnected() && cfgProvider !== "ollama"),
    telegram:  !!process.env.TELEGRAM_BOT_TOKEN,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    openai:    isOpenAIConnected(),
    ollama:    ollamaOk,
  });
});

app.put("/setup/core", (req, res) => {
  const { telegramToken, anthropicKey, ollamaUrl, provider, allowedUserIds, adminToken } =
    req.body as Record<string, string>;
  const updates: Record<string, string> = {};
  if (telegramToken)                updates["TELEGRAM_BOT_TOKEN"] = telegramToken;
  if (anthropicKey)                 updates["ANTHROPIC_API_KEY"]  = anthropicKey;
  if (ollamaUrl)                    updates["OLLAMA_BASE_URL"]     = ollamaUrl;
  if (allowedUserIds !== undefined) updates["ALLOWED_USER_IDS"]   = allowedUserIds;
  if (adminToken)                   updates["WEB_ADMIN_TOKEN"]     = adminToken;
  try {
    updateEnvFile(updates);
    if (provider && ["anthropic", "openai", "ollama"].includes(provider)) {
      const defaultModels: Record<string, string> = {
        anthropic: "claude-sonnet-4-6",
        openai:    "gpt-4o",
        ollama:    "llama3.2",
      };
      let cfg: Record<string, unknown> = {};
      try { cfg = JSON.parse(readText(cfgPath("settings.json"))); } catch {}
      cfg.provider = provider;
      if (!cfg.model || cfg.model === "claude-sonnet-4-6" && provider !== "anthropic") {
        cfg.model = defaultModels[provider];
      }
      writeText(cfgPath("settings.json"), JSON.stringify(cfg, null, 2));
    }
    log.info("Core credentials saved via setup wizard.");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/setup/secret", (req, res) => {
  const { key, value } = req.body as { key: string; value: string };
  if (!key || !value) { res.status(400).json({ error: "key and value required" }); return; }
  setSecret(key, value);
  log.info(`Secret '${key}' saved via setup wizard.`);
  res.json({ ok: true });
});

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function writeText(path: string, content: string): void {
  writeFileSync(path, content, "utf-8");
}

// ── Auth info (no credentials exposed — just tells frontend if token is needed)
app.get("/api/auth-required", (_req, res) => {
  res.json({ required: true });
});

// ── Status ───────────────────────────────────────────────────────────────────
const startTime = Date.now();

app.get("/api/status", (_req, res) => {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readText(cfgPath("settings.json")));
  } catch {}

  const registry = getRegistry();
  const enabledPlugins = Object.values(registry).filter((p) => p.enabled).length;

  res.json({
    model: settings.model ?? "unknown",
    plugins: { total: Object.keys(registry).length, enabled: enabledPlugins },
    uptimeMs: Date.now() - startTime,
  });
});

// ── Provider ─────────────────────────────────────────────────────────────────

app.get("/api/provider", async (_req, res) => {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readText(cfgPath("settings.json"))); } catch {}
  const ollamaOk = await isOllamaReachable();
  res.json({
    active:         getActiveProvider(),
    default:        cfg.provider ?? "anthropic",
    model:          getActiveModel(),
    anthropicReady: !!process.env.ANTHROPIC_API_KEY,
    anthropicOAuth: isAnthropicOAuthConnected(),
    openaiReady:    isOpenAIConnected(),
    ollamaReady:    ollamaOk,
    ollamaBaseUrl:  getOllamaBaseUrl(),
  });
});

app.post("/api/provider/switch", async (req, res) => {
  const { provider } = req.body as { provider?: string };
  if (!["anthropic", "openai", "ollama"].includes(provider ?? "")) {
    res.status(400).json({ error: "provider must be 'anthropic', 'openai', or 'ollama'" });
    return;
  }
  if (provider === "openai" && !isOpenAIConnected()) {
    res.status(400).json({ error: "OpenAI is not authenticated yet." });
    return;
  }
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY && !isAnthropicOAuthConnected()) {
    res.status(400).json({ error: "Anthropic has no API key or OAuth token." });
    return;
  }
  if (provider === "ollama" && !(await isOllamaReachable())) {
    res.status(400).json({ error: `Ollama is not reachable at ${getOllamaBaseUrl()}. Make sure it's running.` });
    return;
  }

  setRuntimeProvider(provider as "anthropic" | "openai" | "ollama");

  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readText(cfgPath("settings.json"))); } catch {}
  cfg.provider = provider;
  writeText(cfgPath("settings.json"), JSON.stringify(cfg, null, 2));

  log.info(`Provider switched to ${provider} via web admin.`);
  res.json({ ok: true, active: provider });
});

app.post("/api/provider/model", (req, res) => {
  const { provider, model } = req.body as { provider?: string; model?: string };
  if (!provider || !model) { res.status(400).json({ error: "provider and model required" }); return; }
  if (!["anthropic", "openai", "ollama"].includes(provider)) {
    res.status(400).json({ error: "unknown provider" }); return;
  }

  // Apply live — no restart needed
  setRuntimeModel(model);
  setRuntimeProvider(provider as "anthropic" | "openai" | "ollama");

  // Persist to settings.json
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readText(cfgPath("settings.json"))); } catch {}
  cfg.model = model;
  cfg.provider = provider;
  writeText(cfgPath("settings.json"), JSON.stringify(cfg, null, 2));

  log.info(`Provider → ${provider}, model → ${model} (via web admin)`);
  res.json({ ok: true, active: provider, model });
});

app.put("/api/provider/apikey", (req, res) => {
  const { provider, key } = req.body as { provider?: string; key?: string };
  if (!provider || !key) { res.status(400).json({ error: "provider and key required" }); return; }
  let envKey: string;
  if (provider === "anthropic")      envKey = "ANTHROPIC_API_KEY";
  else { res.status(400).json({ error: "API keys can only be set for anthropic" }); return; }
  updateEnvFile({ [envKey]: key });
  process.env[envKey] = key;
  log.info(`${envKey} updated via web admin.`);
  res.json({ ok: true });
});

app.put("/api/provider/baseurl", (req, res) => {
  const { provider, url } = req.body as { provider?: string; url?: string };
  if (!provider || !url) { res.status(400).json({ error: "provider and url required" }); return; }
  if (provider !== "ollama") { res.status(400).json({ error: "Only ollama supports base URL config" }); return; }
  updateEnvFile({ OLLAMA_BASE_URL: url });
  process.env.OLLAMA_BASE_URL = url;
  log.info(`OLLAMA_BASE_URL updated to ${url} via web admin.`);
  res.json({ ok: true });
});

// ── Soul ─────────────────────────────────────────────────────────────────────
app.get("/api/soul", (_req, res) => {
  res.json({ content: readText(cfgPath("soul.md")) });
});

app.put("/api/soul", (req, res) => {
  writeText(cfgPath("soul.md"), req.body.content ?? "");
  log.info("soul.md updated via web admin");
  res.json({ ok: true });
});

// ── User Profile ─────────────────────────────────────────────────────────────
app.get("/api/user", (_req, res) => {
  res.json({ content: readText(cfgPath("user.md")) });
});

app.put("/api/user", (req, res) => {
  writeText(cfgPath("user.md"), req.body.content ?? "");
  log.info("user.md updated via web admin");
  res.json({ ok: true });
});

// ── Heartbeat ────────────────────────────────────────────────────────────────
app.get("/api/heartbeat", (_req, res) => {
  res.json({ content: readText(cfgPath("heartbeat.md")) });
});

app.put("/api/heartbeat", (req, res) => {
  writeText(cfgPath("heartbeat.md"), req.body.content ?? "");
  log.info("heartbeat.md updated via web admin");
  res.json({ ok: true });
});

// ── Memory ───────────────────────────────────────────────────────────────────
app.get("/api/memory", (_req, res) => {
  const longTerm = readText(memPath("memory.md"));
  let shortTerm: { date: string; content: string }[] = [];

  try {
    shortTerm = readdirSync(memPath(""))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .map((f) => ({ date: f.replace(".md", ""), content: readText(memPath(f)) }));
  } catch {}

  res.json({ longTerm, shortTerm });
});

app.put("/api/memory/longterm", (req, res) => {
  writeText(memPath("memory.md"), req.body.content ?? "");
  log.info("memory.md updated via web admin");
  res.json({ ok: true });
});

// ── Settings ─────────────────────────────────────────────────────────────────
app.get("/api/settings", (_req, res) => {
  try {
    const content = JSON.parse(readText(cfgPath("settings.json")));
    res.json({ content });
  } catch {
    res.status(500).json({ error: "Could not parse settings.json" });
  }
});

app.put("/api/settings", (req, res) => {
  try {
    writeText(cfgPath("settings.json"), JSON.stringify(req.body.content, null, 2));
    log.info("settings.json updated via web admin");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to write settings.json" });
  }
});

app.patch("/api/settings", (req, res) => {
  const PATCHABLE = new Set([
    "model",
    "max_tokens", "max_history", "timezone",
    "quiet_hours_start", "quiet_hours_end",
    "tool_loop_warn", "tool_loop_max",
    "prune_tool_results_after", "compaction_threshold",
  ]);
  try {
    let cfg: Record<string, unknown> = {};
    try { cfg = JSON.parse(readText(cfgPath("settings.json"))); } catch {}
    for (const [key, value] of Object.entries(req.body as Record<string, unknown>)) {
      if (PATCHABLE.has(key)) cfg[key] = value;
    }
    writeText(cfgPath("settings.json"), JSON.stringify(cfg, null, 2));
    log.info(`settings.json patched: ${Object.keys(req.body).join(", ")}`);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to patch settings.json" });
  }
});

// ── Plugins ──────────────────────────────────────────────────────────────────
app.get("/api/plugins", (_req, res) => {
  const registry = getRegistry();
  const list = Object.entries(registry).map(([name, entry]) => ({ name, ...entry }));
  res.json(list);
});

app.post("/api/plugins/:name/toggle", (req, res) => {
  const { name } = req.params;
  const registry = getRegistry();
  if (!(name in registry)) {
    res.status(404).json({ error: "Plugin not found" });
    return;
  }
  const newState = !registry[name].enabled;
  setPluginEnabled(name, newState);
  log.info(`Plugin '${name}' ${newState ? "enabled" : "disabled"} via web admin`);
  res.json({ enabled: newState });
});

app.delete("/api/plugins/:name", (req, res) => {
  const { name } = req.params;
  unregisterPlugin(name);
  const pluginDir = join(ROOT, "plugins", name);
  if (existsSync(pluginDir)) {
    rmSync(pluginDir, { recursive: true, force: true });
  }
  log.info(`Plugin '${name}' deleted via web admin`);
  res.json({ ok: true });
});

app.get("/api/plugins/:name/code", (req, res) => {
  const { name } = req.params;
  // Only allow alphanumeric plugin names to prevent path traversal
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    res.status(400).json({ error: "Invalid plugin name" });
    return;
  }
  const tsPath = join(ROOT, "plugins", name, "index.ts");
  if (!existsSync(tsPath)) {
    res.status(404).json({ error: "Source file not found" });
    return;
  }
  res.json({ content: readText(tsPath) });
});

// ── Integrations ─────────────────────────────────────────────────────────────
// Returns all plugins enriched with live connection/configured status for the admin UI.
app.get("/api/integrations", (_req, res) => {
  const registry = getRegistry();
  const list = Object.entries(registry).map(([name, entry]) => {
    const base = { name, ...entry };

    if (!entry.integration) return { ...base, status: "unknown" };

    if (entry.integration.type === "oauth" && entry.integration.authService === "google") {
      return { ...base, status: isGoogleConnected() ? "connected" : "disconnected" };
    }

    if (entry.integration.type === "apikey" && entry.integration.secretKey) {
      const configured = !!getSecret(entry.integration.secretKey);
      return { ...base, status: configured ? "configured" : "missing_key" };
    }

    if (entry.integration.type === "email") {
      const configured = !!(getSecret("EMAIL_ADDRESS") && getSecret("EMAIL_PASSWORD") && getSecret("EMAIL_IMAP_HOST") && getSecret("EMAIL_SMTP_HOST"));
      return { ...base, status: configured ? "configured" : "missing_key" };
    }

    return { ...base, status: "unknown" };
  });
  res.json(list);
});

// ── Skills ────────────────────────────────────────────────────────────────────
app.get("/api/skills", (_req, res) => {
  res.json({ skills: listSkills(), activeId: getActiveSkillId() });
});

app.post("/api/skills", (req, res) => {
  const { name, description } = req.body as { name: string; description: string };
  if (!name?.trim()) { res.status(400).json({ error: "name is required" }); return; }
  const skill = createSkill(name.trim(), (description || "").trim());
  log.info(`Skill '${skill.id}' created via web admin`);
  res.json(skill);
});

app.put("/api/skills/:id", (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9_-]+$/.test(id)) { res.status(400).json({ error: "Invalid skill id" }); return; }
  const existing = loadSkill(id);
  if (!existing) { res.status(404).json({ error: "Skill not found" }); return; }
  const { name, description, systemPrompt, model } = req.body as Partial<AgentSkill>;
  const updated: AgentSkill = {
    ...existing,
    name:         name?.trim()         ?? existing.name,
    description:  description?.trim()  ?? existing.description,
    systemPrompt: systemPrompt         ?? existing.systemPrompt,
    model:        model                ?? existing.model,
  };
  saveSkill(updated);
  log.info(`Skill '${id}' updated via web admin`);
  res.json(updated);
});

app.delete("/api/skills/:id", (req, res) => {
  const { id } = req.params;
  if (id === "main") { res.status(400).json({ error: "Cannot delete the main skill" }); return; }
  if (!/^[a-z0-9_-]+$/.test(id)) { res.status(400).json({ error: "Invalid skill id" }); return; }
  const path = join(process.cwd(), "config/skills", `${id}.md`);
  if (!existsSync(path)) { res.status(404).json({ error: "Skill not found" }); return; }
  rmSync(path);
  if (getActiveSkillId() === id) setActiveSkillId("main");
  log.info(`Skill '${id}' deleted via web admin`);
  res.json({ ok: true });
});

app.post("/api/skills/:id/activate", (req, res) => {
  const { id } = req.params;
  if (!loadSkill(id)) { res.status(404).json({ error: "Skill not found" }); return; }
  setActiveSkillId(id);
  log.info(`Skill '${id}' activated via web admin`);
  res.json({ ok: true, activeId: id });
});


// ── Agents ───────────────────────────────────────────────────────────────────
const AGENTS_DIR_PATH = join(ROOT, "agents");

interface AgentDef {
  id: string;
  model?: string;
  provider?: string;
  systemPrompt: string;
}

function parseAgentFile(raw: string, id: string): AgentDef {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { id, systemPrompt: raw.trim() };
  const front = match[1];
  const body = match[2].trim();
  const get = (key: string): string => {
    const m = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };
  return {
    id,
    systemPrompt: body,
    ...(get("model")    ? { model:    get("model")    } : {}),
    ...(get("provider") ? { provider: get("provider") } : {}),
  };
}

function serializeAgentFile(agent: AgentDef): string {
  const lines: string[] = ["---"];
  if (agent.model)    lines.push(`model: ${agent.model}`);
  if (agent.provider) lines.push(`provider: ${agent.provider}`);
  lines.push("---\n");
  return lines.join("\n") + (agent.systemPrompt || "");
}

function listAgents(): AgentDef[] {
  try {
    mkdirSync(AGENTS_DIR_PATH, { recursive: true });
    return readdirSync(AGENTS_DIR_PATH)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => parseAgentFile(readText(join(AGENTS_DIR_PATH, f)), f.replace(".md", "")));
  } catch { return []; }
}

app.get("/api/agents", (_req, res) => {
  res.json(listAgents());
});

app.put("/api/agents/:id", (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9_-]+$/.test(id)) {
    res.status(400).json({ error: "Invalid agent id — use lowercase letters, numbers, hyphens" });
    return;
  }
  const { model, provider, systemPrompt } = req.body as Partial<AgentDef>;
  mkdirSync(AGENTS_DIR_PATH, { recursive: true });
  const agent: AgentDef = {
    id,
    model:        model        || undefined,
    provider:     provider     || undefined,
    systemPrompt: systemPrompt || "",
  };
  writeText(join(AGENTS_DIR_PATH, `${id}.md`), serializeAgentFile(agent));
  log.info(`Agent '${id}' saved via web admin`);
  res.json(agent);
});

app.delete("/api/agents/:id", (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9_-]+$/.test(id)) {
    res.status(400).json({ error: "Invalid agent id" }); return;
  }
  const path = join(AGENTS_DIR_PATH, `${id}.md`);
  if (!existsSync(path)) { res.status(404).json({ error: "Agent not found" }); return; }
  rmSync(path);
  log.info(`Agent '${id}' deleted via web admin`);
  res.json({ ok: true });
});

// ── Secrets ───────────────────────────────────────────────────────────────────
app.get("/api/secrets", (_req, res) => {
  // Only expose key names — never values
  res.json(listSecretKeys());
});

app.delete("/api/secrets/:key", (req, res) => {
  const ok = deleteSecret(req.params.key);
  if (!ok) {
    res.status(404).json({ error: "Secret not found" });
    return;
  }
  log.info(`Secret '${req.params.key}' deleted via web admin`);
  res.json({ ok: true });
});

// ── Email config ─────────────────────────────────────────────────────────────
const EMAIL_KEYS = ["EMAIL_ADDRESS","EMAIL_PASSWORD","EMAIL_IMAP_HOST","EMAIL_IMAP_PORT","EMAIL_SMTP_HOST","EMAIL_SMTP_PORT","EMAIL_SMTP_SECURE"] as const;

app.get("/api/email/config", (_req, res) => {
  res.json({
    address:    getSecret("EMAIL_ADDRESS")    ?? "",
    imap_host:  getSecret("EMAIL_IMAP_HOST")  ?? "",
    imap_port:  getSecret("EMAIL_IMAP_PORT")  ?? "993",
    smtp_host:  getSecret("EMAIL_SMTP_HOST")  ?? "",
    smtp_port:  getSecret("EMAIL_SMTP_PORT")  ?? "587",
    smtp_secure: getSecret("EMAIL_SMTP_SECURE") ?? "false",
    configured: !!(getSecret("EMAIL_ADDRESS") && getSecret("EMAIL_PASSWORD") && getSecret("EMAIL_IMAP_HOST") && getSecret("EMAIL_SMTP_HOST")),
  });
});

app.post("/api/email/config", (req, res) => {
  const { address, password, imap_host, imap_port, smtp_host, smtp_port, smtp_secure } = req.body as Record<string, string>;
  if (!address || !password || !imap_host || !smtp_host) {
    res.status(400).json({ error: "address, password, imap_host, and smtp_host are required." });
    return;
  }
  setSecret("EMAIL_ADDRESS",     address);
  setSecret("EMAIL_PASSWORD",    password);
  setSecret("EMAIL_IMAP_HOST",   imap_host);
  setSecret("EMAIL_IMAP_PORT",   imap_port  || "993");
  setSecret("EMAIL_SMTP_HOST",   smtp_host);
  setSecret("EMAIL_SMTP_PORT",   smtp_port  || "587");
  setSecret("EMAIL_SMTP_SECURE", smtp_secure === "true" ? "true" : "false");
  log.info(`Email configured for ${address}`);
  res.json({ ok: true });
});

app.delete("/api/email/config", (_req, res) => {
  for (const key of EMAIL_KEYS) deleteSecret(key);
  log.info("Email config cleared.");
  res.json({ ok: true });
});

app.post("/api/email/test", async (req, res) => {
  const { address, password, imap_host, imap_port, smtp_host, smtp_port, smtp_secure } = req.body as Record<string, string>;
  const results: { imap?: string; smtp?: string } = {};

  // Test IMAP
  try {
    const { ImapFlow } = await import("imapflow") as typeof import("imapflow");
    const client = new ImapFlow({
      host: imap_host, port: parseInt(imap_port || "993", 10),
      secure: (imap_port || "993") === "993",
      auth: { user: address, pass: password }, logger: false,
    });
    await client.connect();
    await client.logout();
    results.imap = "ok";
  } catch (e) { results.imap = String(e instanceof Error ? e.message : e); }

  // Test SMTP
  try {
    const nodemailer = await import("nodemailer");
    const t = nodemailer.createTransport({
      host: smtp_host, port: parseInt(smtp_port || "587", 10),
      secure: smtp_secure === "true",
      auth: { user: address, pass: password },
    });
    await t.verify();
    results.smtp = "ok";
  } catch (e) { results.smtp = String(e instanceof Error ? e.message : e); }

  res.json(results);
});

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get("/api/logs", (_req, res) => {
  const logsDir = join(ROOT, "logs");
  try {
    const files = readdirSync(logsDir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .reverse()
      .map((f) => {
        const stat = statSync(join(logsDir, f));
        return { filename: f, date: f.replace(".log", ""), size: stat.size };
      });
    res.json(files);
  } catch {
    res.json([]);
  }
});

app.get("/api/logs/:filename", (req, res) => {
  const { filename } = req.params;
  // Strict filename validation to prevent path traversal
  if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(filename)) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }
  res.json({ content: readText(join(ROOT, "logs", filename)) });
});

// ── Live model list from provider APIs ───────────────────────────────────────
app.get("/api/provider/models", async (req, res) => {
  const provider = req.query.provider as string;
  try {
    if (provider === "anthropic") {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) { res.json({ models: [] }); return; }
      const r = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      const data = await r.json() as { data?: { id: string }[] };
      const models = (data.data ?? []).map((m: { id: string }) => m.id);
      res.json({ models });
    } else if (provider === "openai") {
      const { isOpenAIConnected: oaiConnected, getAccessToken } = await import("../openai/auth");
      if (!oaiConnected()) { res.json({ models: [] }); return; }
      const OpenAI = (await import("openai")).default;
      const token  = await getAccessToken();
      const client = new OpenAI({ apiKey: token });
      const list   = await client.models.list();
      const models = list.data
        .map((m: { id: string }) => m.id)
        .filter((id: string) => id.startsWith("gpt-") || /^o\d/.test(id) || id.startsWith("codex"))
        .sort();
      res.json({ models });
    } else if (provider === "ollama") {
      const baseUrl = getOllamaBaseUrl();
      const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) { res.json({ models: [] }); return; }
      const data = await r.json() as { models?: { name: string }[] };
      const models = (data.models ?? []).map((m: { name: string }) => m.name);
      res.json({ models });
    } else {
      res.status(400).json({ error: "unknown provider" });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Restart ────────────────────────────────────────────────────────────────────
app.post("/api/restart", (_req, res) => {
  res.json({ ok: true });
  log.info("Restart requested via web admin — exiting for process manager to respawn.");
  setTimeout(() => process.exit(0), 300);
});

// ── OAuth routes ──────────────────────────────────────────────────────────────
app.use(createOAuthRouter(PORT));
app.use(createOpenAIRouter(PORT));
app.use(createAnthropicRouter(PORT));

// ── Serve SPA ─────────────────────────────────────────────────────────────────
// Static files from src/web/public (index.html + assets)
app.use(express.static(join(__dirname, "public")));

// Catch-all: serve index.html for any unmatched route (client-side routing)
app.get("/{*path}", (_req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────────
export function startWebServer(): void {
  app.listen(PORT, "0.0.0.0", () => {
    log.success(`Web admin → http://0.0.0.0:${PORT}`);
  });
}
