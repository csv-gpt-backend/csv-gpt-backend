// api/ask.js
module.exports = (req, res) => {
  const q = (req.query.q || req.body?.q || "").toString().trim();
  if (!q || q.toLowerCase() === "ping") {
    return res.status(200).json({ texto: "pong" });
  }
  return res.status(200).json({ texto: `ok: ${q}` });
};
