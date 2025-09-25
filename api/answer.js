// /api/answer.js — Node 18+ (Vercel). GET/POST ?q=...
// Amplía cálculo local a cualquier columna del CSV (promedios, mediana, DE, etc. por paralelo A/B + global)
// Usa GPT-5 únicamente para interpretar (texto en "general") y/o para consultas no numéricas.

import fs from "fs/promises";
import path from "path";
import url from "url";

// === CONFIG ===
const MODEL = (process.env.OPENAI_MODEL || "gpt-5").trim();
const OPENAI_API_KEY = (process.env.open_ai_key || process.env.OPENAI_API_KEY || "").trim();
const OPENAI_URL = "https://api.openai.com/v1/responses";
const OPENAI_TIMEOUT_MS = 115000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4000;

// Rutas (ajusta si tu repo varía)
const CSV_PATH = path.join(process.cwd(), "datos", "decimo.csv");
const TEXTO_PATH = path.join(process.cwd(), "data", "texto_base.js");

// === ESTADO EN MEMORIA ===
const STATE = {
  headers: null,   // Array<string>
  rows: null,      // Array<Array<string>> (incluye header en rows[0])
  textoBase: "",
  loadedAt: 0
};

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

// ====== CARGA Y CSV ======
function detectDelimiter(line) {
  const c = (line.match(/,/g)||[]).length;
  const s = (line.match(/;/g)||[]).length;
  return s > c ? ";" : ",";
}
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const delim = detectDelimiter(lines[0]);
  const split = l => l.split(delim).map(s=>s.trim());
  const headers = split(lines[0]);
  const rows = lines.slice(1).map(split);
  return { headers, rows };
}
async function loadTextoBase() {
  try {
    const mod = await import(url.pathToFileURL(TEXTO_PATH).href + `?v=${Date.now()}`);
    if (typeof mod.TEXTO_BASE === "string") return mod.TEXTO_BASE;
  } catch {}
  try { return await fs.readFile(TEXTO_PATH, "utf8"); } catch { return ""; }
}
async function warmup() {
  if (STATE.rows && STATE.textoBase) return;
  const [raw, tb] = await Promise.all([fs.readFile(CSV_PATH, "utf8"), loadTextoBase()]);
  const parsed = parseCSV(raw);
  STATE.headers = parsed.headers;
  STATE.rows = [parsed.headers, ...parsed.rows];
  STATE.textoBase = tb || "";
  STATE.loadedAt = Date.now();
}

