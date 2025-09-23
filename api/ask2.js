// /api/ask2.js  — prueba mínima
export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    res.status(200).json({
      ok: true,
      endpoint: "ask2",
      msg: "alive",
      method: req.method || "GET"
    });
  } catch (err) {
    res.status(500).json({ ok: false, where: "ask2-min", error: String(err?.message || err) });
  }
}
