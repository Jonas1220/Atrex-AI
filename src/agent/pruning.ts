// Returns a cost-trimmed view of the conversation history for the next API call.
// Tool-result payloads (file reads, search outputs, code execution) are the bulkiest
// items in a session. Once they're older than `prune_tool_results_after` turns from
// the end, we replace their content with a short placeholder. The tool_use blocks
// they pair with are kept untouched, preserving message-shape correctness.
//
// In-memory only — the on-disk transcript and the live `histories` map are not
// modified, so /clear-style audits remain accurate.
import Anthropic from "@anthropic-ai/sdk";
import { settings } from "../config";

type Message = Anthropic.MessageParam;
const PLACEHOLDER = "[pruned: older tool result removed to save context]";

function pruneOldBlocks(content: Message["content"]): Message["content"] {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    if (block.type === "tool_result") return { ...block, content: PLACEHOLDER };
    // Replace image source data with a placeholder to avoid re-sending large
    // base64 payloads in every subsequent API call.
    if (block.type === "image") return { type: "text" as const, text: "[pruned: older image removed to save context]" };
    return block;
  });
}

export function pruneHistory(history: Message[]): Message[] {
  const cutoff = settings.prune_tool_results_after;
  if (cutoff === 0 || history.length <= cutoff) return history;

  const keepFrom = history.length - cutoff;
  return history.map((msg, i) => {
    if (i >= keepFrom) return msg;
    return { ...msg, content: pruneOldBlocks(msg.content) };
  });
}
