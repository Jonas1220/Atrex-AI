// Escalation — lets the agent ask the user to temporarily switch to a more powerful model.
// The tool sends inline buttons; the bot handler intercepts the response directly.
import Anthropic from "@anthropic-ai/sdk";
import { InlineKeyboard } from "grammy";
import { getBotInstance } from "../bot/instance";
import { settings } from "../config";
import type { ToolHandler } from "./tools/types";

// Per-user escalation state. Lasts until the conversation is cleared.
const escalatedUsers = new Set<number>();

export function isEscalated(userId: number): boolean {
  return escalatedUsers.has(userId);
}

export function setEscalated(userId: number): void {
  escalatedUsers.add(userId);
}

export function clearEscalation(userId: number): void {
  escalatedUsers.delete(userId);
}

// Special callback_data values — intercepted in handlers.ts before reaching the agent.
export const ESCALATE_YES = "__escalate_yes__";
export const ESCALATE_NO  = "__escalate_no__";

export const escalationTools: Anthropic.Tool[] = settings.ask_for_escalation
  ? [
      {
        name: "request_escalation",
        description:
          `Ask the user for permission to switch to ${settings.escalation_model} for this task. ` +
          `Use when the task needs deeper reasoning, complex analysis, or nuanced writing that the current model is struggling with. ` +
          `The user will be shown Yes/No buttons and you will be notified of their choice. ` +
          `Do not use for simple tasks — only escalate when it genuinely matters.`,
        input_schema: {
          type: "object" as const,
          properties: {
            reason: {
              type: "string",
              description: "One sentence explaining why the stronger model would help (shown to the user).",
            },
          },
          required: ["reason"],
        },
      },
    ]
  : [];

export const escalationHandlers: Record<string, ToolHandler> = settings.ask_for_escalation
  ? {
      request_escalation: async (input, ctx) => {
        if (isEscalated(ctx.userId)) return "Already using the escalated model.";

        const reason = input.reason as string;
        const keyboard = new InlineKeyboard()
          .text(`Yes, use ${settings.escalation_model}`, ESCALATE_YES)
          .row()
          .text("No, keep going", ESCALATE_NO);

        const bot = getBotInstance();
        await bot.api.sendMessage(
          ctx.userId,
          `This task might need more power.\n\n${reason}\n\nSwitch to ${settings.escalation_model}?`,
          { reply_markup: keyboard }
        );

        return "Escalation request sent to user.";
      },
    }
  : {};
