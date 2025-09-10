import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests allowed" });
  }

  const { description, photoUrl } = req.body;

  if (!description && !photoUrl) {
    return res.status(400).json({ error: "Provide description or photoUrl" });
  }

  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Build GPT messages
    const messages = [
      {
        role: "user",
        content: description
          ? `Analyze nutrition for: ${description} in JSON format with keys: protein, calories, carbs, fat, vitaminA, vitaminC, vitaminD, vitaminE, vitaminK, vitaminB12, iron, calcium, magnesium, zinc, water, sodium, potassium, chloride, fiber`
          : "Analyze nutrition for uploaded food photo (vision feature)"
      },
    ];

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini", // Use GPT-4 for text; GPT-4V later for vision
      messages,
    });

    res.status(200).json({ reply: completion.choices[0].message });
  } catch (err) {
    console.error("OpenAI error:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
}
