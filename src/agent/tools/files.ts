// Tool for creating files in the output/ folder and optionally sending them via Telegram.
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { InputFile } from "grammy";
import { getBotInstance } from "../../bot/instance";
import type { ToolHandler } from "./types";

const OUTPUT_DIR = join(process.cwd(), "output");

function ensureOutputDir(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\-\s]/g, "").trim().replace(/\s+/g, "_") || "output.md";
}

export const fileTools: Anthropic.Tool[] = [
  {
    name: "create_file",
    description:
      "Create a file and save it to the output/ folder. " +
      "Use this whenever the user asks you to write, generate, or export a document — " +
      "markdown notes, reports, plans, code files, CSV exports, anything. " +
      "Set send_to_telegram to true to also deliver the file as a Telegram document.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: {
          type: "string",
          description: "File name including extension (e.g. 'plan.md', 'notes.txt', 'report.csv'). Keep it short and descriptive.",
        },
        content: {
          type: "string",
          description: "Full content of the file.",
        },
        send_to_telegram: {
          type: "boolean",
          description: "If true, send the file as a Telegram document in addition to saving it.",
        },
      },
      required: ["filename", "content"],
    },
  },
];

export const fileHandlers: Record<string, ToolHandler> = {
  create_file: async (input, ctx) => {
    const filename = sanitizeFilename(input.filename as string);
    const content = input.content as string;
    const sendToTelegram = !!(input.send_to_telegram as boolean);

    ensureOutputDir();
    const filePath = join(OUTPUT_DIR, filename);
    writeFileSync(filePath, content, "utf-8");

    if (sendToTelegram && ctx.userId) {
      try {
        const bot = getBotInstance();
        await bot.api.sendDocument(ctx.userId, new InputFile(Buffer.from(content, "utf-8"), filename));
        return `File saved to output/${filename} and sent via Telegram.`;
      } catch (err) {
        return `File saved to output/${filename} but Telegram delivery failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return `File saved to output/${filename}.`;
  },
};
