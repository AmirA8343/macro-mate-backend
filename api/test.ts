// /api/test.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

/* ======================== ENV KEYS ======================== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const NUTRITIONIX_APP_ID = process.env.NUTRITIONIX_APP_ID!;
const NUTRITIONIX_APP_KEY = process.env.NUTRITIONIX_APP_KEY!;

/* ======================== HELPERS ========================= */
const safeNum = (v: any) => (Number.isFinite(+v) ? Math.round(+v) : 0);
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

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
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  const raw = text.match(/\{[\s\S]*\}$/m);
  if (raw) {
    try { return JSON.parse(raw[0]); } catch {}
  }
  return null;
};

/* ======================== MATCHING HELPERS ========================= */
function tokenOverlapScore(a: string, b: string): number {
  const A = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const B = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  A.forEach(t => { if (B.has(t)) inter++; });
  return inter / Math.max(A.size, B.size);
}

function parsePortionMultiplier(portionText?: string | null): number {
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
  return name
    .toLowerCase()
    .replace(/\b(combo|meal|with)\b/g, "")
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

/* =================== NUTRITIONIX + OFF =================== */
async function nxInstant(query: string) {
  const r = await fetch("https://trackapi.nutritionix.com/v2/search/instant", {
    method: "POST",
    headers: {
      "x-app-id": NUTRITIONIX_APP_ID,
      "x-app-key": NUTRITIONIX_APP_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) return null;
  return (await r.json()) as any;
}

async function nxItemById(id: string) {
  const r = await fetch(`https://trackapi.nutritionix.com/v2/search/item?nix_item_id=${id}`, {
    headers: {
      "x-app-id": NUTRITIONIX_APP_ID,
      "x-app-key": NUTRITIONIX_APP_KEY,
    },
  });
  if (!r.ok) return null;
  return (await r.json()) as any;
}

async function nxNatural(query: string) {
  const r = await fetch("https://trackapi.nutritionix.com/v2/natural/nutrients", {
    method: "POST",
    headers: {
      "x-app-id": NUTRITIONIX_APP_ID,
      "x-app-key": NUTRITIONIX_APP_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) return null;
  return (await r.json()) as any;
}

async function offSearch(query: string) {
  const r = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(query)}&search_simple=1&json=1&page_size=1`);
  if (!r.ok) return null;
  return (await r.json()) as any;
}

/* =================== SOURCE RESOLUTION =================== */
async function resolveBrandedFromNutritionix(itemText: string) {
  const inst = await nxInstant(itemText);
  const branded = inst?.branded ?? [];
  if (!branded.length) return null;

  const ranked = branded
    .map((b: any) => ({
      ...b,
      _score: tokenOverlapScore(itemText, `${b.brand_name ?? ""} ${b.food_name ?? ""}`),
    }))
    .sort((a: any, b: any) => b._score - a._score);

  const best = ranked[0];
  if (!best?.nix_item_id) return null;

  const detail = await nxItemById(best.nix_item_id);
  const item = detail?.foods?.[0];
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
}

async function resolveGeneric(itemText: string) {
  const [nat, off] = await Promise.all([nxNatural(itemText), offSearch(itemText)]);
  const natItem = nat?.foods?.[0];
  const natObj = natItem ? {
    source: "Nutritionix Natural",
    calories: safeNum(natItem.nf_calories),
    protein: safeNum(natItem.nf_protein),
    carbs: safeNum(natItem.nf_total_carbohydrate),
    fat: safeNum(natItem.nf_total_fat),
    sodium: safeNum(natItem.nf_sodium),
    fiber: safeNum(natItem.nf_dietary_fiber),
  } : null;

  const offItem = off?.products?.[0]?.nutriments;
  const offObj = offItem ? {
    source: "OpenFoodFacts",
    calories: safeNum(offItem["energy-kcal_100g"]),
    protein: safeNum(offItem.proteins_100g),
    carbs: safeNum(offItem.carbohydrates_100g),
    fat: safeNum(offItem.fat_100g),
    sodium: safeNum(offItem.sodium_100g ? offItem.sodium_100g * 1000 : 0),
    fiber: safeNum(offItem.fiber_100g),
  } : null;

  return natObj || offObj || null;
}

/* =================== GPT STAGES =================== */
async function stage1IdentifyFoods(description: string, photoUrl?: string | null) {
  const prompt = `You are a nutrition analyst. Identify all edible items and portion sizes from this text and image. Return JSON only.`;
  const messages: any[] = [
    { role: "system", content: prompt },
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
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4o", messages, temperature: 0 }),
  });
  const data = (await r.json()) as any;
  const parsed = extractJson(data?.choices?.[0]?.message?.content || "");
  return dedupeFoods(parsed?.foods || []);
}

async function stage2FillMicros(verifiedTotals: any, foodList: string[]) {
  const prompt = `You are a dietitian. Given macros and meal list, fill realistic micronutrients. Return JSON only.`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "system", content: prompt + "\n\n" + JSON.stringify({ verifiedTotals, foodList }) }],
      temperature: 0,
    }),
  });
  const data = (await r.json()) as any;
  return extractJson(data?.choices?.[0]?.message?.content || "") || {};
}

/* =================== CACHE =================== */
type CacheEntry = { value: any; t: number };
const CACHE = new Map<string, CacheEntry>();
const TTL = 1000 * 60 * 60 * 12;
function cacheGet(k: string) {
  const h = CACHE.get(k);
  if (!h || Date.now() - h.t > TTL) return null;
  return h.value;
}
function cacheSet(k: string, v: any) {
  CACHE.set(k, { value: v, t: Date.now() });
  const firstKey = CACHE.keys().next().value as string | undefined;
  if (CACHE.size > 200 && firstKey) CACHE.delete(firstKey);
}

/* =================== MAIN HANDLER =================== */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") return res.status(200).json({ ok: true, message: "✅ test.ts live" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const forceMicros = req.query.forceMicros === "true";
  const { description = "", photoUrl } = req.body || {};
  const cacheKey = JSON.stringify({ description, photoUrl, forceMicros });
  const cached = cacheGet(cacheKey);
  if (cached) return res.status(200).json(cached);

  const foods = await stage1IdentifyFoods(description, photoUrl);
  const items = foods.length ? foods : [{ name: description, portion_text: "" }];

  const verified = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0 };
  let brandedHits = 0;
  const foodList: string[] = [];

  for (const f of items) {
    const base = canonicalizeName(f.name);
    const mult = parsePortionMultiplier(f.portion_text);
    let src = "none";
    let data: any = await resolveBrandedFromNutritionix(base);
    if (!data) data = await resolveGeneric(base);
    if (!data) continue;
    src = data.source;
    console.log(`✅ ${base} → ${src}`);
    verified.calories += safeNum(data.calories * mult);
    verified.protein += safeNum(data.protein * mult);
    verified.carbs += safeNum(data.carbs * mult);
    verified.fat += safeNum(data.fat * mult);
    verified.fiber += safeNum(data.fiber * mult);
    verified.sodium += safeNum(data.sodium * mult);
    if (src === "Nutritionix Branded") brandedHits++;
    foodList.push(`${f.portion_text || ""} ${f.name}`.trim());
  }

  const brandedCoverage = brandedHits / Math.max(1, items.length);
  const looksSane =
    verified.calories >= 200 && verified.calories <= 1200 &&
    verified.protein >= 5 && verified.protein <= 60;

  let result;
  if ((brandedCoverage >= 0.5 && looksSane) && !forceMicros) {
    console.log("🧠 Skipping AI micros — branded data looks good");
    result = buildCompleteNutrition({ ...verified });
  } else {
    console.log("🧩 Forcing AI micronutrient fill");
    const ai = await stage2FillMicros(verified, foodList);
    result = buildCompleteNutrition({ ...verified, ...ai });
  }

  cacheSet(cacheKey, result);
  return res.status(200).json(result);
}
