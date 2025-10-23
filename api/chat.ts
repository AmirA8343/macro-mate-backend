import type { VercelRequest, VercelResponse } from "@vercel/node";

/* ======================== ENV KEYS ======================== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const NUTRITIONIX_APP_ID = process.env.NUTRITIONIX_APP_ID || "";
const NUTRITIONIX_APP_KEY = process.env.NUTRITIONIX_APP_KEY || "";

/* ======================== MODELS ========================== */
const VISION_MODEL = "gpt-4o";  // higher than mini; supports image+text
const TEXT_MODEL   = "gpt-4o";  // keep consistent & strong

/* ======================== HELPERS ========================= */
const safeNum = (v: any) => (Number.isFinite(+v) ? Math.round(+v) : 0);
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

const buildCompleteNutrition = (d: any = {}) => ({
  protein:   safeNum(d.protein),
  calories:  safeNum(d.calories),
  carbs:     safeNum(d.carbs ?? d.carbohydrates),
  fat:       safeNum(d.fat),

  vitaminA:  safeNum(d.vitaminA),
  vitaminC:  safeNum(d.vitaminC),
  vitaminD:  safeNum(d.vitaminD),
  vitaminE:  safeNum(d.vitaminE),
  vitaminK:  safeNum(d.vitaminK),
  vitaminB12:safeNum(d.vitaminB12),
  iron:      safeNum(d.iron),
  calcium:   safeNum(d.calcium),
  magnesium: safeNum(d.magnesium),
  zinc:      safeNum(d.zinc),

  water:     safeNum(d.water),
  sodium:    safeNum(d.sodium),
  potassium: safeNum(d.potassium),
  chloride:  safeNum(d.chloride),
  fiber:     safeNum(d.fiber),
});

const extractJson = (text: string) => {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]) { try { return JSON.parse(fence[1]); } catch {} }
  const raw = text.match(/\{[\s\S]*\}$/m);
  if (raw) { try { return JSON.parse(raw[0]); } catch {} }
  return null;
};

function tokenOverlapScore(a: string, b: string): number {
  const A = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const B = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  A.forEach(t => { if (B.has(t)) inter++; });
  return inter / Math.max(A.size, B.size);
}

function parsePortionMultiplier(portionText?: string): number {
  if (!portionText) return 1;
  const m = portionText.toLowerCase().match(/(?:^|\s)(x?\s*\d+|\d+\s*x)(?:\b|$)/);
  if (m) {
    const val = parseInt(m[0].replace(/[^\d]/g, ""), 10);
    if (Number.isFinite(val) && val > 0 && val < 10) return val;
  }
  if (/\blarge\b/i.test(portionText)) return 1.3;
  if (/\bmedium\b/i.test(portionText)) return 1.0;
  if (/\bsmall\b/i.test(portionText)) return 0.8;
  return 1;
}

