// Starts the scheduler — just the heartbeat pulse now.
// Cron-based schedules have been removed; use heartbeat.md for all reminders.
import { Bot } from "grammy";
import { log } from "../logger";
import { startHeartbeat } from "./heartbeat";

export function startScheduler(bot: Bot): void {
  startHeartbeat(bot);
  log.info("Scheduler started.");
}
