// Two-tier memory system: long-term (memory.md) persists forever, short-term (memory/<date>.md) auto-expires after 2 days.
// Each skill also has its own long-term memory file: memory/skills/<id>.md
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import { getActiveSkillId } from "../skills";

const LONG_TERM_PATH = join(process.cwd(), "memory/memory.md");
const MEMORY_DIR = join(process.cwd(), "memory");
const SKILL_MEMORY_DIR = join(process.cwd(), "memory/skills");

function skillMemoryPath(skillId: string): string {
  return join(SKILL_MEMORY_DIR, `${skillId}.md`);
}

function ensureSkillMemoryDir(): void {
  mkdirSync(SKILL_MEMORY_DIR, { recursive: true });
}

function ensureMemoryDir(): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function todayPath(): string {
  return join(MEMORY_DIR, `${todayDate()}.md`);
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

// Builds the memory section of the system prompt — includes long-term + skill memory + today/yesterday short-term
export function getMemoryForSystemPrompt(): string {
  const longTerm = readFile(LONG_TERM_PATH);

  const skillId = getActiveSkillId();
  const skillMemory = skillId !== "main" ? readFile(skillMemoryPath(skillId)) : "";

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const todayStr = today.toISOString().slice(0, 10);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const todayMemory = readFile(join(MEMORY_DIR, `${todayStr}.md`));
  const yesterdayMemory = readFile(join(MEMORY_DIR, `${yesterdayStr}.md`));

  const parts: string[] = [];

  if (longTerm.trim()) {
    parts.push(longTerm.trim());
  }

  if (skillMemory.trim()) {
    parts.push(`## Skill Memory — ${skillId}\n\n${skillMemory.trim()}`);
  }

  if (yesterdayMemory.trim()) {
    parts.push(`## Short-Term Memory — ${yesterdayStr} (yesterday)\n\n${yesterdayMemory.trim()}`);
  }

  if (todayMemory.trim()) {
    parts.push(`## Short-Term Memory — ${todayStr} (today)\n\n${todayMemory.trim()}`);
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : "";
}

export const memoryTools: Anthropic.Tool[] = [
  {
    name: "add_memory",
    description:
      "Save a memory. Use 'long_term' for facts relevant indefinitely (preferences, key decisions, important dates). " +
      "Use 'skill' for facts specific to the current active skill (e.g. workout logs in a Personal Trainer skill). " +
      "Use 'short_term' for daily context (what happened today, current tasks, temporary notes — stays in context 2 days).",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["long_term", "skill", "short_term"],
          description: "Where to store this memory. 'skill' saves to the active skill's memory file.",
        },
        content: {
          type: "string",
          description: "The memory to save. Be concise but include enough context to be useful later.",
        },
      },
      required: ["type", "content"],
    },
  },
  {
    name: "update_long_term_memory",
    description:
      "Rewrite the entire long-term memory file. Use this to curate, reorganize, or remove outdated memories. " +
      "The current content is in your system prompt under 'Long-Term Memory'.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The full new content of memory.md",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "recall_memory",
    description:
      "Read a specific day's short-term memory. Use this to look back further than yesterday. " +
      "You can also list available memory dates.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD format, or 'list' to see all available dates.",
        },
      },
      required: ["date"],
    },
  },
];

// Called automatically after every conversation exchange — logs what was discussed to short-term memory
export async function autoSaveMemory(userMessage: string, botResponse: string): Promise<void> {
  // Skip trivial exchanges (commands, very short messages)
  if (userMessage.startsWith("/") || userMessage.length < 10) return;

  ensureMemoryDir();
  const timestamp = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const path = todayPath();
  const current = readFile(path);

  const userPreview = userMessage.length > 100 ? userMessage.slice(0, 100) + "..." : userMessage;
  const botPreview = botResponse.length > 100 ? botResponse.slice(0, 100) + "..." : botResponse;
  const entry = `- [${timestamp}] User: ${userPreview} → Bot: ${botPreview}`;

  if (!current) {
    writeFileSync(path, `# ${todayDate()}\n\n${entry}\n`, "utf-8");
  } else {
    writeFileSync(path, current.trimEnd() + "\n" + entry + "\n", "utf-8");
  }
}

export const memoryHandlers: Record<string, (input: Record<string, unknown>) => Promise<string>> = {
  add_memory: async (input) => {
    const type = input.type as string;
    const content = input.content as string;
    const timestamp = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

    if (type === "long_term") {
      const current = readFile(LONG_TERM_PATH);
      const entry = `- ${content}`;
      const updated = current.trimEnd() + "\n" + entry + "\n";
      writeFileSync(LONG_TERM_PATH, updated, "utf-8");
      return "Saved to long-term memory.";
    }

    if (type === "skill") {
      const skillId = getActiveSkillId();
      ensureSkillMemoryDir();
      const path = skillMemoryPath(skillId);
      const current = readFile(path);
      const entry = `- [${timestamp}] ${content}`;
      if (!current) {
        writeFileSync(path, `# Skill Memory — ${skillId}\n\n${entry}\n`, "utf-8");
      } else {
        writeFileSync(path, current.trimEnd() + "\n" + entry + "\n", "utf-8");
      }
      return `Saved to skill memory (${skillId}).`;
    }

    // short_term
    ensureMemoryDir();
    const path = todayPath();
    const current = readFile(path);
    const entry = `- [${timestamp}] ${content}`;

    if (!current) {
      writeFileSync(path, `# ${todayDate()}\n\n${entry}\n`, "utf-8");
    } else {
      writeFileSync(path, current.trimEnd() + "\n" + entry + "\n", "utf-8");
    }

    return "Saved to today's short-term memory.";
  },

  update_long_term_memory: async (input) => {
    const content = input.content as string;
    writeFileSync(LONG_TERM_PATH, content, "utf-8");
    return "Long-term memory updated.";
  },

  recall_memory: async (input) => {
    const date = input.date as string;

    if (date === "list") {
      ensureMemoryDir();
      const files = readdirSync(MEMORY_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(".md", ""))
        .sort()
        .reverse();
      if (files.length === 0) return "No short-term memory files found.";
      return files.map((f) => `- ${f}`).join("\n");
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return "Invalid date format. Use YYYY-MM-DD.";
    }

    const path = join(MEMORY_DIR, `${date}.md`);
    if (!existsSync(path)) return `No memory found for ${date}.`;
    return readFileSync(path, "utf-8");
  },
};
