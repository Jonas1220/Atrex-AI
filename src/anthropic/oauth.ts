// Express routes for Anthropic Claude account OAuth.
// Supports two flows:
//   1. CLI import — POST /auth/anthropic/import-cli reads existing Claude Code
//      CLI keychain credentials (no browser needed, instant).
//   2. Browser redirect (PKCE) — GET /auth/anthropic → platform.claude.com consent →
//      GET /auth/anthropic/callback → tokens stored.
import { Router } from "express";
import { randomBytes, createHash } from "crypto";
import {
  ANTHROPIC_CLIENT_ID,
  isAnthropicOAuthConnected,
  loadFromCLI,
  storeAnthropicTokens,
  updateAnthropicEnvFile,
} from "./auth";
import { log } from "../logger";

const AUTH_BASE  = "https://platform.claude.com";
const AUTH_URL   = `${AUTH_BASE}/oauth/authorize`;
// Token endpoint is inferred from the standard PKCE pattern for this client.
const TOKEN_URL  = "https://claude.ai/oauth/token";
const SCOPES     = "openid org:create_api_key";

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier  = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthUrl(port: number, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type:         "code",
    client_id:             ANTHROPIC_CLIENT_ID,
    redirect_uri:          `http://localhost:${port}/auth/anthropic/callback`,
    scope:                 SCOPES,
    code_challenge:        codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params}`;
}

export function createAnthropicRouter(port: number): Router {
  const router = Router();

  let pkceVerifier = "";

  // ── Status ─────────────────────────────────────────────────────────────────
  router.get("/auth/anthropic/status", (_req, res) => {
    res.json({ connected: isAnthropicOAuthConnected() });
  });

  // ── CLI import ─────────────────────────────────────────────────────────────
  // Reads the Claude Code CLI keychain entry and stores tokens in .env.
  // Only runs when the user explicitly clicks the button in the web admin.
  router.post("/auth/anthropic/import-cli", (_req, res) => {
    try {
      const cred = loadFromCLI();
      if (!cred) {
        res.status(404).json({
          error: "No Claude CLI credentials found. Make sure Claude Code is installed and you are logged in (`claude login`).",
        });
        return;
      }
      storeAnthropicTokens(cred);
      log.success("Anthropic credentials imported from Claude CLI.");
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Browser redirect: start ────────────────────────────────────────────────
  router.get("/auth/anthropic", (_req, res) => {
    const { verifier, challenge } = generatePKCE();
    pkceVerifier = verifier;
    res.redirect(buildAuthUrl(port, challenge));
  });

  // ── Browser redirect: callback ─────────────────────────────────────────────
  router.get("/auth/anthropic/callback", async (req, res) => {
    const code  = req.query.code  as string | undefined;
    const error = req.query.error as string | undefined;

    if (error) { res.status(400).send(`Anthropic auth error: ${error}`); return; }
    if (!code)  { res.status(400).send("Missing authorization code."); return; }

    try {
      const body = new URLSearchParams({
        grant_type:    "authorization_code",
        code,
        client_id:     ANTHROPIC_CLIENT_ID,
        redirect_uri:  `http://localhost:${port}/auth/anthropic/callback`,
        code_verifier: pkceVerifier,
      });

      const r = await fetch(TOKEN_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      if (!r.ok) {
        const text = await r.text().catch(() => "");
        res.status(502).send(`Token exchange failed (${r.status}): ${text}`);
        return;
      }

      const data = await r.json() as {
        access_token:  string;
        refresh_token?: string;
        expires_in?:   number;
      };

      storeAnthropicTokens({
        accessToken:  data.access_token,
        refreshToken: data.refresh_token ?? "",
        expiresAt:    data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : 0,
      });

      pkceVerifier = "";
      log.success("Anthropic OAuth complete (browser PKCE).");
      res.send("<html><body><h2>Anthropic connected.</h2><p>You can close this tab.</p></body></html>");
    } catch (err) {
      res.status(500).send(`Error: ${err}`);
    }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  router.delete("/auth/anthropic", (_req, res) => {
    updateAnthropicEnvFile({
      ANTHROPIC_ACCESS_TOKEN:     "",
      ANTHROPIC_REFRESH_TOKEN:    "",
      ANTHROPIC_TOKEN_EXPIRES_AT: "",
      ANTHROPIC_AUTH_TOKEN:       "",
    });
    process.env.ANTHROPIC_ACCESS_TOKEN     = "";
    process.env.ANTHROPIC_REFRESH_TOKEN    = "";
    process.env.ANTHROPIC_TOKEN_EXPIRES_AT = "";
    process.env.ANTHROPIC_AUTH_TOKEN       = "";
    log.info("Anthropic OAuth tokens cleared.");
    res.json({ ok: true });
  });

  return router;
}
