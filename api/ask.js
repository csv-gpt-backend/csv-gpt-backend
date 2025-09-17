// api/ask.js
import fs from "fs";
import path from "path";
import Papa from "papaparse";
import pdfParse from "pdf-parse";
import OpenAI from "openai";

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";
const GPT_MODEL  = process.env.MODEL_GPT   || "gpt-5";

// Archivos esperados en la raíz del repo
const CSV_PATH  = path.join(process.cwd(), "data.csv");
// Ajusta estos nombres si cambian en tu repo:
const PDF_FILES = [
  "LEXIUM .pdf",
  "EVALUACIONES EXAMENES C.pdf",
].map(f => path.join(process.cwd(), f));

// Cache global (sobrevive entre invocaciones en serverless mientras la función está “caliente”)
let CACHE = {
  csv: null,              // [{NOMBRE, ...}]
  pdfs: [],               // [{file, pages: [{text, page}] , fullText}]
  chunks: null,           // [{id, file, page, text, embedding}]
  ready: { csv:false, pdf:false }
};

// ─────────────────────────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────────────────────────
const ok = (x) => x !== undefined && x !== null;
const norm = (s="") => (s || "").toString().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

function cosineSim(a, b) {
  let dot=0, na=0, nb=0;
  for (let i=0; i<a.length; i++) {
    dot += a[i]*b[i];
    na  += a[i]*a[i];
    nb  += b[i]*b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

function chunkTextByPages(text) {
  // Algunos PDFs traen salto de página como \f; si no, igual troceamos por tamaño.
  const byFormFeed = text.split('\f');
  const pages = byFormFeed.length > 1 ? byFormFeed : [text];

  const chunks = [];
  pages.forEach((pText, i) => {
    const clean = pText.replace(/\s+/g, " ").trim();
    const maxLen = 1000;        // ~800–1200 chars por chunk
    for (let start = 0; start < clean.length; start += maxLen) {
      const slice = clean.slice(start, Math.min(start + maxLen, clean.length));
      if (slice.length > 40) {
        chunks.push({ page: i+1, text: slice });
      }
    }
  });
  return chunks;
}

async function embedTexts(texts) {
  // texts: array de strings
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: texts
  });
  return res.data.map(d => d.embedding);
}

// ─────────────────────────────────────────────────────────────
// CARGA CSV
// ─────────────────────────────────────────────────────────────
function loadCSVOnce() {
  if (CACHE.ready.csv && CACHE.csv) return;

  const csvRaw = fs.readFileSync(CSV_PATH, "utf8");
  const parsed = Papa.parse(csvRaw, {
    header: true,
    delimiter: ";",
    skipEmptyLines: true
  });
  // Normalizar cabeceras
  const rows = parsed.data.map(obj => {
    const normObj = {};
    for (const k of Object.keys(obj)) {
      normObj[k.trim()] = (obj[k] ?? "").toString().trim();
    }
    // Clave auxiliar de nombre normalizado
    normObj.__NOMBRE_NORM__ = norm(normObj.NOMBRE || "");
    return normObj;
  });

  CACHE.csv = rows;
  CACHE.ready.csv = true;
}

// Buscar por nombre (o aproximado si “mi”)
function findStudentRow(q, nombreParam) {
  const rows = CACHE.csv || [];
  // Si viene por parámetro, intentamos directo
  if (nombreParam) {
    const target = norm(nombreParam);
    return rows.find(r => r.__NOMBRE_NORM__ === target) || null;
  }
  // Heurística: si la pregunta incluye un nombre
  const words = q.split(/\s+/).filter(w=>w.length>1);
  // Intento simple: probar substrings contra nombres
  const candidates = rows.filter(r => {
    const N = r.__NOMBRE_NORM__;
    return words.some(w => N.includes(norm(w)));
  });
  // Si no hay, devolver null
  return candidates.length === 1 ? candidates[0] : null;
}

