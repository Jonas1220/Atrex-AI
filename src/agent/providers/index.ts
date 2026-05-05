// Provider dispatcher — routes createMessage() calls to the active LLM backend.
// Supports Anthropic (API key), OpenAI (OAuth), Moonshot (API key), Ollama (local URL).
import Anthropic from "@anthropic-ai/sdk";
import { settings } from "../../config";
import { createMessageAnthropic } from "./anthropic";
import { createMessageOpenAI } from "./openai";
import { createMessageMoonshot } from "./moonshot";
import { createMessageOllama } from "./ollama";

export { anthropic } from "./anthropic";
export { isMoonshotConnected } from "./moonshot";
export { isOllamaConnected } from "./ollama";

export type Provider = "anthropic" | "openai" | "moonshot" | "ollama";

let runtimeProvider: Provider | null = null;
let runtimeModel: string | null = null;

export function setRuntimeProvider(p: Provider | null): void {
  runtimeProvider = p;
}

export function getActiveProvider(): Provider {
  return runtimeProvider ?? (settings.provider as Provider);
}

export function setRuntimeModel(model: string | null): void {
  runtimeModel = model;
}

export function getActiveModel(): string {
  return runtimeModel ?? settings.model;
}

export interface MessageOverrides {
  model?: string;
  provider?: Provider;
}

export async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  overrides?: MessageOverrides
): Promise<Anthropic.Message> {
  const provider = overrides?.provider ?? getActiveProvider();
  const resolved = overrides?.model ? { ...params, model: overrides.model } : params;
  if (provider === "openai")   return createMessageOpenAI(resolved);
  if (provider === "moonshot") return createMessageMoonshot(resolved);
  if (provider === "ollama")   return createMessageOllama(resolved);
  return createMessageAnthropic(resolved);
}
