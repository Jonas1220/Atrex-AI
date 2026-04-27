// Logging with colored terminal output, daily log files, and optional live forwarding to Telegram.
import { appendFileSync, unlinkSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const LOG_DIR = join(process.cwd(), "logs");
const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

// Debug mode: per-user set of user IDs with debug enabled
const debugUsers = new Set<number>();

// Telegram sender — set by bot after init
let telegramSender: ((userId: number, text: string) => Promise<void>) | null = null;

export function setTelegramSender(fn: (userId: number, text: string) => Promise<void>): void {
  telegramSender = fn;
}

export function toggleDebug(userId: number): boolean {
  if (debugUsers.has(userId)) {
    debugUsers.delete(userId);
    return false;
  }
  debugUsers.add(userId);
  return true;
}

export function isDebugEnabled(userId: number): boolean {
  return debugUsers.has(userId);
}

// Forwards log lines to all users who have /debug mode enabled
function sendToTelegram(level: string, message: string): void {
  if (!telegramSender || debugUsers.size === 0) return;
  const line = `🔧 [${level}] ${message}`;
  for (const userId of debugUsers) {
    telegramSender(userId, line).catch(() => {});
  }
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function todayLogFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `${date}.log`);
}

function ensureLogDir(): void {
  const { mkdirSync } = require("fs");
  try {
    mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

// No-op — logs are kept indefinitely
function cleanOldLogs(): void {}

// Returns the last `n` lines from today's log file (falls back to yesterday if today is empty).
export function getRecentLogs(n = 30): string {
  const candidates = [
    new Date(),
    new Date(Date.now() - 86400000), // yesterday
  ].map((d) => join(LOG_DIR, `${d.toISOString().slice(0, 10)}.log`));

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const lines = readFileSync(file, "utf-8").trimEnd().split("\n").filter(Boolean);
      if (lines.length === 0) continue;
      return lines.slice(-n).join("\n");
    } catch {}
  }
  return "(no logs found)";
}

// Deletes all log files older than yesterday. Returns number of files deleted.
export function purgeLogs(): number {
  const { readdirSync } = require("fs");
  ensureLogDir();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const cutoff = yesterday.toISOString().slice(0, 10);

  let deleted = 0;
  try {
    const files: string[] = readdirSync(LOG_DIR);
    for (const file of files) {
      if (file.endsWith(".log") && file.slice(0, 10) < cutoff) {
        try {
          unlinkSync(join(LOG_DIR, file));
          deleted++;
        } catch {}
      }
    }
  } catch {}
  return deleted;
}

function writeToFile(level: string, message: string): void {
  ensureLogDir();
  cleanOldLogs();
  const line = `[${timestamp()}] [${level}] ${message}\n`;
  appendFileSync(todayLogFile(), line);
}

function formatTerminal(color: string, label: string, message: string): string {
  return `${COLORS.dim}${timestamp()}${COLORS.reset} ${color}${label}${COLORS.reset} ${message}`;
}

export const log = {
  info(message: string) {
    console.log(formatTerminal(COLORS.cyan, "INFO", message));
    writeToFile("INFO", message);
    sendToTelegram("INFO", message);
  },

  success(message: string) {
    console.log(formatTerminal(COLORS.green, " OK ", message));
    writeToFile("OK", message);
    sendToTelegram("OK", message);
  },

  warn(message: string) {
    console.warn(formatTerminal(COLORS.yellow, "WARN", message));
    writeToFile("WARN", message);
    sendToTelegram("WARN", message);
  },

  error(message: string) {
    console.error(formatTerminal(COLORS.red, " ERR", message));
    writeToFile("ERROR", message);
    sendToTelegram("ERR", message);
  },

  agent(message: string) {
    console.log(formatTerminal(COLORS.magenta, "AGENT", message));
    writeToFile("AGENT", message);
    sendToTelegram("AGENT", message);
  },

  subagent(message: string) {
    console.log(formatTerminal(COLORS.magenta, " SUB ", message));
    writeToFile("SUB", message);
    sendToTelegram("SUB", message);
  },

  tool(name: string, message: string) {
    console.log(formatTerminal(COLORS.yellow, "TOOL", `[${name}] ${message}`));
    writeToFile("TOOL", `[${name}] ${message}`);
    sendToTelegram("TOOL", `[${name}] ${message}`);
  },

  chat(direction: "in" | "out", userId: number, preview: string) {
    const arrow = direction === "in" ? ">>>" : "<<<";
    const color = direction === "in" ? COLORS.cyan : COLORS.green;
    const truncated = preview.length > 120 ? preview.slice(0, 120) + "..." : preview;
    console.log(formatTerminal(color, arrow, `[${userId}] ${truncated}`));
    writeToFile(arrow, `[${userId}] ${truncated}`);
    // Don't send chat messages to debug — would create infinite loop
  },
};
