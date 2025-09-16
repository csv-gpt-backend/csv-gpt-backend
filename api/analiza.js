// api/analiza.js  — CORS + diag/debug + FUZZY MATCH de dimensiones y alumnos
import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

// ======= CONFIG =======
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // cámbialo en Vercel a gpt-5
const CSV_CANDIDATES = [
  path.join(process.cwd(), "public", "datos.csv"),
  path.join(process.cwd(), "datos.csv"),
];
const DEBUG_FLAG = process.env.DEBUG === "1";

// ======= CSV =======
async function readCsvFile() {
  for (const p of CSV_CANDIDATES) {
    try { return { txt: await fs.readFile(p, "utf8"), path: p }; } catch {}
  }
  throw new Error("No encontré public/datos.csv ni ./datos.csv en el deploy.");
}

function parseCsv(text) {
  const rows = [];
  let cur = [], cell = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i+1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { cur.push(cell); cell = ""; }
      else if (ch === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = ""; }
      else if (ch !== "\r") cell += ch;
    }
  }
  if (cell.length || cur.length) { cur.push(cell); rows.push(cur); }
  return rows.filter(r => r.length && r.some(x => String(x).trim() !== ""));
}

let __csvCache = { rows:null, headers:null, usedPath:null, rowCount:0 };
async function loadCsvOnce() {
  if (__csvCache.rows) return __csvCache;
  const { txt, path:usedPath } = await readCsvFile();
  const arr = parseCsv(txt);
  if (arr.length < 2) throw new Error("CSV vacío o sin datos suficientes.");

  const headers = arr[0].map(h => String(h).trim());
  const rows = arr.slice(1).map(r => {
    const o = {}; headers.forEach((h,i)=> o[h] = r[i] ?? ""); return o;
  });
  __csvCache = { rows, headers, usedPath, rowCount:rows.length };
  return __csvCache;
}

// ======= Utils =======
const stripAcc = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const normText = s => stripAcc(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const normKey  = s => normText(s).replace(/\s+/g, ""); // sin espacios

function isNumeric(v) {
  const s = typeof v === "string" ? v.replace(",", ".").trim() : v;
  return s !== "" && Number.isFinite(Number(s));
}
function toNumber(v) {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, base = Math.floor(pos), rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base+1] - sorted[base]) : sorted[base];
}
function computeMetrics(rows, numericCols) {
  const out = {};
  for (const col of numericCols) {
    const arr = rows.map(r => toNumber(r[col])).filter(v => v !== null).sort((a,b)=>a-b);
    if (!arr.length) continue;
    const sum = arr.reduce((a,b)=>a+b,0);
    out[col] = { n:arr.length, min:arr[0], max:arr.at(-1), mean:sum/arr.length,
                 p25:quantile(arr,0.25), p50:quantile(arr,0.50), p75:quantile(arr,0.75), p90:quantile(arr,0.90) };
  }
  return out;
}
function detectNameColumn(headers) {
  const lower = headers.map(h=>h.toLowerCase());
  const cands = ["alumno", "alumna", "nombre", "nombres", "estudiante"];
  for (const c of cands) {
    const i = lower.findIndex(h => h.includes(c));
    if (i !== -1) return headers[i];
  }
  return headers[0];
}

// ------- fuzzy dimension matching -------
const ALIASES = {
  "autoestima": ["auto estima", "self esteem", "estima"],
  "empatia": ["empatía", "empatia", "empatico"],
  "bienestar fisico": ["bienestar físico", "salud fisica", "salud física"],
  "inteligencia emocional": ["ie", "emocional", "int emocional"],
  "motivacion": ["motivación", "motivation"],
  "toma de decisiones": ["decisiones","decision making","tomar decisiones"],
  "liderazgo": ["liderazgos"],
  "timidez": ["introversion","introversión"],
};

function buildDimIndex(headers) {
  const map = new Map(); // keyNormalizado -> nombreOriginal
  for (const h of headers) {
    const nk = normKey(h);
    if (nk) map.set(nk, h);
    // si hay " X y Y " también indexa tokens sueltos
    for (const tok of normText(h).split(" ").filter(t=>t.length>2)) {
      const k = tok;
      if (!map.has(k)) map.set(k, h);
    }
  }
  for (const [base, aliasArr] of Object.entries(ALIASES)) {
    const b = normKey(base);
    if (!map.has(b)) map.set(b, base.toUpperCase());
    for (const a of aliasArr) {
      const k = normKey(a);
      if (!map.has(k)) map.set(k, base.toUpperCase());
    }
  }
  return map;
}

