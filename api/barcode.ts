// api/barcode.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NUTRITIONIX_APP_ID = process.env.NUTRITIONIX_APP_ID;
const NUTRITIONIX_APP_KEY = process.env.NUTRITIONIX_APP_KEY;

function safeNum(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function buildCompleteNutrition(data: any = {}) {
  return {
    name: data.name || "Unknown",
    brand: data.brand || "",
    servingSize: data.servingSize || "",
    source: data.source || "unknown",

    protein: safeNum(data.protein),
    calories: safeNum(data.calories),
    carbs: safeNum(data.carbs ?? data.carbohydrates),
    fat: safeNum(data.fat),

    vitaminA: safeNum(data.vitaminA),
    vitaminC: safeNum(data.vitaminC),
    vitaminD: safeNum(data.vitaminD),
    vitaminE: safeNum(data.vitaminE),
    vitaminK: safeNum(data.vitaminK),
    vitaminB12: safeNum(data.vitaminB12),
    iron: safeNum(data.iron),
    calcium: safeNum(data.calcium),
    magnesium: safeNum(data.magnesium),
    zinc: safeNum(data.zinc),

    water: safeNum(data.water),
    sodium: safeNum(data.sodium),
    potassium: safeNum(data.potassium),
    chloride: safeNum(data.chloride),

    fiber: safeNum(data.fiber),
  };
}

function extractJsonFromText(text: string): any | null {
  if (!text) return null;

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {}
  }

  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {}
  }

  return null;
}

// 🧠 --- MAIN HANDLER ---
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const barcode = req.query.barcode || req.body?.barcode;
  if (!barcode) {
    return res.status(400).json({ error: "Missing barcode parameter" });
  }

  try {
    // 1️⃣ Try OpenFoodFacts
    const offResp = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`);
    const offData = await offResp.json();

    if (offData?.product) {
      const p = offData.product;
      const nutrients = p.nutriments || {};
      const fromOpenFoodFacts = {
        name: p.product_name || "",
        brand: p.brands || "",
        servingSize: p.serving_size || "",
        source: "OpenFoodFacts",
        calories: nutrients["energy-kcal_100g"],
        protein: nutrients.proteins_100g,
        carbs: nutrients.carbohydrates_100g,
        fat: nutrients.fat_100g,
        fiber: nutrients.fiber_100g,
        sugar: nutrients.sugars_100g,
        sodium: nutrients.sodium_100g ? nutrients.sodium_100g * 1000 : 0,
      };

      // Return immediately if we got solid data
      if (fromOpenFoodFacts.calories || fromOpenFoodFacts.protein || fromOpenFoodFacts.carbs) {
        return res.status(200).json(buildCompleteNutrition(fromOpenFoodFacts));
      }
    }

    // 2️⃣ Fallback to Nutritionix
    if (NUTRITIONIX_APP_ID && NUTRITIONIX_APP_KEY) {
      const nutriResp = await fetch("https://trackapi.nutritionix.com/v2/search/item", {
        method: "POST",
        headers: {
          "x-app-id": NUTRITIONIX_APP_ID,
          "x-app-key": NUTRITIONIX_APP_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ upc: barcode }),
      });

      if (nutriResp.ok) {
        const nutriData = await nutriResp.json();
        const item = nutriData?.foods?.[0];
        if (item) {
          const fromNutritionix = {
            name: item.food_name,
            brand: item.brand_name,
            servingSize: `${item.serving_qty} ${item.serving_unit}`,
            source: "Nutritionix",
            calories: item.nf_calories,
            protein: item.nf_protein,
            carbs: item.nf_total_carbohydrate,
            fat: item.nf_total_fat,
            fiber: item.nf_dietary_fiber,
            sugar: item.nf_sugars,
            sodium: item.nf_sodium,
          };
          return res.status(200).json(buildCompleteNutrition(fromNutritionix));
        }
      }
    }

    // 3️⃣ Final fallback — GPT-4o reasoning
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OpenAI API key" });
    }

    const systemPrompt = `You are a nutrition expert. Given a barcode number, deduce the most likely packaged food and provide estimated nutrition per 100g or per serving in JSON.
    Return only JSON with keys: name, brand, servingSize, calories, protein, carbs, fat, fiber, sugar, sodium, source.
    Use reasonable estimates if not certain, but never return text outside JSON.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Barcode: ${barcode}` },
    ];

    const gptResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.3,
        max_tokens: 400,
      }),
    });

    const gptJson = await gptResp.json();
    const content: string = gptJson.choices?.[0]?.message?.content ?? "";
    console.log("🔍 GPT output:", content.slice(0, 200));

    const parsed = extractJsonFromText(content);
    if (parsed) {
      parsed.source = parsed.source || "GPT-4o";
      return res.status(200).json(buildCompleteNutrition(parsed));
    }

    return res.status(500).json({ error: "Failed to parse GPT nutrition JSON" });
  } catch (err: any) {
    console.error("❌ Barcode API failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
