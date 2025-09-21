export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  const q = (req.query.q || "").toString();
  if (!q || q.toLowerCase() === "ping") {
    return res.status(200).json({ texto: "pong" });
  }
  return res.status(200).json({ texto: `ok: ${q}` });
}
