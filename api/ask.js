// /api/ask.js
// Analiza un CSV completo y responde con texto. Incluye rutas de diagnóstico y timeout.
// 2025-09-17 – versión con "ping" rápido + timeout + mensajes claros.

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { ts, text }

// ---------- Utilidades ----------
function safeFileParam(s, def = "decimo.csv") {
  const x = (s || "").toString().trim();
  if (!x) return def;
  if (x.includes("..") || x.includes("/") || x.includes("\\")) return def;
  return x;
}

async function getCSVText(publicUrl) {
  const hit = cache.get(publicUrl);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_MS) return hit.text;
  const r = await fetch(publicUrl);
  if (!r.ok) throw new Error(`No pude leer CSV ${publicUrl} (HTTP ${r.status})`);
  const text = await r.text();
  cache.set(publicUrl, { ts: now, text });
  return text;
}

function detectDelim(line) {
  if (!line) return ",";
  if (line.includes(";")) return ";";
  if (line.includes("\t")) return "\t";
  if (line.includes("|")) return "|";
  return ",";
}

// ---------- OpenAI con timeout ----------
async function callOpenAI(messages, timeoutMs = 45000) {
  if (!API_KEY) {
    return { ok: false, text: "Falta configurar OPENAI_API_KEY en Vercel." };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let r, data;
  try {
    r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.35,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      console.error("[OpenAI] Timeout");
      return { ok: false, text: "OpenAI tardó demasiado (timeout)." };
    }
    console.error("[OpenAI] Error de red:", err);
    return { ok: false, text: `Error llamando a OpenAI: ${String(err)}` };
  }

  try {
    data = await r.json();
  } catch (e) {
    console.error("[OpenAI] No se pudo parsear JSON:", e);
    const raw = await r.text().catch(() => "");
    return {
      ok: false,
      text: `OpenAI devolvió una respuesta no válida (HTTP ${r.status}). ${raw}`,
    };
  }

  if (!r.ok) {
    const detail = data?.error?.message || JSON.stringify(data);
    console.error("[OpenAI] HTTP", r.status, detail);
    return { ok: false, text: `OpenAI ${r.status}: ${detail}` };
  }

  const text =
    data?.choices?.[0]?.message?.content?.trim() ||
    `No pude consultar OpenAI (HTTP ${r.status}).`;
  return { ok: true, text };
}

// ---------- Prompts ----------
function systemPromptText() {
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Recibirás un CSV completo con columnas variables (no asumas nombres fijos).",
    "Instrucciones:",
    "1) Detecta el delimitador (coma/; /tab/|) y analiza la tabla tal cual.",
    "2) Si preguntan por una persona, localízala por coincidencia del nombre en cualquier columna.",
    "3) No inventes datos: basar todo en el CSV entregado. Si falta info, dilo.",
    "4) Responde breve (~150-180 palabras), tono profesional, en español (MX).",
    "5) No describas asteriscos ni marcas tipográficas; omítelos en la lectura.",
  ].join(" ");
}

function userPromptText(query, csvText) {
  const first = (csvText.split(/\r?\n/)[0] || "").slice(0, 500);
  const delim = detectDelim(first);
  return [
    `PREGUNTA: ${query}`,
    "",
    `DELIMITADOR_APROX: ${JSON.stringify(delim)}`,
    "",
    "A continuación va el CSV completo entre triple backticks. Analízalo tal cual:",
    "```csv",
    csvText,
    "```",
  ].join("\n");
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    const qRaw = (req.query.q || req.body?.q || "").toString();
    const q = qRaw.trim() || "ping";

    const file = safeFileParam(req.query.file || req.query.f || "decimo.csv");

    // Construye URL pública para leer el CSV
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers.host;
    const publicUrl = `${proto}://${host}/datos/${encodeURIComponent(file)}`;

    // -------- RUTA RÁPIDA DE DIAGNÓSTICO (sin OpenAI) --------
    if (q.toLowerCase() === "ping") {
      let csvText = "";
      let lines = 0;
      try {
        csvText = await getCSVText(publicUrl);
        lines = csvText.split(/\r?\n/).filter(Boolean).length;
      } catch (e) {
        console.error("[PING] No pude leer CSV:", e);
        return res.status(200).json({
          text: `pong (sin CSV). Error al leer CSV: ${String(e)}`,
          archivo: file,
          filas_aprox: 0,
          formato: "texto",
        });
      }
      return res.status(200).json({
        text: `pong (CSV OK). Archivo ${file} con ~${lines} filas.`, 
        archivo: file,
        filas_aprox: lines,
        formato: "texto",
      });
    }

    // Lee CSV (si falla, devolvemos error claro)
    let csvText = "";
    try {
      csvText = await getCSVText(publicUrl);
    } catch (e) {
      console.error("[ASK] No pude leer CSV:", e);
      return res.status(502).json({
        text: `No pude leer el CSV (${file}). ${String(e)}`,
        archivo: file,
        filas_aprox: 0,
        formato: "texto",
      });
    }
    const lines = csvText.split(/\r?\n/).filter(Boolean).length;

    // Prepara prompts
    const messages = [
      { role: "system", content: systemPromptText() },
      { role: "user", content: userPromptText(q, csvText) },
    ];

    // Llamada a OpenAI con timeout
    const ai = await callOpenAI(messages, 45000);

    if (!ai.ok) {
      // Responde con código explícito para que el front no quede colgado
      const msg = ai.text || "Error desconocido llamando a OpenAI.";
      console.error("[ASK] Respuesta con error:", msg);
      return res.status(504).json({
        text: `No se pudo obtener respuesta de OpenAI. ${msg}`,
        archivo: file,
        filas_aprox: lines,
        formato: "texto",
      });
    }

    // OK
    return res.status(200).json({
      text: ai.text,
      archivo: file,
      filas_aprox: lines,
      formato: "texto",
    });
  } catch (e) {
    console.error("[ASK] Error no controlado:", e);
    return res.status(500).json({
      text: `Error interno en /api/ask: ${String(e)}`,
      formato: "texto",
    });
  }
}
