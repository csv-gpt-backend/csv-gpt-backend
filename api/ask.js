// api/ask.js — Vercel Serverless (Node 18+)
// Reemplaza el endpoint antiguo. Ahora SIEMPRE manda el CSV completo a GPT.
// GET  /api/ask?q=...   (usa el CSV del deploy)
// POST /api/ask         (opcional: { q, csv } para enviar CSV en el body)

import fs from "fs";
import path from "path";

const VERSION = "gpt5-csv-direct-main";
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

function send(res, code, obj) {
  res.status(code).setHeader("Content-Type", "application/json");
  // CORS SIEMPRE
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(obj));
}

function loadCSVFromDisk() {
  const tries = [
    path.join(process.cwd(), "api", "data.csv"),
    path.join(process.cwd(), "data.csv"),
  ];
  for (const f of tries) {
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
    // Preflight CORS
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

    // Endpoints de prueba (DEVUELVEN JSON)
    if (!q || q.toLowerCase() === "ping")   return send(res, 200, { ok: true });
    if (q.toLowerCase() === "version")      return send(res, 200, { version: VERSION });

    // CSV final (inline si viene por POST; si no, leer del deploy)
    let csv, file, source;
    if (typeof csvInline === "string" && csvInline.trim()) {
      csv = csvInline; source = "inline";
    } else {
      const loaded = loadCSVFromDisk();
      csv = loaded.csv; file = loaded.file; source = loaded.source;
    }

    if (q.toLowerCase() === "diag") {
      return send(res, 200, {
        version: VERSION,
        source,
        file: file || "(inline)",
        lines: csv.split(/\r?\n/).filter(Boolean).length,
        bytes: Buffer.byteLength(csv, "utf8"),
        note: "Este endpoint envía el CSV completo al modelo en cada consulta.",
      });
    }

    // ===== Prompt (CSV → GPT, SOLO JSON) =====
    const system = `
Eres un analista de datos. Recibirás el CSV completo entre <CSV>...</CSV> y una pregunta.
Responde **solo JSON válido** con esta forma mínima:
{
  "respuesta": "texto claro en español",
  "tabla": { "headers": [...], "rows": [[...], ...] },   // si aplica
  "stats": { "n": <int>, "mean": <num>, "extra": {...} } // si aplica
}
Reglas:
- Normaliza mayúsculas/tildes y acepta sinónimos de columnas.
- "por separado"/"por paralelo" => agrupa por la columna de paralelo/sección (A y B).
- Ranking = orden descendente (mayor→menor) con n y promedio.
- "PROMEDIO HABILIDADES INTERPERSONALES": acepta alias como PHINTERPERSONALES.
- "ASERTIVIDAD": acepta cualquier variante "asertiv".
- Incluye TODOS los grupos detectados. Si la columna exacta no existe, di el equivalente usado.
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

export const config = { runtime: "nodejs" };
