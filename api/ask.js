// /api/ask.js
// Analiza múltiples fuentes: CSV y/o PDF dentro de /public (por URL).
// Acepta ?src=datos/decimo.csv&src=documentos/LEXIUM%20.pdf ... (varios)
// Si no pasas src, usa por defecto datos/decimo.csv
// Devuelve texto (para voz) y opcionalmente JSON con ?format=json.

import pdfParse from "pdf-parse";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { ts, text }

// ——— util ———
function safePathParam(s, def = "datos/decimo.csv") {
  let x = (s || "").toString().trim();
  if (!x) return def;
  if (x.includes("..") || x.includes("\\") || x.startsWith("http")) return def;
  x = x.replace(/^\/+/, ""); // sin slash inicial
  return x;
}
function extOf(path) {
  return (path.split(".").pop() || "").toLowerCase();
}

async function getTextFromPublicUrl(publicUrl) {
  const hit = cache.get(publicUrl);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_MS) return hit.text;

  const r = await fetch(publicUrl);
  if (!r.ok) throw new Error(`No pude leer ${publicUrl} (HTTP ${r.status})`);

  const u = new URL(publicUrl);
  const isPDF = u.pathname.toLowerCase().endsWith(".pdf");

  let text = "";
  if (isPDF) {
    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);
    const parsed = await pdfParse(buf);
    text = (parsed.text || "").trim();
  } else {
    text = await r.text(); // CSV u otro texto
  }
  cache.set(publicUrl, { ts: now, text });
  return text;
}

function detectDelim(firstLine) {
  if (!firstLine) return ",";
  if (firstLine.includes(";")) return ";";
  if (firstLine.includes("\t")) return "\t";
  if (firstLine.includes("|")) return "|";
  return ",";
}

// ——— prompts ———
function systemPromptText() {
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Recibirás uno o varios documentos: CSV y/o PDFs, con columnas y formatos variables.",
    "Reglas:",
    "1) Si hay CSV: detecta el delimitador y analiza tal cual (sin asumir encabezados fijos).",
    "2) Si hay PDF: extrae ideas, definiciones, rubricas y escalas relevantes; no inventes nada.",
    "3) Si el usuario pide ORDENAR o RANQUEAR: aplica el orden EXACTO solicitado (asc/desc, por la columna o métrica indicada).",
    "   Indica explícitamente: 'Criterio de orden aplicado: ...'.",
    "4) Cuando la respuesta requiera LISTADOS/GRUPOS/RANKINGS, agrega al final un bloque CSV entre triple backticks (sin texto dentro).",
    "   Primera columna debe ser '#'. Encabezados claros en español.",
    "5) Si hay grupos A/B u otros, incluye todos los grupos detectados y NO omitas ninguno.",
    "6) Si faltan datos para el criterio pedido, dilo y entrega la mejor aproximación posible basada en lo disponible.",
    "7) Responde concisa (~150–180 palabras) en español (MX).",
  ].join(" ");
}

function userPromptText(query, sourcesText) {
  // sourcesText: array de {label, type, text}
  const blocks = sourcesText
    .map((s, i) => {
      if (s.type === "csv") {
        const first = (s.text.split(/\r?\n/)[0] || "").slice(0, 500);
        const delim = detectDelim(first);
        return [
          `=== FUENTE ${i + 1}: ${s.label} (CSV; DELIMITADOR_APROX=${JSON.stringify(delim)}) ===`,
          "```csv",
          s.text,
          "```",
        ].join("\n");
      } else {
        // PDF o texto: lo pasamos como bloque de texto clásico
        // (el modelo no verá el PDF binario; aquí ya es texto plano extraído)
        return [
          `=== FUENTE ${i + 1}: ${s.label} (PDF TEXTO) ===`,
          s.text,
        ].join("\n");
      }
    })
    .join("\n\n");

  return [
    `PREGUNTA: ${query}`,
    "",
    "Analiza TODAS las fuentes a continuación. Si hay conflicto, sé explícita.",
    blocks,
  ].join("\n");
}

function systemPromptJSON() {
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Recibirás varios documentos (CSV/PDF).",
    "Devuelve SOLO un objeto JSON con estas claves exactas:",
    "diagnostico (string),",
    "fortalezas (array<string>),",
    "oportunidades (array<string>),",
    "recomendaciones_corto_plazo (array<string>),",
    "recomendaciones_mediano_plazo (array<string>),",
    "riesgos (array<string>).",
    "Si faltan datos, indícalo textualmente en los campos pertinentes.",
  ].join(" ");
}

function userPromptJSON(query, sourcesText) {
  const blocks = sourcesText
    .map((s, i) => {
      if (s.type === "csv") {
        return [
          `=== FUENTE ${i + 1}: ${s.label} (CSV) ===`,
          "```csv",
          s.text,
          "```",
        ].join("\n");
      } else {
        return [`=== FUENTE ${i + 1}: ${s.label} (PDF TEXTO) ===`, s.text].join(
          "\n"
        );
      }
    })
    .join("\n\n");

  return [
    `PREGUNTA: ${query}`,
    "Analiza TODAS las fuentes:",
    blocks,
  ].join("\n");
}

async function callOpenAI(messages, forceJson = false) {
  if (!API_KEY) {
    return { ok: false, text: "Falta configurar OPENAI_API_KEY en Vercel." };
  }
  const body = { model: MODEL, messages, temperature: 0.35 };
  if (forceJson) body.response_format = { type: "json_object" };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  let data = null;
  try { data = await r.json(); } catch {}
  const text =
    data?.choices?.[0]?.message?.content?.trim() ||
    `No pude consultar OpenAI (HTTP ${r.status}).`;
  return { ok: true, text };
}

export default async function handler(req, res) {
  try {
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";
    const format = (req.query.format || "").toString().toLowerCase(); // "json" | ""

    // Soporta varios ?src=...
    let srcs = req.query.src;
    if (!srcs) {
      // backward-compat: ?file=decimo.csv
      const legacy = (req.query.file || req.query.f || "decimo.csv").toString();
      srcs = [`datos/${legacy}`];
    }
    if (!Array.isArray(srcs)) srcs = [srcs];

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;

    // Descarga y normaliza texto de cada fuente
    const sourcesText = [];
    for (const raw of srcs) {
      const p = safePathParam(raw);
      const label = p;
      const publicUrl = `${proto}://${host}/${encodeURI(p)}`;
      const t = await getTextFromPublicUrl(publicUrl);
      const type = extOf(p) === "pdf" ? "pdf" : "csv";
      sourcesText.push({ label, type, text: t });
    }

    let messages, forceJson = false;
    if (format === "json") {
      messages = [
        { role: "system", content: systemPromptJSON() },
        { role: "user", content: userPromptJSON(q, sourcesText) },
      ];
      forceJson = true;
    } else {
      messages = [
        { role: "system", content: systemPromptText() },
        { role: "user", content: userPromptText(q, sourcesText) },
      ];
    }

    const ai = await callOpenAI(messages, forceJson);

    return res.status(200).json({
      text: ai.text,
      fuentes: srcs,
      formato: format || "texto",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "Error interno.", details: String(e) });
  }
}
