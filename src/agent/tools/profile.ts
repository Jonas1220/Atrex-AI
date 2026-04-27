// Tools for editing user.md (user profile) and soul.md (bot personality) at runtime.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const USER_PROFILE_PATH = join(process.cwd(), "config/user.md");
const SOUL_PATH = join(process.cwd(), "config/soul.md");

function readProfile(): string {
  try {
    return readFileSync(USER_PROFILE_PATH, "utf-8");
  } catch {
    return "";
  }
}

function writeProfile(content: string): void {
  writeFileSync(USER_PROFILE_PATH, content, "utf-8");
}

export const profileTools: Anthropic.Tool[] = [
  {
    name: "update_user_profile",
    description:
      "Update the user's profile (user.md). You can see the current profile in your system prompt. " +
      "Call this tool with the full updated file content whenever you learn new information about the user. " +
      "Preserve existing information — only add or correct fields, never remove unless the user asks.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The full updated content of user.md",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "update_soul",
    description:
      "Update your own personality and behavior rules (soul.md). You can see the current soul in your system prompt. " +
      "Only use this when the user explicitly asks you to change your name, personality, tone, or behavior. " +
      "Never change your soul on your own initiative.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The full updated content of soul.md",
        },
      },
      required: ["content"],
    },
  },
];

export const profileHandlers: Record<string, (input: Record<string, unknown>) => Promise<string>> = {
  update_user_profile: async (input) => {
    const content = input.content as string;
    const before = readProfile();
    writeProfile(content);
    const linesChanged = content.split("\n").length - before.split("\n").length;
    return `Profile updated (${linesChanged >= 0 ? "+" : ""}${linesChanged} lines).`;
  },
  update_soul: async (input) => {
    const content = input.content as string;
    writeFileSync(SOUL_PATH, content, "utf-8");
    return "Soul updated. Changes take effect on the next message.";
  },
};
