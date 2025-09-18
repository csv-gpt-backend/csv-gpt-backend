// /api/ask.js
// Analiza múltiples fuentes: CSV y/o PDF en /public usando URLs internas.
// Acepta varios ?src=... (p.ej., src=datos/decimo.csv&src=documentos/LEXIUM.pdf)
// Si no hay src, usa datos/decimo.csv.
// Devuelve texto (para voz) o JSON con ?format=json.
// ds

export const config = { runtime: "nodejs" }; // asegurar Node en Vercel

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { ts, text }

let pdfParseModule = undefined;
async function loadPdfParse() {
  if (pdfParseModule !== undefined) return pdfParseModule;
  try {
    const mod = await import("pdf-parse"); // dynamic optional
    pdfParseModule = mod.default || mod;
  } catch {
    pdfParseModule = null; // seguirá funcionando sin PDF-parse
  }
  return pdfParseModule;
}

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

  const isPDF = new URL(publicUrl).pathname.toLowerCase().endsWith(".pdf");
  let text = "";

  if (isPDF) {
    const mod = await loadPdfParse();
    if (!mod) {
      text = "[PDF encontrado, pero falta instalar 'pdf-parse' en el servidor.]";
    } else {
      const ab = await r.arrayBuffer();
      const buf = Buffer.from(ab);
      const parsed = await mod(buf).catch(() => ({ text: "" }));
      text = (parsed.text || "").trim();
      if (!text) {
        text = "[No se pudo extraer texto del PDF (¿escaneado/imagen?).]";
      }
    }
  } else {
    text = await r.text(); // CSV/Texto
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

// --- Prompts
function systemPromptText() {
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Recibirás uno o varios documentos: CSV y/o PDFs.",
    "Reglas:",
    "1) CSV: detecta delimitador y analiza tal cual (no asumas encabezados fijos).",
    "2) PDF: usa definiciones/escalas/criterios útiles; no inventes.",
    "3) Si piden ORDENAR/RANQUEAR, aplica exactamente el criterio (asc/desc, columna/métrica) y dilo: 'Criterio de orden aplicado: ...'.",
    "4) Si la respuesta requiere listados/grupos/top-N, añade al final un bloque CSV entre triple backticks (sin texto dentro). Primera columna '#'.",
    "5) Si hay grupos A/B u otros, inclúyelos todos.",
    "6) Si faltan datos, dilo y aproxima con lo disponible.",
    "7) Extensión ~150–180 palabras, español (MX).",
  ].join(" ");
}

function userPromptText(query, sourcesText) {
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
        return [`=== FUENTE ${i + 1}: ${s.label} (PDF TEXTO) ===`, s.text].join("\n");
      }
    })
    .join("\n\n");

  return [
    `PREGUNTA: ${query}`,
    "Analiza TODAS las fuentes. Si hay conflicto, sé explícita.",
    blocks,
  ].join("\n");
}

function systemPromptJSON() {
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Devuelve SOLO un objeto JSON con claves:",
    "diagnostico, fortalezas, oportunidades, recomendaciones_corto_plazo, recomendaciones_mediano_plazo, riesgos.",
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
        return [`=== FUENTE ${i + 1}: ${s.label} (PDF TEXTO) ===`, s.text].join("\n");
      }
    })
    .join("\n\n");

  return [`PREGUNTA: ${query}`, "Analiza TODAS las fuentes:", blocks].join("\n");
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

// --- Handler
export default async function handler(req, res) {
  try {
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";
    const format = (req.query.format || "").toString().toLowerCase(); // "json" | ""

    let srcs = req.query.src;
    if (!srcs) {
      const legacy = (req.query.file || req.query.f || "decimo.csv").toString();
      srcs = [`datos/${legacy}`];
    }
    if (!Array.isArray(srcs)) srcs = [srcs];

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;

    const sourcesText = [];
    for (const raw of srcs) {
      const p = safePathParam(raw);
      const publicUrl = `${proto}://${host}/${encodeURI(p)}`;
      const t = await getTextFromPublicUrl(publicUrl); // puede lanzar si 404
      const type = extOf(p) === "pdf" ? "pdf" : "csv";
      sourcesText.push({ label: p, type, text: t });
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
    // Regresa 200 con explicación para que el front no muestre el genérico
    return res
      .status(200)
      .json({ text: `Error interno al preparar fuentes: ${String(e)}` });
  }
}
