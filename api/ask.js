export default async function handler(req, res) {
  try {
    const q = (req.query.q || req.body?.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "Falta el parámetro q" });
    if (q.toLowerCase() === "ping") return res.status(200).json({ texto: "pong" });
    return res.status(200).json({ texto: `ok: ${q}` });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "error" });
  }
}
