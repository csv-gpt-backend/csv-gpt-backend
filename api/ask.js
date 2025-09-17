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
        return [`=== FUENTE ${i + 1}: ${s.label} (PDF TEXTO) ===`, s]()
