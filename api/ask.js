// api/ask.js — Vercel Serverless (Node 18+)
const fs = require("fs");
const path = require("path");

// === Build/version ===
const VERSION = "gpt5-csv-direct-main-8";

// === Modelo (forzado a GPT-5, con override opcional por env) ===
const MODEL = process.env.OPENAI_MODEL || "gpt-5";

// === API Key ===
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

// ---------- helpers de respuesta ----------
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
}
function sendJSON(res, code, obj) {
  setCORS(res);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
function safeJSON(x, fallback = {}) {
  try { return typeof x === "string" ? JSON.parse(x) : (x || fallback); }
  catch { return fallback; }
}

// ---------- CSV ----------
function detectDelimiter(sample) {
  const head = sample.split(/\r?\n/).slice(0, 3).join("\n");
  const counts = [
    [",", (head.match(/,/g) || []).length],
    [";", (head.match(/;/g) || []).length],
    ["\t", (head.match(/\t/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  return counts[0][1] ? counts[0][0] : ",";
}
function loadCSVFromFS() {
  const tries = [
    path.join(process.cwd(), "api", "data.csv"),
    path.join(process.cwd(), "data.csv"),
  ];
  for (const filePath of tries) {
    if (fs.existsSync(filePath)) {
      const csv = fs.readFileSync(filePath, "utf8");
      const d = detectDelimiter(csv);
      const headerLine = (csv.split(/\r?\n/).find(Boolean) || "");
      const headers = headerLine.split(d).map(s => s.trim());
      const rows = Math.max(0, csv.split(/\r?\n/).filter(Boolean).length - 1);
      return { csv, filePath, rows, headers, source: "fs" };
    }
  }
  throw new Error("CSV no encontrado. Sube api/data.csv o data.csv al repo.");
}

// ---------- OpenAI ----------
async function askOpenAI({ system, user }) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY en Vercel (Production).");

  const payload = {
    model: MODEL,                         // ← GPT-5 (o lo que pongas en OPENAI_MODEL)
    temperature: 1,
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
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI ${r.status}: ${t}`);
  }

  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(text); }
  catch { return { respuesta: text }; }
}

// ---------- handler ----------
module.exports = async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      setCORS(res);
      res.statusCode = 204;
      return res.end();
    }

    // Query param "q" (GET) o body.q (POST)
    let q = "";
    try {
      q = new URL(req.url, `http://${req.headers.host}`).searchParams.get("q") || "";
    } catch {}
    if (!q && req.method !== "GET") {
      const b = typeof req.body === "string" ? safeJSON(req.body) : (req.body || {});
      q = (b.q || "");
    }
    q = (q || "").toString().trim();
    const ql = q.toLowerCase();

    // ---- Health checks / utilidades ----
    if (!q || ql === "ping")   return sendJSON(res, 200, { ok: true });
    if (ql === "version")      return sendJSON(res, 200, { version: VERSION });
    if (ql === "model")        return sendJSON(res, 200, { model: MODEL });

    // ---- CSV: inline (POST.csv) o desde archivo ----
    let csvInfo;
    if (req.method !== "GET") {
      const body = typeof req.body === "string" ? safeJSON(req.body) : (req.body || {});
      if (typeof body.csv === "string" && body.csv.trim()) {
        const csv = body.csv;
        const d = detectDelimiter(csv);
        const headerLine = (csv.split(/\r?\n/).find(Boolean) || "");
        const headers = headerLine.split(d).map(s => s.trim());
        const rows = Math.max(0, csv.split(/\r?\n/).filter(Boolean).length - 1);
        csvInfo = { csv, filePath: "(inline)", rows, headers, source: "inline" };
      }
    }
    if (!csvInfo) csvInfo = loadCSVFromFS();

    // Diagnóstico rápido
    if (ql === "diag") {
      return sendJSON(res, 200, {
        source: csvInfo.source,
        filePath: csvInfo.filePath,
        url: null,
        rows: csvInfo.rows,
        headers: csvInfo.headers,
      });
    }

    // ---- Prompt para análisis directo del CSV ----
    const system = `
Eres un analista de datos. Devuelve SIEMPRE un JSON válido con esta forma:
{
  "respuesta": "texto claro en español",
  "tabla": { "headers": [..], "rows": [[..], ..] },
  "stats": { "n": <int>, "mean": <number> }
}
- Te paso el CSV completo entre <CSV>...</CSV>. La primera fila son encabezados.
- Acepta variantes y sinónimos (acentos, mayúsculas).
- "por separado" / "por paralelo" => agrupa por la columna de paralelo (A, B, etc.).
- "ranking" => ordena de mayor a menor e incluye la posición (1,2,3...).
- Si piden "¿NOMBRE está sobre el promedio...?" calcula y muestra el promedio del grupo y el valor de esa persona.
- Cuando convenga, retorna "tabla" con headers/rows; si no aplica, puedes omitirla.
- Nunca devuelvas Markdown ni texto fuera del JSON.`;

    const user = `<CSV>
${csvInfo.csv}
</CSV>

Pregunta:
${q}`;

    const out = await askOpenAI({ system, user });
    return sendJSON(res, 200, out);

  } catch (err) {
    return sendJSON(res, 500, { error: String(err.message || err) });
  }
};
