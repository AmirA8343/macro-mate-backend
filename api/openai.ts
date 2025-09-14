// api/nutrition.ts
import OpenAI from "openai";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests allowed" });
  }

  const { description, photoUrl } = req.body;

  if (!description && !photoUrl) {
    return res.status(400).json({ error: "Provide description or photoUrl" });
  }

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const systemPrompt = `You are a precise nutrition expert. Analyze the provided meal (text description and/or image).
Return ONLY a single JSON object (no surrounding text) with numeric values (integers) for ALL keys.
If unknown, return 0. Respond with JSON only.`;

    const messages: any[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: description?.trim() || "(no description)" },
    ];

    if (photoUrl) {
      messages.push({ role: "user", content: "Image attached (analyze this as part of the meal)." });
      messages.push({ role: "user", content: [{ type: "image_url", image_url: { url: photoUrl } }] });
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.0,
      max_tokens: 600,
    });

    const reply = completion.choices?.[0]?.message?.content ?? "";

    // Extract JSON safely
    let parsed: Record<string, any> | null = null;
    try {
      parsed = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] || "{}");
    } catch {
      parsed = {};
    }

    const keys = [
      "protein","calories","carbs","fat",
      "vitaminA","vitaminC","vitaminD","vitaminE","vitaminK","vitaminB12",
      "iron","calcium","magnesium","zinc",
      "water","sodium","potassium","chloride",
      "fiber"
    ];

    const finalParsed: Record<string, number> = {};
    for (const key of keys) {
      finalParsed[key] = Number(parsed?.[key] ?? 0); // ✅ optional chaining
    }

    return res.status(200).json(finalParsed);

  } catch (err: any) {
    console.error("❌ Backend error:", err?.response?.data || err);
    return res.status(500).json({ error: "Something went wrong", details: err?.message });
  }
}
