// Singleton bot reference so other modules (e.g. scheduler) can send messages without circular imports.
import { Bot } from "grammy";

let botInstance: Bot | null = null;

export function setBotInstance(bot: Bot): void {
  botInstance = bot;
}

export function getBotInstance(): Bot {
  if (!botInstance) throw new Error("Bot not initialized");
  return botInstance;
}
