interface PluginContext {
  getSecret: (key: string) => string | null;
}

const NOTION_VERSION = "2022-06-28";

function notionHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

// Extracts plain text from Notion rich_text arrays
function richText(arr: any[]): string {
  return (arr || []).map((b: any) => b.plain_text || "").join("");
}

// Converts a Notion page to a readable summary
function summarizePage(page: any): string {
  const props = page.properties || {};
  const lines: string[] = [`id: ${page.id}`];
  for (const [key, val] of Object.entries(props) as [string, any][]) {
    if (val.type === "title")        lines.push(`${key}: ${richText(val.title)}`);
    else if (val.type === "rich_text") lines.push(`${key}: ${richText(val.rich_text)}`);
    else if (val.type === "number")  lines.push(`${key}: ${val.number ?? ""}`);
    else if (val.type === "select")  lines.push(`${key}: ${val.select?.name ?? ""}`);
    else if (val.type === "date")    lines.push(`${key}: ${val.date?.start ?? ""}`);
    else if (val.type === "checkbox") lines.push(`${key}: ${val.checkbox}`);
    else if (val.type === "url")     lines.push(`${key}: ${val.url ?? ""}`);
    else if (val.type === "email")   lines.push(`${key}: ${val.email ?? ""}`);
    else if (val.type === "multi_select")
      lines.push(`${key}: ${(val.multi_select || []).map((o: any) => o.name).join(", ")}`);
  }
  return lines.join("\n");
}