function canonicalizeName(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/\bcombo\b/g, "")
    .replace(/\bmeal\b/g, "")
    .replace(/\bwith\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeFoods(foods: { name: string; portion_text?: string }[]) {
  const kept: typeof foods = [];
  for (const f of foods) {
    const name = canonicalizeName(f.name);
    let dup = false;
    for (const g of kept) {
      const score = tokenOverlapScore(name, canonicalizeName(g.name));
      if (score > 0.8) { dup = true; break; }
    }
    if (!dup) kept.push(f);
  }
  return kept;
}

/* ======================== TYPES ========================== */
interface OpenAIResponse {
  choices?: { message?: { content?: string } }[];
}
interface NutritionixInstantResponse {
  branded?: { nix_item_id?: string; food_name?: string; brand_name?: string }[];
}
interface NutritionixItemFood {
  nf_calories?: number;
  nf_protein?: number;
  nf_total_carbohydrate?: number;
  nf_total_fat?: number;
  nf_sodium?: number;
  nf_dietary_fiber?: number;
  food_name?: string;
  brand_name?: string;
  serving_qty?: number;
  serving_unit?: string;
}
interface NutritionixItemResponse {
  foods?: NutritionixItemFood[];
}
interface OpenFoodFactsResponse {
  products?: {
    product_name?: string;
    nutriments?: {
      ["energy-kcal_100g"]?: number;
      proteins_100g?: number;
      carbohydrates_100g?: number;
      fat_100g?: number;
      sodium_100g?: number; // grams
      fiber_100g?: number;
    };
  }[];
}

/* =================== NUTRITIONIX HELPERS ================= */
async function nxInstant(query: string) {
  if (!NUTRITIONIX_APP_ID || !NUTRITIONIX_APP_KEY) return null;
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
  return (await resp.json()) as NutritionixInstantResponse;
}

async function nxItemById(nix_item_id: string) {
  if (!NUTRITIONIX_APP_ID || !NUTRITIONIX_APP_KEY) return null;
  const resp = await fetch(`https://trackapi.nutritionix.com/v2/search/item?nix_item_id=${nix_item_id}`, {
    headers: {
      "x-app-id": NUTRITIONIX_APP_ID,
      "x-app-key": NUTRITIONIX_APP_KEY,
    },
  });
  if (!resp.ok) return null;
  return (await resp.json()) as NutritionixItemResponse;
}

async function nxNatural(query: string) {
  if (!NUTRITIONIX_APP_ID || !NUTRITIONIX_APP_KEY) return null;
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
  return (await resp.json()) as NutritionixItemResponse;
}

/* =================== OPENFOODFACTS HELPER =============== */
async function offSearch(query: string) {
  const resp = await fetch(
    `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&json=1&page_size=1`
  );
  if (!resp.ok) return null;
  return (await resp.json()) as OpenFoodFactsResponse;
}

/* =================== SOURCE RESOLUTION =================== */
async function resolveBrandedFromNutritionix(itemText: string) {
  const inst = await nxInstant(itemText);
  const branded = inst?.branded ?? [];
  if (!branded.length) return null;

  const ranked = branded
    .map(b => ({
      ...b,
      _score: tokenOverlapScore(itemText, `${b.brand_name ?? ""} ${b.food_name ?? ""}`),
    }))
    .sort((a, b) => (b._score ?? 0) - (a._score ?? 0));

  const best = ranked[0];
  if (!best?.nix_item_id) return null;

  const detail = await nxItemById(best.nix_item_id);
  const item = detail?.foods?.[0];
  if (!item) return null;

  return {
    source: "Nutritionix Branded",
    name: item.food_name || "",
    brand: item.brand_name || "",
    calories: safeNum(item.nf_calories),
    protein: safeNum(item.nf_protein),
    carbs: safeNum(item.nf_total_carbohydrate),
    fat: safeNum(item.nf_total_fat),
    sodium: safeNum(item.nf_sodium),
    fiber: safeNum(item.nf_dietary_fiber),
  };
}

async function resolveGeneric(itemText: string) {
  const [nat, off] = await Promise.all([nxNatural(itemText), offSearch(itemText)]);

  const natItem = nat?.foods?.[0];
  const natObj = natItem
    ? {
        source: "Nutritionix Natural",
        calories: safeNum(natItem.nf_calories),
        protein: safeNum(natItem.nf_protein),
        carbs: safeNum(natItem.nf_total_carbohydrate),
        fat: safeNum(natItem.nf_total_fat),
        sodium: safeNum(natItem.nf_sodium),
        fiber: safeNum(natItem.nf_dietary_fiber),
      }
    : null;

  const offItem = off?.products?.[0]?.nutriments;
  const offObj = offItem
    ? {
        source: "OpenFoodFacts",
        calories: safeNum(offItem["energy-kcal_100g"]),
        protein: safeNum(offItem.proteins_100g),
        carbs: safeNum(offItem.carbohydrates_100g),
        fat: safeNum(offItem.fat_100g),
        sodium: safeNum(offItem.sodium_100g ? offItem.sodium_100g * 1000 : 0), // g→mg
        fiber: safeNum(offItem.fiber_100g),
      }
    : null;

  return natObj || offObj || null;
}

/* =================== AI (VISION + MICROS) =============== */
async function stage1IdentifyFoods(description: string, photoUrl?: string | null) {
  const stage1Prompt = `
You are a nutrition analyst. Identify all edible items and portion sizes from the given text and image.
Return STRICT JSON only:
{
  "foods":[{"name":"string","portion_text":"e.g. 150 g or 1 cup"}],
  "summary":"short summary"
}
No commentary. JSON only.`;

  const messages: any[] = [
    { role: "system", content: stage1Prompt },
    { role: "user", content: description || "(no description)" },
  ];
  if (photoUrl) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: "Analyze this image as part of the meal." },
        { type: "image_url", image_url: { url: photoUrl } },
      ],
    });
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: VISION_MODEL, messages, temperature: 0 }),
  });
  const data = (await resp.json()) as OpenAIResponse;
  const content = data?.choices?.[0]?.message?.content ?? "";
  const parsed = extractJson(content);
  const foods = Array.isArray(parsed?.foods) ? parsed.foods : [];
  return dedupeFoods(foods);
}

