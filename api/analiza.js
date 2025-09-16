// api/analiza.js  (Vercel – ESM, CORS + DIAGNÓSTICO + consultas de GRUPO)

import fs from "fs/promises";
import path from "path";
import OpenAI from "openai";

// ========= CONFIG =========
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // cámbialo cuando uses GPT-5
const CSV_CANDIDATES = [
  path.join(process.cwd(), "public", "datos.csv"),
  path.join(process.cwd(), "datos.csv"),
];
const DEBUG_FLAG = process.env.DEBUG === "1"; // activa modo debug desde Vercel si quieres

let __csvCache = { rows: null, headers: null };

// ========= CSV =========
async function readCsvFile() {
  for (const p of CSV_CANDIDATES) {
    try {
      const txt = await fs.readFile(p, "utf8");
      return { txt, path: p };
    } catch {}
  }
  throw new Error("No encontré public/datos.csv ni ./datos.csv en el deploy.");
}

function parseCsv(text) {
  const rows = [];
  let cur = [], cell = "", inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
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
  if (cell.length > 0 || cur.length) { cur.push(cell); rows.push(cur); }
  return rows.filter(r => r.length && r.some(x => String(x).trim() !== ""));
}

async function loadCsvOnce() {
  if (__csvCache.rows) return __csvCache;
  const { txt, path: usedPath } = await readCsvFile();
  const arr = parseCsv(txt);
  if (arr.length < 2) throw new Error("CSV vacío o sin datos suficientes.");

  const headers = arr[0].map(h => String(h).trim());
  const rows = arr.slice(1).map(r => {
    const o = {}; headers.forEach((h,i)=> o[h] = r[i] ?? ""); return o;
  });

  __csvCache = { rows, headers, usedPath, rowCount: rows.length };
  return __csvCache;
}

// ========= helpers =========
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
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}
function computeMetrics(rows, numericCols) {
  const out = {};
  for (const col of numericCols) {
    const arr = rows.map(r => toNumber(r[col])).filter(v => v !== null).sort((a,b)=>a-b);
    if (!arr.length) continue;
    const sum = arr.reduce((a,b)=>a+b,0);
    out[col] = {
      n: arr.length,
      min: arr[0],
      max: arr[arr.length-1],
      mean: sum/arr.length,
      p25: quantile(arr,0.25),
      p50: quantile(arr,0.50),
      p75: quantile(arr,0.75),
      p90: quantile(arr,0.90),
    };
  }
  return out;
}
function detectNameColumn(headers) {
  const lower = headers.map(h=>h.toLowerCase());
  const cands = ["alumno","alumna","nombre","nombres","estudiante"];
  for (const c of cands) {
    const i = lower.findIndex(h => h.includes(c));
    if (i !== -1) return headers[i];
  }
  return headers[0];
}

// Normaliza texto (sin acentos, minúsculas)
function norm(s){
  return String(s ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim();
}

// Busca nombres tipo Julia, “Julia”, etc.
function extractNameFromQuestion(q) {
  const quoted = q.match(/"([^"]+)"/);
  if (quoted?.[1]) return quoted[1].trim();
  // patrón "como está Julia", "Julia en autoestima" (una sola palabra capitalizada)
  const m = q.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/);
  if (m?.[1]) return m[1].trim();
  return null;
}

// Detecta dimensiones mencionadas comparando con nombres de columnas
function dimsFromQuestion(q, cols){
  const qn = norm(q);
  const found = [];
  for (const c of cols) {
    const cn = norm(c);
    if (cn && qn.includes(cn)) found.push(c);
  }
  // quitar duplicados
  return Array.from(new Set(found));
}

// Detecta intención “general”
function wantsGeneralSummary(q){
  const qn = norm(q);
  return /\b(promedio|promedios|media|medias|general|resumen|grupo)\b/.test(qn);
}

// ========= OpenAI =========
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Responses API: pasar system como mensaje dentro de input (no en raíz)
async function askOpenAI({ model, system, input }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Falta OPENAI_API_KEY en variables de entorno.");
    }
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: input },
  ];
  const r = await client.responses.create({
    model: model || DEFAULT_MODEL,
    input: messages
  });
  return r.output_text || "";
}

