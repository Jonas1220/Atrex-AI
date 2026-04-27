// Per-user conversation history, stored in memory and trimmed to max_history length.
import Anthropic from "@anthropic-ai/sdk";
import { settings } from "../config";

type Message = Anthropic.MessageParam;

const histories = new Map<number, Message[]>();

export function getHistory(userId: number): Message[] {
  if (!histories.has(userId)) {
    histories.set(userId, []);
  }
  return histories.get(userId)!;
}

export function appendMessage(userId: number, message: Message): void {
  const history = getHistory(userId);
  history.push(message);
  if (history.length > settings.max_history) {
    history.splice(0, history.length - settings.max_history);
  }
}

export function clearHistory(userId: number): void {
  histories.delete(userId);
}
