// Tools for managing plugins (create, toggle, delete) and secrets (store, list, delete).
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  loadPlugin,
  unloadPlugin,
  deletePlugin as deletePluginFiles,
  ensurePluginsDir,
} from "../../plugins/loader";
import {
  registerPlugin,
  unregisterPlugin,
  setPluginEnabled,
  getRegistry,
} from "../../plugins/registry";
import {
  getSecret,
  setSecret,
  deleteSecret,
  listSecretKeys,
} from "../../plugins/secrets";

const PLUGINS_DIR = join(process.cwd(), "plugins");

const PLUGIN_TEMPLATE = `
interface PluginContext {
  getSecret: (key: string) => string | null;
  /** Returns a valid Google OAuth access token (auto-refreshed). Null if not connected. */
  getGoogleToken: () => Promise<string | null>;
}

export default function setup(ctx: PluginContext) {
  return {
    tools: [
      {
        name: "example_action",
        description: "What this tool does",
        input_schema: {
          type: "object" as const,
          properties: {
            param: { type: "string", description: "Parameter description" }
          },
          required: ["param"]
        }
      }
    ],
    handlers: {
      example_action: async (input: Record<string, unknown>) => {
        // API key auth:
        // const apiKey = ctx.getSecret("EXAMPLE_API_KEY");
        // if (!apiKey) return "Error: EXAMPLE_API_KEY not set.";

        // Google OAuth auth:
        // const token = await ctx.getGoogleToken();
        // if (!token) return "Error: Google account not connected. Ask the user to connect it.";
        // const res = await fetch("https://www.googleapis.com/...", {
        //   headers: { Authorization: \`Bearer \${token}\` }
        // });

        return "result";
      }
    }
  };
}
`.trim();

export const pluginTools: Anthropic.Tool[] = [
  {
    name: "create_tool",
    description:
      `Create a new tool plugin. Write self-contained TypeScript that exports a default setup function.\n\n` +
      `Template:\n\`\`\`typescript\n${PLUGIN_TEMPLATE}\n\`\`\`\n\n` +
      `Rules:\n` +
      `- Export a default function that receives { getSecret } and returns { tools, handlers }\n` +
      `- Each handler MUST return a string\n` +
      `- Use ctx.getSecret("KEY") for API credentials. If null, return an error asking the user to provide it via store_secret\n` +
      `- fetch() is available globally for HTTP requests\n` +
      `- Tool names MUST be prefixed with the plugin name (e.g. "github_list_repos")\n` +
      `- No external imports — code must be self-contained (no require/import statements)\n` +
      `- Keep plugins focused — one integration per plugin`,
    input_schema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Plugin name in kebab-case (e.g. 'hacker-news', 'google-calendar')",
        },
        description: {
          type: "string",
          description: "Short description of what this plugin does",
        },
        code: {
          type: "string",
          description: "The full TypeScript source code for the plugin",
        },
      },
      required: ["name", "description", "code"],
    },
  },
  {
    name: "list_plugins",
    description: "List all installed plugins and their status (enabled/disabled).",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "toggle_plugin",
    description: "Enable or disable a plugin.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Plugin name" },
        enabled: { type: "boolean", description: "true to enable, false to disable" },
      },
      required: ["name", "enabled"],
    },
  },
  {
    name: "delete_plugin",
    description: "Permanently delete a plugin and its files.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Plugin name to delete" },
      },
      required: ["name"],
    },
  },
  {
    name: "store_secret",
    description:
      "Store an API key or credential securely. Use this when the user provides a key for a plugin. " +
      "Keys are stored in secrets.json (gitignored).",
    input_schema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "Secret name in UPPER_SNAKE_CASE (e.g. 'GOOGLE_API_KEY')",
        },
        value: { type: "string", description: "The secret value" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "list_secrets",
    description: "List stored secret key names (not values) to check what credentials are configured.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "delete_secret",
    description: "Delete a stored secret.",
    input_schema: {
      type: "object" as const,
      properties: {
        key: { type: "string", description: "Secret name to delete" },
      },
      required: ["key"],
    },
  },
];

export const pluginHandlers: Record<
  string,
  (input: Record<string, unknown>) => Promise<string>
> = {
  create_tool: async (input) => {
    const name = input.name as string;
    const description = input.description as string;
    const code = input.code as string;

    // Validate name
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return "Error: Plugin name must be kebab-case (lowercase letters, numbers, hyphens).";
    }

    ensurePluginsDir();
    const pluginDir = join(PLUGINS_DIR, name);

    // Create plugin directory and write source
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "index.ts"), code, "utf-8");

    // Try to compile and load
    const result = loadPlugin(name);

    if (!result.success) {
      // Clean up on failure
      deletePluginFiles(name);
      return `Error: Plugin failed to load — ${result.error}\n\nFix the code and try again.`;
    }

    // Register in plugins.json
    registerPlugin(name, description);

    return `Plugin "${name}" created and loaded successfully.`;
  },

  list_plugins: async () => {
    const registry = getRegistry();
    const names = Object.keys(registry);
    if (names.length === 0) return "No plugins installed.";

    return names
      .map((name) => {
        const p = registry[name];
        const status = p.enabled ? "enabled" : "disabled";
        return `- ${name} (${status}) — ${p.description}`;
      })
      .join("\n");
  },

  toggle_plugin: async (input) => {
    const name = input.name as string;
    const enabled = input.enabled as boolean;

    if (!setPluginEnabled(name, enabled)) {
      return `Plugin "${name}" not found.`;
    }

    if (enabled) {
      const result = loadPlugin(name);
      if (!result.success) return `Failed to load "${name}": ${result.error}`;
    } else {
      unloadPlugin(name);
    }

    return `Plugin "${name}" ${enabled ? "enabled" : "disabled"}.`;
  },

  delete_plugin: async (input) => {
    const name = input.name as string;
    unregisterPlugin(name);
    deletePluginFiles(name);
    return `Plugin "${name}" deleted.`;
  },

  store_secret: async (input) => {
    const key = input.key as string;
    const value = input.value as string;
    setSecret(key, value);
    return `Secret "${key}" stored.`;
  },

  list_secrets: async () => {
    const keys = listSecretKeys();
    if (keys.length === 0) return "No secrets stored.";
    return keys.map((k) => `- ${k}`).join("\n");
  },

  delete_secret: async (input) => {
    const key = input.key as string;
    if (!deleteSecret(key)) return `Secret "${key}" not found.`;
    return `Secret "${key}" deleted.`;
  },
};
