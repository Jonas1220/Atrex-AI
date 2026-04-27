// Express routes for the Google OAuth2 flow — mounted on the web admin server.
// Flow: GET /auth/google → Google consent → GET /auth/google/callback → tokens stored.
import { Router } from "express";
import { buildAuthUrl, disconnectGoogle, isGoogleConfigured, isGoogleConnected, storeGoogleTokens } from "./auth";
import { getSecret } from "../plugins/secrets";
import { log } from "../logger";

export function createOAuthRouter(port: number): Router {
  const router = Router();

  // ── Status ─────────────────────────────────────────────────────────────────
  // Used by the admin UI dashboard and the agent's check_google_connection tool.
  router.get("/auth/google/status", (_req, res) => {
    res.json({
      configured: isGoogleConfigured(),
      connected:  isGoogleConnected(),
    });
  });

  // ── Auth URL (for manual / VPS flow) ──────────────────────────────────────
  // Returns the OAuth URL as JSON so the frontend can display it for copying.
  router.get("/auth/google/url", (_req, res) => {
    if (!isGoogleConfigured()) {
      res.status(400).json({ error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET not set." });
      return;
    }
    res.json({ url: buildAuthUrl(port) });
  });

  // ── Start OAuth flow ───────────────────────────────────────────────────────
  // User opens this URL in their browser → redirected to Google consent screen.
  router.get("/auth/google", (_req, res) => {
    if (!isGoogleConfigured()) {
      res.status(400).send(
        "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in secrets — store them via the agent first."
      );
      return;
    }
    res.redirect(buildAuthUrl(port));
  });

  // ── Manual callback (VPS / remote flow) ───────────────────────────────────
  // Accepts the full redirect URL that the user pastes from their browser address bar.
  // Extracts the auth code and completes the token exchange server-side.
  router.post("/auth/google/manual", async (req, res) => {
    const { callbackUrl } = req.body as { callbackUrl?: string };
    if (!callbackUrl?.trim()) {
      res.status(400).json({ error: "callbackUrl is required" });
      return;
    }

    let code: string | null = null;
    try {
      const url = new URL(callbackUrl.trim());
      code = url.searchParams.get("code");
    } catch {
      // Not a full URL — maybe they pasted just the code itself
      if (/^[A-Za-z0-9/_\-]+$/.test(callbackUrl.trim())) {
        code = callbackUrl.trim();
      }
    }

    if (!code) {
      res.status(400).json({ error: "Could not extract authorization code from the URL. Make sure you copied the full redirect URL from the browser address bar." });
      return;
    }

    const clientId     = getSecret("GOOGLE_CLIENT_ID")!;
    const clientSecret = getSecret("GOOGLE_CLIENT_SECRET")!;
    const redirectUri  = `http://localhost:${port}/auth/google/callback`;

    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id:     clientId,
          client_secret: clientSecret,
          redirect_uri:  redirectUri,
          grant_type:    "authorization_code",
        }),
      });

      const data = (await tokenRes.json()) as {
        access_token?:  string;
        refresh_token?: string;
        expires_in?:    number;
        error?:         string;
        error_description?: string;
      };

      if (!tokenRes.ok || !data.access_token || !data.refresh_token) {
        const msg = data.error_description ?? data.error ?? "missing tokens in response";
        log.error(`Google manual OAuth error: ${msg}`);
        res.status(400).json({ error: `OAuth failed: ${msg}` });
        return;
      }

      storeGoogleTokens(data.access_token, data.refresh_token, data.expires_in ?? 3600);
      log.success("Google account connected via manual OAuth flow.");
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Google manual OAuth exception: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  // ── OAuth callback ─────────────────────────────────────────────────────────
  // Google redirects here after the user grants consent. Exchanges the code for tokens.
  router.get("/auth/google/callback", async (req, res) => {
    const code = req.query.code as string | undefined;

    if (!code) {
      res.status(400).send("Missing authorization code in callback.");
      return;
    }

    const clientId     = getSecret("GOOGLE_CLIENT_ID")!;
    const clientSecret = getSecret("GOOGLE_CLIENT_SECRET")!;
    const redirectUri  = `http://localhost:${port}/auth/google/callback`;

    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id:     clientId,
          client_secret: clientSecret,
          redirect_uri:  redirectUri,
          grant_type:    "authorization_code",
        }),
      });

      const data = (await tokenRes.json()) as {
        access_token?:  string;
        refresh_token?: string;
        expires_in?:    number;
        error?:         string;
        error_description?: string;
      };

      if (!tokenRes.ok || !data.access_token || !data.refresh_token) {
        const msg = data.error_description ?? data.error ?? "missing tokens in response";
        log.error(`Google OAuth callback error: ${msg}`);
        res.status(400).send(`OAuth failed: ${msg}`);
        return;
      }

      storeGoogleTokens(data.access_token, data.refresh_token, data.expires_in ?? 3600);
      log.success("Google account connected via OAuth.");

      // Return a minimal success page that closes itself after 2 seconds
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Connected</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #070708; color: #edeae0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex; align-items: center; justify-content: center;
      height: 100vh; text-align: center;
    }
    h1 { font-size: 28px; color: #3ddc97; margin-bottom: 10px; letter-spacing: -0.5px; }
    p  { font-size: 13px; color: #5a5754; }
  </style>
</head>
<body>
  <div>
    <h1>Google Connected</h1>
    <p>You can close this tab and return to Telegram.</p>
  </div>
  <script>setTimeout(() => window.close(), 2500);</script>
</body>
</html>`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Google OAuth callback exception: ${msg}`);
      res.status(500).send(`Internal error: ${msg}`);
    }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  // Called by the admin UI disconnect button.
  router.delete("/auth/google", (_req, res) => {
    disconnectGoogle();
    res.json({ ok: true });
  });

  return router;
}
