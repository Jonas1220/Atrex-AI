// Routes incoming WhatsApp messages to the AI agent.
import Anthropic from "@anthropic-ai/sdk";
import { chat } from "../agent/agent";
import { log } from "../logger";
import { config } from "../config";

type BaileysModule = typeof import("@whiskeysockets/baileys");
type WASocket = Awaited<ReturnType<BaileysModule["default"]>>;
type WAMessage = import("@whiskeysockets/baileys").proto.IWebMessageInfo;

// Parse the numeric user ID from a WhatsApp JID.
// JID format: "4917612345678@s.whatsapp.net" → 4917612345678
// Phone numbers are at most 15 digits (E.164) which fits in JS safe integer range.
function jidToUserId(jid: string): number {
  return parseInt(jid.split("@")[0].replace(/\D/g, ""), 10);
}

function isAllowed(userId: number): boolean {
  if (config.allowedUserIds.length === 0) return true;
  return config.allowedUserIds.includes(userId);
}

// Split long text into chunks (WhatsApp handles long messages fine, but
// the agent output can occasionally be extremely long).
async function sendLong(sock: WASocket, jid: string, text: string): Promise<void> {
  const MAX = 4000;
  if (text.length <= MAX) {
    await sock.sendMessage(jid, { text });
    return;
  }
  for (let i = 0; i < text.length; i += MAX) {
    await sock.sendMessage(jid, { text: text.slice(i, i + MAX) });
  }
}

export async function handleWhatsAppMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  if (!msg.key) return;
  const jid = msg.key.remoteJid;
  if (!jid) return;

  // Skip group messages — direct chats only
  if (jid.endsWith("@g.us")) return;

  const userId = jidToUserId(jid);
  if (!isAllowed(userId)) return;

  const m = msg.message;
  if (!m) return;

  // Extract text and optional image from the message
  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    "";

  const isImage = !!m.imageMessage;

  if (!text.trim() && !isImage) return;

  const msgKey = msg.key;

  // Use 👀 reaction as a lightweight "working" indicator instead of a status message
  let hasReacted = false;
  const updateStatus = async (_statusText: string) => {
    if (hasReacted) return;
    hasReacted = true;
    await sock
      .sendMessage(jid, { react: { text: "👀", key: msgKey } })
      .catch(() => {});
  };

  try {
    let response: string;

    if (isImage) {
      const { downloadMediaMessage } = (await import("@whiskeysockets/baileys")) as BaileysModule;
      log.chat("in", userId, `[image] ${text || "(no caption)"}`);

      const buffer = (await downloadMediaMessage(msg as never, "buffer", {})) as Buffer;
      const data = buffer.toString("base64");
      const mimeType = m.imageMessage?.mimetype ?? "image/jpeg";
      const media_type = (
        ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType)
          ? mimeType
          : "image/jpeg"
      ) as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

      const imageBlock: Anthropic.ImageBlockParam = {
        type: "image",
        source: { type: "base64", media_type, data },
      };

      response = await chat(userId, text || "[Image]", updateStatus, [imageBlock]);
    } else {
      log.chat("in", userId, text);
      response = await chat(userId, text, updateStatus);
    }

    // Clear the 👀 reaction when done
    if (hasReacted) {
      await sock
        .sendMessage(jid, { react: { text: "", key: msgKey } })
        .catch(() => {});
    }

    if (response) {
      log.chat("out", userId, response);
      await sendLong(sock, jid, response);
    }
  } catch (err) {
    if (hasReacted) {
      await sock
        .sendMessage(jid, { react: { text: "", key: msgKey } })
        .catch(() => {});
    }
    log.error(`WhatsApp message error: ${err instanceof Error ? err.message : String(err)}`);
    await sock.sendMessage(jid, { text: "Something went wrong. Try again." }).catch(() => {});
  }
}
