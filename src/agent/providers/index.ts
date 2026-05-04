// Provider dispatcher — routes createMessage() calls to the active LLM backend.
// Supports Anthropic (default), OpenAI, and NVIDIA NIM.
// Runtime provider can be overridden per-process via setRuntimeProvider().
import Anthropic from "@anthropic-ai/sdk";
import { settings } from "../../config";
import { createMessageAnthropic } from "./anthropic";
import { createMessageOpenAI } from "./openai";
import { createMessageNvidia } from "./nvidia";
import { createMessageOllama } from "./ollama";

export { anthropic } from "./anthropic";

// Runtime overrides — applied immediately without a restart.
// null = fall back to the value loaded from settings.json at startup.
let runtimeProvider: "anthropic" | "openai" | "nvidia" | "ollama" | null = null;
let runtimeModel: string | null = null;

export function setRuntimeProvider(p: "anthropic" | "openai" | "nvidia" | "ollama" | null): void {
  runtimeProvider = p;
}

export function getActiveProvider(): "anthropic" | "openai" | "nvidia" | "ollama" {
  return runtimeProvider ?? settings.provider;
}

export function setRuntimeModel(model: string | null): void {
  runtimeModel = model;
}

export function getActiveModel(): string {
  return runtimeModel ?? settings.model;
}

export interface MessageOverrides {
  model?: string;
  provider?: "anthropic" | "openai" | "nvidia" | "ollama";
}

export async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  overrides?: MessageOverrides
): Promise<Anthropic.Message> {
  const provider = overrides?.provider ?? getActiveProvider();
  const resolved = overrides?.model ? { ...params, model: overrides.model } : params;
  if (provider === "openai")  return createMessageOpenAI(resolved);
  if (provider === "nvidia")  return createMessageNvidia(resolved);
  if (provider === "ollama")  return createMessageOllama(resolved);
  return createMessageAnthropic(resolved);
}
