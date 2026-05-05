// Ollama provider adapter.
// Two connection modes:
//   url    — OpenAI-compat /v1/chat/completions via OLLAMA_BASE_URL (default localhost:11434)
//   apikey — Native Ollama /api/chat via OLLAMA_BASE_URL + OLLAMA_API_KEY bearer token
// Mode is auto-detected from which env vars are set, or set explicitly via OLLAMA_MODE.
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

export function getOllamaMode(): "apikey" | "url" {
  const explicit = process.env.OLLAMA_MODE;
  if (explicit === "apikey" || explicit === "url") return explicit;
  return process.env.OLLAMA_API_KEY ? "apikey" : "url";
}

// Returns the base URL with /v1 appended — used by the OpenAI-compat path (url mode).
export function getOllamaBaseUrl(): string {
  const raw = (process.env.OLLAMA_BASE_URL ?? "").replace(/\/$/, "");
  const base = raw || (getOllamaMode() === "url" ? "http://localhost:11434" : "");
  if (!base) return "";
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

// Returns the raw base URL without /v1 — used by the native /api/chat path (apikey mode).
function getRawBase(): string {
  return (process.env.OLLAMA_BASE_URL ?? "").replace(/\/$/, "").replace(/\/v1$/, "");
}

// ── Shared helper ─────────────────────────────────────────────────────────────

function systemText(blocks: Anthropic.TextBlockParam[]): string {
  return blocks
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

// ── URL mode: Anthropic → OpenAI-compat ──────────────────────────────────────

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

      const textBlocks = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
      const toolBlocks = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

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

function convertResponse(completion: OpenAI.Chat.ChatCompletion, originalModel: string): Anthropic.Message {
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

  const stopReason: Anthropic.Message["stop_reason"] =
    forceToolUse || choice.finish_reason === "tool_calls" ? "tool_use"
    : choice.finish_reason === "length"                   ? "max_tokens"
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

// ── API key mode: Anthropic → native Ollama /api/chat ────────────────────────
// Ollama.com hosted API uses POST /api/chat with bearer token auth.
// The native format differs from OpenAI-compat: no tool_call_id on tool results,
// tool call IDs are absent in responses (we generate them), and the response
// envelope is {message, done_reason} not {choices: [{message, finish_reason}]}.

type NativeMessage =
  | { role: "system" | "user" | "assistant"; content: string; tool_calls?: NativeToolCall[] }
  | { role: "tool"; content: string };

type NativeToolCall = { function: { name: string; arguments: Record<string, unknown> } };

type NativeResponse = {
  model: string;
  message: {
    role: "assistant";
    content: string;
    tool_calls?: NativeToolCall[];
  };
  done: boolean;
  done_reason: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

function convertMessagesNative(msgs: Anthropic.MessageParam[]): NativeMessage[] {
  const out: NativeMessage[] = [];

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
          out.push({ role: "tool", content });
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

      const textBlocks = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
      const toolBlocks = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      const tool_calls: NativeToolCall[] = toolBlocks.map((b) => ({
        function: { name: b.name, arguments: b.input as Record<string, unknown> },
      }));

      out.push({
        role:    "assistant",
        content: textBlocks.map((b) => b.text).join("\n") || "",
        ...(tool_calls.length > 0 ? { tool_calls } : {}),
      });
    }
  }

  return out;
}

function convertToolsNative(tools: Anthropic.Tool[]): NativeToolCall["function"] extends infer F ? { type: "function"; function: F }[] : never {
  return tools.map((t) => ({
    type:     "function" as const,
    function: {
      name:        t.name,
      description: t.description ?? "",
      parameters:  t.input_schema as Record<string, unknown>,
    },
  })) as never;
}

function convertResponseNative(response: NativeResponse, originalModel: string): Anthropic.Message {
  const msg     = response.message;
  const content: Array<Anthropic.TextBlock | Anthropic.ToolUseBlock> = [];

  if (msg.content) {
    content.push({ type: "text", text: msg.content, citations: null });
  }

  let i = 0;
  for (const tc of msg.tool_calls ?? []) {
    const args = tc.function.arguments;
    const input = typeof args === "string" ? (() => { try { return JSON.parse(args); } catch { return {}; } })() : args;
    content.push({
      type:  "tool_use",
      id:    `toolu_${Date.now()}_${i++}`,
      name:  tc.function.name,
      input: input as Record<string, unknown>,
    });
  }

  const stopReason: Anthropic.Message["stop_reason"] =
    (msg.tool_calls?.length ?? 0) > 0 ? "tool_use"
    : response.done_reason === "length" ? "max_tokens"
    : "end_turn";

  return {
    id:            `msg_ollama_${Date.now()}`,
    type:          "message",
    role:          "assistant",
    model:         originalModel,
    content,
    stop_reason:   stopReason,
    stop_sequence: null,
    usage: {
      input_tokens:                response.prompt_eval_count ?? 0,
      output_tokens:               response.eval_count        ?? 0,
      cache_read_input_tokens:     null,
      cache_creation_input_tokens: null,
    },
  };
}

async function createMessageOllamaNative(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  const model   = params.model || getActiveModel();
  const rawBase = getRawBase();
  if (!rawBase) throw new Error("Ollama: OLLAMA_BASE_URL is required in API key mode. Set it in the dashboard.");

  const endpoint = `${rawBase}/api/chat`;
  const apiKey   = process.env.OLLAMA_API_KEY;

  const systemBlocks = (params.system ?? []) as Anthropic.TextBlockParam[];
  const systemStr    = systemText(systemBlocks);
  const tools        = (params.tools ?? []) as Anthropic.Tool[];

  const messages: NativeMessage[] = [
    ...(systemStr ? [{ role: "system" as const, content: systemStr }] : []),
    ...convertMessagesNative(params.messages),
  ];

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    ...(tools.length > 0 ? { tools: convertToolsNative(tools) } : {}),
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  log.agent(`[ollama-api] ${model} @ ${endpoint} — ${messages.length} messages`);

  const r = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const errText = await r.text().catch(() => r.statusText);
    throw new Error(`Ollama API error ${r.status}: ${errText}`);
  }

  const response = await r.json() as NativeResponse;
  return convertResponseNative(response, model);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function createMessageOllama(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  if (getOllamaMode() === "apikey") {
    return createMessageOllamaNative(params);
  }

  // url mode — local Ollama via OpenAI-compat /v1/chat/completions
  const model   = params.model || getActiveModel();
  const baseURL = getOllamaBaseUrl();
  const client  = new OpenAI({ apiKey: "ollama", baseURL });

  const systemBlocks = (params.system ?? []) as Anthropic.TextBlockParam[];
  const systemStr    = systemText(systemBlocks);
  const messages     = convertMessages(params.messages);
  const tools        = (params.tools ?? []) as Anthropic.Tool[];

  const fullMessages: ChatCompletionMessageParam[] = [
    ...(systemStr ? [{ role: "system" as const, content: systemStr }] : []),
    ...messages,
  ];

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
