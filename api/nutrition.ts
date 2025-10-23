import type { VercelRequest, VercelResponse } from "@vercel/node";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const NUTRITIONIX_APP_ID = process.env.NUTRITIONIX_APP_ID!;
const NUTRITIONIX_APP_KEY = process.env.NUTRITIONIX_APP_KEY!;

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------------- */
/*                               Type Definitions                             */
/* -------------------------------------------------------------------------- */
interface NutritionixInstantResponse {
  branded?: { nix_item_id?: string; food_name?: string }[];
}

interface NutritionixItemResponse {
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

/* -------------------------------------------------------------------------- */
/*                             Nutritionix Instant                            */
/* -------------------------------------------------------------------------- */
async function fetchNutritionixInstant(query: string) {
  try {
    const resp = await fetch("https://trackapi.nutritionix.com/v2/search/instant", {
      method: "POST",
      headers: {
        "x-app-id": NUTRITIONIX_APP_ID,
        "x-app-key": NUTRITIONIX_APP_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) return null;

    const data = (await resp.json()) as NutritionixInstantResponse;
    const branded = data?.branded?.[0];
    if (!branded?.nix_item_id) return null;

    const detailResp = await fetch(`https://trackapi.nutritionix.com/v2/search/item?nix_item_id=${branded.nix_item_id}`, {
      headers: {
        "x-app-id": NUTRITIONIX_APP_ID,
        "x-app-key": NUTRITIONIX_APP_KEY,
      },
    });
    if (!detailResp.ok) return null;

    const detailData = (await detailResp.json()) as NutritionixItemResponse;
    const item = detailData?.foods?.[0];
    if (!item) return null;

    return {
      source: "Nutritionix Branded",
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

/* -------------------------------------------------------------------------- */
/*                             Nutritionix Natural                            */
/* -------------------------------------------------------------------------- */
async function fetchNutritionixNatural(query: string) {
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

    const data = (await resp.json()) as NutritionixItemResponse;
    const item = data?.foods?.[0];
    if (!item) return null;

    return {
      source: "Nutritionix Natural",
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

/* -------------------------------------------------------------------------- */
/*                               OpenFoodFacts                                */
/* -------------------------------------------------------------------------- */
async function fetchOpenFoodFacts(query: string) {
  try {
    const resp = await fetch(
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&json=1&page_size=1`
    );
    if (!resp.ok) return null;

    const data = (await resp.json()) as OpenFoodFactsResponse;
    const p = data?.products?.[0];
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

/* -------------------------------------------------------------------------- */
/*                                  Handler                                   */
/* -------------------------------------------------------------------------- */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { description = "", photoUrl } = req.body || {};
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OpenAI key" });

  try {
    /* ---------- Stage 1: Identify foods (GPT-4o Vision) ---------- */
    const stage1Prompt = `
You are a nutrition analyst. Identify all edible items and portion sizes from the given text and image.
Return STRICT JSON only:
{
  "foods": [{"name":"string","portion_text":"e.g. 150 g or 1 cup"}],
  "summary": "short human summary"
}
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
      body: JSON.stringify({ model: "gpt-4o", messages: stage1Msgs, temperature: 0 }),
    });

    const stage1Data = (await stage1Resp.json()) as OpenAIResponse;
    const stage1Content = stage1Data?.choices?.[0]?.message?.content ?? "";
    const stage1 = extractJson(stage1Content) ?? { foods: [] };

    /* ---------- Stage 1.5: Manager (databases) ---------- */
    const foodList = stage1.foods?.map((f: any) => `${f.portion_text || ""} ${f.name}`) || [];
    const verified = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0 };

    for (const item of foodList) {
      const branded = await fetchNutritionixInstant(item);
      const generic = !branded ? await fetchNutritionixNatural(item) : null;
      const off = !branded && !generic ? await fetchOpenFoodFacts(item) : null;
      const source = branded || generic || off;

      if (source) {
        verified.calories += source.calories || 0;
        verified.protein += source.protein || 0;
        verified.carbs += source.carbs || 0;
        verified.fat += source.fat || 0;
        verified.fiber += source.fiber || 0;
        verified.sodium += source.sodium || 0;
      }
    }

    /* ---------- Stage 2: AI Refinement ---------- */
    const stage2Prompt = `
You are an expert dietitian. Given verified database totals and the food list, fill missing micronutrients realistically.
Ensure totals are plausible (<2000 kcal per meal). Respond with one JSON only:
{
  "protein":0,"calories":0,"carbs":0,"fat":0,
  "vitaminA":0,"vitaminC":0,"vitaminD":0,"vitaminE":0,"vitaminK":0,"vitaminB12":0,
  "iron":0,"calcium":0,"magnesium":0,"zinc":0,
  "water":0,"sodium":0,"potassium":0,"chloride":0,"fiber":0
}

Database verified totals:
${JSON.stringify(verified)}

Foods:
${JSON.stringify(foodList)}
`;

    const stage2Resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "system", content: stage2Prompt }],
        temperature: 0,
        max_tokens: 800,
      }),
    });

    const stage2Data = (await stage2Resp.json()) as OpenAIResponse;
    const stage2Content = stage2Data?.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(stage2Content);

    if (parsed) return res.status(200).json(buildCompleteNutrition(parsed));
    return res.status(500).json({ error: "Failed to parse nutrition JSON" });
  } catch (err: any) {
    console.error("❌ analyze-meal error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}
