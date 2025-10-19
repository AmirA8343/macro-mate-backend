// api/openai
import type { VercelRequest, VercelResponse } from "@vercel/node";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function safeNum(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function buildCompleteNutrition(data: any = {}) {
  return {
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OpenAI API key" });
  }

  const { description, photoUrl } = req.body;

  const systemPrompt = `You are a precise nutrition expert. Analyze the provided meal (text description and/or image).
Return ONLY a single JSON object (no surrounding text) with numeric values (integers) for ALL of the following keys:
protein (g), calories (kcal), carbs (g), fat (g),
vitaminA (µg), vitaminC (mg), vitaminD (µg), vitaminE (mg), vitaminK (µg), vitaminB12 (µg),
iron (mg), calcium (mg), magnesium (mg), zinc (mg),
water (ml), sodium (mg), potassium (mg), chloride (mg),
fiber (g).

If unknown, return 0. Respond with JSON only.`;

  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: description?.trim() || "(no description)" },
  ];

  if (photoUrl) {
    messages.push({ role: "user", content: "Image attached (analyze this as part of the meal)." });
    messages.push({ role: "user", content: [{ type: "image_url", image_url: { url: photoUrl } }] });
  }

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.0,
        max_tokens: 600,
      }),
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ error: `OpenAI API error ${resp.status}` });
    }

    const data = await resp.json();
    const content: string = data.choices?.[0]?.message?.content ?? "";
    console.log("🔎 OpenAI output:", content.slice(0, 200));

    const parsed = extractJsonFromText(content);
    if (parsed) {
      return res.status(200).json(buildCompleteNutrition(parsed));
    }

    return res.status(500).json({ error: "Failed to parse nutrition JSON" });
  } catch (err: any) {
    console.error("❌ Nutrition API failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
