import * as nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { existsSync, statSync } from "fs";
import { relative, resolve } from "path";

interface PluginContext {
  getSecret: (key: string) => string | null;
}

type AttachmentInput = {
  filename?: string;
  path?: string;
  content_base64?: string;
  content_type?: string;
};

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && rel !== "..");
}

function resolveAttachmentPath(inputPath: string): string | null {
  const resolved = resolve(process.cwd(), inputPath);
  const allowedRoots = [
    process.cwd(),
    resolve(process.cwd(), "output"),
    resolve("/tmp"),
  ];

  return allowedRoots.some((root) => isPathInside(root, resolved)) ? resolved : null;
}

function normalizeAttachments(raw: unknown): { attachments?: nodemailer.SendMailOptions["attachments"]; error?: string } {
  if (raw == null) return {};
  if (!Array.isArray(raw)) return { error: "attachments must be an array." };

  const attachments: NonNullable<nodemailer.SendMailOptions["attachments"]> = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      return { error: `Attachment ${i + 1} must be an object.` };
    }

    const input = item as AttachmentInput;
    if (!input.path && !input.content_base64) {
      return { error: `Attachment ${i + 1} must include either path or content_base64.` };
    }

    if (input.path && input.content_base64) {
      return { error: `Attachment ${i + 1} cannot include both path and content_base64.` };
    }

    if (input.path) {
      const resolvedPath = resolveAttachmentPath(input.path);
      if (!resolvedPath) {
        return { error: `Attachment ${i + 1} path is outside allowed directories.` };
      }
      if (!existsSync(resolvedPath)) {
        return { error: `Attachment ${i + 1} file not found: ${input.path}` };
      }
      const stats = statSync(resolvedPath);
      if (!stats.isFile()) {
        return { error: `Attachment ${i + 1} path is not a file: ${input.path}` };
      }
      if (stats.size > MAX_ATTACHMENT_BYTES) {
        return { error: `Attachment ${i + 1} exceeds 20 MB.` };
      }

      attachments.push({
        path: resolvedPath,
        ...(input.filename ? { filename: input.filename } : {}),
        ...(input.content_type ? { contentType: input.content_type } : {}),
      });
      continue;
    }

    let content: Buffer;
    try {
      content = Buffer.from(input.content_base64 as string, "base64");
    } catch {
      return { error: `Attachment ${i + 1} has invalid base64 content.` };
    }

    if (content.length === 0) {
      return { error: `Attachment ${i + 1} content is empty.` };
    }
    if (content.length > MAX_ATTACHMENT_BYTES) {
      return { error: `Attachment ${i + 1} exceeds 20 MB.` };
    }

    attachments.push({
      filename: input.filename || `attachment-${i + 1}`,
      content,
      ...(input.content_type ? { contentType: input.content_type } : {}),
    });
  }

  return { attachments };
}

function getConfig(ctx: PluginContext) {
  return {
    address:     ctx.getSecret("EMAIL_ADDRESS") ?? "",
    password:    ctx.getSecret("EMAIL_PASSWORD") ?? "",
    imapHost:    ctx.getSecret("EMAIL_IMAP_HOST") ?? "",
    imapPort:    parseInt(ctx.getSecret("EMAIL_IMAP_PORT") ?? "993", 10),
    smtpHost:    ctx.getSecret("EMAIL_SMTP_HOST") ?? "",
    smtpPort:    parseInt(ctx.getSecret("EMAIL_SMTP_PORT") ?? "587", 10),
    smtpSecure:  ctx.getSecret("EMAIL_SMTP_SECURE") === "true",
  };
}

function isConfigured(ctx: PluginContext): boolean {
  const c = getConfig(ctx);
  return !!(c.address && c.password && c.imapHost && c.smtpHost);
}

async function withImap<T>(cfg: ReturnType<typeof getConfig>, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: cfg.imapPort === 993,
    auth: { user: cfg.address, pass: cfg.password },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout();
  }
}

