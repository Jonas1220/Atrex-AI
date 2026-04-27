// Compiles plugin TypeScript to JS via esbuild, loads them into memory, and exposes their tools.
import { transformSync } from "esbuild";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getRegistry, isPluginEnabled } from "./registry";
import { getSecret } from "./secrets";
import { getValidAccessToken } from "../google/auth";
import { log } from "../logger";

const PLUGINS_DIR = join(process.cwd(), "plugins");

type Handler = (input: Record<string, unknown>) => Promise<string>;

interface PluginContext {
  getSecret: (key: string) => string | null;
  /** Returns a valid Google OAuth access token, auto-refreshing if expired. Null if not connected. */
  getGoogleToken: () => Promise<string | null>;
  /** Returns the Google OAuth consent URL the user must open, or null if GOOGLE_CLIENT_ID is not set. */
  getGoogleAuthUrl: () => string | null;
  /** Returns true if a Google refresh token is stored (account is connected). */
  isGoogleConnected: () => boolean;
  /** Removes all stored Google tokens, disconnecting the account. */
  disconnectGoogle: () => void;
}

interface LoadedPlugin {
  tools: Anthropic.Tool[];
  handlers: Record<string, Handler>;
}

const loaded = new Map<string, LoadedPlugin>();

// Transpiles a plugin's index.ts to index.js using esbuild (no bundling, just TS -> JS)
function compile(name: string): { success: boolean; jsPath: string; error?: string } {
  const sourceDir = join(PLUGINS_DIR, name);
  const sourcePath = join(sourceDir, "index.ts");
  const jsPath = join(sourceDir, "index.js");

  if (!existsSync(sourcePath)) {
    return { success: false, jsPath, error: `File not found: ${sourcePath}` };
  }

  try {
    const source = readFileSync(sourcePath, "utf-8");
    const { code } = transformSync(source, {
      loader: "ts",
      format: "cjs",
      target: "node20",
    });
    writeFileSync(jsPath, code);
    return { success: true, jsPath };
  } catch (err) {
    return {
      success: false,
      jsPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function loadPlugin(name: string): { success: boolean; error?: string } {
  const result = compile(name);
  if (!result.success) {
    log.error(`Plugin "${name}" failed to compile: ${result.error}`);
    return { success: false, error: result.error };
  }

  try {
    // Clear require cache for hot-reload
    const resolved = require.resolve(result.jsPath);
    delete require.cache[resolved];

    const mod = require(resolved);
    const setup = mod.default || mod;

    if (typeof setup !== "function") {
      return { success: false, error: "Plugin must export a default setup function." };
    }

    const ctx: PluginContext = {
      getSecret:        (key) => getSecret(key),
      getGoogleToken:   () => getValidAccessToken(),
      getGoogleAuthUrl: () => {
        if (!getSecret("GOOGLE_CLIENT_ID")) return null;
        const port = parseInt(process.env.WEB_ADMIN_PORT || "3000", 10);
        // Inline to avoid importing the oauth module (which imports express)
        const { buildAuthUrl } = require("../google/auth");
        return buildAuthUrl(port) as string;
      },
      isGoogleConnected: () => {
        const { isGoogleConnected: check } = require("../google/auth");
        return check() as boolean;
      },
      disconnectGoogle: () => {
        const { disconnectGoogle: dc } = require("../google/auth");
        dc();
      },
    };

    const plugin = setup(ctx) as LoadedPlugin;

    if (!Array.isArray(plugin.tools) || typeof plugin.handlers !== "object") {
      return {
        success: false,
        error: "setup() must return { tools: Tool[], handlers: Record<string, Handler> }.",
      };
    }

    loaded.set(name, plugin);
    log.success(`Plugin "${name}" loaded (${plugin.tools.length} tool(s)).`);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Plugin "${name}" failed to load: ${msg}`);
    return { success: false, error: msg };
  }
}

export function unloadPlugin(name: string): void {
  loaded.delete(name);
  log.info(`Plugin "${name}" unloaded.`);
}

export function deletePlugin(name: string): void {
  unloadPlugin(name);
  const dir = join(PLUGINS_DIR, name);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

export function loadAllEnabled(): void {
  const registry = getRegistry();
  let count = 0;
  for (const name of Object.keys(registry)) {
    if (registry[name].enabled) {
      const result = loadPlugin(name);
      if (result.success) count++;
    }
  }
  log.info(`Plugins: ${count} loaded, ${Object.keys(registry).length} registered.`);
}

export function getPluginTools(): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  for (const plugin of loaded.values()) {
    tools.push(...plugin.tools);
  }
  return tools;
}

export function getPluginHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  for (const plugin of loaded.values()) {
    Object.assign(handlers, plugin.handlers);
  }
  return handlers;
}

export function ensurePluginsDir(): void {
  mkdirSync(PLUGINS_DIR, { recursive: true });
}
