// Compacts conversation history when it grows too long by summarising old turns
// into a short synthetic context block. Uses Haiku (cheap, fast) for summaries.
//
// Safety rule: never cut between an assistant tool_use block and its paired
// tool_result — the API will reject the conversation shape. We walk backwards
// from the target cut point to find the nearest safe boundary.
import Anthropic from "@anthropic-ai/sdk";
import { settings } from "../config";
import { getHistory } from "./context";
import { anthropic } from "./anthropic";
import { log } from "../logger";

type Message = Anthropic.MessageParam;

const SUMMARY_MODEL = "claude-haiku-4-5-20251001";

function hasToolUse(msg: Message): boolean {
  if (typeof msg.content === "string" || !Array.isArray(msg.content)) return false;
  return msg.content.some(
    (b) => typeof b === "object" && b !== null && (b as { type: string }).type === "tool_use"
  );
}

// Walk backwards from targetCut to find a safe splice point.
// Safe = history[i-1] is an assistant turn with no tool_use, so history[i] is
// guaranteed to be a plain user message (not a tool_result).
function findSafeCutIndex(history: Message[], targetCut: number): number {
  for (let i = Math.min(targetCut, history.length - 1); i >= 2; i--) {
    const prev = history[i - 1];
    if (prev.role === "assistant" && !hasToolUse(prev)) return i;
  }
  return 0;
}

// Renders messages as a plain text transcript for the summarisation prompt.
function messagesToText(messages: Message[]): string {
  return messages
    .map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      let text: string;

      if (typeof m.content === "string") {
        text = m.content;
      } else {
        text = (m.content as Anthropic.ContentBlockParam[])
          .map((b) => {
            const block = b as unknown as Record<string, unknown>;
            if (block.type === "text") return block.text as string;
            if (block.type === "tool_use") return `[called: ${block.name}]`;
            if (block.type === "tool_result") {
              const c = block.content;
              const snippet =
                typeof c === "string"
                  ? c
                  : Array.isArray(c)
                  ? (c as { type: string; text?: string }[])
                      .map((x) => (x.type === "text" ? x.text : ""))
                      .join(" ")
                  : "";
              return `[result: ${snippet.slice(0, 300)}]`;
            }
            return "";
          })
          .filter(Boolean)
          .join(" ");
      }

      return `${role}: ${text.slice(0, 600)}`;
    })
    .join("\n\n");
}

async function summarize(messages: Message[]): Promise<string> {
  const transcript = messagesToText(messages);

  const response = await anthropic.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 1024,
    system:
      "Summarise this conversation transcript into a compact factual summary. " +
      "Cover: topics discussed, decisions made, tasks completed, key facts shared. " +
      "Under 300 words. Plain prose, no headers.",
    messages: [{ role: "user", content: transcript }],
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n") || "(no summary)";
}

// Called before every chat() API call. Compacts history when it exceeds
// settings.compaction_threshold. Returns true if compaction ran.
export async function compactIfNeeded(userId: number): Promise<boolean> {
  const threshold = settings.compaction_threshold;
  if (threshold === 0) return false;

  const history = getHistory(userId);
  if (history.length <= threshold) return false;

  const targetCut = history.length - threshold;
  const cutIndex = findSafeCutIndex(history, targetCut);

  // Need at least 4 messages to be worth compacting
  if (cutIndex < 4) return false;

  log.info(`Compacting ${cutIndex} messages for user ${userId} (${history.length} total)`);

  try {
    const summary = await summarize(history.slice(0, cutIndex));

    // Inject as a synthetic user/assistant pair so alternating-role invariant
    // is preserved regardless of what history[cutIndex] contains.
    const pair: Message[] = [
      {
        role: "user",
        content: `[Summary of earlier conversation — context only]\n\n${summary}`,
      },
      {
        role: "assistant",
        content: "Got it, I have the context.",
      },
    ];

    history.splice(0, cutIndex, ...pair);
    log.success(`Compacted: ${cutIndex} → 2 messages (${history.length} remain)`);
    return true;
  } catch (err) {
    log.error(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
