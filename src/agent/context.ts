// Per-user conversation history, stored in memory and trimmed to max_history length.
// History is automatically cleared after 2 hours of inactivity.
import Anthropic from "@anthropic-ai/sdk";
import { settings } from "../config";

type Message = Anthropic.MessageParam;

const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const histories = new Map<number, Message[]>();
const lastActivity = new Map<number, number>();

export function getHistory(userId: number): Message[] {
  const lastTs = lastActivity.get(userId);
  if (lastTs && Date.now() - lastTs > INACTIVITY_TIMEOUT_MS) {
    histories.delete(userId);
    lastActivity.delete(userId);
  }
  if (!histories.has(userId)) {
    histories.set(userId, []);
  }
  return histories.get(userId)!;
}

export function appendMessage(userId: number, message: Message): void {
  const history = getHistory(userId);
  lastActivity.set(userId, Date.now());
  history.push(message);
  if (history.length > settings.max_history) {
    history.splice(0, history.length - settings.max_history);
  }
}

export function clearHistory(userId: number): void {
  histories.delete(userId);
  lastActivity.delete(userId);
}
