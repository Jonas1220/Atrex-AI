// Terminal-based setup wizard for Atrex AI.
// Designed for headless installs (VPS) where the dashboard isn't reachable.
// Run via `atrex setup` (which executes `node dist/setup-cli.js` from the install dir).
import { createInterface, Interface } from "readline";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const ENV_PATH = join(ROOT, ".env");

// ── ANSI ──────────────────────────────────────────────────────────────────────
const c = {
  bold:  "\x1b[1m",
  dim:   "\x1b[2m",
  red:   "\x1b[31m",
  green: "\x1b[32m",
  amber: "\x1b[33m",
  cyan:  "\x1b[36m",
  reset: "\x1b[0m",
};

const ok      = (s: string) => console.log(`  ${c.green}✓${c.reset}  ${s}`);
const info    = (s: string) => console.log(`  ${c.cyan}→${c.reset}  ${s}`);
const warn    = (s: string) => console.log(`  ${c.amber}!${c.reset}  ${s}`);
const heading = (s: string) => {
  console.log("");
  console.log(`${c.bold}${s}${c.reset}`);
  console.log(`${c.dim}─────────────────────────────────────────────${c.reset}`);
};

// ── .env reader/writer (matches src/web/server.ts updateEnvFile) ─────────────
function readEnvVar(key: string): string {
  try {
    const lines = readFileSync(ENV_PATH, "utf-8").split("\n");
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
      if (m && m[1] === key) return m[2];
    }
  } catch {}
  return "";
}

function updateEnv(updates: Record<string, string>): void {
  let content = "";
  try { content = readFileSync(ENV_PATH, "utf-8"); } catch {}

  const lines = content.split("\n");
  const written = new Set<string>();

  const patched = lines.map((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
    if (m && updates[m[1]] !== undefined && updates[m[1]] !== "") {
      written.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key) && value !== "") patched.push(`${key}=${value}`);
  }

  writeFileSync(ENV_PATH, patched.join("\n"), "utf-8");
}

// ── Config seeding (matches src/web/server.ts ensureConfigDefaults) ──────────
function ensureConfig(): void {
  mkdirSync(join(ROOT, "config"), { recursive: true });

  const settingsPath = join(ROOT, "config", "settings.json");
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, JSON.stringify({
      model:       "claude-sonnet-4-6",
      max_tokens:  1024,
      max_history: 50,
      timezone:    "UTC",
    }, null, 2), "utf-8");
  }

  for (const f of readdirSync(join(ROOT, "config"))) {
    if (!f.endsWith(".initial.md")) continue;
    const dest = join(ROOT, "config", f.replace(".initial.md", ".md"));
    if (!existsSync(dest)) copyFileSync(join(ROOT, "config", f), dest);
  }
}

function setProvider(provider: string): void {
  const settingsPath = join(ROOT, "config", "settings.json");
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
  cfg.provider = provider;
  const defaults: Record<string, string> = {
    anthropic: "claude-sonnet-4-6",
    openai:    "gpt-4o",
    moonshot:  "kimi-k2.6",
    ollama:    "llama3.2",
  };
  if (!cfg.model || cfg.model === "claude-sonnet-4-6") {
    cfg.model = defaults[provider];
  }
  writeFileSync(settingsPath, JSON.stringify(cfg, null, 2), "utf-8");
}