// ====== UTILES NUMÉRICOS Y BUSQUEDA DE COLUMNAS ======
function norm(s) {
  return (s||"").normalize("NFD").replace(/\p{Diacritic}/gu,"").toLowerCase().trim();
}
function toNumber(x) {
  if (x==null) return null;
  const v = String(x).replace(/,/g,".").trim();
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function mean(arr){ const a=arr.filter(v=>v!=null).map(Number); return a.length? a.reduce((p,c)=>p+c,0)/a.length : null; }
function median(arr){
  const a=arr.filter(v=>v!=null).map(Number).sort((x,y)=>x-y);
  if(!a.length) return null;
  const m=Math.floor(a.length/2);
  return a.length%2? a[m] : (a[m-1]+a[m])/2;
}
function stddev(arr){
  const a=arr.filter(v=>v!=null).map(Number);
  if(a.length<2) return null;
  const m=mean(a);
  const v=a.reduce((p,c)=>p+(c-m)*(c-m),0)/(a.length-1);
  return Math.sqrt(v);
}
function min(arr){ const a=arr.filter(v=>v!=null).map(Number); return a.length? Math.min(...a):null; }
function max(arr){ const a=arr.filter(v=>v!=null).map(Number); return a.length? Math.max(...a):null; }

function findColumnIndex(headers, q) {
  // Busca la columna más probable mencionada en la pregunta q
  // Coincidencia por inclusión (insensible a acentos), y preferir coincidencia exacta
  const H = headers.map(norm);
  const nq = norm(q);
  // Intenta por palabras claves entre comillas o palabras largas
  const tokens = nq.split(/[^a-z0-9]+/).filter(t=>t.length>=3);
  // Ranking simple: exacta > incluye palabra completa > substring
  let best = { idx: -1, score: -1 };
  for (let i=0;i<H.length;i++){
    const h = H[i];
    if (!h) continue;
    // exacta
    if (tokens.includes(h)) { if (10>best.score) best={idx:i,score:10}; continue; }
    // incluye palabra
    const hitWord = tokens.some(t=>h===t || h.includes(t) || t.includes(h));
    if (hitWord && best.score<6){ best={idx:i,score:6}; continue; }
    // substring directa del texto
    if (nq.includes(h) || h.includes(nq)){ if (best.score<3) best={idx:i,score:3}; }
  }
  return best.idx;
}

function computeStatsForColumn(rows, colIdx) {
  if (colIdx<0) return null;
  const headers = rows[0];
  const idxPar = headers.findIndex(h => norm(h)==="paralelo" || /paralel/.test(norm(h)));
  const idxCurso = headers.findIndex(h => norm(h)==="curso" || /curso/.test(norm(h)));
  const idxNombre = headers.findIndex(h => norm(h)==="nombre" || /nombre/.test(norm(h)));

  const body = rows.slice(1);
  const A=[], B=[], ALL=[];
  for (const r of body){
    const v = toNumber(r[colIdx]);
    if (v==null) continue;
    const p = String(r[idxPar]||"").trim().toUpperCase();
    if (p==="A") A.push(v);
    else if (p==="B") B.push(v);
    ALL.push(v);
  }
  const stats = {
    A: { n:A.length, mean:mean(A), median:median(A), sd:stddev(A), min:min(A), max:max(A) },
    B: { n:B.length, mean:mean(B), median:median(B), sd:stddev(B), min:min(B), max:max(B) },
    ALL:{ n:ALL.length, mean:mean(ALL), median:median(ALL), sd:stddev(ALL), min:min(ALL), max:max(ALL) }
  };
  return { stats, idxPar, idxCurso, idxNombre, headers };
}

function format2(x){ return (x==null||!isFinite(x)) ? "" : x.toFixed(2); }

// ====== DETECTORES DE INTENCIÓN ======
function wantsListOnly(q){
  const s=norm(q);
  return /(lista|listado)\b/.test(s) && /(estudiante|alumno)/.test(s) && !/(puntaje|puntos|nota|calificaci)/.test(s);
}
function asksCompareAB(q){
  const s=norm(q);
  return /(compar|diferenc)/.test(s) && /(paralelo| a y b| a vs b| entre a y b)/.test(s);
}
function asksStats(q){
  const s=norm(q);
  return /(promedio|media|mediana|desviaci|percentil|tendencia|min|max|vari|distribuc)/.test(s);
}

// ====== PROMPTS PARA GPT-5 (sólo interpretación) ======
function buildJSONContract({compact=false}={}){
  const size = compact ? "Sé conciso (≤1200 tokens)." : "Sé claro, sin redundancias.";
  return `
Devuelve SOLO este JSON:
{
  "general": "explicación/interpretación (sin asteriscos ni preámbulos)",
  "lists": [{ "title": "Título", "items": ["item 1","item 2"] }],
  "tables": [{ "title": "Título", "columns": ["Col1","Col2"], "rows": [["v1","v2"]] }]
}
Reglas: Español (Ecuador/México). ${size}
`.trim();
}

function buildInterpretationPrompt(metricName, stats, textoBase, {compact=true}={}){
  const A = stats.A, B = stats.B, ALL=stats.ALL;
  const diff = (A.mean!=null && B.mean!=null) ? (B.mean - A.mean) : null;
  const pct  = (A.mean!=null && B.mean!=null && A.mean!==0) ? (diff/A.mean*100) : null;

  return `
Eres psicometrista. Interpreta los resultados del indicador **${metricName}** por paralelo, con base en los siguientes valores (ya calculados):

- Paralelo A: N=${A.n}, Promedio=${format2(A.mean)}, Mediana=${format2(A.median)}, DE=${format2(A.sd)}
- Paralelo B: N=${B.n}, Promedio=${format2(B.mean)}, Mediana=${format2(B.median)}, DE=${format2(B.sd)}
- Global: N=${ALL.n}, Promedio=${format2(ALL.mean)}, Mediana=${format2(ALL.median)}, DE=${format2(ALL.sd)}
- Diferencia B−A: ${format2(diff)} (${pct==null?"":format2(pct)+"%"}).

Habla de percentiles de forma conceptual (sin inventar baremos). Señala implicaciones prácticas (alertas/refuerzos) y cautelas metodológicas (sesgo, dispersión, outliers).
${buildJSONContract({compact})}

### Texto base (referencia breve, no copiar en bloque):
${textoBase}
`.trim();
}

function buildGeneralPrompt(question, csvCtx, textoBase, {compact=false}={}){
  return `
Eres analista psicométrico. Responde con explicación completa y tablas cuando aporten valor.
${buildJSONContract({compact})}

### Datos CSV (cabeceras y muestras):
${JSON.stringify(csvCtx)}

### Texto base (referencia):
${textoBase}

### Pregunta:
${question}
`.trim();
}

// ====== OPENAI (con retry y extracción robusta) ======
function extractTextFromResponse(data){
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;
  if (Array.isArray(data?.output)){
    for (const item of data.output){
      if (item?.type==="message" && Array.isArray(item.content)){
        const block=item.content.find(c=>c?.type==="output_text" && typeof c.text==="string");
        if (block?.text) return block.text;
      }
    }
    for (const item of data.output){
      const block=item?.content?.find?.(c=>typeof c?.text==="string");
      if (block?.text) return block.text;
    }
  }
  return "";
}
function extractJSON(text){
  const s=text.indexOf("{"), e=text.lastIndexOf("}");
  if (s===-1 || e===-1 || e<=s) throw new Error("No se encontró JSON en la salida del modelo");
  return JSON.parse(text.slice(s,e+1));
}
async function callOpenAIOnce(prompt, {maxOutput=DEFAULT_MAX_OUTPUT_TOKENS}={}, signal){
  const res = await fetch(OPENAI_URL, {
    method: "POST",
    signal,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: MODEL, input: prompt, max_output_tokens: maxOutput })
  });
  if (!res.ok){
    const t=await res.text().catch(()=> "");
    throw new Error(`OpenAI ${res.status}: ${t}`);
  }
  return res.json();
}
async function callOpenAIWithRetry(prompt, {compactPrompt=null, maxOutput=DEFAULT_MAX_OUTPUT_TOKENS}={}){
  // Primer intento
  let controller = new AbortController();
  let timer = setTimeout(()=>controller.abort(), OPENAI_TIMEOUT_MS);
  try{
    const data = await callOpenAIOnce(prompt, {maxOutput}, controller.signal);
    const text = extractTextFromResponse(data);
    const incomplete = data?.incomplete_details?.reason === "max_output_tokens";
    if (text && text.trim() && !incomplete) return extractJSON(text);
  }catch(e){
    // si no fue AbortError, seguimos a retry igual
  }finally{ clearTimeout(timer); }

  // Segundo intento (compacto + más tope)
  controller = new AbortController();
  timer = setTimeout(()=>controller.abort(), OPENAI_TIMEOUT_MS);
  try{
    const data = await callOpenAIOnce(compactPrompt||prompt, {maxOutput: Math.max(maxOutput, 8000)}, controller.signal);
    const text = extractTextFromResponse(data);
    if (!text || !text.trim()) throw new Error("No se pudo extraer texto del modelo (retry).");
    return extractJSON(text);
  }finally{ clearTimeout(timer); }
}