function dimsFromQuestionFuzzy(q, numericCols) {
  const qn = normText(q);
  const qKey = normKey(q);
  const idx = buildDimIndex(numericCols);

  const hits = new Set();

  // 1) match directo por key completo
  for (const [k, original] of idx) {
    if (!k) continue;
    if (qKey.includes(k) || qn.split(" ").includes(k)) hits.add(original);
  }

  // 2) tokens > 3 chars que aparezcan dentro del nombre de columna
  const qTokens = qn.split(" ").filter(t => t.length > 3);
  for (const t of qTokens) {
    for (const col of numericCols) {
      const ck = normText(col);
      if (ck.includes(t)) hits.add(col);
    }
  }

  return Array.from(hits);
}

// ------- alumno -------
function extractNameFromQuestion(q) {
  const quoted = q.match(/"([^"]+)"/);
  if (quoted?.[1]) return quoted[1].trim();
  const m = q.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/);
  if (m?.[1]) return m[1].trim();
  return null;
}

function wantsGeneralSummary(q){
  const qn = normText(q);
  return /\b(promedio|promedios|media|medias|general|resumen|grupo)\b/.test(qn);
}

// ======= OpenAI =======
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Responses API: pasar "system" DENTRO de input (no en raíz)
async function askOpenAI({ model, system, input }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY.");
  const r = await client.responses.create({
    model: model || DEFAULT_MODEL,
    input: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: input },
    ],
  });
  return r.output_text || "";
}

// ======= Handler =======
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  try {
    const q = (req.query?.q || req.body?.q || "").toString().trim();
    const diag  = req.query?.diag === "1" || req.body?.diag === "1";
    const debug = DEBUG_FLAG || req.query?.debug === "1" || req.body?.debug === "1";

    if (q.toLowerCase() === "ping") { res.status(200).json({ ok:true, respuesta:"pong" }); return; }

    if (diag) {
      const out = { ok:true, step:"diag" };
      try {
        out.hasApiKey = Boolean(process.env.OPENAI_API_KEY);
        const csv = await loadCsvOnce();
        out.csvPath = csv.usedPath;
        out.headers = csv.headers;
        out.rowCount = csv.rowCount;
        out.numericCols = csv.headers.filter(h => csv.rows.some(r => isNumeric(r[h])));
      } catch (e) { out.ok=false; out.error="DIAG: " + e.message; }
      res.status(200).json(out); return;
    }

    if (!q) { res.status(400).json({ ok:false, error:"Falta el parámetro q." }); return; }

    // 1) CSV
    let csv;
    try { csv = await loadCsvOnce(); }
    catch (e) { if (debug) return res.status(200).json({ ok:false, step:"loadCsv", error:e.message }); throw e; }

    const { rows, headers } = csv;
    const nameCol = detectNameColumn(headers);
    const numericCols = headers.filter(h => rows.some(r => isNumeric(r[h])));

    // 2) intención
    const askedName       = extractNameFromQuestion(q);
    const askedForStudent = Boolean(askedName || req.query?.alumno);
    let alumnoRow = null, alumnoLabel = null;

    if (askedForStudent) {
      const alumnoQ = (req.query?.alumno || askedName || "").toString().trim();
      if (alumnoQ) {
        const needle = normText(alumnoQ);
        alumnoRow = rows.find(r => normText(r[nameCol]).includes(needle)) || null;
        alumnoLabel = alumnoRow ? String(alumnoRow[nameCol]) : "(no encontrado)";
      }
    }

    const dimsMatched = dimsFromQuestionFuzzy(q, numericCols);
    const wantGeneral = wantsGeneralSummary(q);

    // 3) métricas del grupo
    const groupMetrics = computeMetrics(rows, numericCols);

    // 4) payload
    const payload = {
      alumno: askedForStudent ? (alumnoLabel ?? "(no encontrado)") : null,
      askedForStudent,
      nameColumn: nameCol,
      question: q,
      dimsMatched,
      wantGeneral,
      columns_numeric: numericCols,
      student_values: alumnoRow
        ? Object.fromEntries(numericCols.map(c => [c, toNumber(alumnoRow[c])]))
        : null,
      groupMetrics
    };

    const system = `
Eres un analista educativo y SOLO puedes usar el JSON proporcionado.
- Si askedForStudent=false, NO digas "alumno no encontrado"; responde a nivel grupo.
- Si askedForStudent=true y alumno="(no encontrado)", dilo y sugiere escribir el nombre exacto entre comillas.
- Si hay dimsMatched, enfócate en esas dimensiones (promedio y percentiles del grupo; si hay student_values, compáralo).
- Si wantGeneral=true y no hay dimsMatched, haz un resumen breve con 3–8 dimensiones relevantes del grupo.
- Responde en español, claro y conciso (6–8 líneas). No inventes datos ni columnas que no existen.`;

    const prompt = `
JSON:
${JSON.stringify(payload, null, 2)}

Instrucción:
Responde estrictamente usando los datos que ves en el JSON.`;

    const respuesta = await askOpenAI({ system, input: prompt, model: DEFAULT_MODEL });
    res.status(200).json({ ok:true, respuesta, dimsMatched, alumno: payload.alumno });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || "Error interno" });
  }
}
