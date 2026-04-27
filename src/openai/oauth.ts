// Express routes for OpenAI Codex subscription OAuth.
// Supports two flows:
//   1. Device-code (best for VPS/headless) — GET /auth/openai/device-start,
//      then poll POST /auth/openai/device-poll until tokens arrive.
//   2. Browser redirect (PKCE) — GET /auth/openai → auth.openai.com consent →
//      GET /auth/openai/callback → tokens stored.
import { Router } from "express";
import { randomBytes, createHash } from "crypto";
import { CODEX_CLIENT_ID, isOpenAIConnected, storeTokens } from "./auth";
import { log } from "../logger";

const AUTH_BASE        = "https://auth.openai.com";
const TOKEN_URL        = `${AUTH_BASE}/oauth/token`;
const DEVICE_CALLBACK  = `${AUTH_BASE}/deviceauth/callback`;
const SCOPES           = "openid profile email offline_access";

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier  = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function buildAuthUrl(port: number, codeChallenge: string): string {
  const params = new URLSearchParams({
    response_type:         "code",
    client_id:             CODEX_CLIENT_ID,
    redirect_uri:          `http://localhost:${port}/callback`,
    scope:                 SCOPES,
    code_challenge:        codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_BASE}/authorize?${params}`;
}

export function createOpenAIRouter(port: number): Router {
  const router = Router();

  let pkceVerifier = "";

  // ── Status ────────────────────────────────────────────────────────────────
  router.get("/auth/openai/status", (_req, res) => {
    res.json({ connected: isOpenAIConnected() });
  });

  // ── Device-code: start ────────────────────────────────────────────────────
  // Step 1: POST /api/accounts/deviceauth/usercode → { device_auth_id, user_code, interval }
  // Returns { device_auth_id, user_code, verification_uri, interval } for the UI.
  router.get("/auth/openai/device-start", async (_req, res) => {
    try {
      const r = await fetch(`${AUTH_BASE}/api/accounts/deviceauth/usercode`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        res.status(502).json({ error: `OpenAI device-code error (${r.status}): ${text}` });
        return;
      }
      const data = await r.json() as {
        device_auth_id?: string;
        user_code?: string;
        usercode?: string;
        interval?: number;
      };
      const deviceAuthId = data.device_auth_id;
      const userCode     = data.user_code ?? data.usercode;
      if (!deviceAuthId || !userCode) {
        res.status(502).json({ error: "OpenAI response missing device_auth_id or user_code." });
        return;
      }
      res.json({
        device_auth_id:   deviceAuthId,
        user_code:        userCode,
        verification_uri: `${AUTH_BASE}/codex/device`,
        interval:         data.interval ?? 5,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Device-code: poll ────────────────────────────────────────────────────
  // Step 2: Poll POST /api/accounts/deviceauth/token with { device_auth_id, user_code }.
  //         403/404 = still waiting; 200 = { authorization_code, code_verifier }.
  // Step 3: Exchange POST /oauth/token with server-returned code_verifier → tokens.
  router.post("/auth/openai/device-poll", async (req, res) => {
    const { device_auth_id, user_code } = req.body as {
      device_auth_id?: string;
      user_code?: string;
    };
    if (!device_auth_id || !user_code) {
      res.status(400).json({ error: "device_auth_id and user_code required" });
      return;
    }

    try {
      // Step 2 — check if user has approved
      const pollRes = await fetch(`${AUTH_BASE}/api/accounts/deviceauth/token`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ device_auth_id, user_code }),
      });

      if (pollRes.status === 403 || pollRes.status === 404) {
        res.json({ pending: true });
        return;
      }

      if (!pollRes.ok) {
        const text = await pollRes.text().catch(() => "");
        let errMsg = `HTTP ${pollRes.status}`;
        try {
          const j = JSON.parse(text) as { error?: string; error_description?: string };
          if (j.error) errMsg = j.error_description ? `${j.error}: ${j.error_description}` : j.error;
        } catch {}
        res.status(502).json({ error: errMsg });
        return;
      }

      const pollData = await pollRes.json() as {
        authorization_code?: string;
        code_verifier?: string;
      };
      const authorizationCode = pollData.authorization_code;
      const codeVerifier      = pollData.code_verifier;
      if (!authorizationCode || !codeVerifier) {
        res.status(502).json({ error: "OpenAI authorization response missing exchange fields." });
        return;
      }

      // Step 3 — exchange for tokens
      const tokenRes = await fetch(TOKEN_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type:    "authorization_code",
          code:          authorizationCode,
          redirect_uri:  DEVICE_CALLBACK,
          client_id:     CODEX_CLIENT_ID,
          code_verifier: codeVerifier,
        }),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => "");
        res.status(502).json({ error: `Token exchange failed (${tokenRes.status}): ${text}` });
        return;
      }

      const tokenData = await tokenRes.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!tokenData.access_token) {
        res.status(502).json({ error: "Token exchange succeeded but no access_token returned." });
        return;
      }

      storeTokens({
        accessToken:  tokenData.access_token,
        refreshToken: tokenData.refresh_token ?? "",
        expiresAt:    tokenData.expires_in
          ? Math.floor(Date.now() / 1000) + tokenData.expires_in
          : 0,
      });
      log.success("OpenAI Codex OAuth complete (device-code).");
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Browser redirect: start ───────────────────────────────────────────────
  router.get("/auth/openai", (_req, res) => {
    const { verifier, challenge } = generatePKCE();
    pkceVerifier = verifier;
    res.redirect(buildAuthUrl(port, challenge));
  });

  // ── Browser redirect: callback ────────────────────────────────────────────
  router.get("/callback", async (req, res) => {
    const code  = req.query.code  as string | undefined;
    const error = req.query.error as string | undefined;

    if (error) { res.status(400).send(`OpenAI auth error: ${error}`); return; }
    if (!code)  { res.status(400).send("Missing authorization code."); return; }

    try {
      const body = new URLSearchParams({
        grant_type:    "authorization_code",
        code,
        client_id:     CODEX_CLIENT_ID,
        redirect_uri:  `http://localhost:${port}/callback`,
        code_verifier: pkceVerifier,
      });
      const r = await fetch(TOKEN_URL, {
        method:  "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "Accept": "application/json",
        },
        body,
      });

      if (!r.ok) {
        const text = await r.text().catch(() => "");
        res.status(502).send(`Token exchange failed (${r.status}): ${text}`);
        return;
      }

      const data = await r.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };
      storeTokens({
        accessToken:  data.access_token,
        refreshToken: data.refresh_token ?? "",
        expiresAt:    data.expires_in
          ? Math.floor(Date.now() / 1000) + data.expires_in
          : 0,
      });
      pkceVerifier = "";
      log.success("OpenAI Codex OAuth complete (browser).");
      res.send(`<html><head><script>
try { if (window.opener) window.opener.postMessage({type:'openai-connected'},'*'); } catch(e){}
setTimeout(function(){ window.close(); }, 100);
</script></head>
<body style="font-family:system-ui;text-align:center;padding:40px;background:#0f1117;color:#e2e8f0">
<h2 style="color:#4ade80">OpenAI connected!</h2>
<p style="color:#94a3b8">This window will close automatically.</p></body></html>`);
    } catch (err) {
      res.status(500).send(`Error: ${err}`);
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  router.delete("/auth/openai", (_req, res) => {
    const { updateEnvFile } = require("./auth") as typeof import("./auth");
    updateEnvFile({
      OPENAI_ACCESS_TOKEN:     "",
      OPENAI_REFRESH_TOKEN:    "",
      OPENAI_TOKEN_EXPIRES_AT: "",
    });
    process.env.OPENAI_ACCESS_TOKEN     = "";
    process.env.OPENAI_REFRESH_TOKEN    = "";
    process.env.OPENAI_TOKEN_EXPIRES_AT = "";
    log.info("OpenAI OAuth tokens cleared.");
    res.json({ ok: true });
  });

  return router;
}