// ====== RESPUESTAS LOCALES (sin modelo) ======
function tableStudentsBasic(rows){
  const headers = rows[0];
  const idxNombre = headers.findIndex(h=>/nombre/i.test(h));
  const idxCurso = headers.findIndex(h=>/curso/i.test(h));
  const idxPar   = headers.findIndex(h=>/paralel/i.test(h));
  const body = rows.slice(1);
  const out = body.map(r => [r[idxNombre]||"", r[idxCurso]||"", r[idxPar]||""]);
  return {
    general: "Lista de estudiantes de Décimo (sin puntajes).",
    lists: [],
    tables: [{ title:"Estudiantes", columns:["Nombre","Curso","Paralelo"], rows: out }]
  };
}

function tableStatsResponse(metric, comp){ // comp: {stats,{A,B,ALL}}
  const s = comp.stats;
  const diff = (s.A.mean!=null && s.B.mean!=null) ? s.B.mean - s.A.mean : null;
  const pct  = (s.A.mean!=null && s.B.mean!=null && s.A.mean!==0) ? (diff/s.A.mean*100) : null;

  const summary = {
    title: `Resumen numérico — ${metric}`,
    columns: ["Grupo","N","Prom.","Mediana","DE","Mín","Máx"],
    rows: [
      ["Paralelo A", String(s.A.n), format2(s.A.mean), format2(s.A.median), format2(s.A.sd), format2(s.A.min), format2(s.A.max)],
      ["Paralelo B", String(s.B.n), format2(s.B.mean), format2(s.B.median), format2(s.B.sd), format2(s.B.min), format2(s.B.max)],
      ["Global",     String(s.ALL.n), format2(s.ALL.mean), format2(s.ALL.median), format2(s.ALL.sd), format2(s.ALL.min), format2(s.ALL.max)]
    ]
  };
  const compare = {
    title: `Comparación A vs B — ${metric}`,
    columns: ["Métrica","Valor"],
    rows: [
      ["Diferencia B−A", format2(diff)],
      ["Diferencia % vs A", pct==null? "" : `${format2(pct)}%`]
    ]
  };
  return { summary, compare };
}