export default function setup(ctx: PluginContext) {
  return {
    tools: [
      {
        name: "notion_search",
        description: "Search Notion for pages and databases matching a query.",
        input_schema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "Search terms" },
            filter_type: {
              type: "string",
              enum: ["page", "database"],
              description: "Restrict results to pages or databases (omit for both)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "notion_get_page",
        description: "Get a Notion page's properties and content blocks by ID.",
        input_schema: {
          type: "object" as const,
          properties: {
            page_id: { type: "string", description: "Notion page ID" },
          },
          required: ["page_id"],
        },
      },
      {
        name: "notion_query_database",
        description: "Query a Notion database, optionally filtering or sorting results.",
        input_schema: {
          type: "object" as const,
          properties: {
            database_id: { type: "string", description: "Notion database ID" },
            filter: {
              type: "object",
              description: "Notion filter object (optional). E.g. {property:'Status',select:{equals:'Done'}}",
            },
            sorts: {
              type: "array",
              description: "Sort array (optional). E.g. [{property:'Date',direction:'descending'}]",
              items: { type: "object" },
            },
            page_size: { type: "number", description: "Max results to return (default 10, max 100)" },
          },
          required: ["database_id"],
        },
      },
      {
        name: "notion_create_page",
        description: "Create a new Notion page inside a database or as a child of another page.",
        input_schema: {
          type: "object" as const,
          properties: {
            parent_id: {
              type: "string",
              description: "ID of the parent database or page",
            },
            parent_type: {
              type: "string",
              enum: ["database_id", "page_id"],
              description: "Whether the parent is a database or a page",
            },
            properties: {
              type: "object",
              description: "Page properties as a Notion properties object. For database pages, must include the title property.",
            },
            content: {
              type: "string",
              description: "Optional plain-text content to add as a paragraph block",
            },
          },
          required: ["parent_id", "parent_type", "properties"],
        },
      },
      {
        name: "notion_update_page",
        description: "Update properties of an existing Notion page.",
        input_schema: {
          type: "object" as const,
          properties: {
            page_id: { type: "string", description: "Notion page ID to update" },
            properties: {
              type: "object",
              description: "Properties to update as a Notion properties object",
            },
            archived: {
              type: "boolean",
              description: "Set to true to archive (delete) the page",
            },
          },
          required: ["page_id", "properties"],
        },
      },
      {
        name: "notion_append_blocks",
        description: "Append text blocks to an existing Notion page.",
        input_schema: {
          type: "object" as const,
          properties: {
            page_id: { type: "string", description: "Notion page ID" },
            content: { type: "string", description: "Text to append as paragraph blocks (newlines become separate blocks)" },
          },
          required: ["page_id", "content"],
        },
      },
    ],

    handlers: {
      notion_search: async (input: Record<string, unknown>) => {
        const apiKey = ctx.getSecret("NOTION_API_KEY");
        if (!apiKey) return "Error: NOTION_API_KEY not set.";

        const body: any = { query: input.query };
        if (input.filter_type) body.filter = { value: input.filter_type, property: "object" };

        const res = await fetch("https://api.notion.com/v1/search", {
          method: "POST",
          headers: notionHeaders(apiKey),
          body: JSON.stringify(body),
        });
        const data = await res.json() as any;
        if (data.object === "error") return `Notion error: ${data.message}`;

        const results = (data.results || []).slice(0, 20);
        if (!results.length) return "No results found.";

        return results.map((r: any) => {
          const titleProp = Object.values(r.properties || {}).find((p: any) => p.type === "title") as any;
          const title = titleProp ? richText(titleProp.title) : "(untitled)";
          return `[${r.object}] ${title} — id: ${r.id}`;
        }).join("\n");
      },

      notion_get_page: async (input: Record<string, unknown>) => {
        const apiKey = ctx.getSecret("NOTION_API_KEY");
        if (!apiKey) return "Error: NOTION_API_KEY not set.";

        const pageId = input.page_id as string;

        const [pageRes, blocksRes] = await Promise.all([
          fetch(`https://api.notion.com/v1/pages/${pageId}`, {
            headers: notionHeaders(apiKey),
          }),
          fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=50`, {
            headers: notionHeaders(apiKey),
          }),
        ]);

        const page  = await pageRes.json() as any;
        const blocks = await blocksRes.json() as any;

        if (page.object === "error")   return `Notion error: ${page.message}`;
        if (blocks.object === "error") return `Notion error: ${blocks.message}`;

        const propSummary = summarizePage(page);

        const blockText = (blocks.results || []).map((b: any) => {
          const type = b.type;
          const content = b[type];
          if (content?.rich_text) return richText(content.rich_text);
          return "";
        }).filter(Boolean).join("\n");

        return propSummary + (blockText ? `\n\n--- Content ---\n${blockText}` : "");
      },

      notion_query_database: async (input: Record<string, unknown>) => {
        const apiKey = ctx.getSecret("NOTION_API_KEY");
        if (!apiKey) return "Error: NOTION_API_KEY not set.";

        const body: any = { page_size: (input.page_size as number) || 10 };
        if (input.filter) body.filter = input.filter;
        if (input.sorts)  body.sorts  = input.sorts;

        const res = await fetch(
          `https://api.notion.com/v1/databases/${input.database_id}/query`,
          { method: "POST", headers: notionHeaders(apiKey), body: JSON.stringify(body) }
        );
        const data = await res.json() as any;
        if (data.object === "error") return `Notion error: ${data.message}`;

        const results = data.results || [];
        if (!results.length) return "No results found.";

        return results.map((p: any) => summarizePage(p)).join("\n\n---\n\n");
      },

      notion_create_page: async (input: Record<string, unknown>) => {
        const apiKey = ctx.getSecret("NOTION_API_KEY");
        if (!apiKey) return "Error: NOTION_API_KEY not set.";

        const body: any = {
          parent: { [input.parent_type as string]: input.parent_id },
          properties: input.properties,
        };

        if (input.content) {
          body.children = (input.content as string).split("\n").filter(Boolean).map((line: string) => ({
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
          }));
        }

        const res = await fetch("https://api.notion.com/v1/pages", {
          method: "POST",
          headers: notionHeaders(apiKey),
          body: JSON.stringify(body),
        });
        const data = await res.json() as any;
        if (data.object === "error") return `Notion error: ${data.message}`;
        return `Page created: ${data.id}`;
      },

      notion_update_page: async (input: Record<string, unknown>) => {
        const apiKey = ctx.getSecret("NOTION_API_KEY");
        if (!apiKey) return "Error: NOTION_API_KEY not set.";

        const body: any = { properties: input.properties };
        if (typeof input.archived === "boolean") body.archived = input.archived;

        const res = await fetch(`https://api.notion.com/v1/pages/${input.page_id}`, {
          method: "PATCH",
          headers: notionHeaders(apiKey),
          body: JSON.stringify(body),
        });
        const data = await res.json() as any;
        if (data.object === "error") return `Notion error: ${data.message}`;
        return `Page updated: ${data.id}`;
      },

      notion_append_blocks: async (input: Record<string, unknown>) => {
        const apiKey = ctx.getSecret("NOTION_API_KEY");
        if (!apiKey) return "Error: NOTION_API_KEY not set.";

        const children = (input.content as string).split("\n").filter(Boolean).map((line: string) => ({
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: line } }] },
        }));

        const res = await fetch(`https://api.notion.com/v1/blocks/${input.page_id}/children`, {
          method: "PATCH",
          headers: notionHeaders(apiKey),
          body: JSON.stringify({ children }),
        });
        const data = await res.json() as any;
        if (data.object === "error") return `Notion error: ${data.message}`;
        return `Appended ${children.length} block(s) to page ${input.page_id}`;
      },
    },
  };
}
