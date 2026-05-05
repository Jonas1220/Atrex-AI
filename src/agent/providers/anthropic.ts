// Anthropic client with model failover and retry-with-backoff.
import Anthropic from "@anthropic-ai/sdk";
import { config, settings } from "../../config";
import { log } from "../../logger";

export const anthropic = new Anthropic({ apiKey: config.anthropicKey });

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
  const client = new Anthropic({ apiKey: config.anthropicKey });

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
          log.warn(`Anthropic ${status ?? "network"} on ${model}, retrying in ${wait}ms (${attempt + 1}/${PER_MODEL_RETRIES})`);
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
