import type { VercelRequest, VercelResponse } from "@vercel/node";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

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

/* ---------- main handler ---------- */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { description = "", photoUrl } = req.body || {};
  if (!OPENAI_API_KEY) return res.status(500).json({ error: "Missing OpenAI key" });

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
  if (photoUrl)
    stage1Msgs.push({
      role: "user",
      content: [
        { type: "text", text: "Analyze this image as part of the meal." },
        { type: "image_url", image_url: { url: photoUrl } },
      ],
    });

  const stage1Resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: stage1Msgs, temperature: 0 }),
  });
  const stage1Data = (await stage1Resp.json()) as any;
const stage1Content: string = stage1Data.choices?.[0]?.message?.content ?? "";

  const stage1 = extractJson(stage1Content) ?? { foods: [] };

  // --- Stage 2: compute nutrition ---
  const foodList = stage1.foods?.map((f: any) => `${f.portion_text || ""} ${f.name}`).join(", ") || description;
  const stage2Prompt = `
You are an expert dietitian. Estimate total nutrition for: ${foodList}.
Output ONLY one JSON object with numeric values (integers). Keys:
protein (g), calories (kcal), carbs (g), fat (g),
vitaminA (µg), vitaminC (mg), vitaminD (µg), vitaminE (mg), vitaminK (µg), vitaminB12 (µg),
iron (mg), calcium (mg), magnesium (mg), zinc (mg),
water (ml), sodium (mg), potassium (mg), chloride (mg), fiber (g).

If unknown, use 0. Double-check that totals are realistic (not >2000 kcal per meal).
Respond with JSON only.
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

  const stage2Data = await stage2Resp.json() as any;
  const stage2Content: string = stage2Data.choices?.[0]?.message?.content ?? "";
  const parsed = extractJson(stage2Content);

  if (parsed) return res.status(200).json(buildCompleteNutrition(parsed));
  return res.status(500).json({ error: "Failed to parse nutrition JSON" });
}
