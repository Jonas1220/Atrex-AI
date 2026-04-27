// Sub-personality context management — each context has its own system prompt and memory.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

const CONTEXTS_DIR = join(process.cwd(), "config/contexts");
const RUNTIME_PATH = join(process.cwd(), "config/runtime.json");

export interface AgentContext {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  createdAt: string;
}

// ── Runtime state ─────────────────────────────────────────────────────────────

function readRuntime(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(RUNTIME_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeRuntime(data: Record<string, unknown>): void {
  writeFileSync(RUNTIME_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function getActiveContextId(): string {
  const rt = readRuntime();
  return (rt.activeContext as string) || "main";
}

export function setActiveContextId(id: string): void {
  writeRuntime({ ...readRuntime(), activeContext: id });
}

// ── Context files ─────────────────────────────────────────────────────────────

function ensureContextsDir(): void {
  mkdirSync(CONTEXTS_DIR, { recursive: true });
}

export function loadContext(id: string): AgentContext | null {
  try {
    return JSON.parse(readFileSync(join(CONTEXTS_DIR, `${id}.json`), "utf-8")) as AgentContext;
  } catch {
    return null;
  }
}

export function saveContext(ctx: AgentContext): void {
  ensureContextsDir();
  writeFileSync(join(CONTEXTS_DIR, `${ctx.id}.json`), JSON.stringify(ctx, null, 2), "utf-8");
}

export function listContexts(): AgentContext[] {
  ensureContextsDir();
  return readdirSync(CONTEXTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(CONTEXTS_DIR, f), "utf-8")) as AgentContext;
      } catch {
        return null;
      }
    })
    .filter((c): c is AgentContext => c !== null)
    .sort((a, b) => {
      if (a.id === "main") return -1;
      if (b.id === "main") return 1;
      return a.name.localeCompare(b.name);
    });
}

export function getActiveContext(): AgentContext {
  const id = getActiveContextId();
  return loadContext(id) ?? defaultMainContext();
}

function defaultMainContext(): AgentContext {
  return {
    id: "main",
    name: "Main",
    description: "Personal assistant — general help, calendar, and tasks",
    systemPrompt: "",
    createdAt: new Date().toISOString(),
  };
}

export function ensureMainContext(): void {
  ensureContextsDir();
  const path = join(CONTEXTS_DIR, "main.json");
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(defaultMainContext(), null, 2), "utf-8");
  }
}

// ── Lookup & creation ─────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

export function findContextByName(query: string): AgentContext | null {
  const all = listContexts();
  const lower = query.toLowerCase().trim();
  return (
    all.find((c) => c.id === lower) ??
    all.find((c) => c.name.toLowerCase() === lower) ??
    all.find((c) => c.name.toLowerCase().startsWith(lower)) ??
    null
  );
}

export function createContext(name: string, description: string): AgentContext {
  const id = slugify(name);
  const ctx: AgentContext = {
    id,
    name,
    description,
    systemPrompt: `You are now acting as ${name}. ${description}`.trim(),
    createdAt: new Date().toISOString(),
  };
  saveContext(ctx);
  return ctx;
}
