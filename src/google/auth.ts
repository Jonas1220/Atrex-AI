// Google OAuth2 token management — stores tokens in secrets.json, auto-refreshes when expired.
import { getSecret, setSecret, deleteSecret } from "../plugins/secrets";
import { log } from "../logger";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Keys used in secrets.json
const KEY_ACCESS  = "GOOGLE_ACCESS_TOKEN";
const KEY_REFRESH = "GOOGLE_REFRESH_TOKEN";
const KEY_EXPIRY  = "GOOGLE_TOKEN_EXPIRY"; // stored as Unix ms timestamp string

// Scopes granted during OAuth — covers Gmail + Calendar
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

/** Returns true if GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set in secrets.json. */
export function isGoogleConfigured(): boolean {
  return !!(getSecret("GOOGLE_CLIENT_ID") && getSecret("GOOGLE_CLIENT_SECRET"));
}

/** Returns true if a refresh token is stored (i.e. the user has connected their Google account). */
export function isGoogleConnected(): boolean {
  return !!getSecret(KEY_REFRESH);
}

/** Builds the Google OAuth2 consent URL that the user must open in their browser. */
export function buildAuthUrl(port: number): string {
  const params = new URLSearchParams({
    client_id:     getSecret("GOOGLE_CLIENT_ID")!,
    redirect_uri:  `http://localhost:${port}/auth/google/callback`,
    response_type: "code",
    scope:         GOOGLE_SCOPES,
    access_type:   "offline",
    prompt:        "consent", // always re-issue a refresh token
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Saves access + refresh tokens after a successful OAuth exchange or refresh. */
export function storeGoogleTokens(
  accessToken: string,
  refreshToken: string,
  expiresInSeconds: number
): void {
  // Subtract 60 seconds as a buffer so we refresh before the token actually expires
  const expiry = Date.now() + expiresInSeconds * 1000 - 60_000;
  setSecret(KEY_ACCESS,  accessToken);
  setSecret(KEY_REFRESH, refreshToken);
  setSecret(KEY_EXPIRY,  String(expiry));
  log.success("Google tokens stored.");
}

/** Removes all stored Google tokens — disconnects the account. */
export function disconnectGoogle(): void {
  deleteSecret(KEY_ACCESS);
  deleteSecret(KEY_REFRESH);
  deleteSecret(KEY_EXPIRY);
  log.info("Google account disconnected.");
}

/** Exchanges a refresh token for a new access token and updates secrets.json. */
async function refreshAccessToken(): Promise<string | null> {
  const clientId     = getSecret("GOOGLE_CLIENT_ID");
  const clientSecret = getSecret("GOOGLE_CLIENT_SECRET");
  const refreshToken = getSecret(KEY_REFRESH);

  if (!clientId || !clientSecret || !refreshToken) return null;

  try {
    const res = await fetch(TOKEN_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?:   number;
      error?:        string;
    };

    if (!res.ok || !data.access_token) {
      log.error(`Google token refresh failed: ${data.error ?? "unknown"}`);
      return null;
    }

    const expiry = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
    setSecret(KEY_ACCESS, data.access_token);
    setSecret(KEY_EXPIRY, String(expiry));
    log.info("Google access token refreshed.");
    return data.access_token;
  } catch (err) {
    log.error(`Google token refresh error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Returns a valid Google access token, automatically refreshing it if expired.
 * Returns null if not connected or if the refresh fails.
 * Plugins call this via ctx.getGoogleToken().
 */
export async function getValidAccessToken(): Promise<string | null> {
  if (!isGoogleConnected()) return null;

  const expiry    = parseInt(getSecret(KEY_EXPIRY) ?? "0", 10);
  const isExpired = Date.now() >= expiry;

  if (!isExpired) {
    return getSecret(KEY_ACCESS);
  }

  return refreshAccessToken();
}
