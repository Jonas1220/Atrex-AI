// OpenAI provider adapter — accepts Anthropic-shaped request params and returns
// an Anthropic-shaped Message, so agent.ts never needs to know which provider
// is in use. Auth is via OpenAI OAuth (ChatGPT account).
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getActiveModel } from ".";
import { log } from "../../logger";
import { getAccessToken } from "../../openai/auth";
import { createMessageWithClient } from "./openai-compat";

export async function createMessageOpenAI(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  const model = params.model || getActiveModel();
  const token = await getAccessToken();
  const client = new OpenAI({ apiKey: token });
  log.agent(`[openai] ${model} — ${params.messages.length} messages`);
  return createMessageWithClient(params, client, model);
}
