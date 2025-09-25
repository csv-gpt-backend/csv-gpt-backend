// /api/answer.js
// Node 18+ (Vercel). Endpoint JSON: GET/POST ?q=...  (también maneja __warmup)

import fs from "fs/promises";
import path from "path";
import url from "url";

// === CONFIG ===
const MODEL = process.env.OPENAI_MODEL || "gpt-5"; // fuerza gpt-5 si no se define
const OPENAI_API_KEY = process.env.open_ai_key;
const OPENAI_URL = "https://api.openai.com/v1/responses";

const OPENAI_TIMEOUT_MS = 115000; // más alto que 55s para evitar Abort
const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

const CSV_PATH = path.join(process.cwd(), "datos", "decimo.csv");
const TEXTO_PATH = path.join(process.cwd(), "data", "texto_base.js");

// === MEMORIA GLOBAL ===
const STATE = {
  csvRows: null,       // Array<Array<string>>
  headers: null,       // Array<string>
  textoBase: "",
  loadedAt: 0
};

// Utilidades JSON HTTP
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

// Carga texto_base.js (exporta TEXTO_BASE)
async function loadTextoBase() {
  try {
    const mod = await import(url.pathToFileURL(TEXTO_PATH).href + `?v=${Date.now()}`);
    if (typeof mod.TEXTO_BASE === "string") return mod.TEXTO_BASE;
  } catch (e) {
    // fallback: intenta leer como archivo plano
    try {
      const raw = await fs.readFile(TEXTO_PATH, "utf8");
      return raw;
    } catch {}
  }
  return "";
}

// Detección del delimitador y parse CSV simple (maneja , y ;)
function detectDelimiter(line) {
  const commas = (line.match(/,/g) || []).length;
  const semis = (line.match(/;/g) || []).length;
  return semis > commas ? ";" : ",";
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const delim = detectDelimiter(lines[0]);

  // parser muy simple; si tu CSV tiene comillas y comas internas, usa un parser serio
  const split = l => l.split(delim).map(s => s.trim());

  const headers = split(lines[0]);
  const rows = lines.slice(1).map(split);
  return { headers, rows };
}

// Carga CSV + texto base a memoria
async function warmup() {
  if (STATE.csvRows && STATE.textoBase) {
    return; // ya listo
  }
  const [csvRaw, txtb] = await Promise.all([
    fs.readFile(CSV_PATH, "utf8"),
    loadTextoBase()
  ]);
  const parsed = parseCSV(csvRaw);
  STATE.csvRows = [parsed.headers, ...parsed.rows];
  STATE.headers = parsed.headers;
  STATE.textoBase = txtb || "";
  STATE.loadedAt = Date.now();
}

