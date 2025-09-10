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
        text: `You are a precise nutrition expert. Analyze the meal below and return ONLY valid JSON with numeric values for ALL keys, even if some are 0:
{"protein","calories","carbs","fat",
"vitaminA","vitaminC","vitaminD","vitaminE","vitaminK","vitaminB12",
"iron","calcium","magnesium","zinc",
"water","sodium","potassium","chloride","fiber"}.

Meal description: ${description}

⚠️ Respond ONLY with the JSON object, nothing else.`
      });
    }

    if (photoUrl) {
      content.push({
        type: "image_url",
        image_url: { url: photoUrl },
      });
    }

    console.log("📡 Sending request to OpenAI:", { description, photoUrl });

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
    console.log("📥 Raw OpenAI reply:", reply);

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
      parsed = { ...parsed, ...parsedJson };
    } catch (e) {
      console.warn("⚠️ Could not parse AI response, using defaults. Reply was:", reply);
    }

    console.log("✅ Parsed nutrition:", parsed);
    return res.status(200).json(parsed);
  } catch (err: any) {
    console.error("❌ Backend error:", err?.response?.data || err);
    return res.status(500).json({ error: "Something went wrong", details: err?.message });
  }
}
