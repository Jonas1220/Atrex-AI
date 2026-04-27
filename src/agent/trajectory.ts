// Per-user flight recorder. Captures the most recent chat() invocation as a structured
// timeline (model, tool calls, timings, token usage, errors) so it can be /export-ed
// for debugging weird tool loops. In-memory only — overwritten each turn.
import { settings } from "../config";

export interface TrajectoryToolCall {
  name: string;
  inputPreview: string;     // truncated JSON of input
  resultLength: number;
  durationMs: number;
  error?: string;
}

export interface TrajectoryStep {
  model: string;
  promptTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  stopReason: string | null;
  durationMs: number;
  toolCalls: TrajectoryToolCall[];
  thinking?: string;
}

export interface Trajectory {
  userId: number;
  startedAt: string;
  finishedAt?: string;
  userMessage: string;
  totalDurationMs?: number;
  thinkingLevel: string;
  escalated: boolean;
  steps: TrajectoryStep[];
  finalText?: string;
  error?: string;
}

const recent = new Map<number, Trajectory>();

export class TrajectoryBuilder {
  private t: Trajectory;
  private start: number;

  constructor(userId: number, userMessage: string, thinkingLevel: string, escalated: boolean) {
    this.start = Date.now();
    this.t = {
      userId,
      startedAt: new Date().toISOString(),
      userMessage: userMessage.length > 2000 ? userMessage.slice(0, 2000) + "…" : userMessage,
      thinkingLevel,
      escalated,
      steps: [],
    };
  }

  enabled(): boolean {
    return settings.enable_trajectory;
  }

  step(step: TrajectoryStep): void {
    if (!this.enabled()) return;
    this.t.steps.push(step);
  }

  finish(finalText: string, error?: string): void {
    if (!this.enabled()) return;
    this.t.finishedAt = new Date().toISOString();
    this.t.totalDurationMs = Date.now() - this.start;
    this.t.finalText = finalText.length > 2000 ? finalText.slice(0, 2000) + "…" : finalText;
    if (error) this.t.error = error;
    recent.set(this.t.userId, this.t);
  }
}

export function getTrajectory(userId: number): Trajectory | null {
  return recent.get(userId) ?? null;
}

export function previewToolInput(input: unknown): string {
  let s: string;
  try { s = JSON.stringify(input); } catch { s = String(input); }
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}