// === HELPERS PARA CSV ===
function norm(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function findColumn(headers, candidates) {
  const H = headers.map(norm);
  for (const c of candidates) {
    const n = norm(c);
    const i = H.indexOf(n);
    if (i !== -1) return i;
  }
  // búsqueda contiene (por si nombres tipo "Nivel TENSION")
  for (let i = 0; i < H.length; i++) {
    if (candidates.some(c => H[i].includes(norm(c)))) return i;
  }
  return -1;
}

function toNumber(x) {
  if (x == null) return null;
  const v = String(x).replace(/,/g, ".").trim();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mean(nums) {
  const arr = nums.map(toNumber).filter(v => v != null);
  return arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : null;
}

function computeParallelMeans(rows, metricName) {
  if (!rows || rows.length < 2) return null;
  const headers = rows[0];
  const idxScore = findColumn(headers, [metricName, "puntaje "+metricName, metricName.toUpperCase()]);
  const idxPar   = findColumn(headers, ["Paralelo", "parallel", "PARALELO"]);
  if (idxScore === -1 || idxPar === -1) return null;

  const body = rows.slice(1);
  const A = [];
  const B = [];
  for (const r of body) {
    const p = String(r[idxPar] || "").toUpperCase();
    const s = toNumber(r[idxScore]);
    if (s == null) continue;
    if (p === "A") A.push(s);
    else if (p === "B") B.push(s);
  }
  return {
    A: { n: A.length, mean: mean(A) },
    B: { n: B.length, mean: mean(B) }
  };
}

// === PROMPT BUILDERS ===
function buildJSONContract({compact=false} = {}) {
  const sizeHint = compact
    ? "Sé conciso. JSON de 800–1200 tokens máximo."
    : "Sé claro y evita redundancias innecesarias.";

  return `
Devuelve EXCLUSIVAMENTE un JSON con esta forma:

{
  "general": "explicación y conclusiones (sin asteriscos ni preámbulos)",
  "lists": [
    { "title": "Título", "items": ["item 1", "item 2"] }
  ],
  "tables": [
    { "title": "Título", "columns": ["Col1","Col2"], "rows": [["v1","v2"], ["..."]] }
  ]
}

Reglas:
- Nada fuera del JSON.
- Español (Ecuador/México).
- ${sizeHint}
- Si piden “lista de estudiantes”, SOLO Nombre, Curso, Paralelo.
- Si piden cálculos, hazlos (promedios, percentiles, desviación, etc.) y explica breve.
- Usa el texto base solo para fundamentar (no copiar).
`.trim();
}

function buildPrompt(question, csvCtx, textoBase, {compact=false} = {}) {
  return `
Eres un analista psicométrico experto.
${buildJSONContract({compact})}

### Datos CSV (JSON):
${JSON.stringify(csvCtx)}

### Texto base (referencia):
${textoBase}

### Pregunta:
${question}
`.trim();
}

function buildInterpretationPrompt(metricName, stats, textoBase, {compact=true} = {}) {
  return `
Eres psicometrista. Explica brevemente la diferencia entre promedios de **${metricName}**:

Paralelo A: N=${stats.A.n}, Promedio=${stats.A.mean?.toFixed(2) ?? "s/d"}
Paralelo B: N=${stats.B.n}, Promedio=${stats.B.mean?.toFixed(2) ?? "s/d"}

- Usa percentiles en sentido conceptual (no inventes baremos exactos si no hay).
- Conclusiones prácticas (alertas/refuerzos).

${buildJSONContract({compact})}

### Texto base (referencia):
${textoBase}
`.trim();
}

// === EXTRACCIÓN DE TEXTO DESDE OPENAI RESPONSES ===
function extractTextFromResponse(data) {
  // Algunas libs ya dejan esto:
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;

  // Estructura “responses”: busca el primer bloque “message” con “output_text”
  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        const block = item.content.find(c => c?.type === "output_text" && typeof c.text === "string");
        if (block?.text) return block.text;
      }
    }
    // Fallback: cualquier bloque con “text”
    for (const item of data.output) {
      const block = item?.content?.find?.(c => typeof c?.text === "string");
      if (block?.text) return block.text;
    }
  }
  return "";
}

// Extrae el primer objeto JSON válido del texto
function extractJSON(text) {
  if (!text || typeof text !== "string") throw new Error("Respuesta vacía");
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No se encontró JSON en la salida del modelo");
  }
  const slice = text.slice(start, end + 1);
  return JSON.parse(slice);
}

// === LLAMADAS A OPENAI CON RETRY ===
async function callOpenAIOnce(prompt, { maxOutput = DEFAULT_MAX_OUTPUT_TOKENS } = {}, signal) {
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      input: prompt,
      max_output_tokens: maxOutput
    })
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=>"");
    throw new Error(`OpenAI ${res.status}: ${txt}`);
  }
  return res.json();
}

async function callOpenAIWithRetry(prompt, { compactPrompt = null, maxOutput = DEFAULT_MAX_OUTPUT_TOKENS } = {}) {
  // 1er intento
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const data = await callOpenAIOnce(prompt, { maxOutput }, controller.signal);
    let text = extractTextFromResponse(data);
    const incomplete = data?.incomplete_details?.reason === "max_output_tokens";
    if (text && text.trim() && !incomplete) {
      return extractJSON(text);
    }
    // Si sin texto o incompleto, caemos al retry
  } catch (err) {
    if (err.name !== "AbortError") {
      // seguimos al retry igualmente
    }
  } finally {
    clearTimeout(timer);
  }

  // 2º intento (compacto + más tope)
  controller = new AbortController();
  timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const data = await callOpenAIOnce(compactPrompt || prompt, { maxOutput: Math.max(maxOutput, 8000) }, controller.signal);
    const text = extractTextFromResponse(data);
    if (!text || !text.trim()) throw new Error("No se pudo extraer texto del modelo (retry).");
    return extractJSON(text);
  } finally {
    clearTimeout(timer);
  }
}

