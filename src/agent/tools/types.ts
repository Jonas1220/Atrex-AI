// Shared types for tool handlers.

/** Per-invocation context passed to every built-in tool handler. */
export interface ToolContext {
  userId: number;
  /** Called before each tool executes so the UI can show what's happening. */
  updateStatus?: (text: string) => Promise<void>;
  /** Telegram chat ID — present when the message came from the Telegram bot. */
  chatId?: number;
  /** Telegram message ID of the user's message — used by send_reaction. */
  messageId?: number;
}

/** Signature every built-in tool handler must satisfy. */
export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: ToolContext
) => Promise<string>;
