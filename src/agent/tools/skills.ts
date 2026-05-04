import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { loadSkill, setActiveSkillId } from "../skills";

const SKILL_MEMORY_DIR = join(process.cwd(), "config/skill-memory");

function readSkillMemory(skillId: string): string {
  try {
    return readFileSync(join(SKILL_MEMORY_DIR, `${skillId}.md`), "utf-8");
  } catch {
    return "";
  }
}

export const skillTools: Anthropic.Tool[] = [
  {
    name: "use_skill",
    description:
      "Activate a skill to load its focused instructions and memory. " +
      "Call this when the user's request clearly matches a skill's domain — before composing your response. " +
      "The returned instructions apply immediately for this response and stay active for future messages.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The skill id to activate (from the Available Skills list in your system prompt).",
        },
      },
      required: ["id"],
    },
  },
];

export const skillHandlers: Record<string, (input: Record<string, unknown>) => Promise<string>> = {
  use_skill: async (input) => {
    const id = input.id as string;
    const skill = loadSkill(id);
    if (!skill) {
      return `No skill found with id "${id}". Check the Available Skills list in your system prompt.`;
    }

    setActiveSkillId(id);

    const memory = readSkillMemory(id);

    const parts: string[] = [`## Skill activated: ${skill.name}`];
    if (skill.systemPrompt?.trim()) {
      parts.push(`### Focus Instructions\n\n${skill.systemPrompt.trim()}`);
    }
    if (memory.trim()) {
      parts.push(`### Skill Memory\n\n${memory.trim()}`);
    }
    parts.push("Apply these instructions for your response.");

    return parts.join("\n\n");
  },
};