// ====== META ======
function meta(ms=0){
  return { model: MODEL, ms, loadedAt: STATE.loadedAt, rowCount: STATE.rows? STATE.rows.length-1 : 0 };
}

// ====== HANDLERS ======
export async function GET(req){
  try{
    if (!OPENAI_API_KEY) return json({ok:false, error:"Falta open_ai_key"}, 500);
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q")||"").trim();

    if (q==="__warmup"){ await warmup(); return json({ok:true, warmup:true}); }

    const t0=Date.now();
    await warmup();

    // 1) Lista simple de estudiantes (local)
    if (wantsListOnly(q)){
      const ans = tableStudentsBasic(STATE.rows);
      return json({ ok:true, source: meta(Date.now()-t0), answer: ans });
    }

    const headers = STATE.headers;
    const colIdx = findColumnIndex(headers, q);

    // 2) Si detectamos una columna y la intención es estadística, calculamos local y pedimos SOLO interpretación
    if (colIdx>=0 && (asksStats(q) || asksCompareAB(q))){
      const colName = headers[colIdx];
      const comp = computeStatsForColumn(STATE.rows, colIdx);
      if (comp){
        // Construye respuesta base local (tablas)…
        const base = tableStatsResponse(colName, comp);

        // …y pide a GPT-5 SOLO el texto interpretativo
        const prompt = buildInterpretationPrompt(colName, comp.stats, STATE.textoBase, {compact:true});
        let interp;
        try{
          interp = await callOpenAIWithRetry(prompt, {maxOutput: 3000});
        }catch(e){
          // Fallback: si el modelo falla, igual devolvemos lo numérico
          interp = { general: `Interpretación breve: ${colName}. A y B comparados numéricamente.`, lists:[], tables:[] };
        }

        const answer = {
          general: interp.general || `Interpretación de ${colName}.`,
          lists: interp.lists || [],
          tables: [ base.summary, base.compare, ...(interp.tables||[]) ]
        };
        return json({ ok:true, source: meta(Date.now()-t0), answer });
      }
    }

    // 3) Flujo general (manda contexto y deja que GPT-5 resuelva todo)
    const csvCtx = { headers: STATE.headers, sample: STATE.rows.slice(1, 60) }; // muestra para no saturar
    const full = buildGeneralPrompt(q, csvCtx, STATE.textoBase, {compact:false});
    const compact = buildGeneralPrompt(q, csvCtx, STATE.textoBase, {compact:true});
    let answer;
    try{
      answer = await callOpenAIWithRetry(full, { compactPrompt: compact, maxOutput: DEFAULT_MAX_OUTPUT_TOKENS });
    }catch(e){
      answer = { general:`Hubo un problema al analizar: ${e.message}`, lists:[], tables:[] };
    }
    return json({ ok:true, source: meta(Date.now()-t0), answer });

  }catch(e){
    return json({ ok:true, source: meta(0), answer:{ general:"Hubo un problema al analizar: "+e.message, lists:[], tables:[] } }, 200);
  }
}