// ========= Handler =========
export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  // --------------

  try {
    const q = (req.query?.q || req.body?.q || "").toString().trim();
    const diag = req.query?.diag === "1" || req.body?.diag === "1";
    const debug = DEBUG_FLAG || req.query?.debug === "1" || req.body?.debug === "1";

    // PING de salud
    if (q.toLowerCase() === "ping") {
      res.status(200).json({ ok: true, respuesta: "pong" });
      return;
    }

    if (diag) {
      const out = { ok: true, step: "diag" };
      try {
        out.hasApiKey = Boolean(process.env.OPENAI_API_KEY);
        const csv = await loadCsvOnce();
        out.csvPath = csv.usedPath;
        out.headers = csv.headers;
        out.rowCount = csv.rowCount;
        out.numericCols = csv.headers.filter(h => csv.rows.some(r => isNumeric(r[h])));
      } catch (e) {
        out.ok = false;
        out.error = `DIAG: ${e.message}`;
      }
      res.status(200).json(out);
      return;
    }

    if (!q) {
      res.status(400).json({ ok:false, error:"Falta el parámetro q." });
      return;
    }

    // 1) CSV
    let csv;
    try {
      csv = await loadCsvOnce();
    } catch (e) {
      if (debug) return res.status(200).json({ ok:false, step:"loadCsv", error:e.message });
      throw e;
    }

    const { rows, headers } = csv;
    const nameCol = detectNameColumn(headers);
    const numericCols = headers.filter(h => rows.some(r => isNumeric(r[h])));

    // 2) intención por alumno / grupo
    const askedName = extractNameFromQuestion(q); // lo que el usuario escribió
    const askedForStudent = Boolean(askedName || req.query?.alumno);
    let alumnoRow = null;
    let alumnoLabel = null;

    if (askedForStudent) {
      const alumnoQ = (req.query?.alumno || askedName || "").toString().trim();
      if (alumnoQ) {
        const needle = norm(alumnoQ);
        alumnoRow = rows.find(r => norm(r[nameCol]).includes(needle)) || null;
        alumnoLabel = alumnoRow ? String(alumnoRow[nameCol]) : "(no encontrado)";
      }
    }

    // 3) dimensiones & resumen general
    const dimsMatched = dimsFromQuestion(q, numericCols);
    const wantGeneral = wantsGeneralSummary(q);

    // 4) métricas del grupo
    const groupMetrics = computeMetrics(rows, numericCols);

    // 5) payload para el modelo
    const payload = {
      // Si NO pidieron alumno, no pongas “(no encontrado)”
      alumno: askedForStudent ? (alumnoLabel ?? "(no encontrado)") : null,
      askedForStudent,
      nameColumn: nameCol,
      question: q,
      dimsMatched,        // dimensiones detectadas en el texto
      wantGeneral,        // si pidió promedios/resumen de grupo
      columns_numeric: numericCols,
      student_values: alumnoRow
        ? Object.fromEntries(numericCols.map(c => [c, toNumber(alumnoRow[c])]))
        : null,
      groupMetrics
    };

    const system = `
Eres un analista educativo y SOLO puedes usar el JSON proporcionado.
Reglas:
- Si askedForStudent=false, NO digas "alumno no encontrado".
- Si askedForStudent=true y alumno="(no encontrado)", dilo y sugiere escribir el nombre entre comillas.
- Si hay dimsMatched (una o varias), concéntrate en esas dimensiones: reporta promedio (mean) y percentiles del grupo.
- Si wantGeneral=true y no hay dimsMatched, da un resumen corto con los promedios de 3–8 dimensiones relevantes.
- Si existe student_values, puedes comparar con el grupo en esas dimensiones.
- Responde en español, claro y breve (6–8 líneas). No inventes datos.`;

    const prompt = `
JSON:
${JSON.stringify(payload, null, 2)}

Instrucción:
- Responde siguiendo las reglas del sistema.`;

    let respuesta;
    try {
      respuesta = await askOpenAI({ system, input: prompt, model: DEFAULT_MODEL });
    } catch (e) {
      if (debug) return res.status(200).json({ ok:false, step:"openai", error:e.message });
      throw e;
    }

    res.status(200).json({ ok:true, respuesta, dimsMatched, alumno: payload.alumno });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || "Error interno" });
  }
}
