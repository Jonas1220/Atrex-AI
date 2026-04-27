// Heartbeat pulse — fires every 30 minutes and lets the agent check heartbeat.md
// for due items. The agent responds either with "NONE" (nothing to do) or with
// the text of a user-facing message, which we forward verbatim via Telegram.
import cron from "node-cron";
import { Bot } from "grammy";
import { chatOnce } from "../agent/agent";
import { config, settings } from "../config";
import { log } from "../logger";
import { ensureHeartbeat, getDueItems } from "../agent/tools/heartbeat";

const PULSE_CRON = "*/30 * * * *";

let pulsing = false;

function buildPulsePrompt(dueItems: string[]): string {
  const now = new Date().toLocaleString("en-GB", {
    timeZone: settings.timezone,
    year:   "numeric",
    month:  "2-digit",
    day:    "2-digit",
    hour:   "2-digit",
    minute: "2-digit",
  });

  const itemList = dueItems.map((item) => `  ${item}`).join("\n");

  return (
    `[HEARTBEAT PULSE] Current time: ${now} (${settings.timezone}).\n\n` +
    `The following heartbeat items are due right now:\n\n${itemList}\n\n` +
    `For each item:\n` +
    `- Send the user a short, friendly message. Whatever plain text you return will be sent verbatim via Telegram.\n` +
    `- Call update_heartbeat to remove fired one-shots (leave recurring items — the schedule implies the next occurrence).\n` +
    `- If you already sent a message via send_buttons or another tool, respond NONE so we don't double-send.\n\n` +
    `Respond with the message text, or exactly NONE if nothing needs sending.`
  );
}

export function startHeartbeat(bot: Bot): void {
  const [userId] = config.allowedUserIds;
  if (!userId) {
    log.info("Heartbeat disabled — no allowed users configured.");
    return;
  }

  ensureHeartbeat();

  if (!cron.validate(PULSE_CRON)) {
    log.error(`Invalid heartbeat cron: ${PULSE_CRON}`);
    return;
  }

  cron.schedule(
    PULSE_CRON,
    async () => {
      if (pulsing) {
        log.warn("Heartbeat: previous pulse still running, skipping this tick.");
        return;
      }
      // Suppress pulses during quiet hours to avoid unnecessary API calls at night.
      const { quiet_hours_start: start, quiet_hours_end: end } = settings;
      if (start !== end) {
        const hour = new Date().toLocaleString("en-GB", { timeZone: settings.timezone, hour: "numeric", hour12: false });
        const h = parseInt(hour, 10);
        const inQuiet = start > end ? (h >= start || h < end) : (h >= start && h < end);
        if (inQuiet) {
          log.info(`Heartbeat: quiet hours (${start}–${end}), skipping.`);
          return;
        }
      }
      // Parse due items in code — no AI needed. Only call Claude if something is actually due.
      const dueItems = getDueItems(settings.timezone);
      if (dueItems.length === 0) {
        log.info("Heartbeat: nothing due, skipping pulse.");
        return;
      }
      pulsing = true;
      try {
        log.info(`Heartbeat: ${dueItems.length} item(s) due — calling agent.`);
        const prompt = buildPulsePrompt(dueItems);
        const response = await chatOnce(userId, prompt, undefined, "heartbeat");
        const trimmed = response.trim();
        if (!trimmed || trimmed.toUpperCase() === "NONE") {
          log.info("Heartbeat: nothing due.");
          return;
        }
        await bot.api.sendMessage(userId, trimmed);
        log.success(`Heartbeat fired → user ${userId}`);
      } catch (err) {
        log.error(`Heartbeat pulse failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        pulsing = false;
      }
    },
    { timezone: settings.timezone }
  );

  log.info(`Heartbeat registered (every 30 min, ${settings.timezone}).`);
}
