// Telegram command and message handlers — routes user input to the AI agent.
import { Bot, Context, InputFile } from "grammy";
import Anthropic from "@anthropic-ai/sdk";
import { chat, chatOnce } from "../agent/agent";
import { clearHistory } from "../agent/context";
import { setEscalated, clearEscalation, ESCALATE_YES, ESCALATE_NO } from "../agent/escalation";
import {
  getActiveSkill,
  getActiveSkillId,
  setActiveSkillId,
  listSkills,
  findSkillByName,
  ensureMainSkill,
} from "../agent/skills";
import { config, settings } from "../config";
import { log, toggleDebug, purgeLogs, getRecentLogs } from "../logger";
import { getRegistry } from "../plugins/registry";
import { getSecret, listSecretKeys } from "../plugins/secrets";
import { FormData, File } from "formdata-node";
import {
  setThinkingLevel,
  getThinkingLevel,
  clearThinking,
  parseLevel,
} from "../agent/thinking";
import { getTrajectory } from "../agent/trajectory";
import { getHistory } from "../agent/context";
import { emit as emitHook } from "../agent/hooks";
import { isOpenAIConnected } from "../openai/auth";
import { setRuntimeProvider, getActiveProvider } from "../agent/anthropic";
import { getWhatsAppSocket } from "../whatsapp/client";

ensureMainSkill();

function isAllowed(userId: number): boolean {
  if (config.allowedUserIds.length === 0) return true;
  return config.allowedUserIds.includes(userId);
}

// Manages a single "status" message that is edited in-place as the agent works.
// Returns helpers to update and delete it. Silently no-ops if the send fails.
// Status message is created lazily — only appears when the first tool fires.
// Pure-text responses produce no status message at all.
async function createStatusMessage(ctx: Context, chatId: number) {
  let msgId: number | undefined;

  return {
    update: async (text: string) => {
      if (!msgId) {
        try {
          const sent = await ctx.api.sendMessage(chatId, text);
          msgId = sent.message_id;
        } catch {}
      } else {
        try { await ctx.api.editMessageText(chatId, msgId, text); } catch {}
      }
    },
    remove: async () => {
      if (!msgId) return;
      try { await ctx.api.deleteMessage(chatId, msgId); } catch {}
      msgId = undefined;
    },
  };
}

// Telegram caps messages at 4096 chars — split longer responses into chunks
async function sendLong(ctx: Context, text: string): Promise<void> {
  const MAX = 4096;
  if (text.length <= MAX) {
    await ctx.reply(text);
    return;
  }
  for (let i = 0; i < text.length; i += MAX) {
    await ctx.reply(text.slice(i, i + MAX));
  }
}

