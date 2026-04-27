// Persists plugin metadata (name, enabled, description) to plugins.json.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const REGISTRY_PATH = join(process.cwd(), "config/plugins.json");

/** Optional metadata for plugins that act as service integrations. */
export interface IntegrationMeta {
  /** 'oauth' = browser-based auth flow; 'apikey' = secret stored in secrets.json; 'email' = IMAP/SMTP config */
  type: "oauth" | "apikey" | "email";
  /** Human-readable integration name, e.g. "Google" */
  displayName: string;
  /** Sub-services covered, e.g. ["Gmail", "Calendar", "Drive"] */
  services: string[];
  /** OAuth only — auth service identifier, e.g. "google" */
  authService?: string;
  /** API key only — the secrets.json key to check for configured status */
  secretKey?: string;
}

export interface PluginEntry {
  enabled: boolean;
  description: string;
  createdAt: string;
  /** Present when the plugin is a service integration (Google, Todoist, etc.) */
  integration?: IntegrationMeta;
}

export type Registry = Record<string, PluginEntry>;

export function getRegistry(): Registry {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveRegistry(data: Registry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function registerPlugin(name: string, description: string): void {
  const reg = getRegistry();
  reg[name] = {
    enabled: true,
    description,
    createdAt: new Date().toISOString(),
  };
  saveRegistry(reg);
}

export function unregisterPlugin(name: string): boolean {
  const reg = getRegistry();
  if (!(name in reg)) return false;
  delete reg[name];
  saveRegistry(reg);
  return true;
}

export function setPluginEnabled(name: string, enabled: boolean): boolean {
  const reg = getRegistry();
  if (!(name in reg)) return false;
  reg[name].enabled = enabled;
  saveRegistry(reg);
  return true;
}

export function isPluginEnabled(name: string): boolean {
  const reg = getRegistry();
  return reg[name]?.enabled ?? false;
}
