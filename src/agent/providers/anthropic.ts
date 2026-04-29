// Anthropic client with model failover and retry-with-backoff.
// Auth priority: ANTHROPIC_AUTH_TOKEN (OAuth) > ANTHROPIC_API_KEY.
import Anthropic from "@anthropic-ai/sdk";
import { config, settings } from "../../config";
import { log } from "../../logger";
import { isAnthropicOAuthConnected, getAnthropicToken } from "../../anthropic/auth";

export function buildAnthropicClient(): Anthropic {
  if (isAnthropicOAuthConnected()) {
    const token = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_ACCESS_TOKEN;
    if (token) return new Anthropic({ authToken: token });
  }
  return new Anthropic({ apiKey: config.anthropicKey });
}

export const anthropic = buildAnthropicClient();

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const PER_MODEL_RETRIES = 2;
const RETRY_BASE_MS = 600;

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) return RETRYABLE_STATUSES.has(err.status ?? 0);
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function createMessageAnthropic(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
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

        if (!isRetryable(err)) throw err;

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
