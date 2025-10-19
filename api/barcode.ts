import type { VercelRequest, VercelResponse } from "@vercel/node";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NUTRITIONIX_APP_ID = process.env.NUTRITIONIX_APP_ID;
const NUTRITIONIX_APP_KEY = process.env.NUTRITIONIX_APP_KEY;

/* ---------------------------- Shared type alias ---------------------------- */
type ProductType = "liquid" | "solid" | "portion" | "unknown" | "non_food";

/* ----------------------------- helpers: numbers ---------------------------- */
function safeNum(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function scalePerServing(valuePer100: any, servingSize: string | undefined) {
  const n = Number(valuePer100);
  if (!Number.isFinite(n) || !servingSize) return safeNum(valuePer100);
  const m = servingSize.match(/([\d.]+)\s*(ml|g)\b/i);
  if (!m) return safeNum(valuePer100);
  const amount = parseFloat(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return safeNum(valuePer100);
  return Math.round((n * amount) / 100);
}

/* -------------------------------------------------------------------------- */
/*                             🧠 EDIBILITY GUARD                             */
/* -------------------------------------------------------------------------- */

const BLOCK_COSMETIC = [
  "sunscreen","spf","moisturizer","cleanser","serum","retinol","niacinamide",
  "hyaluronic","cream","lotion","ointment","balm","mask","peel","exfoliant",
  "skin","face","body","shampoo","conditioner","hair","deodorant","makeup",
  "cosmetic","fragrance","perfume","aftershave","lipstick","lip balm"
];
const BLOCK_HOUSEHOLD = [
  "detergent","bleach","disinfectant","cleaner","laundry","fabric softener",
  "air freshener","insecticide","repellent","trash bag","foil","zip bag"
];
const BLOCK_CONTAINER = [
  "refillable","reusable","stainless","plastic","metal","glass","flask","tumbler",
  "thermos","bottle","container","jar","lid"
];
const BLOCK_CHEMICAL = [
  "benzene","sulfate","hydroxide","chloride","titanium dioxide",
  "zinc oxide","silicone","polyethylene","polypropyl","acrylate","copolymer"
];
const PET_NONFOOD = ["cat litter","dog shampoo","flea","tick collar"];
const FOOD_HINTS = [
  "sugar","salt","wheat","rice","milk","cream","butter","egg","yeast","cocoa",
  "chocolate","vanilla","flour","soy","peanut","almond","hazelnut","olive",
  "sunflower","garlic","onion","tomato","apple","banana","strawberry","meat",
  "fish","chicken","pasta","snack","chips","drink","bar","sauce","oil","bread"
];
const BEVERAGE_HINTS = [
  "drink","juice","water","soda","cola","energy drink","sports drink","tea",
  "coffee","smoothie","beer","wine"
];

function includesAny(s: string, arr: string[]) {
  const x = s.toLowerCase();
  return arr.some(w => x.includes(w));
}

function plausibleNutrition(n: any): boolean {
  if (!n) return false;
  const vals = [
    Number(n["energy-kcal_100g"]),
    Number(n.proteins_100g),
    Number(n.carbohydrates_100g),
    Number(n.fat_100g)
  ].filter(Number.isFinite);
  return vals.some(v => v > 0);
}

function isReusableContainer(name: string, categories: string) {
  const hay = `${name} ${categories}`.toLowerCase();
  if (includesAny(hay, BLOCK_CONTAINER) && !includesAny(hay, ["bottled water","spring water","juice"])) {
    return true;
  }
  return false;
}

function guardEdible({
  name = "",
  brand = "",
  categories = "",
  servingSize = "",
  nutriments = undefined,
}: {
  name?: string;
  brand?: string;
  categories?: string;
  servingSize?: string;
  nutriments?: any;
}): { isEdible: boolean; reason: string } {
  const hay = [name, brand, categories, servingSize].join(" ").toLowerCase();

  if (includesAny(hay, PET_NONFOOD)) return { isEdible: false, reason: "pet product" };
  if (includesAny(hay, BLOCK_HOUSEHOLD) || includesAny(hay, BLOCK_CHEMICAL))
    return { isEdible: false, reason: "household/chemical product" };
  if (isReusableContainer(name, categories)) return { isEdible: false, reason: "reusable container" };

  // Cosmetics are blocked only if no food clues exist
  if (includesAny(hay, BLOCK_COSMETIC) && !includesAny(hay, FOOD_HINTS) && !includesAny(hay, BEVERAGE_HINTS))
    return { isEdible: false, reason: "cosmetic product" };

  // Build a confidence score
  let score = 0;
  if (includesAny(hay, BEVERAGE_HINTS)) score += 2;
  if (includesAny(hay, FOOD_HINTS)) score += 2;
  if (plausibleNutrition(nutriments)) score += 3;
  if (includesAny(hay, ["bottled water","spring water","mineral water"])) score += 2;
  if (hay.includes("oil") && includesAny(hay, ["skin","hair","body","face"])) score -= 3;
  if (/\bspf\s?\d{1,3}\b/.test(hay)) score -= 4;

  if (score >= 2) return { isEdible: true, reason: "sufficient edible evidence" };
  return { isEdible: false, reason: "insufficient edible evidence" };
}

/* ------------------------------ helpers: output ----------------------------- */
function buildCompleteNutrition(data: any = {}) {
  return {
    name: data.name || "Unknown",
    brand: data.brand || "",
    source: data.source || "unknown",
    type: data.type || "unknown",
    servingSize: data.servingSize || "",
    baseAmount: safeNum(data.baseAmount),
    baseUnit:
      data.baseUnit === "ml" || data.baseUnit === "g" || data.baseUnit === "portion"
        ? data.baseUnit
        : "g",
    calories: safeNum(data.calories),
    protein: safeNum(data.protein),
    carbs: safeNum(data.carbs ?? data.carbohydrates),
    fat: safeNum(data.fat),
    fiber: safeNum(data.fiber),
    sugar: safeNum(data.sugar),
    sodium: safeNum(data.sodium),
  };
}

function extractJsonFromText(text: string): any | null {
  if (!text) return null;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch {}
  }
  return null;
}

/* --------------------------------- handler -------------------------------- */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const barcode = (req.query.barcode || (req.body as any)?.barcode)?.toString();
  if (!barcode) return res.status(400).json({ error: "Missing barcode parameter" });

  try {
    /* ------------------------------- 1) OpenFoodFacts ------------------------------ */
    const offResp = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`);
    if (offResp.ok) {
      const offData: any = await offResp.json(); // <-- cast to any to satisfy TS
      const p = offData?.product;
      if (p) {
        const name = p.product_name || "";
        const brand = p.brands || "";
        const servingRaw = p.serving_size || "";
        const categoriesText = (p.categories_tags || []).join(", ");
        const n = p.nutriments || {};

        const guard = guardEdible({ name, brand, categories: categoriesText, servingSize: servingRaw, nutriments: n });
        if (!guard.isEdible)
          return res.status(200).json({ error: "non_food", message: guard.reason });

        const caloriesPer100 = n["energy-kcal_100g"];
        const proteinPer100 = n.proteins_100g;
        const carbsPer100 = n.carbohydrates_100g;
        const fatPer100 = n.fat_100g;
        const fiberPer100 = n.fiber_100g;
        const sugarsPer100 = n.sugars_100g;
        const sodiumPer100Mg = Number.isFinite(n.sodium_100g)
          ? n.sodium_100g * 1000
          : undefined;

        const servingSizeOut = servingRaw || "100 g";
        const baseUnit = servingRaw.includes("ml") ? "ml" : "g";
        const baseAmount = safeNum(servingSizeOut.match(/[\d.]+/)?.[0]) || 100;
        const shouldScale = baseUnit === "ml" || baseUnit === "g";

        const fromOpenFoodFacts = {
          name,
          brand,
          source: "OpenFoodFacts",
          type: baseUnit === "ml" ? "liquid" : "solid",
          servingSize: servingSizeOut,
          baseAmount,
          baseUnit,
          calories: shouldScale ? scalePerServing(caloriesPer100, servingSizeOut) : safeNum(caloriesPer100),
          protein: shouldScale ? scalePerServing(proteinPer100, servingSizeOut) : safeNum(proteinPer100),
          carbs: shouldScale ? scalePerServing(carbsPer100, servingSizeOut) : safeNum(carbsPer100),
          fat: shouldScale ? scalePerServing(fatPer100, servingSizeOut) : safeNum(fatPer100),
          fiber: shouldScale ? scalePerServing(fiberPer100, servingSizeOut) : safeNum(fiberPer100),
          sugar: shouldScale ? scalePerServing(sugarsPer100, servingSizeOut) : safeNum(sugarsPer100),
          sodium: shouldScale ? scalePerServing(sodiumPer100Mg, servingSizeOut) : safeNum(sodiumPer100Mg),
        };

        return res.status(200).json(buildCompleteNutrition(fromOpenFoodFacts));
      }
    }

    /* -------------------------------- 2) Nutritionix ------------------------------- */
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
        const nutriData: any = await nutriResp.json(); // <-- cast to any
        const item = nutriData?.foods?.[0];
        if (item) {
          const name = item.food_name || "";
          const brand = item.brand_name || "";
          const servingStr = `${item.serving_qty || 1} ${item.serving_unit || "portion"}`;
          const guard = guardEdible({
            name, brand, categories: "", servingSize: servingStr, nutriments: {
              "energy-kcal_100g": item.nf_calories,
              proteins_100g: item.nf_protein,
              carbohydrates_100g: item.nf_total_carbohydrate,
              fat_100g: item.nf_total_fat,
            }
          });
          if (!guard.isEdible)
            return res.status(200).json({ error: "non_food", message: guard.reason });

          const fromNutritionix = {
            name,
            brand,
            source: "Nutritionix",
            type: "solid",
            servingSize: servingStr,
            baseAmount: safeNum(item.serving_qty),
            baseUnit: item.serving_unit || "portion",
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

    /* ---------------------------------- 3) GPT ----------------------------------- */
    if (!OPENAI_API_KEY)
      return res.status(500).json({ error: "Missing OpenAI API key" });

    const systemPrompt = `You are a nutrition expert. Given a barcode number, deduce the most likely packaged edible product and provide estimated nutrition per serving.
Respond ONLY with JSON including:
- name, brand
- servingSize (like "355 ml" or "50 g" or "1 portion")
- type: one of "liquid" | "solid" | "portion" | "unknown" | "non_food"
- calories, protein, carbs, fat, fiber, sugar, sodium (integers)
- source: "GPT-4o"
If not edible, respond with {"error":"non_food","message":"Not an edible product."}`;

    const gptResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Barcode: ${barcode}` },
        ],
        temperature: 0.2,
        max_tokens: 400,
      }),
    });

    const gptJson: any = await gptResp.json(); // <-- cast to any
    const content: string = gptJson?.choices?.[0]?.message?.content ?? "";
    const parsed = extractJsonFromText(content);
    if (parsed?.error === "non_food")
      return res.status(200).json(parsed);

    const guard = guardEdible({
      name: parsed?.name,
      brand: parsed?.brand,
      servingSize: parsed?.servingSize,
      nutriments: {
        "energy-kcal_100g": parsed?.calories,
        proteins_100g: parsed?.protein,
        carbohydrates_100g: parsed?.carbs,
        fat_100g: parsed?.fat,
      }
    });
    if (!guard.isEdible)
      return res.status(200).json({ error: "non_food", message: guard.reason });

    const fromGpt = {
      name: parsed.name,
      brand: parsed.brand,
      source: "GPT-4o",
      type: parsed.type,
      servingSize: parsed.servingSize,
      baseAmount: safeNum(parsed.baseAmount) || 100,
      baseUnit: parsed.baseUnit || "g",
      calories: parsed.calories,
      protein: parsed.protein,
      carbs: parsed.carbs,
      fat: parsed.fat,
      fiber: parsed.fiber,
      sugar: parsed.sugar,
      sodium: parsed.sodium,
    };
    return res.status(200).json(buildCompleteNutrition(fromGpt));
  } catch (err: any) {
    console.error("❌ Barcode API failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
