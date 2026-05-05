// Core AI agent — sends messages to Claude with tool support and manages the conversation loop.
import Anthropic from "@anthropic-ai/sdk";
import { settings, getSystemPrompt } from "../config";
import { log } from "../logger";
import { appendMessage, getHistory } from "./context";
import { getActiveSkill } from "./skills";
import { getTools, getToolHandlers, ToolContext } from "./tools";
import { createMessage, getActiveModel } from "./providers";
import { LoopGuard } from "./loop-guard";
import { getThinkingConfig, getThinkingLevel } from "./thinking";
import { pruneHistory } from "./pruning";
import { compactIfNeeded } from "./compaction";
import { TrajectoryBuilder, previewToolInput, TrajectoryToolCall } from "./trajectory";
import { emit as emitHook } from "./hooks";

// Marks the last tool with cache_control so Anthropic caches all tool definitions
// as a single block. Returns a new array (original is not mutated).
function withCachedTools(tools: Anthropic.Tool[]): Anthropic.ToolUnion[] {
  if (tools.length === 0) return tools;
  const lastIdx = tools.length - 1;
  return tools.map((t, i) =>
    i === lastIdx ? { ...t, cache_control: { type: "ephemeral" as const } } : t
  );
}

// Maps a tool name + input to a short human-readable status string.
function toolStatusText(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "read_file":               return `Reading ${input.path ?? "file"}...`;
    case "list_dir":                return `Listing ${input.path ?? "directory"}...`;
    case "run_shell":               return `Running: ${String(input.command ?? "").slice(0, 60)}...`;
    case "fetch_url":               return `Fetching ${input.url ?? "page"}...`;
    case "run_code":                return "Running code...";
    case "add_memory":              return "Saving to memory...";
    case "update_long_term_memory": return "Updating memory...";
    case "update_soul":             return "Updating personality...";
    case "update_user_profile":     return "Updating your profile...";
    case "update_heartbeat":        return "Updating heartbeat...";
    case "spawn_agent":             return `Consulting ${input.role ?? "agent"}...`;
    case "run_codex":               return `Codex: ${String(input.task ?? "").slice(0, 60)}...`;
    case "create_file":             return "Creating file...";
    case "send_reaction":           return "";
    case "use_skill":               return `Switching to ${input.skill_id ?? "skill"}...`;
    default: {
      if (name.includes("search")) return `Searching for "${input.query ?? input.q ?? "..."}"...`;
      return "Working...";
    }
  }
}

// Runs all tool_use blocks from a Claude response and collects their results.
// `ctx` is passed through to every handler so per-request state (userId) is never shared globally.
// `recorded` is filled with per-call metadata so the trajectory recorder can include it.
async function executeTools(
  content: Anthropic.ContentBlock[],
  ctx: ToolContext,
  recorded?: TrajectoryToolCall[]
): Promise<Anthropic.ToolResultBlockParam[]> {
  const toolUseBlocks = content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );

  const handlers = getToolHandlers();
  const results: Anthropic.ToolResultBlockParam[] = [];

  for (const block of toolUseBlocks) {
    const handler = handlers[block.name];
    let result: string;
    let errorMsg: string | undefined;
    const startedAt = Date.now();

    if (ctx.updateStatus) {
      await ctx.updateStatus(toolStatusText(block.name, block.input as Record<string, unknown>)).catch(() => {});
    }

    await emitHook("tool:before", {
      userId: ctx.userId,
      toolName: block.name,
      input: block.input as Record<string, unknown>,
    });

    if (!handler) {
      result = `Unknown tool: ${block.name}`;
      errorMsg = "unknown tool";
      log.warn(`Unknown tool called: ${block.name}`);
    } else {
      try {
        log.tool(block.name, "executing");
        result = await handler(block.input as Record<string, unknown>, ctx);
        log.tool(block.name, result);
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        result = `Tool error: ${errorMsg}`;
        log.error(`Tool ${block.name} failed: ${result}`);
      }
    }

    const durationMs = Date.now() - startedAt;
    await emitHook("tool:after", {
      userId: ctx.userId,
      toolName: block.name,
      resultLength: result.length,
      durationMs,
      error: errorMsg,
    });

    recorded?.push({
      name: block.name,
      inputPreview: previewToolInput(block.input),
      resultLength: result.length,
      durationMs,
      error: errorMsg,
    });

    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: result,
    });
  }

  return results;
}

function activeChatModel(userId: number): string {
  return getActiveSkill().model || getActiveModel();
}

