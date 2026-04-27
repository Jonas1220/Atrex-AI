// Google integration plugin — Gmail, Calendar, and Drive.
// Connection is handled via OAuth (connect_google → browser consent → tokens stored automatically).
// All API calls use ctx.getGoogleToken() which auto-refreshes the access token when needed.

interface PluginContext {
  getSecret: (key: string) => string | null;
  getGoogleToken: () => Promise<string | null>;
  getGoogleAuthUrl: () => string | null;
  isGoogleConnected: () => boolean;
  disconnectGoogle: () => void;
}

const GMAIL_BASE    = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

async function gFetch(
  token: string,
  url: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export default function setup(ctx: PluginContext) {
  // Helper: get a valid token or return an error string
  async function token(): Promise<string | { error: string }> {
    const t = await ctx.getGoogleToken();
    if (!t) return { error: "Google account not connected. Ask me to connect it first." };
    return t;
  }

  return {
    tools: [
      // ── Account management ────────────────────────────────────────────────
      {
        name: "connect_google",
        description:
          "Generate a Google OAuth link for the user to authorize Gmail, Calendar, and Drive access. " +
          "Only call when the user asks to connect their Google account.",
        input_schema: { type: "object" as const, properties: {}, required: [] },
      },
      {
        name: "check_google_connection",
        description:
          "Check whether the Google account is connected. Call before using Gmail or Calendar tools " +
          "to give a helpful error if not connected.",
        input_schema: { type: "object" as const, properties: {}, required: [] },
      },
      {
        name: "disconnect_google",
        description:
          "Disconnect the Google account by removing stored tokens. Only call when explicitly asked.",
        input_schema: { type: "object" as const, properties: {}, required: [] },
      },

      // ── Gmail ─────────────────────────────────────────────────────────────
      {
        name: "gmail_list_emails",
        description: "List recent emails from Gmail. Returns sender, subject, date, and snippet.",
        input_schema: {
          type: "object" as const,
          properties: {
            maxResults: { type: "number", description: "Max emails to return (default 10, max 50)" },
            query:      { type: "string", description: "Gmail search query, e.g. 'is:unread from:boss@company.com'" },
          },
          required: [],
        },
      },
      {
        name: "gmail_read_email",
        description: "Read the full content of an email by its ID.",
        input_schema: {
          type: "object" as const,
          properties: {
            id: { type: "string", description: "Email message ID from gmail_list_emails" },
          },
          required: ["id"],
        },
      },
      {
        name: "gmail_send_email",
        description: "Send an email via Gmail.",
        input_schema: {
          type: "object" as const,
          properties: {
            to:      { type: "string",  description: "Recipient email address" },
            subject: { type: "string",  description: "Email subject" },
            body:    { type: "string",  description: "Email body (plain text)" },
            cc:      { type: "string",  description: "CC email address (optional)" },
          },
          required: ["to", "subject", "body"],
        },
      },

      // ── Calendar ──────────────────────────────────────────────────────────
      {
        name: "calendar_list_events",
        description: "List upcoming calendar events.",
        input_schema: {
          type: "object" as const,
          properties: {
            maxResults: { type: "number", description: "Max events to return (default 10)" },
            timeMin:    { type: "string", description: "Start of time range in ISO 8601 format (default: now)" },
            timeMax:    { type: "string", description: "End of time range in ISO 8601 format (optional)" },
            calendarId: { type: "string", description: "Calendar ID (default: primary)" },
          },
          required: [],
        },
      },
      {
        name: "calendar_create_event",
        description: "Create a new event on Google Calendar.",
        input_schema: {
          type: "object" as const,
          properties: {
            title:       { type: "string", description: "Event title" },
            startTime:   { type: "string", description: "Start time in ISO 8601 format, e.g. '2026-04-20T10:00:00'" },
            endTime:     { type: "string", description: "End time in ISO 8601 format" },
            description: { type: "string", description: "Event description (optional)" },
            location:    { type: "string", description: "Event location (optional)" },
            calendarId:  { type: "string", description: "Calendar ID (default: primary)" },
          },
          required: ["title", "startTime", "endTime"],
        },
      },
      {
        name: "calendar_delete_event",
        description: "Delete a calendar event by its ID.",
        input_schema: {
          type: "object" as const,
          properties: {
            eventId:    { type: "string", description: "Event ID from calendar_list_events" },
            calendarId: { type: "string", description: "Calendar ID (default: primary)" },
          },
          required: ["eventId"],
        },
      },
    ],

    handlers: {
      // ── Account management ────────────────────────────────────────────────
      connect_google: async () => {
        if (ctx.isGoogleConnected()) {
          return "Google is already connected. To reconnect with a different account, disconnect first.";
        }
        const url = ctx.getGoogleAuthUrl();
        if (!url) {
          return "Google OAuth is not configured. GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env.";
        }
        return (
          `Open this link in your browser to connect your Google account:\n\n${url}\n\n` +
          "After granting permission, close the tab and come back here. " +
          "Gmail and Calendar will be ready to use."
        );
      },

      check_google_connection: async () => {
        if (ctx.isGoogleConnected()) {
          return "Google account is connected. Gmail and Calendar are ready.";
        }
        const url = ctx.getGoogleAuthUrl();
        if (!url) {
          return "Not configured — GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing from .env.";
        }
        return "Google account is not connected. Ask me to connect it and I'll send you the link.";
      },

      disconnect_google: async () => {
        if (!ctx.isGoogleConnected()) return "No Google account is connected.";
        ctx.disconnectGoogle();
        return "Google account disconnected. Tokens have been removed.";
      },

      // ── Gmail ─────────────────────────────────────────────────────────────
      gmail_list_emails: async (input) => {
        const t = await token();
        if (typeof t !== "string") return t.error;

        const max = Math.min((input.maxResults as number) || 10, 50);
        const q   = (input.query as string) || "";
        const params = new URLSearchParams({ maxResults: String(max) });
        if (q) params.set("q", q);

        const listRes = await gFetch(t, `${GMAIL_BASE}/messages?${params}`);
        if (!listRes.ok) return `Gmail error: ${JSON.stringify(listRes.data)}`;

        const list = listRes.data as { messages?: { id: string }[] };
        if (!list.messages?.length) return "No emails found.";

        // Fetch metadata for each message in parallel
        const details = await Promise.all(
          list.messages.map((m) =>
            gFetch(t, `${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
          )
        );

        const emails = details.map((d) => {
          const msg = d.data as {
            id: string;
            snippet: string;
            payload: { headers: { name: string; value: string }[] };
          };
          const h = (name: string) =>
            msg.payload?.headers?.find((h) => h.name === name)?.value ?? "";
          return `ID: ${msg.id}\nFrom: ${h("From")}\nSubject: ${h("Subject")}\nDate: ${h("Date")}\nSnippet: ${msg.snippet}`;
        });

        return emails.join("\n\n---\n\n");
      },

      gmail_read_email: async (input) => {
        const t = await token();
        if (typeof t !== "string") return t.error;

        const res = await gFetch(t, `${GMAIL_BASE}/messages/${input.id}?format=full`);
        if (!res.ok) return `Gmail error: ${JSON.stringify(res.data)}`;

        const msg = res.data as {
          id: string;
          snippet: string;
          payload: {
            headers: { name: string; value: string }[];
            body?: { data?: string };
            parts?: { mimeType: string; body: { data?: string } }[];
          };
        };

        const h = (name: string) =>
          msg.payload?.headers?.find((hdr) => hdr.name === name)?.value ?? "";

        // Try to get plain text body
        let body = "";
        const parts = msg.payload?.parts ?? [];
        const textPart = parts.find((p) => p.mimeType === "text/plain");
        const rawData = textPart?.body?.data ?? msg.payload?.body?.data;
        if (rawData) {
          body = Buffer.from(rawData.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
        } else {
          body = msg.snippet;
        }

        return [
          `From: ${h("From")}`,
          `To: ${h("To")}`,
          `Subject: ${h("Subject")}`,
          `Date: ${h("Date")}`,
          `\n${body.trim()}`,
        ].join("\n");
      },

      gmail_send_email: async (input) => {
        const t = await token();
        if (typeof t !== "string") return t.error;

        const to      = input.to as string;
        const subject = input.subject as string;
        const body    = input.body as string;
        const cc      = (input.cc as string) || "";

        const lines = [
          `To: ${to}`,
          cc ? `Cc: ${cc}` : null,
          `Subject: ${subject}`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          body,
        ]
          .filter((l) => l !== null)
          .join("\n");

        const encoded = Buffer.from(lines)
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        const res = await gFetch(t, `${GMAIL_BASE}/messages/send`, {
          method: "POST",
          body:   JSON.stringify({ raw: encoded }),
        });

        if (!res.ok) return `Failed to send: ${JSON.stringify(res.data)}`;
        return `Email sent to ${to}.`;
      },

      // ── Calendar ──────────────────────────────────────────────────────────
      calendar_list_events: async (input) => {
        const t = await token();
        if (typeof t !== "string") return t.error;

        const calId  = (input.calendarId as string) || "primary";
        const max    = (input.maxResults as number) || 10;
        const params = new URLSearchParams({
          maxResults:  String(max),
          orderBy:     "startTime",
          singleEvents: "true",
          timeMin:     (input.timeMin as string) || new Date().toISOString(),
        });
        if (input.timeMax) params.set("timeMax", input.timeMax as string);

        const res = await gFetch(t, `${CALENDAR_BASE}/calendars/${encodeURIComponent(calId)}/events?${params}`);
        if (!res.ok) return `Calendar error: ${JSON.stringify(res.data)}`;

        const data = res.data as { items?: { id: string; summary: string; start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string }; location?: string; description?: string }[] };
        if (!data.items?.length) return "No upcoming events found.";

        return data.items
          .map((e) => {
            const start = e.start.dateTime ?? e.start.date ?? "";
            const end   = e.end.dateTime   ?? e.end.date   ?? "";
            const lines = [`Title: ${e.summary}`, `ID: ${e.id}`, `Start: ${start}`, `End: ${end}`];
            if (e.location)    lines.push(`Location: ${e.location}`);
            if (e.description) lines.push(`Description: ${e.description}`);
            return lines.join("\n");
          })
          .join("\n\n---\n\n");
      },

      calendar_create_event: async (input) => {
        const t = await token();
        if (typeof t !== "string") return t.error;

        const calId = (input.calendarId as string) || "primary";
        const event: Record<string, unknown> = {
          summary:     input.title,
          start:       { dateTime: input.startTime, timeZone: "UTC" },
          end:         { dateTime: input.endTime,   timeZone: "UTC" },
        };
        if (input.description) event.description = input.description;
        if (input.location)    event.location    = input.location;

        const res = await gFetch(
          t,
          `${CALENDAR_BASE}/calendars/${encodeURIComponent(calId)}/events`,
          { method: "POST", body: JSON.stringify(event) }
        );

        if (!res.ok) return `Failed to create event: ${JSON.stringify(res.data)}`;
        const created = res.data as { id: string; htmlLink: string };
        return `Event created. ID: ${created.id}`;
      },

      calendar_delete_event: async (input) => {
        const t = await token();
        if (typeof t !== "string") return t.error;

        const calId   = (input.calendarId as string) || "primary";
        const eventId = input.eventId as string;
        const res = await gFetch(
          t,
          `${CALENDAR_BASE}/calendars/${encodeURIComponent(calId)}/events/${eventId}`,
          { method: "DELETE" }
        );

        if (!res.ok && res.status !== 204) return `Failed to delete event: ${JSON.stringify(res.data)}`;
        return "Event deleted.";
      },
    },
  };
}