export async function POST(req){
  try{
    if (!OPENAI_API_KEY) return json({ok:false, error:"Falta open_ai_key"}, 500);
    const body = await req.json().catch(()=> ({}));
    const q = (body?.q || body?.question || "").trim();

    if (q==="__warmup"){ await warmup(); return json({ok:true, warmup:true}); }

    const t0=Date.now();
    await warmup();

    if (wantsListOnly(q)){
      const ans = tableStudentsBasic(STATE.rows);
      return json({ ok:true, source: meta(Date.now()-t0), answer: ans });
    }

    const headers = STATE.headers;
    const colIdx = findColumnIndex(headers, q);

    if (colIdx>=0 && (asksStats(q) || asksCompareAB(q))){
      const colName = headers[colIdx];
      const comp = computeStatsForColumn(STATE.rows, colIdx);
      if (comp){
        const base = tableStatsResponse(colName, comp);
        const prompt = buildInterpretationPrompt(colName, comp.stats, STATE.textoBase, {compact:true});
        let interp;
        try{
          interp = await callOpenAIWithRetry(prompt, {maxOutput: 3000});
        }catch(e){
          interp = { general: `Interpretación breve: ${colName}. A y B comparados numéricamente.`, lists:[], tables:[] };
        }
        const answer = {
          general: interp.general || `Interpretación de ${colName}.`,
          lists: interp.lists || [],
          tables: [ base.summary, base.compare, ...(interp.tables||[]) ]
        };
        return json({ ok:true, source: meta(Date.now()-t0), answer });
      }
    }

    const csvCtx = { headers: STATE.headers, sample: STATE.rows.slice(1, 60) };
    const full = buildGeneralPrompt(q, csvCtx, STATE.textoBase, {compact:false});
    const compact = buildGeneralPrompt(q, csvCtx, STATE.textoBase, {compact:true});
    let answer;
    try{
      answer = await callOpenAIWithRetry(full, { compactPrompt: compact, maxOutput: DEFAULT_MAX_OUTPUT_TOKENS });
    }catch(e){
      answer = { general:`Hubo un problema al analizar: ${e.message}`, lists:[], tables:[] };
    }
    return json({ ok:true, source: meta(Date.now()-t0), answer });

  }catch(e){
    return json({ ok:true, source: meta(0), answer:{ general:"Hubo un problema al analizar: "+e.message, lists:[], tables:[] } }, 200);
  }
}
