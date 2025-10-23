import type { VercelRequest, VercelResponse } from "@vercel/node";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const NUTRITIONIX_APP_ID = process.env.NUTRITIONIX_APP_ID!;
const NUTRITIONIX_APP_KEY = process.env.NUTRITIONIX_APP_KEY!;

/* ---------- helpers ---------- */
const safeNum = (v: any) => (Number.isFinite(+v) ? Math.round(+v) : 0);
const buildCompleteNutrition = (d: any = {}) => ({
  protein: safeNum(d.protein),
  calories: safeNum(d.calories),
  carbs: safeNum(d.carbs ?? d.carbohydrates),
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

/* ---------- Response Types ---------- */
interface NutritionixResponse {
  foods?: {
    nf_calories?: number;
    nf_protein?: number;
    nf_total_carbohydrate?: number;
    nf_total_fat?: number;
    nf_sodium?: number;
    nf_dietary_fiber?: number;
  }[];
}

interface OpenFoodFactsResponse {
  products?: {
    nutriments?: {
      ["energy-kcal_100g"]?: number;
      proteins_100g?: number;
      carbohydrates_100g?: number;
      fat_100g?: number;
      sodium_100g?: number;
      fiber_100g?: number;
    };
  }[];
}

interface OpenAIResponse {
  choices?: { message?: { content?: string } }[];
}

/* ---------- Nutritionix ---------- */
async function fetchNutritionix(query: string) {
  try {
    const resp = await fetch("https://trackapi.nutritionix.com/v2/natural/nutrients", {
      method: "POST",
      headers: {
        "x-app-id": NUTRITIONIX_APP_ID,
        "x-app-key": NUTRITIONIX_APP_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as NutritionixResponse; // ✅ explicit cast
    const item = data.foods?.[0];
    if (!item) return null;

    return {
      source: "Nutritionix",
      calories: safeNum(item.nf_calories),
      protein: safeNum(item.nf_protein),
      carbs: safeNum(item.nf_total_carbohydrate),
      fat: safeNum(item.nf_total_fat),
      sodium: safeNum(item.nf_sodium),
      fiber: safeNum(item.nf_dietary_fiber),
    };
  } catch {
    return null;
  }
}

/* ---------- OpenFoodFacts ---------- */
async function fetchOpenFoodFacts(query: string) {
  try {
    const resp = await fetch(
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(
        query
      )}&search_simple=1&json=1&page_size=1`
    );
    if (!resp.ok) return null;

    const data = (await resp.json()) as OpenFoodFactsResponse; // ✅ explicit cast
    const p = data.products?.[0];
    const n = p?.nutriments || {};

    if (!n["energy-kcal_100g"]) return null;

    return {
      source: "OpenFoodFacts",
      calories: safeNum(n["energy-kcal_100g"]),
      protein: safeNum(n.proteins_100g),
      carbs: safeNum(n.carbohydrates_100g),
      fat: safeNum(n.fat_100g),
      sodium: safeNum(n.sodium_100g ? n.sodium_100g * 1000 : 0),
      fiber: safeNum(n.fiber_100g),
    };
  } catch {
    return null;
  }
}

/* ---------- main handler ---------- */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { description = "", photoUrl } = req.body || {};
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OpenAI key" });

  try {
    // --- Stage 1: identify foods & portions ---
    const stage1Prompt = `
You are a nutrition analyst. Identify every edible item and estimate portion.
Return STRICT JSON:

{
  "foods": [
    {"name": "string", "portion_text": "e.g. 150 g or 1 cup", "confidence": 0.0-1.0}
  ],
  "summary": "short human summary"
}

Do not calculate calories or macros.
`;

    const stage1Msgs: any[] = [
      { role: "system", content: stage1Prompt },
      { role: "user", content: description || "(no description)" },
    ];

    if (photoUrl) {
      stage1Msgs.push({
        role: "user",
        content: [
          { type: "text", text: "Analyze this image as part of the meal." },
          { type: "image_url", image_url: { url: photoUrl } },
        ],
      });
    }

    const stage1Resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: stage1Msgs, temperature: 0 }),
    });

    const stage1Data = (await stage1Resp.json()) as OpenAIResponse; // ✅ explicit cast
    const stage1Content = stage1Data.choices?.[0]?.message?.content ?? "";
    const stage1 = extractJson(stage1Content) ?? { foods: [] as { name: string; portion_text: string }[] };

    // --- Stage 1.5: gather verified macros from APIs ---
    const foodList = stage1.foods?.map((f) => `${f.portion_text || ""} ${f.name}`) || [];
    const verified = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0 };

    for (const item of foodList) {
      const nx = await fetchNutritionix(item);
      const off = !nx ? await fetchOpenFoodFacts(item) : null;
      const source = nx || off;
      if (source) {
        verified.calories += source.calories || 0;
        verified.protein += source.protein || 0;
        verified.carbs += source.carbs || 0;
        verified.fat += source.fat || 0;
        verified.fiber += source.fiber || 0;
        verified.sodium += source.sodium || 0;
      }
    }

    // --- Stage 2: AI refinement ---
    const stage2Prompt = `
You are an expert dietitian. Given the verified macros from databases and meal items, fill missing micronutrients realistically.
If unknown, use 0. Double-check that totals are realistic (not >2000 kcal per meal).
Return JSON only with:
protein (g), calories (kcal), carbs (g), fat (g),
vitaminA (µg), vitaminC (mg), vitaminD (µg), vitaminE (mg), vitaminK (µg), vitaminB12 (µg),
iron (mg), calcium (mg), magnesium (mg), zinc (mg),
water (ml), sodium (mg), potassium (mg), chloride (mg), fiber (g).

Database verified totals:
${JSON.stringify(verified)}

Foods:
${JSON.stringify(foodList)}
`;

    const stage2Resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: stage2Prompt }],
        temperature: 0,
        max_tokens: 800,
      }),
    });

    const stage2Data = (await stage2Resp.json()) as OpenAIResponse; // ✅ explicit cast
    const stage2Content = stage2Data.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(stage2Content);

    if (parsed) return res.status(200).json(buildCompleteNutrition(parsed));
    return res.status(500).json({ error: "Failed to parse nutrition JSON" });
  } catch (err: any) {
    console.error("❌ analyze-meal error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}
