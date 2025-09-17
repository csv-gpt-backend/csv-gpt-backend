// /api/ask.js
// Analiza un CSV completo (columnas variables) “tal cual” se sube, sin fijar encabezados.
// Lee /public/datos/<file>.csv por URL (cache 5 min). Devuelve texto para tu voz,
// y opcionalmente JSON estructurado si usas ?format=json.

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { ts, text }

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

function systemPromptText() {
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Recibirás un CSV completo con columnas variables (no asumas nombres fijos).",
    "Instrucciones:",
    "1) Detecta el delimitador (coma/; /tab/|) y analiza la tabla tal cual.",
    "2) Si preguntan por una persona, localízala por coincidencia del nombre en cualquier columna.",
    "3) No inventes datos: basar todo en el CSV entregado. Si falta info, dilo.",
    "4) Responde breve (~150-180 palabras), tono profesional, en español (MX).",
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

function systemPromptJSON() {
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Recibirás un CSV completo con columnas variables.",
    "Objetivo: entregar un RESUMEN ESTRUCTURADO en JSON con estas claves exactas:",
    'diagnostico (string corto),',
    'fortalezas (array de strings),',
    'oportunidades (array de strings),',
    'recomendaciones_corto_plazo (array de strings),',
    'recomendaciones_mediano_plazo (array de strings),',
    'riesgos (array de strings).',
    "No inventes datos. Si faltan, indícalo de forma explícita.",
    "Devuelve SOLO el JSON (sin texto adicional).",
  ].join(" ");
}

function userPromptJSON(query, csvText) {
  const first = (csvText.split(/\r?\n/)[0] || "").slice(0, 500);
  const delim = detectDelim(first);
  return [
    `PREGUNTA: ${query}`,
    `DELIMITADOR_APROX: ${JSON.stringify(delim)}`,
    "CSV completo entre triple backticks:",
    "```csv",
    csvText,
    "```",
  ].join("\n");
}

async function callOpenAI(messages) {
  if (!API_KEY) {
    return { ok: false, text: "Falta configurar OPENAI_API_KEY en Vercel." };
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.35, // más consistente
    }),
  });
  const data = await r.json().catch(() => null);
  const text =
    data?.choices?.[0]?.message?.content?.trim() ||
    `No pude consultar OpenAI (HTTP ${r.status}).`;
  return { ok: true, text };
}

export default async function handler(req, res) {
  try {
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";
    const file = safeFileParam(req.query.file || req.query.f || "decimo.csv");
    const format = (req.query.format || "").toString().toLowerCase(); // "json" | ""

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const publicUrl = `${proto}://${host}/datos/${encodeURIComponent(file)}`;

    const csvText = await getCSVText(publicUrl);
    const lines = csvText.split(/\r?\n/).filter(Boolean).length;

    let messages;
    if (format === "json") {
      messages = [
        { role: "system", content: systemPromptJSON() },
        { role: "user", content: userPromptJSON(q, csvText) },
      ];
    } else {
      messages = [
        { role: "system", content: systemPromptText() },
        { role: "user", content: userPromptText(q, csvText) },
      ];
    }

    const ai = await callOpenAI(messages);

    // Para el front: text se usa en pantalla/voz.
    return res.status(200).json({
      text: ai.text,
      archivo: file,
      filas_aprox: lines,
      formato: format || "texto",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "Error interno.", details: String(e) });
  }
}
