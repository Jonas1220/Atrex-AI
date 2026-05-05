// Provider dispatcher — routes createMessage() calls to the active LLM backend.
// Supports Anthropic (API key) and OpenAI (OAuth).
import Anthropic from "@anthropic-ai/sdk";
import { settings } from "../../config";
import { createMessageAnthropic } from "./anthropic";
import { createMessageOpenAI } from "./openai";

export { anthropic } from "./anthropic";

let runtimeProvider: "anthropic" | "openai" | null = null;
let runtimeModel: string | null = null;

export function setRuntimeProvider(p: "anthropic" | "openai" | null): void {
  runtimeProvider = p;
}

export function getActiveProvider(): "anthropic" | "openai" {
  return runtimeProvider ?? (settings.provider as "anthropic" | "openai");
}

export function setRuntimeModel(model: string | null): void {
  runtimeModel = model;
}

export function getActiveModel(): string {
  return runtimeModel ?? settings.model;
}

export interface MessageOverrides {
  model?: string;
  provider?: "anthropic" | "openai";
}

export async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming,
  overrides?: MessageOverrides
): Promise<Anthropic.Message> {
  const provider = overrides?.provider ?? getActiveProvider();
  const resolved = overrides?.model ? { ...params, model: overrides.model } : params;
  if (provider === "openai") return createMessageOpenAI(resolved);
  return createMessageAnthropic(resolved);
}
