// api/ask.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Modelo por defecto (puedes ajustar por env var)
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
// Origen permitido (ajústalo a tu dominio Wix para más seguridad)
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJSON(res, status, obj) {
  setCors(res);
  res.status(status).json(obj);
}

async function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const raw = Buffer.concat(chunks).toString("utf8") || "{}";
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  let q = "";

  if (req.method === "GET") {
    q = (req.query?.q || "").toString().trim();
  } else if (req.method === "POST") {
    const body = await getBody(req);
    q = (body?.q || "").toString().trim();
  } else {
    return sendJSON(res, 405, { ok: false, error: "Método no permitido" });
  }

  // Respuesta de salud
  if (q && q.toLowerCase() === "ping") {
    return sendJSON(res, 200, { ok: true, respuesta: "pong" });
  }

  if (!q) {
    return sendJSON(res, 400, { ok: false, error: "Falta el parámetro 'q'." });
  }

  // Diagnóstico
  if (q.toLowerCase() === "diag") {
    return sendJSON(res, 200, {
      ok: true,
      model: MODEL,
      mode: "chat.completions",
      originAllowed: ALLOW_ORIGIN,
      note: "Si ves esto, el backend está bien.",
    });
  }

  try {
    const systemPrompt =
      "Eres un analista de datos educativos. Responde en español, claro y conciso (6–8 líneas máximo). Si no dispones de datos suficientes, dilo explícitamente.";

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: q },
      ],
      temperature: 0.2,
    });

    const text =
      completion.choices?.[0]?.message?.content?.trim() || "(sin respuesta)";
    return sendJSON(res, 200, { ok: true, respuesta: text });
  } c
