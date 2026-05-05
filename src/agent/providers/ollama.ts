// Ollama local provider — uses Ollama's native /api/chat endpoint.
// No API key needed; configure OLLAMA_BASE_URL (e.g. http://localhost:11434).
import Anthropic from "@anthropic-ai/sdk";
import { getActiveModel } from ".";
import { log } from "../../logger";

export function isOllamaConnected(): boolean {
  return !!process.env.OLLAMA_BASE_URL;
}

function getBaseUrl(): string {
  return (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
}

// ── Native Ollama types ───────────────────────────────────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

interface OllamaRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  stream: false;
}

interface OllamaResponse {
  model: string;
  message: {
    role: "assistant";
    content: string;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  };
  done: boolean;
  done_reason?: string;
}

// ── Request conversion: Anthropic → Ollama ───────────────────────────────────

function convertMessages(msgs: Anthropic.MessageParam[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];

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

      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      const tool_calls = msg.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          function: { name: b.name, arguments: b.input as Record<string, unknown> },
        }));

      out.push({
        role: "assistant",
        content: text,
        ...(tool_calls.length > 0 ? { tool_calls } : {}),
      });
    }
  }

  return out;
}

function convertTools(
  tools: Anthropic.Tool[]
): OllamaRequest["tools"] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name:        t.name,
      description: t.description ?? "",
      parameters:  t.input_schema as Record<string, unknown>,
    },
  }));
}

// ── Response conversion: Ollama → Anthropic ──────────────────────────────────

function convertResponse(data: OllamaResponse, model: string): Anthropic.Message {
  const msg = data.message;
  const content: Array<Anthropic.TextBlock | Anthropic.ToolUseBlock> = [];

  if (msg.content) {
    content.push({ type: "text", text: msg.content, citations: null });
  }

  for (let i = 0; i < (msg.tool_calls ?? []).length; i++) {
    const tc = msg.tool_calls![i];
    content.push({
      type:  "tool_use",
      id:    `call_${i}`,
      name:  tc.function.name,
      input: tc.function.arguments,
    });
  }

  const hasToolCalls = (msg.tool_calls ?? []).length > 0;
  const stopReason: Anthropic.Message["stop_reason"] =
    hasToolCalls              ? "tool_use"
    : data.done_reason === "length" ? "max_tokens"
    : "end_turn";

  return {
    id:            `ollama-${Date.now()}`,
    type:          "message",
    role:          "assistant",
    model,
    content,
    stop_reason:   stopReason,
    stop_sequence: null,
    usage: {
      input_tokens:                0,
      output_tokens:               0,
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
  const baseUrl = getBaseUrl();

  const systemBlocks = (params.system ?? []) as Anthropic.TextBlockParam[];
  const systemStr = systemBlocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");

  const messages: OllamaMessage[] = [
    ...(systemStr ? [{ role: "system" as const, content: systemStr }] : []),
    ...convertMessages(params.messages),
  ];

  const tools = (params.tools ?? []) as Anthropic.Tool[];

  const req: OllamaRequest = {
    model,
    messages,
    ...(tools.length > 0 ? { tools: convertTools(tools) } : {}),
    stream: false,
  };

  log.agent(`[ollama] ${model} — ${messages.length} messages`);

  const res = await fetch(`${baseUrl}/api/chat`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama error (${res.status}): ${body}`);
  }

  const data = await res.json() as OllamaResponse;
  return convertResponse(data, model);
}
