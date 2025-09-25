// api/answer.js
export const maxDuration = 60;              // Vercel: hasta 60s de ejecución
export const runtime = "nodejs18.x";        // Node runtime (permite leer FS)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ====== CONFIG ======
const MODEL = (process.env.OPENAI_MODEL || "gpt-5").trim();
const OPENAI_API_KEY = (process.env.open_ai_key || process.env.OPENAI_API_KEY || "").trim();

// Rutas locales (según tu repo)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_PATH = path.join(__dirname, "..", "datos", "decimo.csv");
const TEXTO_BASE_PATH = path.join(__dirname, "..", "data", "texto_base.js");

// ====== CACHE GLOBAL (no se borra entre invocaciones mientras “caliente”) ======
const STATE = globalThis.__CSV_ASSIST__ || (globalThis.__CSV_ASSIST__ = {
  csv: null,          // { columns:[], rows:[[]], delimiter:';'|',' , rowCount }
  textoBase: "",      // string
  loadedAt: 0
});

// ====== UTILIDADES ======
function splitSmart(line) {
  // Soporta CSV simple con ; o , (sin comillas complejas)
  if (line.includes(";")) return line.split(";").map(s=>s.trim());
  return line.split(",").map(s=>s.trim());
}

function parseCSV(raw) {
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return { columns: [], rows: [], rowCount: 0, delimiter: "," };
  const header = splitSmart(lines[0]);
  const delimiter = lines[0].includes(";") ? ";" : ",";
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitSmart(lines[i]);
    // normaliza al largo del header
    while (parts.length < header.length) parts.push("");
    rows.push(parts.slice(0, header.length));
  }
  return { columns: header, rows, rowCount: rows.length, delimiter };
}

async function loadCSVandText() {
  if (STATE.csv && STATE.textoBase) return;

  // Cargar CSV
  try {
    const raw = await fs.readFile(CSV_PATH, "utf8");
    STATE.csv = parseCSV(raw);
  } catch (e) {
    console.error("No se pudo leer decimo.csv:", e);
    STATE.csv = { columns: [], rows: [], rowCount: 0, delimiter: "," };
  }

  // Cargar texto_base.js (export const TEXTO_BASE = `...`)
  try {
    // import dinámico del módulo para capturar TEXTO_BASE
    const m = await import(pathToFileURL(TEXTO_BASE_PATH).href);
    STATE.textoBase = (m.TEXTO_BASE || "").toString();
  } catch (e) {
    // fallback: intentar leer crudo
    try {
      const raw = await fs.readFile(TEXTO_BASE_PATH, "utf8");
      // extrae todo entre backticks si está como template literal
      const match = raw.match(/`([\s\S]*?)`/);
      STATE.textoBase = match ? match[1] : raw;
    } catch (e2) {
      console.error("No se pudo cargar texto_base.js:", e2);
      STATE.textoBase = "";
    }
  }

  STATE.loadedAt = Date.now();
}

function pathToFileURL(p) {
  const u = new URL("file://");
  u.pathname = path.resolve(p).replace(/\\/g, "/");
  return u;
}

// Pequeño preview del CSV (para el prompt). Aquí mandamos TODO (48 filas × ~20 cols) — el cliente pidió explicación completa.
function buildCSVContext(csv) {
  return {
    columns: csv.columns,
    rowCount: csv.rowCount,
    // enviamos todas las filas; si quisieras menos, usa slice(0, N)
    rows: csv.rows
  };
}

