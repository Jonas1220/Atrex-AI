// Anthropic OAuth token storage and refresh.
// Tokens are persisted in .env as ANTHROPIC_ACCESS_TOKEN, ANTHROPIC_REFRESH_TOKEN,
// and ANTHROPIC_TOKEN_EXPIRES_AT (Unix seconds).
//
// The Anthropic SDK also reads ANTHROPIC_AUTH_TOKEN automatically — we keep them
// in sync so the client can be constructed without per-call token lookup.
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { log } from "../logger";

const ENV_PATH = join(process.cwd(), ".env");
const CLAUDE_CREDENTIALS_PATH = join(
  process.env.HOME ?? "~",
  ".claude",
  ".credentials.json",
);

// macOS keychain entry written by the Claude Code CLI.
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_ACCOUNT = "Claude Code";

// ── .env helpers ──────────────────────────────────────────────────────────────

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

export function updateAnthropicEnvFile(updates: Record<string, string>): void {
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

// ── Public types ──────────────────────────────────────────────────────────────

export interface AnthropicOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix seconds (0 = unknown)
}

// ── Store / read ──────────────────────────────────────────────────────────────

export function storeAnthropicTokens(tokens: AnthropicOAuthTokens): void {
  updateAnthropicEnvFile({
    ANTHROPIC_ACCESS_TOKEN:     tokens.accessToken,
    ANTHROPIC_REFRESH_TOKEN:    tokens.refreshToken,
    ANTHROPIC_TOKEN_EXPIRES_AT: String(tokens.expiresAt),
    // Keep ANTHROPIC_AUTH_TOKEN in sync — the Anthropic SDK reads this env var.
    ANTHROPIC_AUTH_TOKEN:       tokens.accessToken,
  });
  process.env.ANTHROPIC_ACCESS_TOKEN     = tokens.accessToken;
  process.env.ANTHROPIC_REFRESH_TOKEN    = tokens.refreshToken;
  process.env.ANTHROPIC_TOKEN_EXPIRES_AT = String(tokens.expiresAt);
  process.env.ANTHROPIC_AUTH_TOKEN       = tokens.accessToken;
  log.success("Anthropic OAuth tokens stored.");
}

export function isAnthropicOAuthConnected(): boolean {
  const token = process.env.ANTHROPIC_ACCESS_TOKEN || readEnv().ANTHROPIC_ACCESS_TOKEN;
  if (!token) return false;
  const expiresAt = Number(
    process.env.ANTHROPIC_TOKEN_EXPIRES_AT ||
    readEnv().ANTHROPIC_TOKEN_EXPIRES_AT || "0",
  );
  if (expiresAt > 0 && expiresAt < Date.now() / 1000) return false;
  return true;
}

let refreshing: Promise<string> | null = null;

export async function getAnthropicToken(): Promise<string> {
  const env = readEnv();
  const token     = process.env.ANTHROPIC_ACCESS_TOKEN     || env.ANTHROPIC_ACCESS_TOKEN     || "";
  const refresh   = process.env.ANTHROPIC_REFRESH_TOKEN    || env.ANTHROPIC_REFRESH_TOKEN    || "";
  const expiresAt = Number(process.env.ANTHROPIC_TOKEN_EXPIRES_AT || env.ANTHROPIC_TOKEN_EXPIRES_AT || "0");

  const fiveMinsFromNow = Date.now() / 1000 + 300;
  if (token && (expiresAt === 0 || expiresAt > fiveMinsFromNow)) return token;

  if (!refresh) throw new Error("No Anthropic refresh token. Re-authenticate via the web admin.");

  if (refreshing) return refreshing;
  refreshing = doAnthropicRefresh(refresh).finally(() => { refreshing = null; });
  return refreshing;
}

async function doAnthropicRefresh(refreshToken: string): Promise<string> {
  log.info("Refreshing Anthropic OAuth token…");
  const res = await fetch("https://claude.ai/oauth/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
      client_id:     ANTHROPIC_CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic token refresh failed (${res.status}): ${body}`);
  }

  const data = await res.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const expiresAt = data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : 0;
  storeAnthropicTokens({
    accessToken:  data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt,
  });
  return data.access_token;
}

// ── Claude CLI credential import ──────────────────────────────────────────────
// Reads the access token that the Claude Code CLI already stored in the macOS
// keychain (or in ~/.claude/.credentials.json on other platforms). Call this
// only when the user explicitly clicks "Import CLI credentials".

function readKeychainRaw(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const result = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.trim();
  } catch {
    return null;
  }
}

interface ClaudeAiOauth {
  accessToken?:  string;
  refreshToken?: string;
  expiresAt?:    number;
}

function parseCliCredential(raw: string): AnthropicOAuthTokens | null {
  try {
    const parsed = JSON.parse(raw);
    const oauth: ClaudeAiOauth = parsed?.claudeAiOauth ?? {};
    if (!oauth.accessToken) return null;
    let expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
    // Claude CLI stores expiresAt in milliseconds; normalize to Unix seconds.
    if (expiresAt > 1e12) expiresAt = Math.floor(expiresAt / 1000);
    return {
      accessToken:  oauth.accessToken,
      refreshToken: oauth.refreshToken ?? "",
      expiresAt,
    };
  } catch {
    return null;
  }
}

export function loadFromCLI(): AnthropicOAuthTokens | null {
  // 1. macOS keychain
  const keychainRaw = readKeychainRaw();
  if (keychainRaw) {
    const cred = parseCliCredential(keychainRaw);
    if (cred) {
      log.info("Read Anthropic credentials from Claude CLI keychain.");
      return cred;
    }
  }

  // 2. File fallback (~/.claude/.credentials.json)
  if (existsSync(CLAUDE_CREDENTIALS_PATH)) {
    try {
      const raw = readFileSync(CLAUDE_CREDENTIALS_PATH, "utf-8");
      const cred = parseCliCredential(raw);
      if (cred) {
        log.info("Read Anthropic credentials from ~/.claude/.credentials.json.");
        return cred;
      }
    } catch {}
  }

  return null;
}

// Public client ID used by the Claude Code CLI for its OAuth flow.
export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
