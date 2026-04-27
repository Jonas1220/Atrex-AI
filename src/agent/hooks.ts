// Lifecycle event bus. Plugins, skills, and other subsystems can subscribe to
// well-known events fired by the agent loop and bot handlers. Listeners are
// awaited sequentially; errors are caught and logged so a bad listener can't
// take down a chat turn.
import { EventEmitter } from "events";
import { log } from "../logger";

export interface HookEvents {
  "chat:before":      { userId: number; message: string };
  "chat:after":       { userId: number; message: string; response: string; durationMs: number };
  "chat:error":       { userId: number; message: string; error: unknown };
  "tool:before":      { userId: number; toolName: string; input: Record<string, unknown> };
  "tool:after":       { userId: number; toolName: string; resultLength: number; durationMs: number; error?: string };
  "message:received": { userId: number; chatId: number; kind: "text" | "voice" | "button"; text: string };
  "message:sent":     { userId: number; chatId: number; text: string };
}

type HookName = keyof HookEvents;
type HookListener<E extends HookName> = (payload: HookEvents[E]) => void | Promise<void>;

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function on<E extends HookName>(event: E, listener: HookListener<E>): () => void {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

export async function emit<E extends HookName>(event: E, payload: HookEvents[E]): Promise<void> {
  const listeners = emitter.listeners(event) as Array<HookListener<E>>;
  for (const l of listeners) {
    try {
      await l(payload);
    } catch (err) {
      log.error(`Hook listener for "${event}" threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Removes all listeners — primarily for tests. */
export function _resetHooks(): void {
  emitter.removeAllListeners();
}
