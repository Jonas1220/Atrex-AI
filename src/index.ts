// Entry point — boots messaging platforms, loads plugins, starts the scheduler, and starts the web admin.
// If no platform credentials are configured, only the web server starts (setup mode).
import { isConfigured, config } from "./config"; // must be first — runs dotenv.config()
import { log } from "./logger";
import { startWebServer } from "./web/server";

// Web server always starts — needed for both setup mode and normal operation
startWebServer();

if (!isConfigured) {
  log.warn("Atrexai not configured — running in setup mode. Visit http://localhost:3000");
} else {
  const { loadAllEnabled } = require("./plugins/loader");
  const { startScheduler } = require("./scheduler/runner");

  let bot: import("grammy").Bot | null = null;

  // ── Telegram ────────────────────────────────────────────────────────────────
  if (config.telegramToken) {
    // Only import and start grammY when a token is present — prevents API calls with empty token.
    const { createBot } = require("./bot/bot");
    const { setBotInstance } = require("./bot/instance");

    bot = createBot();
    setBotInstance(bot);

    bot!.catch((err: unknown) => {
      log.error(`Unhandled: ${err instanceof Error ? err.message : String(err)}`);
    });

    bot!.start({
      onStart: () => {
        log.success("Telegram online.");
      },
    }).catch((err: unknown) => {
      log.error(`Failed to start Telegram: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // ── Shared services ─────────────────────────────────────────────────────────
  loadAllEnabled();
  startScheduler(bot);
  log.success("Atrexai online.");

  process.once("SIGINT",  () => { log.info("SIGINT received — shutting down.");  bot?.stop(); });
  process.once("SIGTERM", () => { log.info("SIGTERM received — shutting down."); bot?.stop(); });
}