async function stage2FillMicros(verifiedTotals: any, foodList: string[]) {
  const prompt = `
You are an expert dietitian.
You are given verified macronutrient totals for a single meal from Nutritionix/OpenFoodFacts.
Your job is to FILL IN MICRONUTRIENTS ONLY and keep macros realistic. Do not overwrite verified macros.
If any macros look extreme, normalize to these single-meal ranges:
- Calories: 300–1100 kcal
- Protein: 5–60 g
- Carbs: 5–150 g
- Fat: 5–60 g
- Sodium: 100–1500 mg
- Fiber: 0–15 g

Return ONE JSON object with:
protein (g), calories (kcal), carbs (g), fat (g),
vitaminA (µg), vitaminC (mg), vitaminD (µg), vitaminE (mg), vitaminK (µg), vitaminB12 (µg),
iron (mg), calcium (mg), magnesium (mg), zinc (mg),
water (ml), sodium (mg), potassium (mg), chloride (mg), fiber (g).

Verified totals (MACROS ONLY, keep dominant):
${JSON.stringify(verifiedTotals)}

Foods:
${JSON.stringify(foodList)}
`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: TEXT_MODEL, messages: [{ role: "system", content: prompt }], temperature: 0 }),
  });
  const data = (await resp.json()) as OpenAIResponse;
  const content = data?.choices?.[0]?.message?.content ?? "";
  return extractJson(content) || {};
}

/* ========================= LRU CACHE ===================== */
type CacheEntry = { value: any; t: number };
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12h
function cacheGet(key: string) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) { CACHE.delete(key); return null; }
  return hit.value;
}
function cacheSet(key: string, value: any) {
  CACHE.set(key, { value, t: Date.now() });
  if (CACHE.size > 200) {
    const firstKey = CACHE.keys().next().value;
    if (firstKey) CACHE.delete(firstKey);
  }
}

