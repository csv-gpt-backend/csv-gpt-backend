// api/ask.js — Vercel Serverless (Node 18+)
const fs = require("fs");
const path = require("path");

// ===== Build/version =====
const VERSION = "gpt5-csv-direct-main-15";

// ===== Modelo (forzado a GPT-5; override opcional por OPENAI_MODEL) =====
const MODEL = process.env.OPENAI_MODEL || "gpt-5";

// ===== API Key =====
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

// ---------- util ----------
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
function ensureObject(x) {
  if (!x || typeof x !== "object" || Array.isArray(x))
    return { respuesta: String(x || "").trim() || "" };
  if (typeof x.respuesta !== "string") x.respuesta = x.respuesta ? String(x.respuesta) : "";
  return x;
}
function extractFirstJSONBlock(text) {
  // intenta encontrar el primer bloque {...} balanceado
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  if (i >= 0 && j > i) {
    const cand = text.slice(i, j + 1);
    try { return JSON.parse(cand); } catch {}
  }
  return null;
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
async function askOnce({ system, user, maxTokens, timeoutMs, forceJSON }) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY en Vercel (Production).");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  const payload = {
    model: MODEL,
    max_completion_tokens: Math.max(64, Math.min(maxTokens, 1200)),
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user   },
    ],
  };
  if (forceJSON) payload.response_format = { type: "json_object" };

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ac.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    clearTimeout(timer);

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`OpenAI ${r.status}: ${t}`);
    }

    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content || "";
    return text.trim();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError")
      throw new Error(`Timeout: OpenAI tardó demasiado en responder (~${Math.round(timeoutMs/1000)}s).`);
    throw e;
  }
}

async function askOpenAIWithFallback({ system, user, maxTokens = 600, timeoutMs = 45000 }) {
  // 1) intento: JSON estricto
  let txt = await askOnce({ system, user, maxTokens, timeoutMs, forceJSON: true });
  if (!txt) {
    // 2) fallback: formato libre y extracción de JSON
    txt = await askOnce({ system, user, maxTokens: Math.max(maxTokens, 700), timeoutMs, forceJSON: false });
  }

  if (!txt) {
    return { respuesta: "El modelo no devolvió contenido. Intenta de nuevo con &max=700." };
  }

  // intentar parseo directo
  try {
    const obj = ensureObject(JSON.parse(txt));
    if (!obj.respuesta && !obj.tabla) obj.respuesta = "Resultado generado sin detalles adicionales.";
    return obj;
  } catch {
    // si no es JSON puro, intenta extraer el primer bloque JSON
    const block = extractFirstJSONBlock(txt);
    if (block) {
      const obj = ensureObject(block);
      if (!obj.respuesta && !obj.tabla) obj.respuesta = "Resultado generado (recuperado).";
      return obj;
    }
    // último recurso: envolver el texto en respuesta
    return { respuesta: txt };
  }
}

// ---------- handler ----------
module.exports = async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      setCORS(res);
      res.statusCode = 204;
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    let q = url.searchParams.get("q") || "";
    if (!q && req.method !== "GET") {
      const b = typeof req.body === "string" ? safeJSON(req.body) : (req.body || {});
      q = (b.q || "");
    }
    q = (q || "").toString().trim();
    const ql = q.toLowerCase();

    // parámetros opcionales
    const maxParam = parseInt(url.searchParams.get("max") || "", 10);
    const tParam   = parseInt(url.searchParams.get("t")   || "", 10);
    const maxTokens = Number.isFinite(maxParam) ? maxParam : 600;
    const timeoutMs = Number.isFinite(tParam)   ? tParam   : 45000;

    // health
    if (!q || ql === "ping")   return sendJSON(res, 200, { ok: true });
    if (ql === "version")      return sendJSON(res, 200, { version: VERSION });
    if (ql === "model")        return sendJSON(res, 200, { model: MODEL });

    // CSV inline o archivo
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

    if (ql === "diag") {
      return sendJSON(res, 200, {
        source: csvInfo.source, filePath: csvInfo.filePath, url: null,
        rows: csvInfo.rows, headers: csvInfo.headers
      });
    }

    // Prompt reforzado
    const system = `
Eres un analista de datos. Devuelve SIEMPRE JSON válido y conciso:
{
  "respuesta": "texto breve en español",
  "tabla": { "headers": [..], "rows": [[..], ..] }
}
Reglas:
- El CSV viene entre <CSV>...</CSV>. La primera fila son encabezados.
- Acepta sinónimos (acentos/mayúsculas); "por separado" = agrupar por "PARALELO".
- "ranking" => como máximo 10 filas (mayor→menor) e incluye una columna "posición".
- "grupos" o "equipos" => devuelve tabla con headers ["Grupo","NOMBRE"]; crea grupos homogéneos de 5 (el último puede tener menos). Si mencionan dos variables (p.ej. AGRESION y EMPATIA), equilibra ambas.
- Si la consulta es inválida o no hay datos, responde {"respuesta":"No encontrado"}.
- No devuelvas Markdown ni texto fuera del JSON.`;

    const user = `<CSV>
${csvInfo.csv}
</CSV>

Pregunta:
${q}`;

    const out = await askOpenAIWithFallback({ system, user, maxTokens, timeoutMs });
    return sendJSON(res, 200, out);

  } catch (err) {
    return sendJSON(res, 500, { error: String(err.message || err) });
  }
};
