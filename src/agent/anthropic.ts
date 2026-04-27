// Centralized LLM wrapper. Dispatches to Anthropic or OpenAI based on
// settings.provider. Within Anthropic, adds model failover and retry-with-backoff.
// Auth priority: ANTHROPIC_AUTH_TOKEN (OAuth) > ANTHROPIC_API_KEY.
import Anthropic from "@anthropic-ai/sdk";
import { config, settings } from "../config";
import { log } from "../logger";
import { createMessageOpenAI } from "./openai-provider";
import { isAnthropicOAuthConnected, getAnthropicToken } from "../anthropic/auth";

function buildAnthropicClient(): Anthropic {
  // ANTHROPIC_AUTH_TOKEN is set when OAuth is active (written by storeAnthropicTokens).
  // The Anthropic SDK reads it automatically, but we pass it explicitly so the
  // runtime client always reflects the current process.env state.
  if (isAnthropicOAuthConnected()) {
    const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_ACCESS_TOKEN;
    if (token) return new Anthropic({ authToken: token });
  }
  return new Anthropic({ apiKey: config.anthropicKey });
}

export const anthropic = buildAnthropicClient();

// Runtime provider override — set via /provider command, persists for the process lifetime.
// null means fall back to settings.provider (from settings.json at startup).
let runtimeProvider: "anthropic" | "openai" | null = null;

export function setRuntimeProvider(p: "anthropic" | "openai" | null): void {
  runtimeProvider = p;
}

export function getActiveProvider(): "anthropic" | "openai" {
  return runtimeProvider ?? settings.provider;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const PER_MODEL_RETRIES = 2;
const RETRY_BASE_MS = 600;

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) return RETRYABLE_STATUSES.has(err.status ?? 0);
  // Network-level errors (fetch aborted, ECONNRESET) are usually retryable
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Call the active LLM provider. Dispatches to OpenAI when settings.provider
 * is "openai"; otherwise uses Anthropic with model failover + retry.
 */
export async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  if (getActiveProvider() === "openai") {
    return createMessageOpenAI(params);
  }

  // Rebuild client per-call when OAuth is active so a freshly stored token
  // is picked up without requiring a process restart.
  let client = anthropic;
  if (isAnthropicOAuthConnected()) {
    try {
      const token = await getAnthropicToken();
      client = new Anthropic({ authToken: token });
    } catch (err) {
      log.warn(`OAuth token unavailable, falling back to API key: ${err}`);
    }
  }

  const chain = [params.model, ...settings.fallbacks].filter(
    (m, i, arr) => m && arr.indexOf(m) === i
  );

  let lastErr: unknown;
  for (const model of chain) {
    for (let attempt = 0; attempt <= PER_MODEL_RETRIES; attempt++) {
      try {
        return await client.messages.create({ ...params, model });
      } catch (err) {
        lastErr = err;
        const status = err instanceof Anthropic.APIError ? err.status : undefined;
        const msg = err instanceof Error ? err.message : String(err);

        if (!isRetryable(err)) {
          // Non-retryable on this model and not worth trying fallbacks
          // (e.g. 400 invalid request) — fail fast.
          throw err;
        }

        if (attempt < PER_MODEL_RETRIES) {
          const wait = RETRY_BASE_MS * Math.pow(2, attempt);
          log.warn(
            `Anthropic ${status ?? "network"} on ${model}, retrying in ${wait}ms (${attempt + 1}/${PER_MODEL_RETRIES})`
          );
          await sleep(wait);
          continue;
        }

        log.warn(`Model ${model} failed (${status ?? "network"}): ${msg}. Falling over.`);
        break;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
