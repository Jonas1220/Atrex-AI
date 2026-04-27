// Tools for reading files and listing directories on the host machine.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import type { ToolHandler } from "./types";

const MAX_READ_BYTES = 256 * 1024; // 256 KB
const DEFAULT_LINES  = 200;

function expandPath(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  if (!p.startsWith("/")) return join(homedir(), p);
  return resolve(p);
}

function isBinary(buf: Buffer): boolean {
  // Heuristic: if more than 1% of the first 8 KB are null bytes, treat as binary.
  const sample = buf.slice(0, 8192);
  let nulls = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) nulls++;
  }
  return nulls / sample.length > 0.01;
}

export const filesystemTools: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "Read the contents of any file on the user's machine. " +
      "Supports text files of any kind — code, config, markdown, logs, etc. " +
      "Use offset and limit to read specific line ranges of large files. " +
      "Paths can be absolute (/Users/…) or relative to the home directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Absolute path or path relative to ~. Examples: '/etc/hosts', '~/Documents/notes.md', 'Desktop/todo.txt'",
        },
        offset: {
          type: "number",
          description: "1-based line number to start reading from (default: 1).",
        },
        limit: {
          type: "number",
          description: `Maximum number of lines to return (default: ${DEFAULT_LINES}). Use a higher value for large files.`,
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description:
      "List the contents of a directory on the user's machine. " +
      "Returns filenames, types (file/dir), and sizes. " +
      "Use this to explore the filesystem before reading specific files.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Directory path. Defaults to ~ if omitted.",
        },
        include_hidden: {
          type: "boolean",
          description: "Whether to include hidden files (names starting with '.'). Default false.",
        },
      },
      required: [],
    },
  },
];

export const filesystemHandlers: Record<string, ToolHandler> = {
  read_file: async (input) => {
    const rawPath = (input.path as string)?.trim();
    if (!rawPath) return "Error: path is required.";

    const filePath = expandPath(rawPath);

    if (!existsSync(filePath)) return `Error: no such file: ${filePath}`;

    let stat;
    try { stat = statSync(filePath); } catch (e) { return `Error: ${(e as Error).message}`; }
    if (stat.isDirectory()) return `Error: ${filePath} is a directory — use list_dir instead.`;

    const offset = Math.max(1, Number(input.offset) || 1);
    const limit  = Math.max(1, Number(input.limit)  || DEFAULT_LINES);

    let buf: Buffer;
    try { buf = readFileSync(filePath); } catch (e) { return `Error reading file: ${(e as Error).message}`; }

    if (isBinary(buf)) return `[Binary file — ${stat.size} bytes — not shown]`;

    // Truncate to MAX_READ_BYTES before splitting so we never parse a 1 GB file.
    const truncated = buf.length > MAX_READ_BYTES;
    const text = (truncated ? buf.slice(0, MAX_READ_BYTES) : buf).toString("utf-8");
    const lines = text.split("\n");

    const startIdx = offset - 1;
    const slice    = lines.slice(startIdx, startIdx + limit);

    const header = `${filePath} (lines ${offset}–${offset + slice.length - 1} of ${lines.length}${truncated ? "+" : ""})`;
    return `${header}\n${"─".repeat(header.length)}\n${slice.join("\n")}`;
  },

  list_dir: async (input) => {
    const rawPath = ((input.path as string) || "~").trim();
    const dirPath = expandPath(rawPath);
    const includeHidden = !!(input.include_hidden as boolean);

    if (!existsSync(dirPath)) return `Error: no such directory: ${dirPath}`;

    let entries;
    try { entries = readdirSync(dirPath); } catch (e) { return `Error: ${(e as Error).message}`; }

    const rows = entries
      .filter((name) => includeHidden || !name.startsWith("."))
      .map((name) => {
        const full = join(dirPath, name);
        try {
          const s = statSync(full);
          const type = s.isDirectory() ? "dir " : "file";
          const size = s.isDirectory() ? "" : formatSize(s.size);
          return `${type}  ${size.padStart(8)}  ${name}`;
        } catch {
          return `????             ${name}`;
        }
      });

    if (rows.length === 0) return `${dirPath} — (empty)`;
    return `${dirPath}\n${"─".repeat(40)}\n${rows.join("\n")}`;
  },
};

function formatSize(bytes: number): string {
  if (bytes < 1024)       return `${bytes} B`;
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