/* ========================== HANDLER ====================== */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  const { description = "", photoUrl } = req.body || {};
  const cacheKey = JSON.stringify({ description, photoUrl });
  const cached = cacheGet(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    /* -------- Stage 1: identify edible items (Vision + text) -------- */
    const foods: { name: string; portion_text?: string }[] = await stage1IdentifyFoods(description, photoUrl);
    const items = foods.length ? foods : [{ name: description || "meal", portion_text: "" }];

    /* -------- Stage 1.5: resolve each item via DBs (manager) -------- */
    const resolved = await Promise.all(
      items.map(async (f) => {
        const baseText = canonicalizeName(f.name);
        const portionMult = parsePortionMultiplier(f.portion_text);
        // Try Nutritionix branded first
        const branded = await resolveBrandedFromNutritionix(baseText);
        if (branded) {
          return {
            ...branded,
            calories: Math.round(branded.calories * portionMult),
            protein:  Math.round(branded.protein  * portionMult),
            carbs:    Math.round(branded.carbs    * portionMult),
            fat:      Math.round(branded.fat      * portionMult),
            sodium:   Math.round(branded.sodium   * portionMult),
            fiber:    Math.round(branded.fiber    * portionMult),
            _isBranded: true,
          };
        }
        // Generic (Nutritionix natural / OFF)
        const generic = await resolveGeneric(`${f.portion_text || ""} ${baseText}`.trim());
        if (generic) return { ...generic, _isBranded: false };
        return null;
      })
    );

    // Sum verified macros
    const verified = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0 };
    let brandedHits = 0;
    const foodListForPrompt: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const r = resolved[i];
      const f = items[i];
      foodListForPrompt.push(`${f.portion_text || ""} ${f.name}`.trim());
      if (!r) continue;
      verified.calories += r.calories || 0;
      verified.protein  += r.protein  || 0;
      verified.carbs    += r.carbs    || 0;
      verified.fat      += r.fat      || 0;
      verified.fiber    += r.fiber    || 0;
      verified.sodium   += r.sodium   || 0;
      if (r._isBranded) brandedHits++;
    }

    // If we got decent branded coverage and the numbers look sane, skip GPT fill
    const brandedCoverage = brandedHits / Math.max(1, items.length);
    const looksSane =
      verified.calories >= 200 && verified.calories <= 1200 &&
      verified.protein  >= 5   && verified.protein  <= 60   &&
      verified.carbs    >= 5   && verified.carbs    <= 160  &&
      verified.fat      >= 5   && verified.fat      <= 70;

    if (brandedCoverage >= 0.5 && looksSane) {
      const out = buildCompleteNutrition({
        ...verified,
        vitaminA: 0, vitaminC: 0, vitaminD: 0, vitaminE: 0, vitaminK: 0, vitaminB12: 0,
        iron: 0, calcium: 0, magnesium: 0, zinc: 0,
        water: 0, potassium: 0, chloride: 0,
      });
      cacheSet(cacheKey, out);
      return res.status(200).json(out);
    }

    /* -------- Stage 2: AI fills MICROS, keeps MACROS in band -------- */
    const ai = await stage2FillMicros(verified, foodListForPrompt);

    // Merge AI result with verified macros (verified wins)
    const merged: any = {
      protein:  safeNum(verified.protein  || ai.protein),
      calories: safeNum(verified.calories || ai.calories),
      carbs:    safeNum(verified.carbs    || ai.carbs),
      fat:      safeNum(verified.fat      || ai.fat),

      vitaminA: ai.vitaminA || 0,
      vitaminC: ai.vitaminC || 0,
      vitaminD: ai.vitaminD || 0,
      vitaminE: ai.vitaminE || 0,
      vitaminK: ai.vitaminK || 0,
      vitaminB12: ai.vitaminB12 || 0,
      iron: ai.iron || 0,
      calcium: ai.calcium || 0,
      magnesium: ai.magnesium || 0,
      zinc: ai.zinc || 0,

      water: ai.water || 0,
      sodium: safeNum(verified.sodium || ai.sodium || 0),
      potassium: ai.potassium || 0,
      chloride: ai.chloride || 0,
      fiber: safeNum(verified.fiber || ai.fiber || 0),
    };

    // Clamp macros to realistic single-meal ranges
    merged.calories = clamp(merged.calories, 100, 1100);
    merged.protein  = clamp(merged.protein,    5,   60);
    merged.carbs    = clamp(merged.carbs,      5,  150);
    merged.fat      = clamp(merged.fat,        5,   60);
    merged.sodium   = clamp(merged.sodium,     0, 2000);
    merged.fiber    = clamp(merged.fiber,      0,   20);

    // Non-negatives for micros
    const nonNegKeys = [
      "vitaminA","vitaminB12","vitaminC","vitaminD","vitaminE","vitaminK",
      "iron","calcium","magnesium","zinc","water","potassium","chloride"
    ] as const;
    for (const k of nonNegKeys) { (merged as any)[k] = Math.max(0, Number((merged as any)[k] || 0)); }

    const out = buildCompleteNutrition(merged);
    cacheSet(cacheKey, out);
    return res.status(200).json(out);
  } catch (err: any) {
    console.error("❌ nutrition error:", err);
    return res.status(500).json({ error: "Server error", details: err?.message || "unknown" });
  }
}
