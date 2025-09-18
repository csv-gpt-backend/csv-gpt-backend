// /api/ask.js
// Lee el CSV /public/datos/<file>.csv (cache 5 min), agrega texto de PDFs predefinidos,
// maneja memoria (10 min) y consulta OpenAI. Devuelve texto final listo para leer.
// Requiere: OPENAI_API_KEY (y opcional OPENAI_MODEL).

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

// PDFs “ocultos” que se analizarán automáticamente:
const PDF_URLS = [
  process.env.PDF_LEXIUM_URL || "https://csv-gpt-backend.vercel.app/lexium.pdf",
  process.env.PDF_EVALUACIONES_URL || "https://csv-gpt-backend.vercel.app/evaluaciones.pdf",
];

const CACHE_MS = 5 * 60 * 1000;
const cacheCSV = new Map();   // url -> { ts, text }
const sessions = new Map();   // sid -> { ts, history: [{role,content}, ...] }

function safeFileParam(s, def = "decimo.csv") {
  const x = (s || "").toString().trim();
  if (!x) return def;
  if (x.includes("..") || x.includes("/") || x.includes("\\")) return def;
  return x;
}

async function getCSVText(publicUrl) {
  const hit = cacheCSV.get(publicUrl);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_MS) return hit.text;

  const r = await fetch(publicUrl);
  if (!r.ok) throw new Error(`No pude leer CSV ${publicUrl} (HTTP ${r.status})`);
  const text = await r.text();
  cacheCSV.set(publicUrl, { ts: now, text });
  return text;
}

function detectDelim(firstLine) {
  if (!firstLine) return ",";
  if (firstLine.includes(";")) return ";";
  if (firstLine.includes("\t")) return "\t";
  if (firstLine.includes("|")) return "|";
  return ",";
}

function systemPromptText() {
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Recibirás: 1) un CSV completo con columnas variables; 2) (si es posible) texto extraído de 2 PDFs adjuntos por el sistema.",
    "Tareas generales:",
    "- No menciones procesos internos (no digas 'analicé PDFs' ni 'analicé CSV').",
    "- Responde con datos REALES del dataset. Si falta info, dilo.",
    "- Si la petición pide lista/tabla (palabras: lista, listar, enlistar, tabla), devuelve TABLA ordenada y numerada (#).",
    "- Si no pide tabla, devuelve una EXPLICACIÓN breve (~150-180 palabras) y agrega tabla solo si es imprescindible.",
    "- Para 'grupos homogéneos' utiliza clustering simple con distancias euclidianas sobre columnas relevantes (ej.: Agresión, Empatía).",
    "- Para correlación usa Pearson/Spearman, e incluye interpretación breve y r o r² si aplica.",
    "- En tablas: cabeceras fieles al CSV; orden lógico; sin duplicar la misma info arriba y abajo.",
    "- No leas ni muestres asteriscos; evita caracteres superfluos.",
  ].join(" ");
}

function userPrompt(q, csvText, pdfTexts) {
  const first = (csvText.split(/\r?\n/)[0] || "").slice(0, 500);
  const delim = detectDelim(first);

  const bundle = [
    `PREGUNTA: ${q}`,
    "",
    `DELIMITADOR_APROX: ${JSON.stringify(delim)}`,
    "",
    "CSV completo entre triple backticks. Analízalo tal cual:",
    "```csv",
    csvText,
    "```",
  ];

  // Adjunta texto de PDFs si existe
  if (pdfTexts && pdfTexts.length) {
    bundle.push("", "EXTRACTOS DE PDFs (texto plano, para contexto, no lo menciones explícitamente):");
    pdfTexts.forEach((t, i) => {
      if (t && t.trim()) {
        const chunk = t.length > 20000 ? t.slice(0, 20000) + "\n[...]" : t; // recorte por tokens
        bundle.push("", `--- PDF ${i + 1} ---`, chunk);
      }
    });
  }

  return bundle.join("\n");
}

// Extraer texto de PDFs con pdf-parse (si disponible)
async function tryExtractPDF(url) {
  try {
    const pdfParse = (await import("pdf-parse")).default;
    const r = await fetch(url);
    if (!r.ok) return "";
    const buf = await r.arrayBuffer();
    const data = await pdfParse(Buffer.from(buf));
    return data?.text || "";
  } catch (e) {
    // Si no está pdf-parse o falla, seguimos sin PDF
    return "";
  }
}

// Memoria: 10 minutos por sesión simple (por IP+UA)
function sessionId(req) {
  const ua = (req.headers["user-agent"] || "").slice(0, 80);
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "ip";
  return `${ip}|${ua}`;
}
function getSession(sid){
  const now = Date.now();
  const item = sessions.get(sid);
  if (item && (now - item.ts) <= (10 * 60 * 1000)) return item;
  const fresh = { ts: now, history: [] };
  sessions.set(sid, fresh);
  return fresh;
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
      temperature: 0.35,
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

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers.host;
    const publicUrl = `${proto}://${host}/datos/${encodeURIComponent(file)}`;

    // 1) CSV
    const csvText = await getCSVText(publicUrl);
    const lines = csvText.split(/\r?\n/).filter(Boolean).length;

    // 2) PDFs (silencioso; no romper si fallan)
    const pdfTexts = [];
    for (const url of PDF_URLS){
      try{
        const t = await tryExtractPDF(url);
        if (t && t.trim()) pdfTexts.push(t);
      }catch{}
    }

    // 3) Memoria y mensajes
    const sid = sessionId(req);
    const sess = getSession(sid);
    // recorta historial si creció demasiado
    if (sess.history.length > 12) sess.history.splice(0, sess.history.length - 12);

    const messages = [
      { role: "system", content: systemPromptText() },
      ...sess.history, // memoria previa útil
      { role: "user", content: userPrompt(q, csvText, pdfTexts) },
    ];

    // 4) OpenAI
    const ai = await callOpenAI(messages);

    // 5) Actualiza memoria (solo si no es ping básico)
    sess.ts = Date.now();
    sess.history.push({ role:"user", content: q });
    sess.history.push({ role:"assistant", content: ai.text });

    // 6) Devuelve
    return res.status(200).json({
      text: ai.text,
      archivo: file,
      filas_aprox: lines,
      formato: "texto",
    });
  } catch (e) {
    console.error(e);
    return res.status(200).json({
      text: "No se encontró respuesta.",
      error: String(e),
    });
  }
}