// Extrae una métrica desde la pregunta, mapeando a columnas del CSV
function detectMetric(q) {
  const Q = norm(q);
  const mapping = [
    {keys:["PROMEDIO","MEDIA"], col:"PROMEDIO"},
    {keys:["AUTOESTIMA"], col:"AUTOESTIMA"},
    {keys:["TENSION","MANEJO DE LA TENSION","MANEJO TENSION"], col:"MANEJO DE LA TENSION"},
    {keys:["BIENESTAR FISICO","FISICO","BIENESTAR"], col:"BIENESTAR FISICO"},
    {keys:["ASERTIVIDAD"], col:"ASERTIVIDAD"},
    {keys:["COMUNICACION","COMUNICACIÓN"], col:"COMUNICACION"},
    {keys:["HABILIDADES INTRAPERSONALES","INTRAPERSONALES"], col:"HABILIDADES INTRAPERSONALES"},
  ];
  for (const m of mapping) {
    if (m.keys.some(k => Q.includes(k))) return m.col;
  }
  // Si no detectamos, asumimos PROMEDIO cuando hay “PROMEDIO/NOTA”
  if (Q.includes("PROMED")) return "PROMEDIO";
  if (Q.includes("NOTA"))   return "PROMEDIO";
  return null;
}

// Respuesta CSV
function answerFromCSV(q, nombreParam) {
  loadCSVOnce();
  const row = findStudentRow(norm(q), nombreParam);
  if (!row) {
    return { text: "No pude identificar al estudiante. Por favor indica tu nombre y apellido.", refs: [{file:"data.csv"}] };
  }

  const metricCol = detectMetric(q);
  if (metricCol && ok(row[metricCol])) {
    const val = row[metricCol];
    const nombre = row.NOMBRE || "el estudiante";
    return {
      text: `${nombre}, tu ${metricCol.toLowerCase()} es ${val}.`,
      refs: [{file:"data.csv", metric: metricCol, nombre}]
    };
  }

  // Si no preguntó métrica, devolver resumen corto
  const nombre = row.NOMBRE || "el estudiante";
  const baseCols = ["PROMEDIO","AUTOESTIMA","MANEJO DE LA TENSION","BIENESTAR FISICO"];
  const resumen = baseCols
    .filter(c => ok(row[c]))
    .map(c => `${c.toLowerCase()}: ${row[c]}`)
    .join(", ");
  const text = resumen
    ? `${nombre}, aquí tienes un resumen: ${resumen}.`
    : `${nombre}, no encontré métricas disponibles en el registro.`;
  return { text, refs: [{file:"data.csv", nombre}] };
}

// ─────────────────────────────────────────────────────────────
// CARGA PDFs + RAG
// ─────────────────────────────────────────────────────────────
async function loadPDFsOnce() {
  if (CACHE.ready.pdf && CACHE.chunks?.length) return;

  const pdfs = [];
  for (const f of PDF_FILES) {
    if (!fs.existsSync(f)) continue;
    const buffer = fs.readFileSync(f);
    const data = await pdfParse(buffer);
    // Intento de páginas por form feed; si no, todo en una
    const pages = data.text.split('\f').map((t, i) => ({ page: i+1, text: t }));
    pdfs.push({ file: path.basename(f), pages, fullText: data.text });
  }

  // Crear chunks (texto ~1000 chars) y calcular embeddings
  const allChunks = [];
  for (const pdf of pdfs) {
    const chunks = chunkTextByPages(pdf.fullText).map((c, idx) => ({
      id: `${pdf.file}#${c.page}-${idx}`,
      file: pdf.file,
      page: c.page,
      text: c.text
    }));
    allChunks.push(...chunks);
  }

  // Si no hay PDFs, marcamos ready y salimos.
  if (allChunks.length === 0) {
    CACHE.pdfs = pdfs;
    CACHE.chunks = [];
    CACHE.ready.pdf = true;
    return;
  }

  // Embeddings en lotes (por límite de tokens)
  const batchSize = 50;
  for (let i = 0; i < allChunks.length; i += batchSize) {
    const batch = allChunks.slice(i, i + batchSize);
    const emb = await embedTexts(batch.map(b => b.text));
    batch.forEach((b, j) => b.embedding = emb[j]);
    // (Pequeña pausa para ser amable con rate limits)
    await sleep(50);
  }

  CACHE.pdfs = pdfs;
  CACHE.chunks = allChunks;
  CACHE.ready.pdf = true;
}

