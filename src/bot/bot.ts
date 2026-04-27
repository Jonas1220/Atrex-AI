// Creates and configures the Grammy Telegram bot with commands and handlers.
import { Bot } from "grammy";
import { config } from "../config";
import { setTelegramSender } from "../logger";
import { registerHandlers } from "./handlers";

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken);

  bot.api.setMyCommands([
    { command: "skills",    description: "List all skills" },
    { command: "skill",     description: "Show active skill — /skill <name> to override" },
    { command: "btw",       description: "One-shot question — no context, not saved to history" },
    { command: "clear",     description: "Reset conversation history" },
    { command: "plugins",   description: "Show installed plugins & secrets" },
    { command: "status",    description: "Health check — uptime, model, context, plugins" },
    { command: "logs",      description: "Show recent log lines — /logs [n] (default 30, max 100)" },
    { command: "purgelogs", description: "Delete logs older than yesterday" },
    { command: "debug",     description: "Toggle live logs in chat" },
    { command: "openai_login",  description: "Connect OpenAI via ChatGPT subscription OAuth" },
    { command: "email_setup",  description: "Configure agent email: /email_setup addr pass imap_host imap_port smtp_host smtp_port" },
    { command: "help",      description: "Show available commands" },
  ]);

  // Give the logger a way to send messages to Telegram
  setTelegramSender(async (userId, text) => {
    await bot.api.sendMessage(userId, text);
  });

  registerHandlers(bot);
  return bot;
}
