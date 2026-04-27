// Tool for running arbitrary shell commands on the host machine.
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "child_process";
import { join } from "path";
import { homedir } from "os";
import type { ToolHandler } from "./types";

const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB
const MAX_TIMEOUT_S    = 60;
const DEFAULT_TIMEOUT_S = 15;

function expandCwd(cwd?: string): string {
  if (!cwd) return homedir();
  if (cwd.startsWith("~")) return join(homedir(), cwd.slice(1));
  return cwd;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;

    const child = spawn("bash", ["-c", command], {
      cwd,
      env:   process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    function onData(chunk: Buffer): void {
      if (truncated) return;
      totalBytes += chunk.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        chunks.push(chunk.slice(0, chunk.length - (totalBytes - MAX_OUTPUT_BYTES)));
        truncated = true;
        child.stdout.destroy();
        child.stderr.destroy();
      } else {
        chunks.push(chunk);
      }
    }

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000);
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf-8").trimEnd();
      const suffix = truncated ? "\n[output truncated at 256 KB]" : "";
      const exitNote =
        signal === "SIGTERM" || signal === "SIGKILL"
          ? `\n[timed out after ${timeoutMs / 1000}s]`
          : code !== 0
          ? `\n[exit ${code}]`
          : "";
      resolve((output || "(no output)") + suffix + exitNote);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`Error: ${err.message}`);
    });
  });
}

export const shellTools: Anthropic.Tool[] = [
  {
    name: "run_shell",
    description:
      "Run a shell command on the user's machine using bash. " +
      "Full environment access — PATH, HOME, and all env vars are inherited. " +
      "Use this to read files, run scripts, check system state, install packages, " +
      "run CLI tools (git, npm, brew, python, etc.), or do anything you'd do in a terminal. " +
      "Prefer non-interactive commands. For long-running processes use a short timeout and run in background with &. " +
      "Working directory defaults to ~ unless cwd is specified.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The bash command to run. Can include pipes, redirects, and multi-step logic.",
        },
        cwd: {
          type: "string",
          description: "Working directory. Defaults to ~. Supports ~ expansion.",
        },
        timeout: {
          type: "number",
          description: `Timeout in seconds (1–${MAX_TIMEOUT_S}). Default: ${DEFAULT_TIMEOUT_S}.`,
        },
      },
      required: ["command"],
    },
  },
];

export const shellHandlers: Record<string, ToolHandler> = {
  run_shell: async (input) => {
    const command = (input.command as string)?.trim();
    if (!command) return "Error: command is required.";

    const cwd = expandCwd(input.cwd as string | undefined);
    const timeoutSec = Math.min(
      MAX_TIMEOUT_S,
      Math.max(1, Number(input.timeout) || DEFAULT_TIMEOUT_S)
    );

    return runCommand(command, cwd, timeoutSec * 1000);
  },
};
