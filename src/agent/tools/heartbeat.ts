// Heartbeat — proactive task/reminder file. Claude reviews it every 30 minutes
// via the scheduler's heartbeat pulse, and can edit it anytime via `update_heartbeat`.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { log } from "../../logger";
import type { ToolHandler } from "./types";

const HEARTBEAT_PATH  = join(process.cwd(), "config/heartbeat.md");
const TEMPLATE_PATH   = join(process.cwd(), "config/heartbeat.initial.md");

// Minimal fallback if the template file is also missing (e.g. corrupt install).
const FALLBACK_CONTENT = `# Heartbeat

Proactive tasks and reminders. Check this file every 30 minutes and act on items that are due.

## Items

<!-- Add items below. -->
`;

export function readHeartbeat(): string {
  try {
    return readFileSync(HEARTBEAT_PATH, "utf-8");
  } catch {
    return "";
  }
}

// Returns true iff heartbeat.md's `## Items` section actually has something in it.
// Used to short-circuit the 30-min pulse and avoid a full Claude call when there's
// nothing scheduled. HTML comments (the placeholder) are stripped before checking.
export function hasHeartbeatItems(): boolean {
  const content = readHeartbeat();
  const itemsMatch = content.match(/##\s+Items\s*\n([\s\S]*)$/i);
  if (!itemsMatch) return false;
  const stripped = itemsMatch[1]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^---\s*$/gm, "")
    .trim();
  return stripped.length > 0;
}

// Parses heartbeat.md and returns items that are due right now (within the last 2 hours).
// Supports two formats written by the agent:
//   One-shot:   **2026-05-04 11:00** — description
//   Recurring:  **Every Monday 09:00** — description  (or "Every day HH:MM")
// No AI involved — pure date arithmetic in the user's timezone.
export function getDueItems(timezone: string): string[] {
  const content = readHeartbeat();
  const itemsMatch = content.match(/##\s+Items\s*\n([\s\S]*)$/i);
  if (!itemsMatch) return [];

  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  // Format a Date to "YYYY-MM-DD HH:MM" in the given timezone (for string comparison).
  function toTZString(d: Date): string {
    const date = d.toLocaleDateString("en-CA", { timeZone: timezone });
    const time = d.toLocaleTimeString("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false });
    return `${date} ${time}`;
  }

  const nowStr = toTZString(now);
  const twoHAgoStr = toTZString(twoHoursAgo);

  // Today's weekday name (lowercase) and date string in the user's timezone.
  const todayWeekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" })
    .format(now).toLowerCase();
  const todayDate = now.toLocaleDateString("en-CA", { timeZone: timezone });

  const due: string[] = [];

  for (const line of itemsMatch[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<!--") || trimmed.startsWith("---")) continue;

    // One-shot: **YYYY-MM-DD HH:MM**
    const oneshot = trimmed.match(/\*\*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\*\*/);
    if (oneshot) {
      const t = oneshot[1];
      if (t >= twoHAgoStr && t <= nowStr) due.push(trimmed);
      continue;
    }

    // Recurring: **Every <day|weekday> HH:MM**
    const recurring = trimmed.match(/\*\*Every\s+(\w+)\s+(\d{2}:\d{2})\*\*/i);
    if (recurring) {
      const [, period, time] = recurring;
      const itemFull = `${todayDate} ${time}`;
      const matchesDay =
        period.toLowerCase() === "day" ||
        period.toLowerCase() === todayWeekday;
      if (matchesDay && itemFull >= twoHAgoStr && itemFull <= nowStr) {
        due.push(trimmed);
      }
    }
  }

  return due;
}

// On first run, copy heartbeat.initial.md → heartbeat.md so the user can edit the
// live file without touching the committed template. Falls back to minimal stub
// if the template is missing.
export function ensureHeartbeat(): void {
  if (existsSync(HEARTBEAT_PATH)) return;

  let seed = FALLBACK_CONTENT;
  try {
    seed = readFileSync(TEMPLATE_PATH, "utf-8");
  } catch {
    log.warn("heartbeat.initial.md not found — seeding heartbeat.md with fallback content.");
  }
  writeFileSync(HEARTBEAT_PATH, seed, "utf-8");
  log.info("heartbeat.md created from template.");
}

export const heartbeatTools: Anthropic.Tool[] = [
  {
    name: "update_heartbeat",
    description:
      "Rewrite heartbeat.md — the single place for ALL timed reminders and recurring tasks. " +
      "Use this for proactive follow-ups (one-shot), recurring messages (daily/weekly), and any 'remind me at X' requests. " +
      "Supported formats:\n" +
      "  One-shot:  **YYYY-MM-DD HH:MM** — description\n" +
      "  Recurring: **Every day HH:MM** — description\n" +
      "             **Every Monday HH:MM** — description\n" +
      "The current contents are in your system prompt under '## Heartbeat'. " +
      "Always provide the full file — preserve the header and '## Items' section.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: {
          type: "string",
          description: "The full new content of heartbeat.md",
        },
      },
      required: ["content"],
    },
  },
];

export const heartbeatHandlers: Record<string, ToolHandler> = {
  update_heartbeat: async (input) => {
    const content = input.content as string;
    writeFileSync(HEARTBEAT_PATH, content, "utf-8");
    return "Heartbeat updated.";
  },
};
