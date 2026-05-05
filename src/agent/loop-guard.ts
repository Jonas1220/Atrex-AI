// Detects pathological tool loops: same tool with same input fired N times in a row.
// Cheap insurance against agents that wedge themselves in a circle.
import Anthropic from "@anthropic-ai/sdk";
import { settings } from "../config";
import { log } from "../logger";

function fingerprint(name: string, input: unknown): string {
  // Stable JSON: object key order doesn't matter for a small input.
  // Truncate huge inputs so we don't keep megabytes around.
  let serialized: string;
  try { serialized = JSON.stringify(input); } catch { serialized = String(input); }
  if (serialized.length > 500) serialized = serialized.slice(0, 500);
  return `${name}::${serialized}`;
}

export class LoopGuard {
  private counts = new Map<string, number>();
  warned = false;
  exceeded = false;

  /** Returns true if we've crossed the hard limit and the loop should abort. */
  observe(blocks: Anthropic.ContentBlock[]): boolean {
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      const fp = fingerprint(block.name, block.input);
      const n = (this.counts.get(fp) ?? 0) + 1;
      this.counts.set(fp, n);
      const toolName = block.name;

      if (!this.warned && n >= settings.tool_loop_warn) {
        this.warned = true;
        log.warn(`Tool-loop guard: ${toolName} called ${n}x with same input`);
      }
      if (n >= settings.tool_loop_max) {
        this.exceeded = true;
        log.error(`Tool-loop guard: aborting — ${toolName} called ${n}x with same input`);
        return true;
      }
    }
    return false;
  }
}