export async function chat(
  userId: number,
  userMessage: string,
  onStatus?: (text: string) => Promise<void>,
  images?: Anthropic.ImageBlockParam[],
  telegramCtx?: { chatId: number; messageId: number }
): Promise<string> {
  const ctx: ToolContext = { userId, updateStatus: onStatus, ...telegramCtx };
  const traj = new TrajectoryBuilder(
    userId,
    userMessage,
    getThinkingLevel(userId),
    false
  );
  const guard = new LoopGuard();
  const startedAt = Date.now();

  await emitHook("chat:before", { userId, message: userMessage });

  const userContent: Anthropic.MessageParam["content"] = images?.length
    ? [...images, { type: "text" as const, text: userMessage || "[Image]" }]
    : userMessage;
  appendMessage(userId, { role: "user", content: userContent });

  await compactIfNeeded(userId);

  const activeModel = activeChatModel(userId);
  log.agent(`Calling ${activeModel} (${getHistory(userId).length} messages in context)`);

  const callParams = (model: string): Anthropic.MessageCreateParamsNonStreaming => {
    const thinking = getThinkingConfig(userId);
    return {
      model,
      max_tokens: settings.max_tokens,
      system: getSystemPrompt(),
      messages: pruneHistory(getHistory(userId)),
      tools: withCachedTools(getTools()),
      ...(thinking ? { thinking } : {}),
    };
  };

  try {
    let stepStart = Date.now();
    let response = await createMessage(callParams(activeModel));
    let toolsRan = false;
    let stoppedByGuard = false;

    while (response.stop_reason === "tool_use") {
      toolsRan = true;

      const assistantContent = response.content
        .filter((block): block is Anthropic.TextBlock | Anthropic.ToolUseBlock =>
          block.type === "text" || block.type === "tool_use"
        )
        .map((block) => {
          if (block.type === "text") return { type: "text" as const, text: block.text };
          return { type: "tool_use" as const, id: block.id, name: block.name, input: block.input };
        });

      appendMessage(userId, { role: "assistant", content: assistantContent });

      // Loop-guard check before we actually execute the tools — bail early
      // if the model is wedged calling the same thing repeatedly.
      if (guard.observe(response.content)) {
        stoppedByGuard = true;
        // Inject a synthetic tool_result so the conversation stays well-formed,
        // then break out of the loop without making another model call.
        const stubResults: Anthropic.ToolResultBlockParam[] = response.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((b) => ({
            type: "tool_result",
            tool_use_id: b.id,
            content: "Tool loop detected — execution aborted by safety guard.",
            is_error: true,
          }));
        appendMessage(userId, { role: "user", content: stubResults });
        traj.step({
          model: response.model,
          promptTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
          cacheReadTokens: response.usage?.cache_read_input_tokens ?? undefined,
          cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? undefined,
          stopReason: response.stop_reason,
          durationMs: Date.now() - stepStart,
          toolCalls: [],
        });
        break;
      }

      const recordedCalls: TrajectoryToolCall[] = [];
      const toolResults = await executeTools(response.content, ctx, recordedCalls);
      appendMessage(userId, { role: "user", content: toolResults });

      traj.step({
        model: response.model,
        promptTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        cacheReadTokens: response.usage?.cache_read_input_tokens ?? undefined,
        cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? undefined,
        stopReason: response.stop_reason,
        durationMs: Date.now() - stepStart,
        toolCalls: recordedCalls,
      });

      // Re-read active skill in case use_skill was called mid-loop
      stepStart = Date.now();
      response = await createMessage(callParams(activeChatModel(userId)));
    }

    // Warn if response was truncated (max_tokens hit)
    if (response.stop_reason === "max_tokens") {
      log.warn("Response truncated by max_tokens limit.");
    }

    if (!stoppedByGuard) {
      traj.step({
        model: response.model,
        promptTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        cacheReadTokens: response.usage?.cache_read_input_tokens ?? undefined,
        cacheCreationTokens: response.usage?.cache_creation_input_tokens ?? undefined,
        stopReason: response.stop_reason,
        durationMs: Date.now() - stepStart,
        toolCalls: [],
      });
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Only store text blocks in final message — never store orphaned tool_use blocks
    // that weren't executed (e.g. from a max_tokens truncation), as they corrupt the history
    const finalContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => ({ type: "text" as const, text: block.text }));

    if (finalContent.length > 0) {
      appendMessage(userId, { role: "assistant", content: finalContent });
    }

    let finalText: string;
    if (stoppedByGuard) {
      finalText = text || "Stopped — I was about to repeat the same tool call. Try rephrasing or use /clear.";
    } else if (!text && toolsRan) {
      finalText = "Done.";
    } else {
      finalText = text;
    }

    traj.finish(finalText);
    await emitHook("chat:after", {
      userId,
      message: userMessage,
      response: finalText,
      durationMs: Date.now() - startedAt,
    });

    return finalText;
  } catch (err) {
    traj.finish("", err instanceof Error ? err.message : String(err));
    await emitHook("chat:error", { userId, message: userMessage, error: err });
    throw err;
  }
}

// One-shot query — no history read, no history write, isolated from the main conversation.
export async function chatOnce(
  userId: number,
  userMessage: string,
  onStatus?: (text: string) => Promise<void>,
  label = "once"
): Promise<string> {
  const ctx: ToolContext = { userId, updateStatus: onStatus };

  const activeModel = getActiveSkill().model || getActiveModel();
  log.agent(`[${label}] Calling ${activeModel} (no context)`);

  const baseParams = (messages: Anthropic.MessageParam[]): Anthropic.MessageCreateParamsNonStreaming => ({
    model: activeModel,
    max_tokens: settings.max_tokens,
    system: getSystemPrompt(),
    messages,
    tools: withCachedTools(getTools()),
  });

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];
  let response = await createMessage(baseParams(messages));

  // Minimal tool loop — tools still work but nothing is persisted to main history
  let toolsRan = false;
  const guard = new LoopGuard();

  while (response.stop_reason === "tool_use") {
    toolsRan = true;

    if (guard.observe(response.content)) {
      log.warn(`[${label}] Tool-loop detected — aborting`);
      break;
    }

    const assistantContent = response.content
      .filter((block): block is Anthropic.TextBlock | Anthropic.ToolUseBlock =>
        block.type === "text" || block.type === "tool_use"
      )
      .map((block) => {
        if (block.type === "text") return { type: "text" as const, text: block.text };
        return { type: "tool_use" as const, id: block.id, name: block.name, input: block.input };
      });

    const toolResults = await executeTools(response.content, ctx);

    messages.push({ role: "assistant", content: assistantContent });
    messages.push({ role: "user", content: toolResults });

    response = await createMessage(baseParams(messages));
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  if (!text && toolsRan) return "Done.";
  return text;
}
