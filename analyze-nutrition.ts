// api/analyze-nutrition.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { description, photoUrl } = req.body;

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OpenAI API key" });
  }

  try {
    const messages: any[] = [
      {
        role: "system",
        content: `You are a precise nutrition expert. Analyze the meal and return JSON only with numeric values for:
protein (g), calories (kcal), carbs (g), fat (g),
vitaminA (µg), vitaminC (mg), vitaminD (µg), vitaminE (mg), vitaminK (µg), vitaminB12 (µg),
iron (mg), calcium (mg), magnesium (mg), zinc (mg),
water (ml), sodium (mg), potassium (mg), chloride (mg),
fiber (g). If unknown, return 0.`,
      },
      { role: "user", content: description || "(no description)" },
    ];

    if (photoUrl) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "Attached image of meal:" },
          { type: "image_url", image_url: { url: photoUrl } },
        ],
      });
    }

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // supports text + vision
        messages,
        temperature: 0,
        max_tokens: 600,
      }),
    });

    if (!resp.ok) {
      const error = await resp.text();
      return res.status(resp.status).json({ error });
    }

    const data = await resp.json();
    const content: string = data.choices?.[0]?.message?.content ?? "{}";

    let parsed;
    try {
      parsed = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    } catch {
      parsed = {};
    }

    res.status(200).json(parsed);
  } catch (err: any) {
    console.error("❌ Backend error:", err);
    res.status(500).json({ error: err.message });
  }
}
