// Tool for sending Telegram messages with inline reply buttons.
import Anthropic from "@anthropic-ai/sdk";
import { InlineKeyboard } from "grammy";
import { getBotInstance } from "../../bot/instance";
import type { ToolHandler } from "./types";

export const buttonTools: Anthropic.Tool[] = [
  {
    name: "send_buttons",
    description:
      "Send a message to the user with clickable inline reply buttons. " +
      "Use this for confirmation prompts (Yes/No), quick-reply options, or multi-choice follow-ups. " +
      "Each button becomes a tappable option in Telegram. When the user taps one, their choice is sent back to you automatically.",
    input_schema: {
      type: "object" as const,
      properties: {
        message: {
          type: "string",
          description: "The message text to display above the buttons.",
        },
        buttons: {
          type: "array",
          description: "List of button labels. Each label becomes one button. Keep labels short (1-4 words).",
          items: { type: "string" },
          minItems: 1,
          maxItems: 8,
        },
      },
      required: ["message", "buttons"],
    },
  },
];

export const buttonHandlers: Record<string, ToolHandler> = {
  send_buttons: async (input, ctx) => {
    if (!ctx.userId) return "No active user — cannot send buttons.";

    const message = input.message as string;
    const labels = input.buttons as string[];

    const keyboard = new InlineKeyboard();
    for (const label of labels) {
      // Each button on its own row; callback_data capped at 64 bytes
      keyboard.text(label, label.slice(0, 64)).row();
    }

    const bot = getBotInstance();
    await bot.api.sendMessage(ctx.userId, message, { reply_markup: keyboard });

    return `Buttons sent to user with options: ${labels.join(", ")}`;
  },
};
