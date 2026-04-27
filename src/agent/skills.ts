import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

const SKILLS_DIR = join(process.cwd(), "config/skills");
const RUNTIME_PATH = join(process.cwd(), "config/runtime.json");

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  createdAt: string;
  model?: string;
}

// ── Frontmatter helpers ───────────────────────────────────────────────────────
// Skills are stored as .md files with YAML frontmatter:
//
//   ---
//   name: Web Developer
//   description: Build and debug websites and web apps
//   createdAt: 2026-04-21T...
//   ---
//
//   Focus instructions go here as free-form markdown...

function parseFrontmatter(raw: string, id: string): AgentSkill {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    // No frontmatter — treat entire content as systemPrompt
    return { id, name: id, description: "", systemPrompt: raw.trim(), createdAt: new Date().toISOString() };
  }

  const front = match[1];
  const body = match[2].trim();

  const get = (key: string): string => {
    const m = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };

  const model = get("model");
  return {
    id,
    name:         get("name")        || id,
    description:  get("description") || "",
    systemPrompt: body,
    createdAt:    get("createdAt")   || new Date().toISOString(),
    ...(model ? { model } : {}),
  };
}

function serializeFrontmatter(skill: AgentSkill): string {
  const lines = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `createdAt: ${skill.createdAt}`,
  ];
  if (skill.model) lines.push(`model: ${skill.model}`);
  lines.push("---");
  const front = lines.join("\n");
  return skill.systemPrompt.trim()
    ? `${front}\n\n${skill.systemPrompt.trim()}\n`
    : `${front}\n`;
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

export function getActiveSkillId(): string {
  const rt = readRuntime();
  return (rt.activeSkill as string) || "main";
}

export function setActiveSkillId(id: string): void {
  writeRuntime({ ...readRuntime(), activeSkill: id });
}

// ── Skill files ───────────────────────────────────────────────────────────────

function ensureSkillsDir(): void {
  mkdirSync(SKILLS_DIR, { recursive: true });
}

export function loadSkill(id: string): AgentSkill | null {
  try {
    const raw = readFileSync(join(SKILLS_DIR, `${id}.md`), "utf-8");
    return parseFrontmatter(raw, id);
  } catch {
    return null;
  }
}

export function saveSkill(skill: AgentSkill): void {
  ensureSkillsDir();
  writeFileSync(join(SKILLS_DIR, `${skill.id}.md`), serializeFrontmatter(skill), "utf-8");
}

export function listSkills(): AgentSkill[] {
  ensureSkillsDir();
  return readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      try {
        const id = f.replace(/\.md$/, "");
        const raw = readFileSync(join(SKILLS_DIR, f), "utf-8");
        return parseFrontmatter(raw, id);
      } catch {
        return null;
      }
    })
    .filter((s): s is AgentSkill => s !== null)
    .sort((a, b) => {
      if (a.id === "main") return -1;
      if (b.id === "main") return 1;
      return a.name.localeCompare(b.name);
    });
}

export function getActiveSkill(): AgentSkill {
  const id = getActiveSkillId();
  return loadSkill(id) ?? defaultMainSkill();
}

function defaultMainSkill(): AgentSkill {
  return {
    id: "main",
    name: "General",
    description: "General personal assistant — calendar, tasks, and everyday help",
    systemPrompt: "",
    createdAt: new Date().toISOString(),
  };
}

export function ensureMainSkill(): void {
  ensureSkillsDir();
  const path = join(SKILLS_DIR, "main.md");
  if (!existsSync(path)) {
    saveSkill(defaultMainSkill());
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

export function findSkillByName(query: string): AgentSkill | null {
  const all = listSkills();
  const lower = query.toLowerCase().trim();
  return (
    all.find((s) => s.id === lower) ??
    all.find((s) => s.name.toLowerCase() === lower) ??
    all.find((s) => s.name.toLowerCase().startsWith(lower)) ??
    null
  );
}

export function createSkill(name: string, description: string): AgentSkill {
  const skill: AgentSkill = {
    id: slugify(name),
    name,
    description,
    systemPrompt: "",
    createdAt: new Date().toISOString(),
  };
  saveSkill(skill);
  return skill;
}
