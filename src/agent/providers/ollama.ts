// Ollama provider adapter — local/self-hosted LLM running via Ollama.
// Uses the OpenAI-compatible API at OLLAMA_BASE_URL/v1 (default: http://localhost:11434/v1).
// No API key required.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { getActiveModel } from ".";
import { log } from "../../logger";

export function getOllamaBaseUrl(): string {
  const url = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
  return url.endsWith("/v1") ? url : `${url}/v1`;
}

// ── Request conversion: Anthropic → OpenAI ────────────────────────────────────

function systemText(blocks: Anthropic.TextBlockParam[]): string {
  return blocks
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

function convertMessages(msgs: Anthropic.MessageParam[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];

  for (const msg of msgs) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
        continue;
      }

      let userText = "";
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const content =
            typeof block.content === "string"
              ? block.content
              : (block.content as Anthropic.TextBlockParam[])
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("\n");
          out.push({ role: "tool", tool_call_id: block.tool_use_id, content });
        } else if (block.type === "text") {
          userText += (userText ? "\n" : "") + block.text;
        }
      }
      if (userText) out.push({ role: "user", content: userText });
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        out.push({ role: "assistant", content: msg.content });
        continue;
      }

      const textBlocks  = msg.content.filter((b): b is Anthropic.TextBlock    => b.type === "text");
      const toolBlocks  = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      const tool_calls: ChatCompletionMessageToolCall[] = toolBlocks.map((b) => ({
        id:       b.id,
        type:     "function" as const,
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));

      out.push({
        role:    "assistant",
        content: textBlocks.map((b) => b.text).join("\n") || null,
        ...(tool_calls.length > 0 ? { tool_calls } : {}),
      });
    }
  }

  return out;
}

function convertTools(tools: Anthropic.Tool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type:     "function" as const,
    function: {
      name:        t.name,
      description: t.description ?? "",
      parameters:  t.input_schema as Record<string, unknown>,
    },
  }));
}

// ── Response conversion: OpenAI → Anthropic ──────────────────────────────────

// Some models emit a tool call as JSON text in content instead of using tool_calls.
function extractTextToolCall(text: string): { name: string; input: Record<string, unknown> } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj.type === "function" && typeof obj.name === "string") {
      const raw = obj.parameters ?? obj.arguments ?? {};
      return { name: obj.name, input: typeof raw === "string" ? JSON.parse(raw) : raw };
    }
    if (obj.function?.name) {
      const raw = obj.function.arguments ?? {};
      return { name: obj.function.name, input: typeof raw === "string" ? JSON.parse(raw) : raw };
    }
    if (typeof obj.name === "string" && obj.parameters !== undefined) {
      const raw = obj.parameters;
      return { name: obj.name, input: typeof raw === "string" ? JSON.parse(raw) : raw };
    }
  } catch {}
  return null;
}

function convertResponse(
  completion: OpenAI.Chat.ChatCompletion,
  originalModel: string
): Anthropic.Message {
  const choice = completion.choices[0];
  const msg    = choice.message;

  const content: Array<Anthropic.TextBlock | Anthropic.ToolUseBlock> = [];
  let forceToolUse = false;

  if (msg.content) {
    const textCall = (msg.tool_calls == null || msg.tool_calls.length === 0)
      ? extractTextToolCall(msg.content)
      : null;
    if (textCall) {
      forceToolUse = true;
      content.push({ type: "tool_use", id: `toolu_${Date.now()}`, name: textCall.name, input: textCall.input });
    } else {
      content.push({ type: "text", text: msg.content, citations: null });
    }
  }

  for (const tc of msg.tool_calls ?? []) {
    if (!("function" in tc)) continue;
    const fn = (tc as { id: string; function: { name: string; arguments: string } }).function;
    let input: unknown = {};
    try { input = JSON.parse(fn.arguments); } catch {}
    content.push({ type: "tool_use", id: tc.id, name: fn.name, input: input as Record<string, unknown> });
  }

  const finishReason = choice.finish_reason;
  const stopReason: Anthropic.Message["stop_reason"] =
    forceToolUse || finishReason === "tool_calls" ? "tool_use"
    : finishReason === "length"                   ? "max_tokens"
    : "end_turn";

  const usage = completion.usage;
  return {
    id:            completion.id,
    type:          "message",
    role:          "assistant",
    model:         originalModel,
    content,
    stop_reason:   stopReason,
    stop_sequence: null,
    usage: {
      input_tokens:                usage?.prompt_tokens     ?? 0,
      output_tokens:               usage?.completion_tokens ?? 0,
      cache_read_input_tokens:     null,
      cache_creation_input_tokens: null,
    },
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function createMessageOllama(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  const model   = params.model || getActiveModel();
  const baseURL = getOllamaBaseUrl();
  const client  = new OpenAI({ apiKey: "ollama", baseURL });

  const systemBlocks = (params.system ?? []) as Anthropic.TextBlockParam[];
  const systemStr    = systemText(systemBlocks);
  const messages     = convertMessages(params.messages);

  const fullMessages: ChatCompletionMessageParam[] = [
    ...(systemStr ? [{ role: "system" as const, content: systemStr }] : []),
    ...messages,
  ];

  const tools = (params.tools ?? []) as Anthropic.Tool[];

  const req: ChatCompletionCreateParamsNonStreaming = {
    model,
    max_tokens: params.max_tokens,
    messages:   fullMessages,
    ...(tools.length > 0 ? { tools: convertTools(tools) } : {}),
    stream: false,
  };

  log.agent(`[ollama] ${model} @ ${baseURL} — ${fullMessages.length} messages`);
  const completion = await client.chat.completions.create(req);
  return convertResponse(completion, model);
}
