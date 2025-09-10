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

    const content: any[] = [];
    if (description) {
      content.push({
        type: "text",
        text: `You are a nutrition expert. Return ONLY valid JSON with all numeric keys below:
{"protein","calories","carbs","fat","vitaminA","vitaminC","vitaminD","vitaminE","vitaminK","vitaminB12","iron","calcium","magnesium","zinc","water","sodium","potassium","chloride","fiber"}
Analyze this meal: ${description}`,
      });
    }

    if (photoUrl) {
      content.push({
        type: "image_url",
        image_url: { url: photoUrl },
      });
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini", // supports vision + text
      messages: [
        {
          role: "user",
          content,
        },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content ?? "";

    // Extract JSON from reply (handles extra text/code fences)
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    let parsed: any = {};

    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (e) {
        console.warn("⚠️ Could not parse AI JSON, fallback applied:", reply);
      }
    } else {
      console.warn("⚠️ AI reply had no JSON:", reply);
    }

    // Ensure all keys exist
    const keys = [
      "protein","calories","carbs","fat",
      "vitaminA","vitaminC","vitaminD","vitaminE","vitaminK","vitaminB12",
      "iron","calcium","magnesium","zinc",
      "water","sodium","potassium","chloride",
      "fiber"
    ];

    const finalParsed: Record<string, number> = {};
    for (const key of keys) {
      finalParsed[key] = Number(parsed[key] ?? 0);
    }

    return res.status(200).json(finalParsed);

  } catch (err: any) {
    console.error("❌ Backend error:", err?.response?.data || err);
    return res.status(500).json({ error: "Something went wrong", details: err?.message });
  }
}
