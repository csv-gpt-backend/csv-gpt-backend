// api/ask5.js — Vercel Serverless (Node 18+)
// SIEMPRE envía el CSV completo al modelo en cada consulta.
// GET  : /api/ask5?q=...            (lee CSV del deploy: api/data.csv o data.csv)
// POST : { q, csv }                 (si envías csv, usa ese; recomendado desde Wix)

import fs from "fs";
import path from "path";

const VERSION = "gpt5-csv-direct-v3";
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
    model: "gpt-5", // si no está habilitado, usa "gpt-4o"
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

    const isGET = req.method === "GET";
    const q = (isGET ? req.query.q : req.body?.q)?.toString().trim() || "";
    const csvInline = isGET ? null : (req.body?.csv ?? null);

    if (!q || q.toLowerCase() === "ping") return send(res, 200, { ok: true });
    if (q.toLowerCase() === "version") return send(res, 200, { version: VERSION });

    let csv, file, source;
    if (typeof csvInline === "string" && csvInline.trim()) {
      csv = csvInline; source = "inline";
    } else {
      const loaded = loadCSVFromDisk();
      csv = loaded.csv; file = loaded.file; source = loaded.source;
    }

    if (q.toLowerCase() === "diag") {
      return send(res, 200, {
        source,
        file: file || "(inline)",
        lines: csv.split(/\r?\n/).filter(Boolean).length,
        bytes: Buffer.byteLength(csv, "utf8"),
        note: "Este endpoint SIEMPRE envía el CSV completo al modelo.",
      });
    }

    const system = `
Eres analista de datos. Te enviaré el CSV completo entre <CSV>...</CSV> y una pregunta.
Responde **SOLO JSON válido** con:
{
  "respuesta": "texto claro en español",
  "tabla": { "headers": [...], "rows": [[...], ...] },   // si aplica
  "stats": { "n": <int>, "mean": <num>, "extra": {...} },// si aplica
  "debug": { "columns_detected": [...], "groups": [...]}  // breve, para ver qué columnas usaste
}
Reglas clave:
- Normaliza mayúsculas/tildes; reconoce alias. OJO: "INTERPERSONALES" e "INTRAPERSONALES" son conceptos distintos; si piden uno, no uses el otro salvo que el CSV solo contenga uno y lo expliques en "respuesta".
- "por separado" / "por paralelo" => agrupa por columna de paralelo/sección (p.ej. "PARALELO", "SECCIÓN", "CURSO", "GRUPO").
- Ranking = orden **descendente** y muestra n y promedio.
- "PROMEDIO HABILIDADES INTERPERSONALES": acepta alias "PHINTERPERSONALES" y similares.
- "PROMEDIO HABILIDADES INTRAPERSONALES": acepta alias "PHINTRAPERSONALES" y similares.
- "ASERTIVIDAD": acepta cualquier variante "asertiv".
- Conversión numérica robusta: trata "3,8" como 3.8; ignora celdas vacías/no numéricas.
- Incluye **todos** los grupos detectados (A y B). Nada de Markdown/HTML.
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
