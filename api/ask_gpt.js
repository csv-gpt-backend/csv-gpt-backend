// /api/ask_gpt.js — Vercel Serverless (Node 18+)
// SIEMPRE manda el CSV completo a GPT en cada consulta.
// Modo A: POST { q, csv } -> usa ese CSV (recomendado)
// Modo B: sin csv -> lee api/data.csv o data.csv y lo sube al modelo

import fs from "fs";
import path from "path";

const VERSION = "gpt5-csv-direct-v2";
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

function send(res, code, obj) {
  res.status(code).setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(obj));
}

function loadCSVFromDisk() {
  const candidates = [
    path.join(process.cwd(), "api", "data.csv"),
    path.join(process.cwd(), "data.csv"),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      return { csv: fs.readFileSync(f, "utf8"), file: f, source: "file" };
    }
  }
  throw new Error("CSV no encontrado (api/data.csv o data.csv).");
}

async function callOpenAI(system, user) {
  const payload = {
    model: "gpt-5",           // si no lo tienes, usa "gpt-4o"
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(text); } catch { return { respuesta: text }; }
}

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return res.status(204).end();
    }
    if (!OPENAI_API_KEY) return send(res, 500, { error: "Falta OPENAI_API_KEY" });

    // Entradas
    const isGET = req.method === "GET";
    const q = (isGET ? req.query.q : req.body?.q)?.toString().trim() || "";
    const csvInline = isGET ? null : (req.body?.csv ?? null);

    // Endpoints de prueba
    if (!q || q.toLowerCase() === "ping") return send(res, 200, { ok: true });
    if (q.toLowerCase() === "version") return send(res, 200, { version: VERSION });

    // Obtener CSV final (inline o disco)
    let csv, file, source;
    if (typeof csvInline === "string" && csvInline.trim()) {
      csv = csvInline;
      source = "inline";
    } else {
      const loaded = loadCSVFromDisk();
      csv = loaded.csv; file = loaded.file; source = loaded.source;
    }

    if (q.toLowerCase() === "diag") {
      return send(res, 200, {
        source,
        file: file || "(inline)",
        bytes: Buffer.byteLength(csv, "utf8"),
        lines: csv.split(/\r?\n/).filter(Boolean).length,
        hint: "Este endpoint SIEMPRE envía el CSV completo al modelo.",
      });
    }

    // Prompt SIEMPRE con el CSV completo
    const system = `
Eres un analista de datos. Recibirás un CSV completo entre <CSV>...</CSV> y una pregunta.
Responde SIEMPRE en JSON válido con esta forma mínima:
{
  "respuesta": "texto claro y corto en español",
  "tabla": { "headers": [...], "rows": [[...], ...] },  // si aplica
  "stats": { "n": <int>, "mean": <num>, "extra": {...} } // si aplica
}
Reglas:
- Normaliza mayúsculas/acentos y acepta sinónimos de columnas.
- "por separado" o "por paralelo" => agrupa por la columna de paralelo/sección (A y B).
- En rankings, orden descendente (mayor→menor) y muestra n y promedio.
- "PROMEDIO HABILIDADES INTERPERSONALES" acepta alias como PHINTERPERSONALES.
- "ASERTIVIDAD" acepta cualquier variante "asertiv".
- Incluye TODOS los grupos detectados (A y B). No omitas ninguno.
- Si la columna no existe, di cuál usaste como equivalente.
- Nada de Markdown/HTML. SOLO JSON válido.
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

export const config = { runtime: "nodejs" };
