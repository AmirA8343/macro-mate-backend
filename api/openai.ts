import OpenAI from "openai";

type NutritionResponse = {
  protein: number;
  calories: number;
  carbs: number;
  fat: number;
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
        text: `Estimate nutrition for this meal. 
Return ONLY valid JSON with these keys: {"protein": number, "calories": number, "carbs": number, "fat": number}. 
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
    let parsed: NutritionResponse = { protein: 0, calories: 0, carbs: 0, fat: 0 };

    try {
      parsed = JSON.parse(reply);
    } catch (e) {
      console.warn("⚠️ Could not parse AI response, reply was:", reply);
    }

    return res.status(200).json(parsed);
  } catch (err: any) {
    console.error("❌ Backend error:", err?.response?.data || err);
    return res.status(500).json({ error: "Something went wrong", details: err?.message });
  }
}
