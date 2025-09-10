import OpenAI from "openai";

export default async function handler(req, res) {
  // --- CORS headers (needed for Expo fetch) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end(); // preflight
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests allowed" });
  }

  try {
    const { messages, description, photoUrl } = req.body;

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Build messages array
    const msgArray: any[] = [];

    if (messages && Array.isArray(messages)) {
      msgArray.push(...messages);
    } else {
      // Default nutrition system prompt
      msgArray.push({
        role: "system",
        content:
          "You are a precise nutrition expert. Analyze meals and return structured insights.",
      });

      msgArray.push({
        role: "user",
        content: description || "No description provided",
      });

      if (photoUrl) {
        msgArray.push({
          role: "user",
          content: [
            { type: "text", text: "Here is a meal photo to analyze:" },
            { type: "image_url", image_url: { url: photoUrl } },
          ],
        });
      }
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini", // can handle text + images
      messages: msgArray,
      max_tokens: 600,
    });

    res.status(200).json({
      reply: completion.choices[0].message,
    });
  } catch (error) {
    console.error("❌ OpenAI API error:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
}
