// /api/ask.js
// Analiza un CSV (columnas variables) y además lee y analiza una lista de PDFs.
// Devuelve texto para voz y, si la IA devuelve tabla Markdown, tu front la renderiza en tabla.

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const CACHE_MS = 5 * 60 * 1000;

// caches
const csvCache = new Map();       // url -> { ts, text }
const pdfCache = new Map();       // pdfUrl -> { ts, text }

// ===== helpers =====
function safeFileParam(s, def = "decimo.csv") {
  const x = (s || "").toString().trim();
  if (!x) return def;
  if (x.includes("..") || x.includes("/") || x.includes("\\")) return def;
  return x;
}

function detectDelim(line) {
  if (!line) return ",";
  if (line.includes(";")) return ";";
  if (line.includes("\t")) return "\t";
  if (line.includes("|")) return "|";
  return ",";
}

async function getCSVText(publicUrl) {
  const hit = csvCache.get(publicUrl);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_MS) return hit.text;

  const r = await fetch(publicUrl);
  if (!r.ok) throw new Error(`No pude leer CSV ${publicUrl} (HTTP ${r.status})`);
  const text = await r.text();
  csvCache.set(publicUrl, { ts: now, text });
  return text;
}

// pdf-parse: lo cargamos perezosamente para que no rompa el build si no está
let _pdfParse;
async function pdfParseModule() {
  if (!_pdfParse) {
    const mod = await import("pdf-parse"); // ESM default
    _pdfParse = mod.default || mod;
  }
  return _pdfParse;
}

async function getPDFText(url) {
  try {
    const now = Date.now();
    const hit = pdfCache.get(url);
    if (hit && now - hit.ts < CACHE_MS) return hit.text;

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`No pude leer PDF ${url} (HTTP ${resp.status})`);
    const buf = Buffer.from(await resp.arrayBuffer());

    const pdfParse = await pdfParseModule();
    const data = await pdfParse(buf);
    const raw = (data.text || "").trim();

    // recortamos para no explotar el contexto (ajusta si quieres)
    const maxChars = 15000;
    const clipped = raw.length > maxChars ? raw.slice(0, maxChars) : raw;

    pdfCache.set(url, { ts: now, text: clipped });
    return clipped;
  } catch (err) {
    console.error("PDF error", url, err);
    return ""; // seguimos aunque un PDF falle
  }
}

// ===== prompts =====
function systemPromptText() {
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Dispones de un CSV con datos de estudiantes y de varios PDFs con teoría/definiciones.",
    "Reglas:",
    "- Para NOMBRES, VALORES y LISTAS del alumnado: usa EXCLUSIVAMENTE el CSV.",
    "- Para teoría, definiciones o explicación conceptual: apóyate en los PDFs cuando sea pertinente.",
    "- No inventes nada. Si no puedes sostener con CSV/PDF, dilo.",
    "- Si el usuario pide 'tabla, listar, lista, enlistar, cuadro, table': devuelve UNA tabla Markdown ordenada.",
    "- Si no pide tabla, entrega explicación breve (~150-180 palabras) en texto plano.",
    "- NO menciones que estás leyendo PDFs o CSV. No uses asteriscos * en el texto.",
  ].join(" ");
}

function userPromptText(query, csvText, pdfBlocks, delim) {
  const parts = [];
  parts.push(`PREGUNTA: ${query}`);
  parts.push("");
  parts.push(`DELIMITADOR_APROX: ${JSON.stringify(delim)}`);
  parts.push("");
  parts.push("CSV completo entre triple backticks. Analízalo tal cual:");
  parts.push("```csv");
  parts.push(csvText);
  parts.push("```");
  if (pdfBlocks && pdfBlocks.length) {
    parts.push("");
    parts.push("A continuación tienes EXTRACTOS de los PDFs relevantes (texto plano). Úsalos para teoría/definiciones cuando aplique:");
    pdfBlocks.forEach((p, i) => {
      parts.push("");
      parts.push(`### PDF ${i + 1}: ${p.url}`);
      parts.push("```text");
      parts.push(p.text);
      parts.push("```");
    });
  }
  return parts.join("\n");
}

// ===== OpenAI =====
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
      temperature: 0.35,
    }),
  });
  const data = await r.json().catch(() => null);
  const text =
    data?.choices?.[0]?.message?.content?.trim() ||
    `No pude consultar OpenAI (HTTP ${r.status}).`;
  return { ok: true, text };
}

// ===== handler =====
export default async function handler(req, res) {
  try {
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";

    // CSV
    const file = safeFileParam(req.query.file || req.query.f || "decimo.csv");
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const publicUrl = `${proto}://${host}/datos/${encodeURIComponent(file)}`;
    const csvText = await getCSVText(publicUrl);
    const lines = csvText.split(/\r?\n/).filter(Boolean).length;
    const first = (csvText.split(/\r?\n/)[0] || "").slice(0, 500);
    const delim = detectDelim(first);

    // PDFs (comma-separated)
    const pdfsParam = (req.query.pdfs || "").toString().trim();
    const pdfUrls = pdfsParam
      ? pdfsParam.split(",").map((u) => u.trim()).filter(Boolean)
      : [];

    // Descarga y parse de PDFs
    let pdfBlocks = [];
    if (pdfUrls.length) {
      const list = await Promise.all(
        pdfUrls.map(async (url) => ({
          url,
          text: await getPDFText(url),
        }))
      );
      // filtra vacíos
      pdfBlocks = list.filter((p) => p.text && p.text.length > 50);
    }

    const messages = [
      { role: "system", content: systemPromptText() },
      { role: "user", content: userPromptText(q, csvText, pdfBlocks, delim) },
    ];

    const ai = await callOpenAI(messages);

    // nunca devolvemos “analizando PDF/CSV…”
    const clean = (ai.text || "").replace(/Analizando\s+(CSV|PDF).*?\n/gi, "");

    return res.status(200).json({
      text: clean,
      archivo: file,
      filas_aprox: lines,
      fuentes_pdf: pdfBlocks.length,
      formato: "texto",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "Error interno.", details: String(e) });
  }
}
