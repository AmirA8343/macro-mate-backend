export default async function handler(req: any, res: any) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  // Check that the environment variable exists
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, message: "OPENAI_API_KEY missing" });
  }

  // Get description/photo from request
  const { description, photoUrl } = req.body;

  // Just return them back for testing
  res.status(200).json({
    ok: true,
    message: "Endpoint working! Environment variable exists.",
    description: description || null,
    photoUrl: photoUrl || null,
  });
}
