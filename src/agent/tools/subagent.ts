// spawn_agent tool — lets the main agent delegate tasks to specialized sub-agents.
// Sub-agents run as isolated Anthropic conversations with a focused system prompt.
// They have access to plugin tools (search, APIs) but not memory/profile/schedule.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { settings } from "../../config";
import { log } from "../../logger";
import { getPluginTools, getPluginHandlers } from "../../plugins/loader";
import { createMessage } from "../anthropic";

// Load a pre-defined agent persona from agents/<role>.md, if it exists
function loadAgentPersona(role: string): string {
  const slug = role.toLowerCase().replace(/\s+/g, "-");
  const agentPath = join(process.cwd(), "agents", `${slug}.md`);
  if (existsSync(agentPath)) {
    return readFileSync(agentPath, "utf-8").trim();
  }
  return "";
}

// Returns the system prompt as two blocks so the stable persona prefix can be cached
// across tool-loop iterations. Volatile timestamp sits after the cache breakpoint.
function buildSystemPrompt(role: string, persona: string): Anthropic.TextBlockParam[] {
  const identity = persona
    ? persona
    : `You are a specialized AI agent acting as: ${role}.\n\nBe focused, direct, and thorough.`;
  const stable =
    `${identity}\n\n` +
    `You are a sub-agent. Complete the task you are given and return your findings clearly and concisely. ` +
    `You have no conversation history — the task is self-contained.`;

  return [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
    { type: "text", text: `Current time: ${new Date().toISOString()}` },
  ];
}

function withCachedTools(tools: Anthropic.Tool[]): Anthropic.ToolUnion[] {
  if (tools.length === 0) return tools;
  const lastIdx = tools.length - 1;
  return tools.map((t, i) =>
    i === lastIdx ? { ...t, cache_control: { type: "ephemeral" as const } } : t
  );
}

async function runLoop(
  systemPrompt: Anthropic.TextBlockParam[],
  task: string,
  tools: Anthropic.Tool[],
  handlers: Record<string, (input: Record<string, unknown>) => Promise<string>>
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const cachedTools = withCachedTools(tools);

  const baseRequest = {
    model:      settings.subagent_model,
    max_tokens: settings.max_tokens,
    system:     systemPrompt,
  } as const;

  let response: Anthropic.Message = await createMessage(
    cachedTools.length > 0
      ? { ...baseRequest, messages, tools: cachedTools }
      : { ...baseRequest, messages }
  );

  while (response.stop_reason === "tool_use") {
    const assistantContent = response.content
      .filter(
        (b): b is Anthropic.TextBlock | Anthropic.ToolUseBlock =>
          b.type === "text" || b.type === "tool_use"
      )
      .map((b) => {
        if (b.type === "text") return { type: "text" as const, text: b.text };
        return { type: "tool_use" as const, id: b.id, name: b.name, input: b.input };
      });

    messages.push({ role: "assistant", content: assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    )) {
      const handler = handlers[block.name];
      let result: string;
      if (!handler) {
        result = `Unknown tool: ${block.name}`;
      } else {
        try {
          log.subagent(`tool [${block.name}] executing`);
          result = await handler(block.input as Record<string, unknown>);
        } catch (err) {
          result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
    }

    messages.push({ role: "user", content: toolResults });

    response = await createMessage(
      cachedTools.length > 0
        ? { ...baseRequest, messages, tools: cachedTools }
        : { ...baseRequest, messages }
    );
  }

  return (
    response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n") || "(no output)"
  );
}

export const subagentTools: Anthropic.Tool[] = [
  {
    name: "spawn_agent",
    description:
      "Spawn a specialized sub-agent to handle a focused task. " +
      "The sub-agent runs independently with its own context, has access to all plugins (search, APIs, etc.), " +
      "and returns its result as text. " +
      "If a file agents/<role>.md exists, that persona is used. Otherwise the role description itself defines the agent. " +
      "Use this to delegate tasks that benefit from specialized expertise (e.g. 'financial-expert', 'researcher', 'code-reviewer').",
    input_schema: {
      type: "object" as const,
      properties: {
        role: {
          type: "string",
          description:
            "The sub-agent's role or expertise. Use a slug like 'financial-expert' or 'researcher' to match agents/<role>.md, " +
            "or any free-form description if no file exists.",
        },
        task: {
          type: "string",
          description:
            "The full task description for the sub-agent. Be specific — it has no conversation history and no context beyond what you provide here.",
        },
      },
      required: ["role", "task"],
    },
  },
];

export const subagentHandlers: Record<
  string,
  (input: Record<string, unknown>) => Promise<string>
> = {
  spawn_agent: async (input) => {
    const role = input.role as string;
    const task = input.task as string;

    log.subagent(`Spawning "${role}" (model: ${settings.subagent_model})`);

    const persona = loadAgentPersona(role);
    const systemPrompt = buildSystemPrompt(role, persona);
    const tools = getPluginTools();
    const handlers = getPluginHandlers();

    try {
      const result = await runLoop(systemPrompt, task, tools, handlers);
      log.subagent(`"${role}" finished`);
      return `[Sub-agent: ${role}]\n\n${result}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.subagent(`"${role}" failed: ${msg}`);
      return `Sub-agent "${role}" failed: ${msg}`;
    }
  },
};
