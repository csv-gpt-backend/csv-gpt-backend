// /api/ask_gpt.js  — Vercel Serverless (Node)
// Requiere: OPENAI_API_KEY en Vercel
import fs from "fs";
import path from "path";

const VERSION = "gpt5-csv-direct-v1";
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

function send(res, code, obj) {
  res.status(code).setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(obj));
}

function detectDelimiter(sample) {
  const first = sample.split(/\r?\n/).slice(0, 3).join("\n");
  const counts = [
    [",", (first.match(/,/g) || []).length],
    [";", (first.match(/;/g) || []).length],
    ["\t", (first.match(/\t/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  return counts[0][1] ? counts[0][0] : ",";
}

let cached = {
  csv: null,
  file: null,
  headers: null,
  rows: 0,
  delim: ",",
};

function loadCSV() {
  const candidates = [
    path.join(process.cwd(), "api", "data.csv"),
    path.join(process.cwd(), "data.csv"),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      const csv = fs.readFileSync(f, "utf8");
      const delim = detectDelimiter(csv);
      const firstLine = (csv.split(/\r?\n/).find(Boolean) || "");
      const headers = firstLine.split(delim).map((h) => h.trim());
      const rows = csv.split(/\r?\n/).filter((l) => l.trim()).length - 1;
      cached = { csv, file: f, headers, rows: Math.max(0, rows), delim };
      return;
    }
  }
  throw new Error("CSV no encontrado (buscado en api/data.csv y data.csv).");
}

async function chatJSON({ system, user }) {
  const payload = {
    model: "gpt-5", // usa tu modelo; si no está, reemplaza por 'gpt-4o'
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
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI HTTP ${r.status}: ${t}`);
  }
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { respuesta: text };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return res.status(204).end();
    }

    if (!OPENAI_API_KEY) {
      return send(res, 500, { error: "Falta OPENAI_API_KEY en Vercel" });
    }

    if (!cached.csv) loadCSV();

    const q =
      (req.method === "GET" ? req.query.q : req.body?.q)?.toString().trim() || "";

    // Rutas rápidas sin GPT
    if (!q || q.toLowerCase() === "ping") return send(res, 200, { ok: true });
    if (q.toLowerCase() === "version")
      return send(res, 200, { version: VERSION });
    if (q.toLowerCase() === "diag")
      return send(res, 200, {
        file: cached.file,
        rows: cached.rows,
        headers: cached.headers,
        delimiter: cached.delim === "\t" ? "TAB" : cached.delim,
      });

    // --- Prompt que ENVÍA EL CSV COMPLETO EN CADA CONSULTA ---
    const system = `
Eres un analista de datos. Recibirás un CSV completo (encerrado entre <CSV>...</CSV>) y una
pregunta del usuario. Debes calcular con precisión y responder en **JSON válido** con esta forma:

{
  "respuesta": "texto corto y claro en español",
  "tabla": { "headers": [..], "rows": [ [..], [..] ] },   // opcional si aplica
  "stats": { "n": <int>, "mean": <num>, "extra": {...} }  // opcional si aplica
}

Reglas:
- No inventes columnas; normaliza MAYÚSCULAS/acentos y acepta sinónimos comunes.
- "por separado" o "por paralelo" => agrupa por columna de paralelo/sección (ej.: "PARALELO", "CURSO", "SECCIÓN").
- Si piden ranking, ordena **descendente** y muestra n y promedio.
- Si la métrica es "PROMEDIO HABILIDADES INTERPERSONALES", acepta aliases como:
  "PHINTERPERSONALES", "PROMEDIO_INTERPERSONALES", etc.
- Incluye **todos** los grupos detectados (p.ej., Décimo A y Décimo B). Nunca omitas uno.
- Cuando pidan "muestra el cálculo", añade en "respuesta" el detalle (fórmula y números).
- Si la columna exacta no existe, indica cuál encontraste como equivalente.
- Nada de Markdown ni tablas HTML. **Solo JSON** exacto.
`.trim();

    const user = `
<CSV>
${cached.csv}
</CSV>

Pregunta:
${q}
`.trim();

    const out = await chatJSON({ system, user });
    return send(res, 200, out);
  } catch (err) {
    return send(res, 500, { error: String(err.message || err) });
  }
}

export const config = { runtime: "nodejs" };