// Prepara prompt-instrucciones sólidas en español, pidiendo salida JSON estricta.
function buildPrompt(question, csvCtx, textoBase) {
  return `
Eres un analista psicométrico experto. Responde SIEMPRE en español (Ecuador/México), con explicación completa, y entrega la salida EXCLUSIVAMENTE en formato JSON con esta forma:

{
  "general": "texto explicativo y conclusiones (máxima claridad, sin asteriscos)",
  "lists": [
    { "title": "Título de la lista", "items": ["item 1", "item 2", "..."] }
  ],
  "tables": [
    { "title": "Título de la tabla", "columns": ["Col1","Col2","..."], "rows": [ ["v1","v2","..."], ["..."] ] }
  ]
}

Instrucciones IMPORTANTES:
- Evita asteriscos y frases meta (no digas “según el CSV…”); responde directo.
- Numerar las tablas en pantalla NO es tu trabajo (el frontend las numera), pero incluye las columnas correctas y filas en el orden esperado.
- Cuando pida “lista/listado de estudiantes”, incluye en una tabla las columnas: Nombre, Curso, Paralelo (sin puntajes, a menos que los pidan).
- Si el usuario solicita cálculos, realiza análisis matemáticos/psicométricos/estadísticos con la información disponible (promedios, percentiles, Gauss, desviación estándar, correlaciones simples si procede).
- Si solicitan interpretaciones (p. ej., percentiles), ofrece explicación clara sobre la lectura de percentiles y rangos.
- El texto de apoyo a continuación (texto_base) es referencia normativa/descriptiva: úsalo para fundamentar explicaciones.
- El conjunto CSV representa 48 estudiantes con ~20 columnas de puntuaciones (curso y paralelo incluidos).

### Datos CSV (JSON):
${JSON.stringify(csvCtx, null, 2)}

### Texto base (referencia):
${textoBase}

### Pregunta del usuario:
${question}

DEVUELVE SOLO el JSON de salida sin texto adicional.
`;
}

function extractJSON(text) {
  // Intenta localizar el primer objeto JSON válido { ... }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found");
  const candidate = text.slice(start, end + 1);
  return JSON.parse(candidate);
}

// ====== Llamada a OpenAI (Responses API) ======
async function callOpenAI(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55000);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,                 // gpt-5
        // Para gpt-5, evita temperature custom (usa el default del modelo).
        input: prompt,
        // Salida larga: sube el máximo de tokens
        max_output_tokens: 4000
      })
    });

    if (!res.ok) {
      const txt = await res.text().catch(()=>"");
      throw new Error(`OpenAI ${res.status}: ${txt}`);
    }
    const data = await res.json();
    const text = data?.output?.[0]?.content?.[0]?.text
             || data?.output_text
             || JSON.stringify(data);

    return extractJSON(text);
  } finally {
    clearTimeout(timeout);
  }
}

// ====== HANDLER ======
function jsonResponse(obj, code=200) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export async function GET(req) {
  try {
    if (!OPENAI_API_KEY) return jsonResponse({ ok:false, error:"Falta API Key (open_ai_key)" }, 500);

    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();

    if (q === "__warmup") {
      await loadCSVandText();
      return jsonResponse({ ok:true, warmup:true });
    }

    const question = q || "Describe y analiza los datos disponibles.";
    await loadCSVandText();

    const csvCtx = buildCSVContext(STATE.csv);
    const prompt = buildPrompt(question, csvCtx, STATE.textoBase);

    const t0 = Date.now();
    let answerJSON;
    try {
      answerJSON = await callOpenAI(prompt);
    } catch (e) {
      // fallback mínimo si el modelo devuelve texto no-JSON
      answerJSON = { general: "Hubo un problema al analizar: "+e.message, lists:[], tables:[] };
    }
    const ms = Date.now() - t0;

    return jsonResponse({
      ok: true,
      source: { model: MODEL, ms, loadedAt: STATE.loadedAt, rowCount: STATE.csv.rowCount },
      answer: answerJSON
    });
  } catch (e) {
    console.error(e);
    return jsonResponse({ ok:false, error: String(e?.message||e) }, 500);
  }
}

export async function POST(req) {
  try {
    if (!OPENAI_API_KEY) return jsonResponse({ ok:false, error:"Falta API Key (open_ai_key)" }, 500);
    const body = await req.json().catch(()=>({}));
    const q = (body?.question || "").trim();

    if (q === "__warmup") {
      await loadCSVandText();
      return jsonResponse({ ok:true, warmup:true });
    }

    const question = q || "Describe y analiza los datos disponibles.";
    await loadCSVandText();

    const csvCtx = buildCSVContext(STATE.csv);
    const prompt = buildPrompt(question, csvCtx, STATE.textoBase);

    const t0 = Date.now();
    let answerJSON;
    try {
      answerJSON = await callOpenAI(prompt);
    } catch (e) {
      answerJSON = { general: "Hubo un problema al analizar: "+e.message, lists:[], tables:[] };
    }
    const ms = Date.now() - t0;

    return jsonResponse({
      ok: true,
      source: { model: MODEL, ms, loadedAt: STATE.loadedAt, rowCount: STATE.csv.rowCount },
      answer: answerJSON
    });
  } catch (e) {
    console.error(e);
    return jsonResponse({ ok:false, error: String(e?.message||e) }, 500);
  }
}
