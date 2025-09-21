export default function handler(req, res) {
  const q = (req.query.q || "").toString();
  if (q.toLowerCase() === "ping") {
    return res.status(200).json({ texto: "pong" });
  }
  res.status(200).json({ texto: `Recibí: ${q}` });
}
