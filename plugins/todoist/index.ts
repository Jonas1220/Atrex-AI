interface PluginContext {
  getSecret: (key: string) => string | null;
}

export default function setup(ctx: PluginContext) {
  const BASE_URL = "https://api.todoist.com/api/v1";

  function getHeaders() {
    const apiKey = ctx.getSecret("TODOIST_API_KEY");
    if (!apiKey) throw new Error("TODOIST_API_KEY not set.");
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
  }

  return {
    tools: [
      {
        name: "todoist_get_tasks",
        description: "Get a list of tasks. Optionally filter by project_id, label, or filter string (e.g. 'today', 'overdue').",
        input_schema: {
          type: "object" as const,
          properties: {
            project_id: { type: "string", description: "Filter by project ID" },
            label: { type: "string", description: "Filter by label name" },
            filter: { type: "string", description: "Todoist filter query, e.g. 'today', 'overdue', 'p1'" },
          },
          required: [],
        },
      },
      {
        name: "todoist_create_task",
        description: "Create a new task in Todoist.",
        input_schema: {
          type: "object" as const,
          properties: {
            content: { type: "string", description: "Task title/content" },
            description: { type: "string", description: "Optional task description" },
            project_id: { type: "string", description: "Project ID to add task to" },
            due_string: { type: "string", description: "Due date as natural language, e.g. 'today', 'tomorrow', 'next Monday at 3pm'" },
            priority: { type: "number", description: "Priority: 1 (normal) to 4 (urgent)" },
            labels: { type: "array", items: { type: "string" }, description: "List of label names" },
          },
          required: ["content"],
        },
      },
      {
        name: "todoist_update_task",
        description: "Update an existing task by ID.",
        input_schema: {
          type: "object" as const,
          properties: {
            task_id: { type: "string", description: "The task ID to update" },
            content: { type: "string", description: "New task title/content" },
            description: { type: "string", description: "New description" },
            due_string: { type: "string", description: "New due date as natural language" },
            priority: { type: "number", description: "New priority: 1 (normal) to 4 (urgent)" },
            labels: { type: "array", items: { type: "string" }, description: "New list of label names" },
          },
          required: ["task_id"],
        },
      },
      {
        name: "todoist_close_task",
        description: "Mark a task as completed by ID.",
        input_schema: {
          type: "object" as const,
          properties: {
            task_id: { type: "string", description: "The task ID to complete" },
          },
          required: ["task_id"],
        },
      },
      {
        name: "todoist_delete_task",
        description: "Delete a task by ID.",
        input_schema: {
          type: "object" as const,
          properties: {
            task_id: { type: "string", description: "The task ID to delete" },
          },
          required: ["task_id"],
        },
      },
      {
        name: "todoist_get_projects",
        description: "Get all projects in Todoist.",
        input_schema: {
          type: "object" as const,
          properties: {},
          required: [],
        },
      },
      {
        name: "todoist_create_project",
        description: "Create a new project in Todoist.",
        input_schema: {
          type: "object" as const,
          properties: {
            name: { type: "string", description: "Project name" },
            color: { type: "string", description: "Color name, e.g. 'red', 'blue', 'green'" },
            is_favorite: { type: "boolean", description: "Mark as favorite" },
          },
          required: ["name"],
        },
      },
    ],
    handlers: {
      todoist_get_tasks: async (input: Record<string, unknown>) => {
        try {
          const params = new URLSearchParams();
          if (input.project_id) params.append("project_id", input.project_id as string);
          if (input.label) params.append("label", input.label as string);
          if (input.filter) params.append("filter", input.filter as string);

          const url = `${BASE_URL}/tasks${params.toString() ? "?" + params.toString() : ""}`;
          const res = await fetch(url, { headers: getHeaders() });
          if (!res.ok) return `Error: ${res.status} ${await res.text()}`;

          const data = await res.json() as any;
          const tasks = data.results ?? data;
          if (!tasks.length) return "No tasks found.";

          return tasks.map((t: any) =>
            `[${t.id}] ${t.content}${t.due ? ` (due: ${t.due.string})` : ""}${t.priority > 1 ? ` [p${5 - t.priority}]` : ""}${t.description ? `\n  ${t.description}` : ""}`
          ).join("\n");
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },

      todoist_create_task: async (input: Record<string, unknown>) => {
        try {
          const body: Record<string, unknown> = { content: input.content };
          if (input.description) body.description = input.description;
          if (input.project_id) body.project_id = input.project_id;
          if (input.due_string) body.due_string = input.due_string;
          if (input.priority) body.priority = input.priority;
          if (input.labels) body.labels = input.labels;

          const res = await fetch(`${BASE_URL}/tasks`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify(body),
          });
          if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
          const task = await res.json() as any;
          return `Task created: [${task.id}] ${task.content}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },

      todoist_update_task: async (input: Record<string, unknown>) => {
        try {
          const { task_id, ...fields } = input;
          const body: Record<string, unknown> = {};
          if (fields.content) body.content = fields.content;
          if (fields.description) body.description = fields.description;
          if (fields.due_string) body.due_string = fields.due_string;
          if (fields.priority) body.priority = fields.priority;
          if (fields.labels) body.labels = fields.labels;

          const res = await fetch(`${BASE_URL}/tasks/${task_id}`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify(body),
          });
          if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
          const task = await res.json() as any;
          return `Task updated: [${task.id}] ${task.content}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },

      todoist_close_task: async (input: Record<string, unknown>) => {
        try {
          const res = await fetch(`${BASE_URL}/tasks/${input.task_id}/close`, {
            method: "POST",
            headers: getHeaders(),
          });
          if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
          return `Task ${input.task_id} marked as complete.`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },

      todoist_delete_task: async (input: Record<string, unknown>) => {
        try {
          const res = await fetch(`${BASE_URL}/tasks/${input.task_id}`, {
            method: "DELETE",
            headers: getHeaders(),
          });
          if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
          return `Task ${input.task_id} deleted.`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },

      todoist_get_projects: async (_input: Record<string, unknown>) => {
        try {
          const res = await fetch(`${BASE_URL}/projects`, { headers: getHeaders() });
          if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
          const data = await res.json() as any;
          const projects = data.results ?? data;
          if (!projects.length) return "No projects found.";
          return projects.map((p: any) => `[${p.id}] ${p.name}${p.is_favorite ? " ★" : ""}`).join("\n");
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },

      todoist_create_project: async (input: Record<string, unknown>) => {
        try {
          const body: Record<string, unknown> = { name: input.name };
          if (input.color) body.color = input.color;
          if (input.is_favorite !== undefined) body.is_favorite = input.is_favorite;

          const res = await fetch(`${BASE_URL}/projects`, {
            method: "POST",
            headers: getHeaders(),
            body: JSON.stringify(body),
          });
          if (!res.ok) return `Error: ${res.status} ${await res.text()}`;
          const project = await res.json() as any;
          return `Project created: [${project.id}] ${project.name}`;
        } catch (e: any) {
          return `Error: ${e.message}`;
        }
      },
    },
  };
}
