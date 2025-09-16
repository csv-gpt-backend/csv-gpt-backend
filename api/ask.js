// api/ask.js — Vercel Serverless (Node 18+, CommonJS)
// ✔ CORS + no-store
// ✔ Health checks JSON: ping / version / diag (short-circuit al inicio)
// ✔ Lee CSV (api/data.csv o data.csv) y lo envía COMPLETO al modelo en cada consulta

const fs = require("fs");
const path = require("path");

const VERSION = "gpt5-csv-direct-main-6"; // <- DEBE verse en ?q=version
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

/* ---------- utils ---------- */
function setCommonHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
}
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  setCommonHeaders(res);
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
      return { csv, filePath: f, rows, headers };
    }
  }
  throw new Error("CSV no encontrado (api/data.csv o data.csv).");
}
async function callOpenAI(system, user) {
  const payload = {
    model: "gpt-5", // si tu cuenta no lo tiene, usa "gpt-4o"
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

/* ---------- handler ---------- */
module.exports = async (req, res) => {
  try {
    if (req.method === "OPTIONS") { setCommonHeaders(res); res.statusCode = 204; return res.end(); }

    // Obtener 'q' de forma robusta (también desde la URL por si el framework no parsea)
    let q = "";
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      q = url.searchParams.get("q") || q;
    } catch {}
    const bodyQ = req.method !== "GET" ? (req.body?.q || "") : "";
    if (!q && bodyQ) q = bodyQ;
    q = (q || "").toString().trim();
    const ql = q.toLowerCase();

    // ---- SHORT-CIRCUIT: health checks, SIEMPRE JSON ----
    if (!q || ql === "ping")     return send(res, 200, { ok: true });
    if (ql === "version")        return send(res, 200, { version: VERSION });

    // ---- CSV (inline o disco) ----
    let csv, filePath, rows, headers, source = "fs";
    const url = new URL(req.url, `http://${req.headers.host}`);
    const csvInline = req.method !== "GET" ? (req.body?.csv ?? null) : null;

    if (typeof csvInline === "string" && csvInline.trim()) {
      csv = csvInline; filePath = "(inline)"; source = "inline";
      const delim = detectDelimiter(csv);
      headers = (csv.split(/\r?\n/).find(Boolean) || "").split(delim).map(h=>h.trim());
      rows = Math.max(0, csv.split(/\r?\n/).filter(Boolean).length - 1);
    } else {
      const loaded = loadCSV();
      csv = loaded.csv; filePath = loaded.filePath; rows = loaded.rows; headers = loaded.headers;
    }

    if (ql === "diag") {
      return send(res, 200, { source, filePath, url: null, rows, headers });
    }

    if (!OPENAI_API_KEY) return send(res, 500, { error: "Falta OPENAI_API_KEY en Vercel" });

    // ---- CSV → GPT (solo JSON) ----
    const system = `
Eres un analista de datos. Recibirás el CSV COMPLETO entre <CSV>...</CSV> y una pregunta.
Responde SOLO JSON válido:
{
  "respuesta": "texto claro en español",
  "tabla": { "headers": [...], "rows": [[...], ...] },   // si aplica
  "stats": { "n": <int>, "mean": <num>, "extra": {...} } // si aplica
}
Reglas:
- Normaliza mayúsculas/acentos; acepta sinónimos (ASERTIVIDAD, PHINTERPERSONALES, etc.).
- "por separado"/"por paralelo" => agrupa por columna de paralelo/sección (A y B).
- Ranking = orden descendente (mayor→menor) con n y promedio.
- Incluye TODOS los grupos detectados. Si la columna exacta no existe, indica el equivalente usado.
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
};
