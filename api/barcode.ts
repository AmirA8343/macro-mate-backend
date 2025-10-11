// api/barcode.ts
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

/** Scale a per-100g/100ml value to the product's serving size (e.g., 48 kcal per 100ml with servingSize "710 ml" → 340). */
function scalePerServing(valuePer100: any, servingSize: string | undefined) {
  const n = Number(valuePer100);
  if (!Number.isFinite(n) || !servingSize) return safeNum(valuePer100);
  const m = servingSize.match(/([\d.]+)\s*(ml|g)\b/i);
  if (!m) return safeNum(valuePer100);
  const amount = parseFloat(m[1]); // e.g., 710
  if (!Number.isFinite(amount) || amount <= 0) return safeNum(valuePer100);
  return Math.round((n * amount) / 100);
}

/* -------------------------- helpers: type classification -------------------------- */
const NON_FOOD_KEYWORDS = [
  "soap","detergent","toothpaste","shampoo","cleaner","bleach","lotion","deodorant",
  "cosmetic","conditioner","dishwashing","laundry","air freshener","pet food","cat litter"
];
const LIQUID_HINTS = [
  "ml","drink","juice","water","milk","coffee","tea","energy","soda","cola",
  "beverage","sports drink","sparkling"
];
const SOLID_HINTS = [
  "g","chips","snack","bar","bread","rice","cereal","meat","pasta","cookie",
  "cracker","granola","nuts","candy","chocolate"
];
const PORTION_HINTS = ["portion","serving","slice","bar","cup","piece","pack"];

function containsAny(hay: string, words: string[]) {
  const s = hay.toLowerCase();
  return words.some(w => s.includes(w));
}

/** Decide product type from name/categories/serving. */
function detectProductType(
  name?: string,
  categoriesText?: string,
  servingSize?: string
): ProductType {
  const hay = [name ?? "", categoriesText ?? "", servingSize ?? ""].join(" ").toLowerCase();

  if (containsAny(hay, NON_FOOD_KEYWORDS)) return "non_food";
  if (containsAny(hay, PORTION_HINTS)) return "portion";
  if (containsAny(hay, LIQUID_HINTS)) return "liquid";
  if (containsAny(hay, SOLID_HINTS)) return "solid";
  return "unknown";
}

/** Parse base amount & unit from serving size; fallback to sensible defaults. */
function extractBaseAmountAndUnit(
  servingSize?: string,
  inferredType: ProductType = "unknown"
): { baseAmount: number; baseUnit: "ml" | "g" | "portion"; servingSizeOut: string } {
  const s = (servingSize || "").trim();

  // Try numeric + unit pattern: "710 ml", "355ml", "50 g"
  const m = s.match(/([\d.]+)\s*(ml|g)\b/i);
  if (m) {
    const amt = parseFloat(m[1]);
    const unit = m[2].toLowerCase() as "ml" | "g";
    if (Number.isFinite(amt) && amt > 0) {
      return { baseAmount: Math.round(amt), baseUnit: unit, servingSizeOut: s };
    }
  }

  // Portion-like strings
  if (containsAny(s, PORTION_HINTS) || inferredType === "portion") {
    const n = s.match(/([\d.]+)/);
    const amt = n ? parseFloat(n[1]) : 1;
    return {
      baseAmount: Number.isFinite(amt) && amt > 0 ? Math.round(amt) : 1,
      baseUnit: "portion",
      servingSizeOut: s || "1 portion",
    };
  }

  // Fallback by detected type
  switch (inferredType) {
    case "liquid":
      return { baseAmount: 100, baseUnit: "ml", servingSizeOut: s || "100 ml" };
    case "solid":
      return { baseAmount: 100, baseUnit: "g", servingSizeOut: s || "100 g" };
    case "portion":
      return { baseAmount: 1, baseUnit: "portion", servingSizeOut: s || "1 portion" };
    default:
      return { baseAmount: 100, baseUnit: "g", servingSizeOut: s || "100 g" };
  }
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
    sugar: safeNum(data.sugar),
  };
}

