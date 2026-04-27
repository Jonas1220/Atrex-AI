interface PluginContext {
  getSecret: (key: string) => string | null;
}

export default function setup(ctx: PluginContext) {
  return {
    tools: [
      {
        name: "notion_log_meal",
        description: "Log a meal to Notion food tracker. Updates existing day's entry or creates new one.",
        input_schema: {
          type: "object" as const,
          properties: {
            meal_description: { type: "string", description: "What the meal was (e.g. '3 eggs, rice, veggies')" },
            protein_g: { type: "number", description: "Protein in grams" },
            carbs_g: { type: "number", description: "Carbs in grams" },
            fats_g: { type: "number", description: "Fats in grams" },
            calories: { type: "number", description: "Total calories" },
            date: { type: "string", description: "Date in YYYY-MM-DD format (defaults to today)" }
          },
          required: ["meal_description", "protein_g", "carbs_g", "fats_g", "calories"]
        }
      },
      {
        name: "notion_update_weight",
        description: "Log weight and/or body fat percentage for a specific day",
        input_schema: {
          type: "object" as const,
          properties: {
            weight_kg: { type: "number", description: "Weight in kg" },
            body_fat_percent: { type: "number", description: "Body fat percentage" },
            date: { type: "string", description: "Date in YYYY-MM-DD format (defaults to today)" }
          },
          required: []
        }
      },
      {
        name: "notion_get_daily_macros",
        description: "Get the current day's macro totals from Notion",
        input_schema: {
          type: "object" as const,
          properties: {
            date: { type: "string", description: "Date in YYYY-MM-DD format (defaults to today)" }
          },
          required: []
        }
      }
    ],
    handlers: {
      notion_log_meal: async (input: Record<string, unknown>) => {
        const apiKey = ctx.getSecret("NOTION_API_KEY");
        if (!apiKey) return "Error: NOTION_API_KEY not set.";

        const databaseId = "34e7756dc60280828828e2a5218a77ed";
        const date = (input.date as string) || new Date().toISOString().split('T')[0];
        const mealDesc = input.meal_description as string;
        const protein = input.protein_g as number;
        const carbs = input.carbs_g as number;
        const fats = input.fats_g as number;
        const calories = input.calories as number;

        // First, find existing entry for this date
        const queryRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            filter: {
              property: "name",
              date: { equals: date }
            }
          })
        });

        const queryData = await queryRes.json() as any;
        const existingPage = queryData.results?.[0];

        if (existingPage) {
          // Update existing page: append meal to Meals property
          const pageId = existingPage.id;
          const currentMeals = existingPage.properties.Meals?.rich_text?.[0]?.plain_text || "";
          const newMeals = currentMeals ? `${currentMeals}\n${mealDesc}` : mealDesc;

          // Get current totals
          const currentProteins = existingPage.properties.total_proteins?.number || 0;
          const currentCarbs = existingPage.properties.total_carbs?.number || 0;
          const currentFats = existingPage.properties.total_fats?.number || 0;
          const currentCals = existingPage.properties.total_calories?.number || 0;

          // Update page with new meal and totals
          await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
            method: "PATCH",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              properties: {
                Meals: {
                  rich_text: [{ type: "text", text: { content: newMeals } }]
                },
                total_proteins: { number: currentProteins + protein },
                total_carbs: { number: currentCarbs + carbs },
                total_fats: { number: currentFats + fats },
                total_calories: { number: currentCals + calories }
              }
            })
          });

          const newTotalProteins = currentProteins + protein;
          const newTotalCarbs = currentCarbs + carbs;
          const newTotalFats = currentFats + fats;
          const newTotalCals = currentCals + calories;

          return `Meal logged and totals updated. Daily macros: ${newTotalProteins}g protein, ${newTotalCarbs}g carbs, ${newTotalFats}g fats, ${newTotalCals} cal`;
        } else {
          // Create new page
          await fetch(`https://api.notion.com/v1/pages`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              parent: { database_id: databaseId },
              properties: {
                name: { title: [{ type: "text", text: { content: date } }] },
                Meals: { rich_text: [{ type: "text", text: { content: mealDesc } }] },
                total_proteins: { number: protein },
                total_carbs: { number: carbs },
                total_fats: { number: fats },
                total_calories: { number: calories }
              }
            })
          });

          return `Meal logged and totals updated. Daily macros: ${protein}g protein, ${carbs}g carbs, ${fats}g fats, ${calories} cal`;
        }
      },

      notion_update_weight: async (input: Record<string, unknown>) => {
        const apiKey = ctx.getSecret("NOTION_API_KEY");
        if (!apiKey) return "Error: NOTION_API_KEY not set.";

        const databaseId = "34e7756dc60280828828e2a5218a77ed";
        const date = (input.date as string) || new Date().toISOString().split('T')[0];
        const weight = input.weight_kg as number | undefined;
        const bodyFat = input.body_fat_percent as number | undefined;

        if (!weight && !bodyFat) return "Error: Provide at least weight_kg or body_fat_percent.";

        // Find existing entry for this date
        const queryRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            filter: {
              property: "name",
              date: { equals: date }
            }
          })
        });

        const queryData = await queryRes.json() as any;
        const existingPage = queryData.results?.[0];
        const properties: any = {};

        if (weight) properties.weight = { number: weight };
        if (bodyFat) properties["body fat"] = { number: bodyFat };

        if (existingPage) {
          // Update existing page
          await fetch(`https://api.notion.com/v1/pages/${existingPage.id}`, {
            method: "PATCH",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ properties })
          });
        } else {
          // Create new page
          properties.name = { title: [{ type: "text", text: { content: date } }] };
          await fetch(`https://api.notion.com/v1/pages`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              parent: { database_id: databaseId },
              properties
            })
          });
        }

        const logged = [];
        if (weight) logged.push(`${weight}kg`);
        if (bodyFat) logged.push(`${bodyFat}% body fat`);
        return `Logged ${logged.join(" + ")} for ${date}`;
      },

      notion_get_daily_macros: async (input: Record<string, unknown>) => {
        const apiKey = ctx.getSecret("NOTION_API_KEY");
        if (!apiKey) return "Error: NOTION_API_KEY not set.";

        const databaseId = "34e7756dc60280828828e2a5218a77ed";
        const date = (input.date as string) || new Date().toISOString().split('T')[0];

        const queryRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            filter: {
              property: "name",
              date: { equals: date }
            }
          })
        });

        const queryData = await queryRes.json() as any;
        const page = queryData.results?.[0];

        if (!page) return `No entry found for ${date}`;

        const protein = page.properties.total_proteins?.number || 0;
        const carbs = page.properties.total_carbs?.number || 0;
        const fats = page.properties.total_fats?.number || 0;
        const calories = page.properties.total_calories?.number || 0;

        return `Daily macros for ${date}: ${protein}g protein, ${carbs}g carbs, ${fats}g fats, ${calories} cal`;
      }
    }
  };
}
