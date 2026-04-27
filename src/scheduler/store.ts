// Persists scheduled tasks to schedules.json — CRUD operations for the scheduler.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

const STORE_PATH = join(process.cwd(), "config/schedules.json");

export interface Schedule {
  id: string;
  userId: number;
  cron: string;
  /** Static message to send. Mutually exclusive with prompt. */
  message: string | null;
  /** Prompt to run through Claude — sends the AI response. Mutually exclusive with message. */
  prompt: string | null;
  enabled: boolean;
  createdAt: string;
}

export function loadSchedules(): Schedule[] {
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveSchedules(schedules: Schedule[]): void {
  writeFileSync(STORE_PATH, JSON.stringify(schedules, null, 2), "utf-8");
}

export function addSchedule(
  data: Pick<Schedule, "userId" | "cron" | "message" | "prompt">
): Schedule {
  const schedules = loadSchedules();
  const entry: Schedule = {
    id: randomUUID().slice(0, 8),
    userId: data.userId,
    cron: data.cron,
    message: data.message,
    prompt: data.prompt,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  schedules.push(entry);
  saveSchedules(schedules);
  return entry;
}

export function removeSchedule(id: string): boolean {
  const schedules = loadSchedules();
  const filtered = schedules.filter((s) => s.id !== id);
  if (filtered.length === schedules.length) return false;
  saveSchedules(filtered);
  return true;
}

export function getSchedulesByUser(userId: number): Schedule[] {
  return loadSchedules().filter((s) => s.userId === userId);
}
