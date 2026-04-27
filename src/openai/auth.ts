// OpenAI OAuth token storage and refresh.
// Tokens are persisted in .env as OPENAI_ACCESS_TOKEN, OPENAI_REFRESH_TOKEN,
// and OPENAI_TOKEN_EXPIRES_AT (Unix seconds). Refresh happens automatically
// when the access token is within 5 minutes of expiry.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { log } from "../logger";

const ENV_PATH = join(process.cwd(), ".env");

// ── .env reader/writer ────────────────────────────────────────────────────────
function readEnv(): Record<string, string> {
  try {
    const lines = readFileSync(ENV_PATH, "utf-8").split("\n");
    const out: Record<string, string> = {};
    for (const line of lines) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/s);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

export function updateEnvFile(updates: Record<string, string>): void {
  let content = "";
  try { content = readFileSync(ENV_PATH, "utf-8"); } catch {}

  const lines = content.split("\n");
  const written = new Set<string>();

  const patched = lines.map((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
    if (m && updates[m[1]] !== undefined) {
      written.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key)) patched.push(`${key}=${value}`);
  }

  writeFileSync(ENV_PATH, patched.join("\n"), "utf-8");
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix seconds
}

export function storeTokens(tokens: OAuthTokens): void {
  updateEnvFile({
    OPENAI_ACCESS_TOKEN:    tokens.accessToken,
    OPENAI_REFRESH_TOKEN:   tokens.refreshToken,
    OPENAI_TOKEN_EXPIRES_AT: String(tokens.expiresAt),
  });
  // Reflect into process.env so the running process picks them up immediately
  process.env.OPENAI_ACCESS_TOKEN    = tokens.accessToken;
  process.env.OPENAI_REFRESH_TOKEN   = tokens.refreshToken;
  process.env.OPENAI_TOKEN_EXPIRES_AT = String(tokens.expiresAt);
  log.success("OpenAI OAuth tokens stored.");
}

export function isOpenAIConnected(): boolean {
  const token = process.env.OPENAI_ACCESS_TOKEN || readEnv().OPENAI_ACCESS_TOKEN;
  if (!token) return false;
  const expiresAt = Number(process.env.OPENAI_TOKEN_EXPIRES_AT || readEnv().OPENAI_TOKEN_EXPIRES_AT || "0");
  if (expiresAt > 0 && expiresAt < Date.now() / 1000) return false;
  return true;
}

let refreshing: Promise<string> | null = null;

export async function getAccessToken(): Promise<string> {
  const env = readEnv();
  const token      = process.env.OPENAI_ACCESS_TOKEN    || env.OPENAI_ACCESS_TOKEN || "";
  const refresh    = process.env.OPENAI_REFRESH_TOKEN   || env.OPENAI_REFRESH_TOKEN || "";
  const expiresAt  = Number(process.env.OPENAI_TOKEN_EXPIRES_AT || env.OPENAI_TOKEN_EXPIRES_AT || "0");

  const fiveMinsFromNow = Date.now() / 1000 + 300;
  if (token && (expiresAt === 0 || expiresAt > fiveMinsFromNow)) {
    return token;
  }

  if (!refresh) throw new Error("No OpenAI refresh token. Re-authenticate via the web admin (/auth/openai).");

  // Deduplicate concurrent refresh calls
  if (refreshing) return refreshing;
  refreshing = doRefresh(refresh).finally(() => { refreshing = null; });
  return refreshing;
}

async function doRefresh(refreshToken: string): Promise<string> {
  log.info("Refreshing OpenAI OAuth token…");
  const res = await fetch("https://auth.openai.com/oauth/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
      client_id:     CODEX_CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const expiresAt = data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : 0;
  storeTokens({
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt,
  });
  return data.access_token;
}

// Public client ID used by the Codex CLI for its OAuth flow.
// This is intentionally public — the same as `openai codex login`.
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
