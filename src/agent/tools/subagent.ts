// spawn_agent tool — lets the main agent delegate tasks to specialized sub-agents.
// Sub-agents run as isolated conversations with a focused system prompt.
// Each agent in agents/<role>.md can specify its own model and provider via frontmatter.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { settings } from "../../config";
import { log } from "../../logger";
import { getPluginTools, getPluginHandlers } from "../../plugins/loader";
import { createMessage, getActiveModel, getActiveProvider, MessageOverrides } from "../providers";
import { codexTools, codexHandlers } from "./codex";

const AGENTS_DIR = join(process.cwd(), "agents");

interface AgentPersona {
  systemPrompt: string;
  model?: string;
  provider?: "anthropic" | "openai" | "nvidia";
}

// Parses optional YAML frontmatter (model, provider) from agents/<role>.md
function loadAgentPersona(role: string): AgentPersona {
  const slug = role.toLowerCase().replace(/\s+/g, "-");
  const path = join(AGENTS_DIR, `${slug}.md`);
  if (!existsSync(path)) return { systemPrompt: "" };

  const raw = readFileSync(path, "utf-8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { systemPrompt: raw.trim() };

  const front = match[1];
  const body = match[2].trim();

  const get = (key: string): string => {
    const m = front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };

  const model = get("model");
  const providerRaw = get("provider");
  const provider =
    providerRaw === "openai" || providerRaw === "nvidia" || providerRaw === "anthropic"
      ? providerRaw
      : undefined;

  return { systemPrompt: body, ...(model ? { model } : {}), ...(provider ? { provider } : {}) };
}

function buildSystemPrompt(role: string, persona: AgentPersona): Anthropic.TextBlockParam[] {
  const identity = persona.systemPrompt
    ? persona.systemPrompt
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
  overrides: MessageOverrides,
  tools: Anthropic.Tool[],
  handlers: Record<string, (input: Record<string, unknown>) => Promise<string>>
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const cachedTools = withCachedTools(tools);

  const baseParams: Anthropic.MessageCreateParamsNonStreaming = {
    model:      overrides.model ?? getActiveModel(),
    max_tokens: settings.max_tokens,
    system:     systemPrompt,
    messages,
  };

  let response: Anthropic.Message = await createMessage(
    cachedTools.length > 0 ? { ...baseParams, tools: cachedTools } : baseParams,
    overrides
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
        ? { ...baseParams, messages, tools: cachedTools }
        : { ...baseParams, messages },
      overrides
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
      "The sub-agent runs independently with its own context and returns its result as text. " +
      "If agents/<role>.md exists, that persona is used — including its configured model and provider. " +
      "Available roles: 'coder' (coding tasks), 'researcher' (web research). " +
      "Or use any free-form role description for an ad-hoc agent.",
    input_schema: {
      type: "object" as const,
      properties: {
        role: {
          type: "string",
          description:
            "The sub-agent role. Use a slug matching agents/<role>.md (e.g. 'coder', 'researcher') " +
            "or any free-form description for an ad-hoc agent with no persona file.",
        },
        task: {
          type: "string",
          description:
            "The full task for the sub-agent. Be specific — it has no conversation history beyond what you provide here.",
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

    const persona = loadAgentPersona(role);
    const overrides: MessageOverrides = {
      model:    persona.model    ?? getActiveModel(),
      provider: persona.provider ?? getActiveProvider(),
    };

    log.subagent(`Spawning "${role}" (${overrides.provider}/${overrides.model})`);

    const systemPrompt = buildSystemPrompt(role, persona);
    const tools = [...getPluginTools(), ...codexTools];
    const pluginHandlerMap = getPluginHandlers();
    const handlers: Record<string, (input: Record<string, unknown>) => Promise<string>> = {
      ...pluginHandlerMap,
    };
    for (const [name, fn] of Object.entries(codexHandlers)) {
      handlers[name] = (input) => fn(input, { userId: 0 });
    }

    try {
      const result = await runLoop(systemPrompt, task, overrides, tools, handlers);
      log.subagent(`"${role}" finished`);
      return `[Sub-agent: ${role}]\n\n${result}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.subagent(`"${role}" failed: ${msg}`);
      return `Sub-agent "${role}" failed: ${msg}`;
    }
  },
};