// ── Prompt helpers ────────────────────────────────────────────────────────────
// One readline owns stdin's data flow. For hidden TTY input we pause it,
// take over stdin in raw mode, then resume — so masked input doesn't leak.
function ask(rl: Interface, question: string, def?: string): Promise<string> {
  const prompt = def ? `  ${question} ${c.dim}[${def}]${c.reset}: ` : `  ${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => resolve((ans || "").trim() || def || ""));
  });
}

function maskedDefault(value: string): string | undefined {
  if (!value) return undefined;
  if (value.length <= 6) return "•••";
  return `${value.slice(0, 4)}…${value.slice(-3)}`;
}

function askHidden(rl: Interface, question: string, def?: string): Promise<string> {
  const masked = def ? maskedDefault(def) : "";
  const promptLabel = masked
    ? `  ${question} ${c.dim}[${masked}, enter to keep]${c.reset}: `
    : `  ${question}: `;

  // Non-TTY: just use the shared readline. The default is masked in the prompt
  // so secrets are never echoed to stdout, but pressing enter returns the real
  // default value to the caller.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return new Promise((resolve) => {
      rl.question(promptLabel, (ans) => resolve((ans || "").trim() || def || ""));
    });
  }

  // TTY: pause the readline and take over stdin so we can mask keystrokes.
  process.stdout.write(promptLabel);
  return new Promise((resolve, reject) => {
    rl.pause();
    let input = "";
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onErr);
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          process.stdout.write("\n");
          // Hand stdin control back to readline for subsequent prompts.
          rl.resume();
          resolve(input || def || "");
          return;
        }
        if (ch === "") { // Ctrl-C
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "" || ch === "\b") { // backspace / DEL
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else if (ch >= " ") {
          input += ch;
          process.stdout.write("•");
        }
      }
    };
    const onErr = (e: Error) => { cleanup(); reject(e); };

    stdin.on("data", onData);
    stdin.on("error", onErr);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Banner
  console.log("");
  console.log(`${c.bold}${c.amber}    ___  ________________  __  ___    ____${c.reset}`);
  console.log(`${c.bold}${c.amber}   / _ | /_  __/ ___/ __/ | |/_/ |  / /  |${c.reset}`);
  console.log(`${c.bold}${c.amber}  / __ |  / / / /  / _/  _>  < | | / / /| |${c.reset}`);
  console.log(`${c.bold}${c.amber} /_/ |_| /_/ /_/  /___/ /_/|_| |_|/_/_/ |_|${c.reset}`);
  console.log("");
  console.log(`  ${c.dim}Terminal setup wizard${c.reset}`);

  ensureConfig();

  // ── Step 1: Telegram ───────────────────────────────────────────────────────
  heading("Step 1 of 3 — Telegram bot");
  console.log(`  Create a bot with ${c.bold}@BotFather${c.reset} on Telegram, then paste the token below.`);
  console.log("");

  const existingTg = readEnvVar("TELEGRAM_BOT_TOKEN");
  let tgToken = "";
  while (!tgToken) {
    tgToken = await askHidden(rl, "Telegram bot token", existingTg || undefined);
    if (!tgToken) warn("Token is required.");
  }

  // ── Step 2: AI Provider ────────────────────────────────────────────────────
  heading("Step 2 of 3 — AI provider");
  console.log(`  Choose your LLM provider:`);
  console.log("");
  console.log(`    ${c.amber}1${c.reset}) Anthropic ${c.dim}(Claude — API key)${c.reset}`);
  console.log(`    ${c.amber}2${c.reset}) OpenAI    ${c.dim}(GPT — OAuth, browser required)${c.reset}`);
  console.log(`    ${c.amber}3${c.reset}) Moonshot  ${c.dim}(Kimi — API key)${c.reset}`);
  console.log(`    ${c.amber}4${c.reset}) Ollama    ${c.dim}(local models — URL only)${c.reset}`);
  console.log("");

  let provider = "";
  while (!provider) {
    const choice = await ask(rl, "Choice [1-4]", "1");
    switch (choice) {
      case "1": provider = "anthropic"; break;
      case "2": provider = "openai";    break;
      case "3": provider = "moonshot";  break;
      case "4": provider = "ollama";    break;
      default:  warn("Enter 1, 2, 3, or 4.");
    }
  }

  console.log("");
  const updates: Record<string, string> = { TELEGRAM_BOT_TOKEN: tgToken };

  if (provider === "anthropic") {
    const existing = readEnvVar("ANTHROPIC_API_KEY");
    let key = "";
    while (!key) {
      key = await askHidden(rl, "Anthropic API key (sk-ant-…)", existing || undefined);
      if (!key) warn("Required.");
    }
    if (key !== existing) updates.ANTHROPIC_API_KEY = key;
  } else if (provider === "openai") {
    info(`OpenAI uses OAuth — a browser is required for the initial connection.`);
    info(`After this wizard, finish the connection on a machine with a browser:`);
    console.log("");
    console.log(`    ${c.dim}On a desktop:${c.reset}  ${c.amber}atrex open${c.reset}`);
    console.log(`    ${c.dim}On a VPS:${c.reset}     forward the dashboard port over SSH:`);
    console.log(`    ${c.dim}              ssh -L <port>:localhost:<port> user@vps${c.reset}`);
    console.log(`    ${c.dim}              then open http://localhost:<port> on your laptop${c.reset}`);
    console.log("");
  } else if (provider === "moonshot") {
    const existing = readEnvVar("MOONSHOT_API_KEY");
    let key = "";
    while (!key) {
      key = await askHidden(rl, "Moonshot API key (sk-…)", existing || undefined);
      if (!key) warn("Required.");
    }
    if (key !== existing) updates.MOONSHOT_API_KEY = key;
  } else if (provider === "ollama") {
    const existing = readEnvVar("OLLAMA_BASE_URL") || "http://localhost:11434";
    const url = await ask(rl, "Ollama base URL", existing);
    updates.OLLAMA_BASE_URL = url.replace(/\/$/, "");
  }

  // ── Step 3: Allowed users (optional) ───────────────────────────────────────
  heading("Step 3 of 3 — Allowed Telegram users (optional)");
  console.log(`  Restrict the bot to specific users by Telegram ID.`);
  console.log(`  ${c.dim}Get your ID from @userinfobot. Comma-separated for multiple users.${c.reset}`);
  console.log(`  ${c.dim}Empty = anyone can talk to the bot (not recommended).${c.reset}`);
  console.log("");

  const existingIds = readEnvVar("ALLOWED_USER_IDS");
  const allowedIds = await ask(rl, "Allowed user IDs", existingIds || undefined);
  if (allowedIds !== existingIds) updates.ALLOWED_USER_IDS = allowedIds;

  // ── Save ───────────────────────────────────────────────────────────────────
  rl.close();
  console.log("");
  updateEnv(updates);
  setProvider(provider);

  ok("Saved credentials to .env");
  ok(`Provider set to ${c.bold}${provider}${c.reset}`);

  // ── Done ───────────────────────────────────────────────────────────────────
  const port = readEnvVar("WEB_ADMIN_PORT") || "3000";
  console.log("");
  console.log(`${c.dim}─────────────────────────────────────────────${c.reset}`);
  console.log(`  ${c.green}${c.bold}Setup complete.${c.reset}`);
  console.log(`${c.dim}─────────────────────────────────────────────${c.reset}`);
  console.log("");
  console.log(`  Start the agent:  ${c.amber}atrex start${c.reset}`);
  console.log(`  Check status:     ${c.amber}atrex status${c.reset}`);
  console.log(`  Tail logs:        ${c.amber}atrex logs${c.reset}`);
  console.log("");
  console.log(`  ${c.dim}Advanced config (plugins, soul, skills, agents) lives in the dashboard:${c.reset}`);
  console.log(`  ${c.dim}    http://localhost:${port}${c.reset}`);
  console.log(`  ${c.dim}    Token: run ${c.amber}atrex token${c.reset}${c.dim} to retrieve it.${c.reset}`);
  console.log("");
}

main().catch((err) => {
  console.error("");
  console.error(`  ${c.red}✗${c.reset}  Setup failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error("");
  process.exit(1);
});
