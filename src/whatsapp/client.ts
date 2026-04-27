// WhatsApp client via Baileys — manages the WA Web socket connection.
// Auth session is persisted to config/whatsapp-auth/ so you only scan once.
import { join } from "path";
import { log } from "../logger";

// Baileys is ESM-only; use dynamic import from CommonJS.
type BaileysModule = typeof import("@whiskeysockets/baileys");
type WASocket = Awaited<ReturnType<BaileysModule["default"]>>;

let sock: WASocket | null = null;
let isStarting = false;

export function getWhatsAppSocket(): WASocket | null {
  return sock;
}

export async function startWhatsApp(): Promise<void> {
  if (isStarting) return;
  isStarting = true;

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = (await import("@whiskeysockets/baileys")) as BaileysModule;

  const authDir = join(process.cwd(), "config/whatsapp-auth");
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    // Suppress Baileys' own verbose logger
    logger: { level: "silent", child: () => ({ level: "silent" }) } as never,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      log.info("WhatsApp: scan the QR code above with your phone (WhatsApp → Linked Devices → Link a Device)");
    }
    if (connection === "close") {
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      if (loggedOut) {
        log.warn("WhatsApp: logged out — delete config/whatsapp-auth/ and restart to re-link.");
      } else {
        log.warn(`WhatsApp: connection closed (code ${code}) — reconnecting...`);
        isStarting = false;
        startWhatsApp().catch((err) =>
          log.error(`WhatsApp reconnect failed: ${err instanceof Error ? err.message : String(err)}`)
        );
      }
    }
    if (connection === "open") {
      log.success("WhatsApp connected.");
    }
  });

  // Import and wire message handler after socket is ready
  const { handleWhatsAppMessage } = await import("./handlers");

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      handleWhatsAppMessage(sock!, msg).catch((err) =>
        log.error(`WhatsApp handler error: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
  });

  isStarting = false;
}
