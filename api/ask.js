// api/ask.js
export default async function handler(req, res) {
  const q = (req.query.q || "").toString().trim();

  if (!q) {
    return res.status(400).json({ error: "Falta el parámetro q" });
  }

  if (q.toLowerCase() === "ping") {
    return res.status(200).json({ texto: "pong" });
  }

  return res.status(200).json({ texto: `ok: ${q}` });
}
