export default async function handler(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: "API key not found" });
  }

  res.status(200).json({ ok: true, message: "Vercel sees your API key!" });
}
