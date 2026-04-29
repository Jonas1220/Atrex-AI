// Memory system: long-term (memory.md) persists forever. Each skill also has its own memory file.
// There is no short-term memory — anything worth keeping goes to long-term.
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
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

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

// Builds the memory section of the system prompt — long-term + active skill memory
export function getMemoryForSystemPrompt(): string {
  const longTerm = readFile(LONG_TERM_PATH);

  const skillId = getActiveSkillId();
  const skillMemory = skillId !== "main" ? readFile(skillMemoryPath(skillId)) : "";

  const parts: string[] = [];

  if (longTerm.trim()) {
    parts.push(longTerm.trim());
  }

  if (skillMemory.trim()) {
    parts.push(`## Skill Memory — ${skillId}\n\n${skillMemory.trim()}`);
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : "";
}

export const memoryTools: Anthropic.Tool[] = [
  {
    name: "add_memory",
    description:
      "Save a memory. Use 'long_term' for anything worth keeping across sessions: preferences, decisions, projects, deadlines, key people, lessons, anything the user asked you to remember. " +
      "Use 'skill' for facts specific to the current active skill (e.g. workout logs in a Personal Trainer skill). " +
      "There is no short-term memory — if it's worth saving, use 'long_term'.",
    input_schema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["long_term", "skill"],
          description: "Where to store this memory.",
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
      "The current content is in your system prompt under 'Long-Term Memory'. " +
      "Use this during the daily 03:00 cleanup heartbeat or any time memory feels cluttered.",
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
];

export const memoryHandlers: Record<string, (input: Record<string, unknown>) => Promise<string>> = {
  add_memory: async (input) => {
    const type = input.type as string;
    const content = input.content as string;
    const timestamp = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

    if (type === "long_term") {
      mkdirSync(MEMORY_DIR, { recursive: true });
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

    return `Unknown memory type: ${type}`;
  },

  update_long_term_memory: async (input) => {
    const content = input.content as string;
    mkdirSync(MEMORY_DIR, { recursive: true });
    writeFileSync(LONG_TERM_PATH, content, "utf-8");
    return "Long-term memory updated.";
  },
};
