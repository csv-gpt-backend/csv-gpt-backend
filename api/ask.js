// /api/ask.js
// Analiza CSVs con columnas variables: envía el archivo "tal cual" a OpenAI.
// - Lee /public/datos/<file>.csv por URL (cache 5 min).
// - Si el CSV es grande, filtra filas según tokens de la pregunta.
// - Devuelve { text } y metadatos (chars_enviados, recortado, archivo).

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const CACHE = new Map(); // key: url -> { ts, text }

// límites
const MAX_CHARS = 250_000;  // si el csv cabe en este tamaño → se envía completo
const HARD_CAP   = 400_000; // nunca enviar más de esto
const CACHE_MS   = 5 * 60 * 1000;

// ---- utilidades ----
function safeFileParam(s, def = "decimo.csv") {
  const x = (s || "").toString().trim();
  if (!x) return def;
  // no permitimos rutas con ../ ni barras
  if (x.includes("..") || x.includes("/") || x.includes("\\")) return def;
  return x;
}

function detectDelim(firstLine) {
  if (!firstLine) return ",";
  if (firstLine.includes(";")) return ";";
  if (firstLine.includes("\t")) return "\t";
  if (firstLine.includes("|")) return "|";
  return ",";
}

function tokenize(q) {
  return (q || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w && w.length >= 3 && !["los","las","una","que","con","del","para","por","unas","unos","sobre","como","cual","cuales","donde","cuando","cualquiera"].includes(w));
}

// filtra el CSV por tokens: conserva cabecera + filas que contengan algún token
function filterCSV(raw, query, maxChars = HARD_CAP) {
  const lines = raw.split(/\r?\n/);
  if (!lines.length) return raw.slice(0, maxChars);

  const header = lines.shift();
  const tokens = tokenize(query);
  if (!tokens.length) return (header + "\n" + lines.join("\n")).slice(0, maxChars);

  const out = [header];
  for (const l of lines) {
    const ll = l.toLowerCase();
    if (tokens.some(t => ll.includes(t))) out.push(l);
    if (out.join("\n").length >= maxChars) break;
  }
  // si casi no hubo matches, manda una muestra para contexto
  if (out.length < 5) {
    out.push(...lines.slice(0, Math.min(200, lines.length)));
  }
  return out.join("\n").slice(0, maxChars);
}

async function getCSVText(url) {
  const now = Date.now();
  const hit = CACHE.get(url);
  if (hit && now - hit.ts < CACHE_MS) return hit.text;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`No pude leer CSV ${url} (HTTP ${r.status})`);
  const text = await r.text();
  CACHE.set(url, { ts: now, text });
  return text;
}

function buildSystemPrompt() {
  return [
    "Eres una asesora educativa clara y ejecutiva. Hablas español (México).",
    "Recibirás un CSV (o fragmento) con columnas variables (no asumas nombres fijos).",
    "1) Detecta el delimitador (coma, punto y coma, tab, etc.).",
    "2) Para responder, analiza la tabla tal como viene; no inventes datos.",
    "3) Si piden por una persona, localízala por coincidencias del nombre dentro del CSV.",
    "4) Si los datos son incompletos, dilo y explica qué faltaría.",
    "5) Responde breve (máx. ~180 palabras) y con criterio profesional.",
  ].join(" ");
}

function buildUserPrompt(q, csv, delim) {
  return [
    `PREGUNTA: ${q}`,
    "",
    `DELIMITADOR_APROX: ${JSON.stringify(delim)}`,
    "",
    "CSV (o fragmento) entre triple backticks. Analízalo tal cual:",
    "```csv",
    csv,
    "```"
  ].join("\n");
}

// ---- OpenAI call ----
async function askOpenAI(q, csvText) {
  if (!API_KEY) {
    return { text: "Falta configurar OPENAI_API_KEY en Vercel." };
  }
  const firstLine = csvText.split(/\r?\n/)[0] || "";
  const delim = detectDelim(firstLine);

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user",   content: buildUserPrompt(q, csvText, delim) }
  ];

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
  return { text };
}

// ---- Handler ----
export default async function handler(req, res) {
  try {
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";
    const file = safeFileParam(req.query.file || req.query.f || "decimo.csv");

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers.host;
    const url   = `${proto}://${host}/datos/${encodeURIComponent(file)}`;

    // 1) leer CSV (público) con cache
    const raw = await getCSVText(url);
    const size = raw.length;

    // 2) recortar si es necesario
    let csvToSend = raw;
    let recortado = false;
    if (size > MAX_CHARS) {
      csvToSend = filterCSV(raw, q, HARD_CAP);
      recortado = true;
    } else if (size > HARD_CAP) {
      csvToSend = raw.slice(0, HARD_CAP);
      recortado = true;
    }

    // 3) preguntar al modelo
    const ai = await askOpenAI(q, csvToSend);

    return res.status(200).json({
      text: ai.text,
      archivo: file,
      chars_enviados: csvToSend.length,
      recortado,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "Error interno.", details: String(e) });
  }
}
