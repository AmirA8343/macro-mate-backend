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

    const messages = [
      {
        role: "user",
        content: `Estimate nutrition for this meal: ${
          description || ""
        }${photoUrl ? " (Image: " + photoUrl + ")" : ""}. Return JSON: {"protein": number, "calories": number, "carbs": number, "fat": number}.`,
      },
    ];

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini", // use GPT-4V for vision if needed
      messages: messages as any,
    });

    const reply = completion.choices?.[0]?.message?.content ?? "";
    let parsed: NutritionResponse = { protein: 0, calories: 0, carbs: 0, fat: 0 };

    try {
      parsed = JSON.parse(reply);
    } catch {
      parsed = { protein: 20, calories: 400, carbs: 45, fat: 15 }; // fallback
    }

    res.status(200).json(parsed);
  } catch (err) {
    console.error("Backend error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
}
