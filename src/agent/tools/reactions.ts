// Tool for reacting to the user's Telegram message with an emoji.
import Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "./types";

const ALLOWED_REACTIONS = ["👀", "👌", "🤮", "🤔", "👍", "👎", "🔥", "🎉"] as const;
type AllowedReaction = (typeof ALLOWED_REACTIONS)[number];

export const reactionTools: Anthropic.Tool[] = [
  {
    name: "send_reaction",
    description:
      "React to the user's message with an emoji. " +
      "Use this to give quick non-verbal feedback before or after a longer response. " +
      "👀 = working on it, 👌 = done/OK, 🤮 = won't do that, 🤔 = thinking, 👍/👎 = agree/disagree, 🔥 = great, 🎉 = congrats. " +
      "Only works in Telegram chats.",
    input_schema: {
      type: "object" as const,
      properties: {
        emoji: {
          type: "string",
          enum: [...ALLOWED_REACTIONS],
          description: "The emoji reaction to send.",
        },
      },
      required: ["emoji"],
    },
  },
];

export const reactionHandlers: Record<string, ToolHandler> = {
  send_reaction: async (input, ctx) => {
    if (!ctx.chatId || !ctx.messageId) {
      return "Reactions are only available in Telegram chats.";
    }

    const emoji = input.emoji as string;
    if (!ALLOWED_REACTIONS.includes(emoji as AllowedReaction)) {
      return `Unknown reaction "${emoji}". Allowed: ${ALLOWED_REACTIONS.join(" ")}`;
    }

    try {
      const { getBotInstance } = await import("../../bot/instance");
      const bot = getBotInstance();
      await bot.api.setMessageReaction(ctx.chatId, ctx.messageId, [
        { type: "emoji", emoji: emoji as AllowedReaction },
      ]);
      return `Reacted with ${emoji}`;
    } catch (err) {
      return `Failed to send reaction: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
