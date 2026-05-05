// Moonshot (Kimi) provider adapter — OpenAI-compatible API at api.moonshot.ai.
// Auth is via MOONSHOT_API_KEY in .env.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getActiveModel } from ".";
import { log } from "../../logger";
import { createMessageWithClient } from "./openai-compat";

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";

export function isMoonshotConnected(): boolean {
  return !!process.env.MOONSHOT_API_KEY;
}

export async function createMessageMoonshot(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  const key = process.env.MOONSHOT_API_KEY;
  if (!key) throw new Error("MOONSHOT_API_KEY not set.");
  const model = params.model || getActiveModel();
  const client = new OpenAI({ apiKey: key, baseURL: MOONSHOT_BASE_URL });
  log.agent(`[moonshot] ${model} — ${params.messages.length} messages`);
  return createMessageWithClient(params, client, model);
}