async function answerFromPDFs(q) {
  await loadPDFsOnce();
  if (!CACHE.chunks || CACHE.chunks.length === 0) {
    return { text: "No hay material PDF disponible para consultar por ahora.", refs: [] };
  }

  // Embedding de la pregunta
  const qEmb = (await embedTexts([q]))[0];

  // Top-K por similitud
  const scored = CACHE.chunks
    .map(ch => ({ ch, score: cosineSim(qEmb, ch.embedding) }))
    .sort((a,b) => b.score - a.score)
    .slice(0, 5);

  const context = scored.map(s => `Archivo: ${s.ch.file} | Página: ${s.ch.page}\n${s.ch.text}`).join("\n\n---\n\n");
  const system = `Eres un asistente educativo. Responde SOLO usando el contexto proporcionado.
- Si la respuesta no está en el contexto, di explícitamente: "No consta en el material provisto".
- Responde en español (México), claro y breve (apto para voz), y añade precisión cuando corresponda.`;

  const comp = await openai.chat.completions.create({
    model: GPT_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Pregunta del estudiante: ${q}\n\nContexto:\n${context}` }
    ]
  });

  const text = (comp.choices?.[0]?.message?.content || "").trim() || "No consta en el material provisto.";
  const refs = scored.map(s => ({ file: s.ch.file, page: s.ch.page, score: Number(s.score.toFixed(3)) }));
  return { text, refs };
}

// ─────────────────────────────────────────────────────────────
// CLASIFICACIÓN (GPT-5)  grades | content | other
// ─────────────────────────────────────────────────────────────
async function classifyQuestion(q) {
  // Regla rápida por si el modelo falla
  const Q = norm(q);
  const csvHints = /(PROMED|NOTA|CALIFIC|AUTOESTIMA|TENSION|BIENESTAR|ASERTIV|COMUNIC|INTRAPER)/;
  if (csvHints.test(Q) && !/DEFINIC|QUE ES|CONCEP|SEGUN/.test(Q)) return "grades";

  const prompt = `Clasifica la pregunta en **una sola palabra**:
- "grades" si trata de calificaciones/notas/promedios/estudiantes del CSV.
- "content" si pide definiciones, teoría o contenidos de los PDFs.
- "other" si no aplica.

Pregunta: "${q}"`;
  const out = await openai.chat.completions.create({
    model: GPT_MODEL,
    temperature: 0,
    messages: [{ role: "user", content: prompt }]
  });
  const cls = (out.choices?.[0]?.message?.content || "").trim().toLowerCase();
  return ["grades","content","other"].includes(cls) ? cls : "other";
}

// ─────────────────────────────────────────────────────────────
// HANDLER HTTP
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    // CORS simple (por si llamas desde otra página)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    const q = (req.query.q || req.query.question || "").toString().trim();
    const nombre = (req.query.nombre || req.query.name || "").toString().trim();

    if (!q) return res.status(400).json({ error: "Falta parámetro q" });
    if (q.toLowerCase() === "ping") return res.json({ ok: true, respuesta: "pong" });

    // 1) Clasificar
    const intent = await classifyQuestion(q);

    // 2) Rutas
    if (intent === "grades") {
      const r = answerFromCSV(q, nombre);
      return res.json({ source: "csv", text: r.text, refs: r.refs });
    }
    if (intent === "content") {
      const r = await answerFromPDFs(q);
      return res.json({ source: "pdf", text: r.text, refs: r.refs });
    }

    // 3) Fallback
    return res.json({
      source: "other",
      text: "Formula tu pregunta sobre tus calificaciones (promedios y métricas) o sobre el material de los PDFs.",
      refs: []
    });

  } catch (err) {
    console.error("ask.js error:", err);
    return res.status(500).json({ error: "Error interno en /api/ask" });
  }
}
