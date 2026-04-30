// run_codex tool — delegates coding tasks to the Codex CLI.
// Injects OPENAI_API_KEY from secrets so the main agent doesn't need it in .env.
// Uses --approval-mode=full-auto for non-interactive execution.
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { getSecret } from "../../plugins/secrets";
import type { ToolHandler } from "./types";

const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_OUTPUT_BYTES = 128 * 1024;

function resolveCwd(cwd?: string): string {
  if (!cwd) return process.cwd();
  if (cwd.startsWith("~")) return join(homedir(), cwd.slice(2));
  return cwd;
}

export const codexTools: Anthropic.Tool[] = [
  {
    name: "run_codex",
    description:
      "Delegate a coding task to the Codex CLI. Codex runs autonomously in the specified directory — " +
      "it reads files, writes and edits code, runs tests, and returns what it did. " +
      "Use for any task that requires reading or modifying files: implementing features, fixing bugs, " +
      "refactoring, writing tests. Always specify the working directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description:
            "The coding task to perform. Be specific — include file names, function names, " +
            "what to implement or fix, and any relevant context.",
        },
        cwd: {
          type: "string",
          description:
            "Absolute path to the project directory where Codex should work. " +
            "Use ~ for home directory. Defaults to the Atrex project root if omitted.",
        },
      },
      required: ["task"],
    },
  },
];

export const codexHandlers: Record<string, ToolHandler> = {
  run_codex: async (input) => {
    const task = input.task as string;
    const cwd = resolveCwd(input.cwd as string | undefined);

    const apiKey = getSecret("OPENAI_API_KEY") || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return (
        "OPENAI_API_KEY not found. Store it via the Secrets page in the dashboard " +
        "or tell me: \"Store secret OPENAI_API_KEY <your-key>\"."
      );
    }

    const env = { ...process.env, OPENAI_API_KEY: apiKey };

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let truncated = false;

      const child = spawn("codex", ["--approval-mode", "full-auto", "--quiet", task], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      function onData(chunk: Buffer): void {
        if (truncated) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_OUTPUT_BYTES) {
          chunks.push(chunk.slice(0, chunk.length - (totalBytes - MAX_OUTPUT_BYTES)));
          truncated = true;
        } else {
          chunks.push(chunk);
        }
      }

      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      const timer = setTimeout(() => {
        child.kill();
        const out = Buffer.concat(chunks).toString("utf-8").trim();
        resolve(`[run_codex] Timed out after 10 minutes.\n${out}`);
      }, TIMEOUT_MS);

      child.on("close", (code) => {
        clearTimeout(timer);
        const out = Buffer.concat(chunks).toString("utf-8").trim();
        const suffix = truncated ? "\n\n[Output truncated]" : "";
        resolve(out ? out + suffix : `Codex exited with code ${code} — no output.`);
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve("Codex CLI not found. Install it with: npm install -g @openai/codex");
        } else {
          resolve(`Failed to start codex: ${err.message}`);
        }
      });
    });
  },
};