// === META SOURCE ===
function meta(ms = 0) {
  return {
    model: MODEL,
    ms,
    loadedAt: STATE.loadedAt,
    rowCount: STATE.csvRows ? STATE.csvRows.length - 1 : 0
  };
}

// === ROUTERS ===
export async function GET(req) {
  try {
    if (!OPENAI_API_KEY) {
      return json({ ok: false, error: "Falta open_ai_key en variables de entorno." }, 500);
    }
    const { searchParams } = new URL(req.url);
    const question = (searchParams.get("q") || "").trim();

    // __warmup
    if (question === "__warmup") {
      await warmup();
      return json({ ok: true, warmup: true });
    }

    const t0 = Date.now();
    await warmup();

    // Caso especial: “TENSION A vs B”
    const q = question.toLowerCase();
    const isCompareTension =
      /tensi[oó]n/.test(q) && /(promedio|media)/.test(q) && /(paralelo| a y b| a vs b| entre a y b)/.test(q);

    if (isCompareTension) {
      const stats = computeParallelMeans(STATE.csvRows, "TENSION");
      if (stats && stats.A.mean != null && stats.B.mean != null) {
        const compactPrompt = buildInterpretationPrompt("TENSIÓN", stats, STATE.textoBase, { compact: true });
        const answer = await callOpenAIWithRetry(compactPrompt, { compactPrompt, maxOutput: 3000 });
        const ms = Date.now() - t0;
        return json({ ok: true, source: meta(ms), answer });
      }
      // si no pudo calcular localmente, sigue flujo normal
    }

    // Flujo general
    // Compactar CSV a objeto pequeño (no mandes todas las filas si no es necesario).
    // Aquí mandamos todo porque mantuviste análisis completo. Si quieres más velocidad:
    // - recorta columnas no usadas, o
    // - manda stats precomputados.
    const csvCtx = { headers: STATE.headers, rows: STATE.csvRows.slice(1, /*todo*/ undefined) };

    const prompt = buildPrompt(question, csvCtx, STATE.textoBase, { compact: false });
    const compactPrompt = buildPrompt(question, csvCtx, STATE.textoBase, { compact: true });

    const answer = await callOpenAIWithRetry(prompt, { compactPrompt, maxOutput: DEFAULT_MAX_OUTPUT_TOKENS });
    const ms = Date.now() - t0;
    return json({ ok: true, source: meta(ms), answer });
  } catch (err) {
    return json({ ok: true, source: meta(0), answer: { general: "Hubo un problema al analizar: " + err.message, lists: [], tables: [] } }, 200);
  }
}

export async function POST(req) {
  try {
    if (!OPENAI_API_KEY) {
      return json({ ok: false, error: "Falta open_ai_key en variables de entorno." }, 500);
    }
    const body = await req.json().catch(() => ({}));
    const question = (body?.q || body?.question || "").trim();

    if (question === "__warmup") {
      await warmup();
      return json({ ok: true, warmup: true });
    }

    const t0 = Date.now();
    await warmup();

    const q = question.toLowerCase();
    const isCompareTension =
      /tensi[oó]n/.test(q) && /(promedio|media)/.test(q) && /(paralelo| a y b| a vs b| entre a y b)/.test(q);

    if (isCompareTension) {
      const stats = computeParallelMeans(STATE.csvRows, "TENSION");
      if (stats && stats.A.mean != null && stats.B.mean != null) {
        const compactPrompt = buildInterpretationPrompt("TENSIÓN", stats, STATE.textoBase, { compact: true });
        const answer = await callOpenAIWithRetry(compactPrompt, { compactPrompt, maxOutput: 3000 });
        const ms = Date.now() - t0;
        return json({ ok: true, source: meta(ms), answer });
      }
    }

    const csvCtx = { headers: STATE.headers, rows: STATE.csvRows.slice(1) };
    const prompt = buildPrompt(question, csvCtx, STATE.textoBase, { compact: false });
    const compactPrompt = buildPrompt(question, csvCtx, STATE.textoBase, { compact: true });

    const answer = await callOpenAIWithRetry(prompt, { compactPrompt, maxOutput: DEFAULT_MAX_OUTPUT_TOKENS });
    const ms = Date.now() - t0;
    return json({ ok: true, source: meta(ms), answer });
  } catch (err) {
    return json({ ok: true, source: meta(0), answer: { general: "Hubo un problema al analizar: " + err.message, lists: [], tables: [] } }, 200);
  }
}
