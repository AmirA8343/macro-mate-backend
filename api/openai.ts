import OpenAI from "openai";

type NutritionResponse = {
  protein: number;
  calories: number;
  carbs: number;
  fat: number;

  vitaminA: number;
  vitaminC: number;
  vitaminD: number;
  vitaminE: number;
  vitaminK: number;
  vitaminB12: number;
  iron: number;
  calcium: number;
  magnesium: number;
  zinc: number;

  water: number;
  sodium: number;
  potassium: number;
  chloride: number;

  fiber: number;
};

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
        text: `Estimate nutrition for this meal. Return ONLY valid JSON with numeric values for these keys:
{"protein","calories","carbs","fat","vitaminA","vitaminC","vitaminD","vitaminE","vitaminK","vitaminB12",
"iron","calcium","magnesium","zinc","water","sodium","potassium","chloride","fiber"}.
Meal: ${description}`,
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

    // Default all nutrients to 0
    let parsed: NutritionResponse = {
      protein: 0,
      calories: 0,
      carbs: 0,
      fat: 0,
      vitaminA: 0,
      vitaminC: 0,
      vitaminD: 0,
      vitaminE: 0,
      vitaminK: 0,
      vitaminB12: 0,
      iron: 0,
      calcium: 0,
      magnesium: 0,
      zinc: 0,
      water: 0,
      sodium: 0,
      potassium: 0,
      chloride: 0,
      fiber: 0,
    };

    try {
      const parsedJson = JSON.parse(reply);
      // Assign only keys that exist in our type
      for (const key of Object.keys(parsed)) {
        if (parsedJson[key] !== undefined) {
          parsed[key as keyof NutritionResponse] = Math.round(Number(parsedJson[key])) || 0;
        }
      }
    } catch (e) {
      console.warn("⚠️ Could not parse AI response, reply was:", reply);
    }

    return res.status(200).json({ ok: true, parsed, raw: reply });
  } catch (err: any) {
    console.error("❌ Backend error:", err?.response?.data || err);
    return res.status(500).json({ error: "Something went wrong", details: err?.message });
  }
}
