// OpenAI provider adapter — accepts Anthropic-shaped request params and returns
// an Anthropic-shaped Message, so agent.ts never needs to know which provider
// is in use. All format translation happens here.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { settings } from "../../config";
import { getActiveModel } from ".";
import { log } from "../../logger";
import { getAccessToken } from "../../openai/auth";

// ── Request conversion: Anthropic → OpenAI ───────────────────────────────────

function systemText(blocks: Anthropic.TextBlockParam[]): string {
  return blocks
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

function convertMessages(
  msgs: Anthropic.MessageParam[]
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];

  for (const msg of msgs) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
        continue;
      }

      let userText = "";
      const imageParts: Array<{ type: "image_url"; image_url: { url: string } }> = [];
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const content = typeof block.content === "string"
            ? block.content
            : (block.content as Anthropic.TextBlockParam[])
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n");
          out.push({ role: "tool", tool_call_id: block.tool_use_id, content });
        } else if (block.type === "text") {
          userText += (userText ? "\n" : "") + block.text;
        } else if (block.type === "image" && block.source.type === "base64") {
          imageParts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        }
      }
      if (imageParts.length > 0) {
        const parts: Array<
          { type: "text"; text: string } |
          { type: "image_url"; image_url: { url: string } }
        > = [
          ...imageParts,
          ...(userText ? [{ type: "text" as const, text: userText }] : []),
        ];
        out.push({ role: "user", content: parts } as ChatCompletionMessageParam);
      } else if (userText) {
        out.push({ role: "user", content: userText });
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        out.push({ role: "assistant", content: msg.content });
        continue;
      }

      const textBlocks = msg.content.filter(
        (b): b is Anthropic.TextBlock => b.type === "text"
      );
      const toolUseBlocks = msg.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      const tool_calls: ChatCompletionMessageToolCall[] = toolUseBlocks.map((b) => ({
        id:   b.id,
        type: "function" as const,
        function: {
          name:      b.name,
          arguments: JSON.stringify(b.input),
        },
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
    type: "function" as const,
    function: {
      name:       t.name,
      description: t.description ?? "",
      parameters:  t.input_schema as Record<string, unknown>,
    },
  }));
}

function reasoningEffort(
  thinking: Anthropic.ThinkingConfigParam | undefined,
  model: string
): "low" | "medium" | "high" | undefined {
  if (!thinking || thinking.type !== "enabled") return undefined;
  if (!model.startsWith("o")) return undefined;
  const budget = thinking.budget_tokens;
  if (budget <= 1024) return "low";
  if (budget <= 8192) return "medium";
  return "high";
}

// ── Response conversion: OpenAI → Anthropic ──────────────────────────────────

function convertResponse(
  completion: OpenAI.Chat.ChatCompletion,
  originalModel: string
): Anthropic.Message {
  const choice = completion.choices[0];
  const msg    = choice.message;

  const content: Array<Anthropic.TextBlock | Anthropic.ToolUseBlock> = [];

  if (msg.content) {
    content.push({ type: "text", text: msg.content, citations: null });
  }

  for (const tc of msg.tool_calls ?? []) {
    if (!("function" in tc)) continue;
    const fn = (tc as { id: string; function: { name: string; arguments: string } }).function;
    let input: unknown = {};
    try { input = JSON.parse(fn.arguments); } catch {}
    content.push({
      type:  "tool_use",
      id:    tc.id,
      name:  fn.name,
      input: input as Record<string, unknown>,
    });
  }

  const finishReason = choice.finish_reason;
  let stopReason: Anthropic.Message["stop_reason"];
  if (finishReason === "tool_calls")  stopReason = "tool_use";
  else if (finishReason === "length") stopReason = "max_tokens";
  else                                stopReason = "end_turn";

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
      input_tokens:               usage?.prompt_tokens              ?? 0,
      output_tokens:              usage?.completion_tokens          ?? 0,
      cache_read_input_tokens:    null,
      cache_creation_input_tokens: null,
    },
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function createMessageOpenAI(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  const model = params.model || getActiveModel();
  const token = await getAccessToken();

  const client = new OpenAI({ apiKey: token });

  const systemBlocks = (params.system ?? []) as Anthropic.TextBlockParam[];
  const systemStr    = systemText(systemBlocks);
  const messages     = convertMessages(params.messages);

  const fullMessages: ChatCompletionMessageParam[] = [
    ...(systemStr ? [{ role: "system" as const, content: systemStr }] : []),
    ...messages,
  ];

  const tools = (params.tools ?? []) as Anthropic.Tool[];
  const thinking = (params as { thinking?: Anthropic.ThinkingConfigParam }).thinking;
  const effort = reasoningEffort(thinking, model);

  const req: ChatCompletionCreateParamsNonStreaming = {
    model,
    max_tokens: params.max_tokens,
    messages:   fullMessages,
    ...(tools.length > 0 ? { tools: convertTools(tools) } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    stream: false,
  };

  log.agent(`[openai] ${model} — ${fullMessages.length} messages`);
  const completion = await client.chat.completions.create(req);
  return convertResponse(completion, model);
}