export default function setup(ctx: PluginContext) {
  return {
    tools: [
      {
        name: "send_email",
        description: "Send an email from the agent's email address.",
        input_schema: {
          type: "object" as const,
          properties: {
            to:       { type: "string",  description: "Recipient email address(es), comma-separated" },
            subject:  { type: "string",  description: "Email subject" },
            body:     { type: "string",  description: "Email body (plain text)" },
            cc:       { type: "string",  description: "CC email address(es), comma-separated (optional)" },
            reply_to: { type: "string",  description: "Reply-To address (optional)" },
            attachments: {
              type: "array",
              description: "Optional attachments. Each item must provide either a file path or base64 content.",
              items: {
                type: "object",
                properties: {
                  filename: { type: "string", description: "Attachment filename override (optional)" },
                  path: { type: "string", description: "Path to a local file inside the workspace, output/, or /tmp" },
                  content_base64: { type: "string", description: "Base64-encoded attachment content" },
                  content_type: { type: "string", description: "MIME type such as application/pdf (optional)" },
                },
                required: [],
              },
            },
          },
          required: ["to", "subject", "body"],
        },
      },
      {
        name: "list_emails",
        description: "List recent emails from the inbox (or another folder).",
        input_schema: {
          type: "object" as const,
          properties: {
            folder: { type: "string", description: "Folder name (default: INBOX)" },
            limit:  { type: "number", description: "Max emails to return (default: 10, max: 50)" },
            unread_only: { type: "boolean", description: "Only return unread emails (default: false)" },
          },
          required: [],
        },
      },
      {
        name: "read_email",
        description: "Read the full content of a specific email by its UID.",
        input_schema: {
          type: "object" as const,
          properties: {
            uid:    { type: "number", description: "Email UID from list_emails" },
            folder: { type: "string", description: "Folder containing the email (default: INBOX)" },
          },
          required: ["uid"],
        },
      },
      {
        name: "search_emails",
        description: "Search emails by keyword, sender, or subject.",
        input_schema: {
          type: "object" as const,
          properties: {
            query:  { type: "string", description: "Search query — searches subject and body" },
            from:   { type: "string", description: "Filter by sender email (optional)" },
            folder: { type: "string", description: "Folder to search (default: INBOX)" },
            limit:  { type: "number", description: "Max results (default: 10)" },
          },
          required: ["query"],
        },
      },
      {
        name: "reply_to_email",
        description: "Reply to an email by its UID.",
        input_schema: {
          type: "object" as const,
          properties: {
            uid:    { type: "number", description: "UID of the email to reply to" },
            folder: { type: "string", description: "Folder containing the email (default: INBOX)" },
            body:   { type: "string", description: "Reply body (plain text)" },
          },
          required: ["uid", "body"],
        },
      },
    ],

    handlers: {
      send_email: async (input: Record<string, unknown>) => {
        if (!isConfigured(ctx)) return "Email not configured. Set it up via the dashboard or /email_setup.";
        const cfg = getConfig(ctx);
        const { attachments, error } = normalizeAttachments(input.attachments);
        if (error) return `Error: ${error}`;

        const transport = nodemailer.createTransport({
          host: cfg.smtpHost,
          port: cfg.smtpPort,
          secure: cfg.smtpSecure,
          auth: { user: cfg.address, pass: cfg.password },
        });
        await transport.sendMail({
          from:    cfg.address,
          to:      input.to as string,
          subject: input.subject as string,
          text:    input.body as string,
          ...(input.cc      ? { cc: input.cc as string } : {}),
          ...(input.reply_to ? { replyTo: input.reply_to as string } : {}),
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        });
        return `Email sent to ${input.to}${attachments && attachments.length > 0 ? ` with ${attachments.length} attachment(s)` : ""}.`;
      },

      list_emails: async (input: Record<string, unknown>) => {
        if (!isConfigured(ctx)) return "Email not configured.";
        const cfg = getConfig(ctx);
        const folder = (input.folder as string) || "INBOX";
        const limit  = Math.min((input.limit as number) || 10, 50);
        const unreadOnly = input.unread_only === true;

        const emails = await withImap(cfg, async (client) => {
          await client.mailboxOpen(folder);
          const criteria = unreadOnly ? { seen: false } : { all: true };
          const results: string[] = [];
          const messages = [];

          for await (const msg of client.fetch(criteria, {
            uid: true, envelope: true, flags: true,
          })) {
            messages.push(msg);
          }

          // Most recent first
          messages.reverse();
          for (const msg of messages.slice(0, limit)) {
            const from    = msg.envelope?.from?.[0];
            const fromStr = from ? `${from.name || ""} <${from.address}>`.trim() : "unknown";
            const date    = msg.envelope?.date?.toISOString().split("T")[0] ?? "";
            const unread  = !msg.flags?.has("\\Seen") ? " [UNREAD]" : "";
            results.push(`UID ${msg.uid}${unread} | ${date} | From: ${fromStr} | ${msg.envelope?.subject ?? "(no subject)"}`);
          }
          return results;
        });

        return emails.length ? emails.join("\n") : "No emails found.";
      },

      read_email: async (input: Record<string, unknown>) => {
        if (!isConfigured(ctx)) return "Email not configured.";
        const cfg    = getConfig(ctx);
        const uid    = input.uid as number;
        const folder = (input.folder as string) || "INBOX";

        return await withImap(cfg, async (client) => {
          await client.mailboxOpen(folder);
          const msg = await client.fetchOne(`${uid}`, {
            uid: true, envelope: true, bodyStructure: true, source: true,
          }, { uid: true });

          if (!msg) return `No email found with UID ${uid}.`;

          const from    = msg.envelope?.from?.[0];
          const fromStr = from ? `${from.name || ""} <${from.address}>`.trim() : "unknown";
          const date    = msg.envelope?.date?.toISOString() ?? "";
          const subject = msg.envelope?.subject ?? "(no subject)";

          // Extract plain text from raw source
          let body = msg.source?.toString("utf-8") ?? "";
          // Strip headers (everything before first blank line)
          const headerEnd = body.indexOf("\r\n\r\n");
          if (headerEnd !== -1) body = body.slice(headerEnd + 4);
          // Truncate long emails
          if (body.length > 4000) body = body.slice(0, 4000) + "\n\n[truncated]";

          // Mark as read
          await client.messageFlagsAdd(`${uid}`, ["\\Seen"], { uid: true });

          return `From: ${fromStr}\nDate: ${date}\nSubject: ${subject}\n\n${body}`;
        });
      },

      search_emails: async (input: Record<string, unknown>) => {
        if (!isConfigured(ctx)) return "Email not configured.";
        const cfg    = getConfig(ctx);
        const folder = (input.folder as string) || "INBOX";
        const limit  = Math.min((input.limit as number) || 10, 50);
        const query  = (input.query as string).toLowerCase();
        const from   = input.from as string | undefined;

        const results = await withImap(cfg, async (client) => {
          await client.mailboxOpen(folder);
          const criteria: Record<string, unknown> = {};
          if (from) criteria["from"] = from;
          else criteria["all"] = true;

          const lines: string[] = [];
          const messages = [];
          for await (const msg of client.fetch(criteria, { uid: true, envelope: true })) {
            messages.push(msg);
          }

          for (const msg of messages.reverse()) {
            const subject = msg.envelope?.subject ?? "";
            if (!subject.toLowerCase().includes(query)) continue;
            const f    = msg.envelope?.from?.[0];
            const fStr = f ? `${f.name || ""} <${f.address}>`.trim() : "unknown";
            const date = msg.envelope?.date?.toISOString().split("T")[0] ?? "";
            lines.push(`UID ${msg.uid} | ${date} | From: ${fStr} | ${subject}`);
            if (lines.length >= limit) break;
          }
          return lines;
        });

        return results.length ? results.join("\n") : "No matching emails found.";
      },

      reply_to_email: async (input: Record<string, unknown>) => {
        if (!isConfigured(ctx)) return "Email not configured.";
        const cfg    = getConfig(ctx);
        const uid    = input.uid as number;
        const folder = (input.folder as string) || "INBOX";
        const body   = input.body as string;

        return await withImap(cfg, async (client) => {
          await client.mailboxOpen(folder);
          const msg = await client.fetchOne(`${uid}`, { uid: true, envelope: true }, { uid: true });
          if (!msg) return `No email found with UID ${uid}.`;

          const replyTo = msg.envelope?.replyTo?.[0] ?? msg.envelope?.from?.[0];
          const toAddr  = replyTo?.address ?? "";
          const subject = msg.envelope?.subject ?? "";
          const reSubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
          const msgId   = msg.envelope?.messageId;

          const transport = nodemailer.createTransport({
            host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpSecure,
            auth: { user: cfg.address, pass: cfg.password },
          });

          await transport.sendMail({
            from:    cfg.address,
            to:      toAddr,
            subject: reSubject,
            text:    body,
            ...(msgId ? { inReplyTo: msgId, references: msgId } : {}),
          });

          return `Reply sent to ${toAddr}.`;
        });
      },
    },
  };
}
