// Simple key-value store for API keys and credentials, persisted to secrets.json (gitignored).
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const SECRETS_PATH = join(process.cwd(), "config/secrets.json");

function load(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function save(data: Record<string, string>): void {
  writeFileSync(SECRETS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function getSecret(key: string): string | null {
  return load()[key] ?? null;
}

export function setSecret(key: string, value: string): void {
  const data = load();
  data[key] = value;
  save(data);
}

export function deleteSecret(key: string): boolean {
  const data = load();
  if (!(key in data)) return false;
  delete data[key];
  save(data);
  return true;
}

export function listSecretKeys(): string[] {
  return Object.keys(load());
}
