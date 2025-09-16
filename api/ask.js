// api/ask.js — Vercel Serverless (Node 18+, ESM)
// CSV → GPT-5 en cada consulta. CORS siempre. Health checks en JSON.

import fs from "fs";
import path from "path";

const VERSION = "gpt5-csv-direct-main-3"; // <- DEBE verse en ?q=version
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function send(res, code, obj) {
  res.status(code);
  res.setHeader("Content-Type", "application/json");
  cors(res);
  res.end(JSON.stringify(obj));
}

function loadCSV() {
  const tries = [
    path.join(process.cwd(), "api", "data.csv"),
    path.join(process.cwd(), "data.csv"),
  ];
  for (const f of tries) {
    if (fs.existsSync(f)) return { csv: fs.readFileSync(f, "utf8"), file: f };
  }
  throw new Error("CSV no encontrado (api/data.csv o data.csv).");
}

async function callOpenAI(system, user) {
  const payload = {
    model: "gpt-5", // si no está habilitado en tu cuenta, usa "gpt-4o"
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(text); } catch { return { respuesta: text }; }
}

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") { cors(res); return res.status(204).end(); }

    const isGET = req.method === "GET";
    const q = (isGET ? req.query.q : req.body?.q)?.toString().trim() || "";
    const csvInline = isGET ? null : (req.body?.csv ?? null);

    // Health checks (siempre JSON)
    if (!q || q.toLowerCase() === "ping")    return send(res, 200, { ok: true });
    if (q.toLowerCase() === "version")       return send(res, 200, { version: VERSION });

    // Cargar CSV (inline o disco)
    let csv, file;
    if (typeof csvInline === "string" && csvInline.trim()) {
      csv = csvInline; file = "(inline)";
    } else {
      const loaded = loadCSV(); csv = loaded.csv; file = loaded.file;
    }
    if (q.toLowerCase() === "diag") {
      return send(res, 200, {
        version: VERSION, file,
        lines: csv.split(/\r?\n/).filter(Boolean).length,
        bytes: Buffer.byteLength(csv, "utf8"),
        note: "Este endpoint manda el CSV completo al modelo en cada consulta."
      });
    }

    if (!OPENAI_API_KEY) return send(res, 500, { error: "Falta OPENAI_API_KEY" });

    // Prompt CSV → GPT (solo JSON)
    const system = `
Eres un analista de datos. Recibirás el CSV COMPLETO entre <CSV>...</CSV> y una pregunta.
Responde SOLO JSON válido:
{
  "respuesta": "texto claro en español",
  "tabla": { "headers": [...], "rows": [[...], ...] },   // si aplica
  "stats": { "n": <int>, "mean": <num>, "extra": {...} } // si aplica
}
Reglas:
- Normaliza mayúsculas/tildes y acepta sinónimos (ASERTIVIDAD, PHINTERPERSONALES, etc.).
- "por separado"/"por paralelo" => agrupa por columna de paralelo/sección (A y B).
- Ranking = orden descendente (mayor→menor) con n y promedio.
- Incluye TODOS los grupos detectados. Si la columna exacta no existe, indica el equivalente usado.
- Nada de Markdown/HTML. SOLO JSON exacto.
`.trim();

    const user = `
<CSV>
${csv}
</CSV>

Pregunta:
${q}
`.trim();

    const out = await callOpenAI(system, user);
    return send(res, 200, out);
  } catch (err) {
    return send(res, 500, { error: String(err.message || err) });
  }
}

export const config = { runtime: "nodejs18.x" };
