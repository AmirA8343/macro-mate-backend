// /api/test.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const NUTRITIONIX_APP_ID = process.env.NUTRITIONIX_APP_ID!;
const NUTRITIONIX_APP_KEY = process.env.NUTRITIONIX_APP_KEY!;

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */
const safeNum = (v: any) => (Number.isFinite(+v) ? Math.round(+v) : 0);
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

const buildCompleteNutrition = (d: any = {}) => ({
  protein: safeNum(d.protein),
  calories: safeNum(d.calories),
  carbs: safeNum(d.carbs),
  fat: safeNum(d.fat),
  vitaminA: safeNum(d.vitaminA),
  vitaminC: safeNum(d.vitaminC),
  vitaminD: safeNum(d.vitaminD),
  vitaminE: safeNum(d.vitaminE),
  vitaminK: safeNum(d.vitaminK),
  vitaminB12: safeNum(d.vitaminB12),
  iron: safeNum(d.iron),
  calcium: safeNum(d.calcium),
  magnesium: safeNum(d.magnesium),
  zinc: safeNum(d.zinc),
  water: safeNum(d.water),
  sodium: safeNum(d.sodium),
  potassium: safeNum(d.potassium),
  chloride: safeNum(d.chloride),
  fiber: safeNum(d.fiber),
});

const extractJson = (text: string) => {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) try { return JSON.parse(fence[1]); } catch {}
  const raw = text.match(/\{[\s\S]*\}/);
  if (raw) try { return JSON.parse(raw[0]); } catch {}
  return null;
};

/* -------------------------------------------------------------------------- */
/*                             Ingredient Extraction                           */
/* -------------------------------------------------------------------------- */
async function identifyIngredients(description: string) {
  const prompt = `
You are a nutrition analyst. Identify all ingredients and their quantities from the description.
Return JSON only in this format:
{
  "ingredients": [{"name": "grilled chicken breast", "amount": "200 g"}, {"name": "white rice", "amount": "150 g"}],
  "summary": "short human summary"
}
If a quantity is not given, estimate a realistic default (e.g., 150 g, 1 tbsp, 1 slice).
`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: description },
      ],
      temperature: 0,
    }),
  });

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  const parsed = extractJson(content);
  return parsed?.ingredients ?? [];
}

/* -------------------------------------------------------------------------- */
/*                           Nutrition Calculation AI                          */
/* -------------------------------------------------------------------------- */
async function calculateNutrition(ingredients: any[]) {
  const prompt = `
You are an expert dietitian.
Estimate the nutrition facts for the entire meal based on these measured ingredients.

Ingredients (with amounts):
${JSON.stringify(ingredients, null, 2)}

Return ONLY JSON like this:
{
  "protein": 0, "calories": 0, "carbs": 0, "fat": 0,
  "vitaminA": 0, "vitaminC": 0, "vitaminD": 0, "vitaminE": 0, "vitaminK": 0, "vitaminB12": 0,
  "iron": 0, "calcium": 0, "magnesium": 0, "zinc": 0,
  "water": 0, "sodium": 0, "potassium": 0, "chloride": 0, "fiber": 0
}

Make sure totals are realistic for one meal:
- Calories: 200–1100 kcal
- Protein: 5–70 g
- Carbs: 5–150 g
- Fat: 5–60 g
- Sodium: 100–1500 mg
- Fiber: 0–20 g
`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "system", content: prompt }],
      temperature: 0,
      max_tokens: 800,
    }),
  });

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  const parsed = extractJson(content);
  return parsed || {};
}

/* -------------------------------------------------------------------------- */
/*                                   Handler                                  */
/* -------------------------------------------------------------------------- */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { description = "" } = req.body || {};

  try {
    const ingredients = await identifyIngredients(description);
    const nutrition = await calculateNutrition(ingredients);

    const merged = {
      ...buildCompleteNutrition(nutrition),
      ingredients,
      source: "AI with portion-based reasoning",
    };

    return res.status(200).json(merged);
  } catch (err: any) {
    console.error("❌ Error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}