export function registerHandlers(bot: Bot): void {
  bot.command("start", (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    ctx.reply("Atrexai online.");
  });

  bot.command("clear", (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    clearHistory(ctx.from!.id);
    clearEscalation(ctx.from!.id);
    clearThinking(ctx.from!.id);
    ctx.reply("Conversation cleared.");
  });

  // /think low|medium|high|off — sets the per-user extended-thinking budget
  bot.command(["think", "t"], (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const arg = ctx.match?.trim();
    if (!arg) {
      const level = getThinkingLevel(ctx.from!.id);
      ctx.reply(
        `Thinking: ${level}\n` +
        `Usage: /think low|medium|high|off`
      );
      return;
    }
    const parsed = parseLevel(arg);
    if (!parsed) {
      ctx.reply("Unknown level. Use: low, medium, high, off.");
      return;
    }
    setThinkingLevel(ctx.from!.id, parsed);
    ctx.reply(parsed === "off" ? "Thinking disabled." : `Thinking set to ${parsed}.`);
  });

  // /export — sends the most recent chat trajectory as a JSON file
  bot.command("export", async (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const traj = getTrajectory(ctx.from!.id);
    if (!traj) {
      await ctx.reply("No trajectory recorded yet — send a message first.");
      return;
    }
    const json = JSON.stringify(traj, null, 2);
    const buf = Buffer.from(json, "utf-8");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      await ctx.replyWithDocument(new InputFile(buf, `trajectory-${stamp}.json`));
    } catch (err) {
      log.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.reply("Couldn't attach trajectory file.");
    }
  });


  bot.command("plugins", (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const registry = getRegistry();
    const plugins = Object.entries(registry);
    const secrets = listSecretKeys();

    if (plugins.length === 0) {
      ctx.reply("No plugins installed.");
      return;
    }

    const lines = plugins.map(([name, p]) => {
      const status = p.enabled ? "✓" : "✗";
      return `${status} ${name} — ${p.description}`;
    });

    let msg = lines.join("\n");
    if (secrets.length > 0) {
      msg += `\n\nSecrets: ${secrets.join(", ")}`;
    }
    ctx.reply(msg);
  });

  bot.command("purgelogs", (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const deleted = purgeLogs();
    ctx.reply(deleted > 0 ? `Deleted ${deleted} old log file(s).` : "No old logs to delete.");
  });

  // /logs [n] — show the last n lines from today's log file (default 30, max 100)
  bot.command("logs", async (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const arg = parseInt(ctx.match?.trim() || "30", 10);
    const n = Math.min(Math.max(1, isNaN(arg) ? 30 : arg), 100);
    const lines = getRecentLogs(n);
    await sendLong(ctx, `\`\`\`\n${lines}\n\`\`\``);
  });

  bot.command("status", async (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;

    const uptime = process.uptime();
    const uptimeStr = uptime < 60
      ? `${Math.floor(uptime)}s`
      : uptime < 3600
      ? `${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`
      : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);

    const provider = getActiveProvider();
    const model = provider === "openai" ? settings.openai_model : settings.model;

    const historyLen = getHistory(ctx.from!.id).length;
    const thinkingLevel = getThinkingLevel(ctx.from!.id);

    const registry = getRegistry();
    const enabledPlugins = Object.entries(registry)
      .filter(([, p]) => p.enabled)
      .map(([name]) => name);

    const messengers: string[] = ["Telegram"];
    if (config.whatsappEnabled) {
      const waSocket = getWhatsAppSocket();
      messengers.push(`WhatsApp (${waSocket ? "connected" : "disconnected"})`);
    }

    const lines = [
      `🟢 Online — uptime ${uptimeStr}`,
      ``,
      `Messenger: ${messengers.join(", ")}`,
      `Model: ${model} (${provider})`,
      thinkingLevel !== "off" ? `Thinking: ${thinkingLevel}` : null,
      ``,
      `Context: ${historyLen} messages`,
      `Memory: ${heapMB} MB`,
      ``,
      `Plugins (${enabledPlugins.length}): ${enabledPlugins.join(", ") || "none"}`,
    ].filter((l): l is string => l !== null);

    await ctx.reply(lines.join("\n"));
  });

  bot.command("debug", (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const enabled = toggleDebug(ctx.from!.id);
    ctx.reply(enabled ? "Debug mode ON — logs will appear here." : "Debug mode OFF.");
  });

  // /skills — list all available skills
  bot.command("skills", (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const all = listSkills();
    const activeId = getActiveSkillId();
    const lines = all.map((s) => `${s.id === activeId ? "▶" : " "} ${s.name} — ${s.description}`);
    ctx.reply(lines.join("\n") || "No skills found.");
  });

  // /skill — show active skill, or /skill <name> to manually override
  bot.command("skill", (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const name = ctx.match?.trim();
    if (!name) {
      const active = getActiveSkill();
      ctx.reply(`Active skill: ${active.name}\n${active.description}`);
      return;
    }
    const found = findSkillByName(name);
    if (!found) {
      ctx.reply(`No skill found matching "${name}". Use /skills to see all.`);
      return;
    }
    setActiveSkillId(found.id);
    clearHistory(ctx.from!.id);
    ctx.reply(`Skill set to: ${found.name}\n${found.description}`);
  });

  // /btw <question> — one-shot isolated query, no context read or write
  bot.command("btw", async (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply("Usage: /btw <your question>");
      return;
    }

    const status = await createStatusMessage(ctx, ctx.chat.id);
    try {
      log.chat("in", ctx.from!.id, `[btw] ${query}`);
      const response = await chatOnce(ctx.from!.id, query, status.update, "btw");
      await status.remove();
      log.chat("out", ctx.from!.id, response);
      if (response) await sendLong(ctx, response);
    } catch (err) {
      await status.remove();
      log.error(`btw handler error: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.reply("Something went wrong. Try again.");
    }
  });

  // /provider [anthropic|openai] — show or switch the active LLM provider
  bot.command("provider", (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const arg = ctx.match?.trim().toLowerCase();

    if (!arg) {
      const active = getActiveProvider();
      const model  = active === "openai" ? settings.openai_model : settings.model;
      const oaiOk  = isOpenAIConnected();
      ctx.reply(
        `Provider: ${active} (${model})\n` +
        `OpenAI OAuth: ${oaiOk ? "connected" : "not connected"}\n` +
        `\nUsage: /provider anthropic|openai\n` +
        `To authenticate with OpenAI: visit http://localhost:3000/auth/openai (browser) or call /openai_login for device code.`
      );
      return;
    }

    if (arg !== "anthropic" && arg !== "openai") {
      ctx.reply("Unknown provider. Use: anthropic or openai.");
      return;
    }

    if (arg === "openai" && !isOpenAIConnected()) {
      ctx.reply(
        "OpenAI is not authenticated yet.\n" +
        "Visit the web admin → http://localhost:3000/auth/openai to sign in with your ChatGPT account,\n" +
        "or use /openai_login to start the device-code flow from here."
      );
      return;
    }

    setRuntimeProvider(arg);
    const model = arg === "openai" ? settings.openai_model : settings.model;
    ctx.reply(`Provider switched to ${arg} (${model}).`);
  });

  // /openai_login — start OpenAI device-code flow and show the code to enter at openai.com
  bot.command("openai_login", async (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    try {
      const res = await fetch(`http://localhost:${process.env.WEB_ADMIN_PORT || "3000"}/auth/openai/device-start`);
      if (!res.ok) {
        await ctx.reply(`Failed to start OpenAI login: HTTP ${res.status}`);
        return;
      }
      const data = await res.json() as {
        device_auth_id: string;
        user_code: string;
        verification_uri: string;
        interval: number;
      };

      await ctx.reply(
        `OpenAI login — open this URL and enter the code:\n\n` +
        `URL: ${data.verification_uri}\n` +
        `Code: \`${data.user_code}\`\n\n` +
        `Waiting for approval… (checking every ${data.interval}s)`,
        { parse_mode: "Markdown" }
      );

      // Poll until tokens arrive or 15 minutes pass
      const deadline = Date.now() + 15 * 60 * 1000;
      const interval = (data.interval ?? 5) * 1000;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
        const pollRes = await fetch(
          `http://localhost:${process.env.WEB_ADMIN_PORT || "3000"}/auth/openai/device-poll`,
          {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ device_auth_id: data.device_auth_id, user_code: data.user_code }),
          }
        );
        const poll = await pollRes.json() as { ok?: boolean; pending?: boolean; error?: string };
        if (poll.ok) {
          setRuntimeProvider("openai");
          await ctx.reply(`OpenAI connected. Switched to provider: openai (${settings.openai_model}).`);
          return;
        }
        if (poll.error) {
          await ctx.reply(`Login failed: ${poll.error}`);
          return;
        }
        // poll.pending — keep waiting
      }

      await ctx.reply("OpenAI login timed out after 15 minutes. Try again with /openai_login.");
    } catch (err) {
      await ctx.reply(`Login error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // /email_setup — configure email credentials step by step
  // Usage: /email_setup <address> <password> <imap_host> <imap_port> <smtp_host> <smtp_port>
  // Example: /email_setup me@example.com secret imap.gmail.com 993 smtp.gmail.com 587
  bot.command("email_setup", async (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    if (parts.length < 6 || !parts[0]) {
      await ctx.reply(
        "Usage:\n" +
        "/email_setup <address> <password> <imap_host> <imap_port> <smtp_host> <smtp_port>\n\n" +
        "Example:\n" +
        "/email_setup me@gmail.com mypassword imap.gmail.com 993 smtp.gmail.com 587\n\n" +
        "For Gmail, use an App Password (myaccount.google.com/apppasswords) and enable IMAP in Gmail settings.\n" +
        "You can also configure this via the web dashboard."
      );
      return;
    }
    const [address, password, imap_host, imap_port, smtp_host, smtp_port] = parts;
    try {
      const port = process.env.WEB_ADMIN_PORT || "3000";
      const token = process.env.WEB_ADMIN_TOKEN || "";
      const res = await fetch(`http://localhost:${port}/api/email/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ address, password, imap_host, imap_port, smtp_host, smtp_port }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (data.ok) {
        await ctx.reply(`✅ Email configured for ${address}.\n\nTo verify the connection, open the dashboard → Integrations → Email → Test Connection.`);
      } else {
        await ctx.reply(`Failed: ${data.error}`);
      }
    } catch (err) {
      await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("help", (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    ctx.reply(
      "/btw <question> — isolated one-shot query, no context\n" +
      "/think low|medium|high|off — set extended-thinking budget\n" +
      "/export — send last conversation trajectory as JSON\n" +
      "/provider [anthropic|openai] — show or switch LLM provider\n" +
      "/openai_login — connect OpenAI via ChatGPT subscription OAuth\n" +
      "/email_setup <addr> <pass> <imap_host> <imap_port> <smtp_host> <smtp_port> — configure agent email\n" +
      "\nSkills:\n" +
      "/skills — list all skills\n" +
      "/skill — show active skill\n" +
      "/skill <name> — manually set active skill\n" +
      "\nConversation:\n" +
      "/clear — reset conversation\n" +
      "\nSystem:\n" +
      "/plugins — installed plugins & secrets\n" +
      "/purgelogs — delete old logs\n" +
      "/debug — toggle live logs in chat\n" +
      "/help — this message"
    );
  });

  bot.on("message:voice", async (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;

    const apiKey = getSecret("OPENAI_API_KEY");
    if (!apiKey) {
      await ctx.reply("Voice messages require an OpenAI API key. Tell the agent: 'store my OpenAI API key'.");
      return;
    }

    const chatId = ctx.chat.id;
    const status = await createStatusMessage(ctx, chatId);

    try {
      await status.update("Transcribing voice message...");

      // Download voice file from Telegram
      const fileInfo = await ctx.api.getFile(ctx.message.voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${fileInfo.file_path}`;
      const audioRes = await fetch(fileUrl);
      if (!audioRes.ok) throw new Error(`Failed to download voice file: ${audioRes.status}`);
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      // Transcribe via OpenAI Whisper
      const form = new FormData();
      form.set("model", "whisper-1");
      form.set("file", new File([audioBuffer], "voice.ogg", { type: "audio/ogg" }));

      const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form as unknown as BodyInit,
      });

      if (!whisperRes.ok) {
        const err = await whisperRes.text();
        throw new Error(`Whisper error: ${err}`);
      }

      const { text: transcript } = await whisperRes.json() as { text: string };
      if (!transcript?.trim()) {
        await status.remove();
        await ctx.reply("Couldn't make out anything in that voice message.");
        return;
      }

      log.chat("in", ctx.from!.id, `[voice] ${transcript}`);
      const response = await chat(ctx.from!.id, transcript, status.update, undefined, { chatId, messageId: ctx.message.message_id });
      await status.remove();
      log.chat("out", ctx.from!.id, response);
      if (response) await sendLong(ctx, response);
    } catch (err) {
      await status.remove();
      log.error(`Voice handler error: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.reply("Failed to process voice message. Try again.");
    }
  });

  // ── Photo messages ────────────────────────────────────────────────────────
  bot.on("message:photo", async (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const userId = ctx.from!.id;
    const chatId = ctx.chat.id;
    const status = await createStatusMessage(ctx, chatId);
    try {
      // Telegram sends multiple sizes; the last entry is the highest resolution.
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      await status.update("Looking at your image…");

      const fileInfo = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${fileInfo.file_path}`;
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer()).toString("base64");
      const ext = fileInfo.file_path?.split(".").pop()?.toLowerCase();
      const media_type = (
        ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg"
      ) as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      const imageBlock: Anthropic.ImageBlockParam = { type: "image", source: { type: "base64", media_type, data } };

      const caption = ctx.message.caption ?? "";
      log.chat("in", userId, `[image] ${caption || "(no caption)"}`);
      const response = await chat(userId, caption || "[Image]", status.update, [imageBlock], { chatId, messageId: ctx.message.message_id });
      await status.remove();
      log.chat("out", userId, response);
      if (response) await sendLong(ctx, response);
    } catch (err) {
      await status.remove();
      log.error(`Photo handler error: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.reply("Failed to process image. Try again.");
    }
  });

  // ── Image documents (uncompressed photos sent as files) ───────────────────
  bot.on("message:document", async (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const doc = ctx.message.document;
    if (!doc.mime_type?.startsWith("image/")) return;
    const userId = ctx.from!.id;
    const chatId = ctx.chat.id;
    const status = await createStatusMessage(ctx, chatId);
    try {
      await status.update("Looking at your image…");

      const fileInfo = await ctx.api.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramToken}/${fileInfo.file_path}`;
      const res = await fetch(fileUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer()).toString("base64");
      const media_type = (doc.mime_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp");
      const imageBlock: Anthropic.ImageBlockParam = { type: "image", source: { type: "base64", media_type, data } };

      const caption = ctx.message.caption ?? "";
      log.chat("in", userId, `[image] ${caption || "(no caption)"}`);
      const response = await chat(userId, caption || "[Image]", status.update, [imageBlock], { chatId, messageId: ctx.message.message_id });
      await status.remove();
      log.chat("out", userId, response);
      if (response) await sendLong(ctx, response);
    } catch (err) {
      await status.remove();
      log.error(`Document handler error: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.reply("Failed to process image. Try again.");
    }
  });

  // Inline button presses — route the label back to the agent as a user message
  bot.on("callback_query:data", async (ctx) => {
    const userId = ctx.from.id;
    if (!isAllowed(userId)) {
      await ctx.answerCallbackQuery();
      return;
    }
    // Inline-mode callbacks can arrive without an attached chat — nothing to reply to.
    if (!ctx.chat) {
      await ctx.answerCallbackQuery();
      return;
    }

    const chatId = ctx.chat.id;
    const label = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    // Escalation buttons are handled directly — don't route through the agent.
    if (label === ESCALATE_YES) {
      setEscalated(userId);
      await ctx.api.sendMessage(chatId, `Switched to ${settings.escalation_model}. Go ahead.`);
      return;
    }
    if (label === ESCALATE_NO) {
      await ctx.api.sendMessage(chatId, "Staying on current model.");
      return;
    }

    const status = await createStatusMessage(ctx, chatId);
    try {
      log.chat("in", userId, `[button] ${label}`);
      const response = await chat(userId, label, status.update);
      await status.remove();
      log.chat("out", userId, response);
      if (response) await sendLong(ctx, response);
    } catch (err) {
      await status.remove();
      log.error(`Button handler error: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.reply("Something went wrong. Try again.");
    }
  });

  bot.on("message:text", async (ctx) => {
    if (!isAllowed(ctx.from!.id)) return;
    const chatId = ctx.chat.id;
    const status = await createStatusMessage(ctx, chatId);
    await emitHook("message:received", {
      userId: ctx.from!.id,
      chatId,
      kind: "text",
      text: ctx.message.text,
    });
    try {
      log.chat("in", ctx.from!.id, ctx.message.text);
      const response = await chat(ctx.from!.id, ctx.message.text, status.update, undefined, { chatId, messageId: ctx.message.message_id });
      await status.remove();
      log.chat("out", ctx.from!.id, response);
      if (response) {
        await sendLong(ctx, response);
        await emitHook("message:sent", { userId: ctx.from!.id, chatId, text: response });
      }
    } catch (err) {
      await status.remove();
      log.error(`Agent error: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.reply("Something went wrong. Try again.");
    }
  });
}
