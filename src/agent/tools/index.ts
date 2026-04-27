// Aggregates all built-in tools and dynamically loaded plugin tools into a single registry.
import Anthropic from "@anthropic-ai/sdk";
import { profileTools, profileHandlers } from "./profile";
import { pluginTools, pluginHandlers } from "./plugins";
import { memoryTools, memoryHandlers } from "./memory";
import { subagentTools, subagentHandlers } from "./subagent";
import { skillTools, skillHandlers } from "./skills";
import { fileTools, fileHandlers } from "./files";
import { filesystemTools, filesystemHandlers } from "./filesystem";
import { shellTools, shellHandlers } from "./shell";
import { fetchTools, fetchHandlers } from "./fetch";
import { codeTools, codeHandlers } from "./code";
import { buttonTools, buttonHandlers } from "./buttons";
import { reactionTools, reactionHandlers } from "./reactions";
import { heartbeatTools, heartbeatHandlers } from "./heartbeat";
import { escalationTools, escalationHandlers } from "../escalation";
import { getPluginTools, getPluginHandlers } from "../../plugins/loader";
import type { ToolHandler } from "./types";

export type { ToolContext, ToolHandler } from "./types";

const builtInTools: Anthropic.Tool[] = [
  ...profileTools,
  ...pluginTools,
  ...memoryTools,
  ...subagentTools,
  ...skillTools,
  ...fileTools,
  ...filesystemTools,
  ...shellTools,
  ...fetchTools,
  ...codeTools,
  ...buttonTools,
  ...reactionTools,
  ...heartbeatTools,
  ...escalationTools,
];

const builtInHandlers: Record<string, ToolHandler> = {
  ...profileHandlers,
  ...pluginHandlers,
  ...memoryHandlers,
  ...subagentHandlers,
  ...skillHandlers,
  ...fileHandlers,
  ...filesystemHandlers,
  ...shellHandlers,
  ...fetchHandlers,
  ...codeHandlers,
  ...buttonHandlers,
  ...reactionHandlers,
  ...heartbeatHandlers,
  ...escalationHandlers,
};

// Called on every request — includes dynamically loaded plugin tools
export function getTools(): Anthropic.Tool[] {
  return [...builtInTools, ...getPluginTools()];
}

// Plugin handlers use the legacy (input) => Promise<string> signature.
// Wrap them so they satisfy ToolHandler (extra `ctx` arg is simply ignored).
export function getToolHandlers(): Record<string, ToolHandler> {
  const wrapped: Record<string, ToolHandler> = {};
  for (const [name, fn] of Object.entries(getPluginHandlers())) {
    wrapped[name] = async (input) => fn(input);
  }
  return { ...builtInHandlers, ...wrapped };
}
