import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const results: any = {};

  try {
    // 🔹 Test Nutritionix
    const nutritionix = await fetch("https://trackapi.nutritionix.com/v2/natural/nutrients", {
      method: "POST",
      headers: {
        "x-app-id": process.env.NUTRITIONIX_APP_ID || "",
        "x-app-key": process.env.NUTRITIONIX_APP_KEY || "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "1 egg" }),
    });

    results.nutritionix = {
      status: nutritionix.status,
      ok: nutritionix.ok,
      message: nutritionix.ok ? "✅ Nutritionix works" : "❌ Nutritionix failed",
    };
  } catch (e: any) {
    results.nutritionix = { error: e.message };
  }

  try {
    // 🔹 Test OpenAI
    const openai = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    });

    results.openai = {
      status: openai.status,
      ok: openai.ok,
      message: openai.ok ? "✅ OpenAI works" : "❌ OpenAI failed",
    };
  } catch (e: any) {
    results.openai = { error: e.message };
  }

  try {
    // 🔹 Test OpenFoodFacts (no key needed)
    const off = await fetch("https://world.openfoodfacts.org/cgi/search.pl?search_terms=apple&search_simple=1&json=1&page_size=1");
    results.openfoodfacts = {
      status: off.status,
      ok: off.ok,
      message: off.ok ? "✅ OpenFoodFacts works" : "❌ OpenFoodFacts failed",
    };
  } catch (e: any) {
    results.openfoodfacts = { error: e.message };
  }

  return res.status(200).json(results);
}
