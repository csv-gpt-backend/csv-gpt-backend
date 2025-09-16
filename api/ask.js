// api/ask.js — Vercel Serverless (Node 18+, CommonJS)
// CSV -> GPT-5 en cada consulta. CORS siempre. Health checks en JSON.

const fs = require("fs");
const path = require("path");

const VERSION = "gpt5-csv-direct-main-4"; // <- DEBE verse en ?q=version
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  cors(res);
  res.end(JSON.stringify(obj));
}

function detectDelimiter(sample) {
  const head = sample.split(/\r?\n/).slice(0, 3).join("\n");
  const counts = [
    [",", (head.match(/,/g) || []).length],
    [";", (head.match(/;/g) || []).length],
    ["\t", (head.match(/\t/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  return counts[0][1] ? counts[0][0] : ",";
}
function loadCSV() {
  const tries = [
    path.join(process.cwd(), "api", "data.csv"),
    path.join(process.cwd(), "data.csv"),
  ];
  for (const f of tries) {
    if (fs.existsSync(f)) {
      const csv = fs.readFileSync(f, "utf8");
      const delim = detectDelimiter(csv);
      const first = (csv.split(/\r?\n/).find(Boolean) || "");
      const headers = first.split(delim).map(h => h.trim());
      const rows = Math.max(0, csv.split(/\r?\n/).filter(Boolean).length - 1);
      return { csv, file: f, headers, rows, delim };
    }
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

module.exports = async (req, res) => {
  try {
    // CORS preflight
    if (req.method === "OPTIONS") { cors(res); res.statusCode = 204; return res.end(); }

    const isGET = req.method === "GET";
    const q = (isGET ? req.query.q : req.body?.q)?.toString().trim() || "";
    const csvInline = isGET ? null : (req.body?.csv ?? null);

    // ==== Health checks (SIEMPRE JSON) ====
    if (!q || q.toLowerCase() === "ping")    return send(res, 200, { ok: true });
    if (q.toLowerCase() === "version")       return send(res, 200, { version: VERSION });

    // ==== Cargar CSV (inline o del deploy) ====
    let csv, file, headers, rows;
    if (typeof csvInline === "string" && csvInline.trim()) {
      csv = csvInline; file = "(inline)";
      const delim = detectDelimiter(csv);
      headers = (csv.split(/\r?\n/).find(Boolean) || "").split(delim).map(h=>h.trim());
      rows = Math.max(0, csv.split(/\r?\n/).filter(Boolean).length - 1);
    } else {
      const loaded = loadCSV(); csv = loaded.csv; file = loaded.file; headers = loaded.headers; rows = loaded.rows;
    }
    if (q.toLowerCase() === "diag") {
      return send(res, 200, { file, rows, headers });
    }

    if (!OPENAI_API_KEY) return send(res, 500, { error: "Falta OPENAI_API_KEY en Vercel" });

    // ==== Prompt (CSV COMPLETO -> GPT, SOLO JSON) ====
    const system = `
Eres un analista de datos. Recibirás el CSV COMPLETO entre <CSV>...</CSV> y una pregunta.
Responde SOLO JSON válido con al menos:
{
  "respuesta": "texto claro en español",
  "tabla": { "headers": [...], "rows": [[...], ...] },   // si aplica
  "stats": { "n": <int>, "mean": <num>, "extra": {...} } // si aplica
}
Reglas:
- Normaliza mayúsculas/acentos; acepta sinónimos (ASERTIVIDAD, PHINTERPERSONALES, etc.).
- "por separado"/"por paralelo" => agrupa por la columna de paralelo/sección (p.ej. PARALLELO/CURSO/SECCIÓN/GRUPO).
- Ranking = orden descendente (mayor→menor) con n y promedio.
- Incluye TODOS los grupos detectados (A y B). Si la columna exacta no existe, indica el equivalente usado.
- Nada de Markdown/HTML: SOLO JSON válido.
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
};
