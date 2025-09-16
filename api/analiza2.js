// api/analiza2.js  (Wrapper + CORS + ping)

import handler from "./analiza.js";

export default async function analiza2(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const q = (req.query?.q || req.body?.q || "").toString().trim();
  if (q.toLowerCase() === "ping") {
    res.status(200).json({ ok: true, respuesta: "pong" });
    return;
  }
  return handler(req, res);
}
