interface PluginContext {
  getSecret: (key: string) => string | null;
}

export default function setup(ctx: PluginContext) {
  return {
    tools: [
      {
        name: "brave_search",
        description: "Search the web using Brave Search. Returns titles, URLs, and descriptions of results.",
        input_schema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "The search query" },
            count: { type: "number", description: "Number of results to return (default 5, max 20)" }
          },
          required: ["query"]
        }
      }
    ],
    handlers: {
      brave_search: async (input: Record<string, unknown>) => {
        const apiKey = ctx.getSecret("BRAVE_SEARCH_API_KEY");
        if (!apiKey) return "Error: BRAVE_SEARCH_API_KEY not set. Please provide it.";

        const query = input.query as string;
        const count = (input.count as number) || 5;

        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;

        const response = await fetch(url, {
          headers: {
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": apiKey
          }
        });

        if (!response.ok) {
          return `Error: Brave Search API returned ${response.status} ${response.statusText}`;
        }

        const data = await response.json() as any;
        const results = data?.web?.results;

        if (!results || results.length === 0) {
          return "No results found.";
        }

        return results.map((r: any, i: number) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description || "No description"}`
        ).join("\n\n");
      }
    }
  };
}