/** Extract JSON payload from GPT output safely */
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
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const barcode = (req.query.barcode || (req.body as any)?.barcode)?.toString();
  if (!barcode) {
    return res.status(400).json({ error: "Missing barcode parameter" });
  }

  try {
    /* ------------------------------- 1) OpenFoodFacts ------------------------------ */
    const offResp = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`);
    if (offResp.ok) {
      const offData = await offResp.json();
      const p = offData?.product;
      if (p) {
        const name = p.product_name || "";
        const brand = p.brands || "";
        const servingRaw = p.serving_size || "";
        const categoriesText = (p.categories_tags || []).join(", ");
        const type = detectProductType(name, categoriesText, servingRaw);

        if (type === "non_food") {
          return res.status(200).json({
            error: "non_food",
            message: "Sorry, this product is not recognized as an edible item.",
          });
        }

        const { baseAmount, baseUnit, servingSizeOut } = extractBaseAmountAndUnit(servingRaw, type);
        const n = p.nutriments || {};

        const caloriesPer100 = n["energy-kcal_100g"];
        const proteinPer100 = n.proteins_100g;
        const carbsPer100 = n.carbohydrates_100g;
        const fatPer100 = n.fat_100g;
        const fiberPer100 = n.fiber_100g;
        const sugarsPer100 = n.sugars_100g;
        const sodiumPer100Mg = Number.isFinite(n.sodium_100g)
          ? n.sodium_100g * 1000
          : undefined;

        const shouldScale = baseUnit === "ml" || baseUnit === "g";
        const fromOpenFoodFacts = {
          name,
          brand,
          source: "OpenFoodFacts",
          type,
          servingSize: servingSizeOut,
          baseAmount,
          baseUnit,

          calories: shouldScale ? scalePerServing(caloriesPer100, servingSizeOut) : safeNum(caloriesPer100),
          protein:  shouldScale ? scalePerServing(proteinPer100,  servingSizeOut) : safeNum(proteinPer100),
          carbs:    shouldScale ? scalePerServing(carbsPer100,    servingSizeOut) : safeNum(carbsPer100),
          fat:      shouldScale ? scalePerServing(fatPer100,      servingSizeOut) : safeNum(fatPer100),
          fiber:    shouldScale ? scalePerServing(fiberPer100,    servingSizeOut) : safeNum(fiberPer100),
          sugar:    shouldScale ? scalePerServing(sugarsPer100,   servingSizeOut) : safeNum(sugarsPer100),
          sodium:   shouldScale ? scalePerServing(sodiumPer100Mg, servingSizeOut) : safeNum(sodiumPer100Mg),
        };

        if (fromOpenFoodFacts.calories || fromOpenFoodFacts.protein || fromOpenFoodFacts.carbs) {
          return res.status(200).json(buildCompleteNutrition(fromOpenFoodFacts));
        }
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
        const nutriData = await nutriResp.json();
        const item = nutriData?.foods?.[0];
        if (item) {
          const name = item.food_name || "";
          const brand = item.brand_name || "";
          const servingQty = item.serving_qty;
          const servingUnit = (item.serving_unit || "").toLowerCase();
          const servingWeightG = item.serving_weight_grams;

          let type: ProductType = "unknown";
          let servingStr = "";

          if (servingUnit === "g" || servingUnit === "grams") {
            servingStr = `${servingQty || servingWeightG || 100} g`;
            type = "solid";
          } else if (servingUnit === "ml") {
            servingStr = `${servingQty || 100} ml`;
            type = "liquid";
          } else if (servingWeightG) {
            servingStr = `${servingWeightG} g`;
            type = "solid";
          } else {
            servingStr = `${servingQty || 1} portion`;
            type = "portion";
          }

          if (detectProductType(name, "", servingStr) === "non_food") {
            return res.status(200).json({
              error: "non_food",
              message: "Sorry, this product is not recognized as an edible item.",
            });
          }

          const { baseAmount, baseUnit, servingSizeOut } = extractBaseAmountAndUnit(servingStr, type);

          const fromNutritionix = {
            name,
            brand,
            source: "Nutritionix",
            type,
            servingSize: servingSizeOut,
            baseAmount,
            baseUnit,

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
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OpenAI API key" });
    }

    const systemPrompt = `You are a nutrition expert. Given a barcode number, deduce the most likely packaged edible product and provide estimated nutrition per serving.
Respond ONLY with JSON including:
- name, brand
- servingSize (string like "355 ml" or "50 g" or "1 portion")
- type: one of "liquid" | "solid" | "portion" | "unknown" | "non_food"
- calories, protein, carbs, fat, fiber, sugar, sodium (integers)
- source: "GPT-4o"
If not edible, set {"error":"non_food","message":"Sorry, this product is not recognized as an edible item."}`;

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
        temperature: 0.2,
        max_tokens: 400,
      }),
    });

    const gptJson = await gptResp.json();
    const content: string = gptJson?.choices?.[0]?.message?.content ?? "";
    const parsed = extractJsonFromText(content);

    if (parsed?.error === "non_food") {
      return res.status(200).json(parsed);
    }

    if (parsed) {
      const type: ProductType = parsed.type || detectProductType(parsed.name, "", parsed.servingSize);
      const { baseAmount, baseUnit, servingSizeOut } = extractBaseAmountAndUnit(parsed.servingSize, type);
      const fromGpt = {
        name: parsed.name,
        brand: parsed.brand,
        source: "GPT-4o",
        type,
        servingSize: servingSizeOut,
        baseAmount,
        baseUnit,
        calories: parsed.calories,
        protein: parsed.protein,
        carbs: parsed.carbs,
        fat: parsed.fat,
        fiber: parsed.fiber,
        sugar: parsed.sugar,
        sodium: parsed.sodium,
      };
      return res.status(200).json(buildCompleteNutrition(fromGpt));
    }

    return res.status(500).json({ error: "Failed to parse nutrition JSON" });
  } catch (err: any) {
    console.error("❌ Barcode API failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
