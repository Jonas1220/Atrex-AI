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
  private fingerprints: string[] = [];
  warned = false;
  exceeded = false;

  /** Returns true if we've crossed the hard limit and the loop should abort. */
  observe(blocks: Anthropic.ContentBlock[]): boolean {
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      this.fingerprints.push(fingerprint(block.name, block.input));
    }

    const window = this.fingerprints.slice(-settings.tool_loop_max);
    const last = window[window.length - 1];
    if (!last) return false;
    const sameRunLength = window.filter((f) => f === last).length;

    if (!this.warned && sameRunLength >= settings.tool_loop_warn) {
      this.warned = true;
      log.warn(`Tool-loop guard: ${last.split("::")[0]} called ${sameRunLength}x with same input`);
    }
    if (sameRunLength >= settings.tool_loop_max) {
      this.exceeded = true;
      log.error(`Tool-loop guard: aborting — ${last.split("::")[0]} called ${sameRunLength}x with same input`);
      return true;
    }
    return false;
  }
}
