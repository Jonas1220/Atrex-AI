// Per-user "thinking" budget. Set with /think low|medium|high|off.
// The selected level is converted to an Anthropic ThinkingConfig and applied
// to the next chat() call(s). Cleared on /clear or when explicitly turned off.
import Anthropic from "@anthropic-ai/sdk";

export type ThinkingLevel = "off" | "low" | "medium" | "high";

const LEVEL_BUDGETS: Record<Exclude<ThinkingLevel, "off">, number> = {
  low: 1024,
  medium: 4096,
  high: 16000,
};

const userLevels = new Map<number, ThinkingLevel>();

export function setThinkingLevel(userId: number, level: ThinkingLevel): void {
  if (level === "off") userLevels.delete(userId);
  else userLevels.set(userId, level);
}

export function getThinkingLevel(userId: number): ThinkingLevel {
  return userLevels.get(userId) ?? "off";
}

export function clearThinking(userId: number): void {
  userLevels.delete(userId);
}

/** Returns an Anthropic thinking config to splat into messages.create, or undefined. */
export function getThinkingConfig(userId: number): Anthropic.ThinkingConfigParam | undefined {
  const level = getThinkingLevel(userId);
  if (level === "off") return undefined;
  return { type: "enabled", budget_tokens: LEVEL_BUDGETS[level] };
}

export function parseLevel(input: string): ThinkingLevel | null {
  const v = input.trim().toLowerCase();
  if (v === "off" || v === "none" || v === "0") return "off";
  if (v === "low" || v === "l") return "low";
  if (v === "medium" || v === "med" || v === "m") return "medium";
  if (v === "high" || v === "h") return "high";
  return null;
}
