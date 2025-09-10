export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST requests allowed" });
  }

  res.status(200).json({
    ok: true,
    message: "Vercel endpoint is working!",
    timestamp: new Date().toISOString()
  });
}
