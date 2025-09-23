// /api/answer.js
// Fuentes: /datos/decimo.csv + /data/texto_base.js (conceptual)
// Requiere: open_ai_key (u OPENAI_API_KEY)

import fs from "fs";
import path from "path";

export const config = { runtime: "nodejs" };

/* ===== Helpers ===== */
const clip = (s, max=90000) => {
  const t = String(s||"");
  return t.length>max ? t.slice(0, max) + "\n[... recortado ...]" : t;
};
const safeRead  = p => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const statMtime = p => { try { return fs.statSync(p).mtimeMs || 0; } catch { return 0; } };
const isNum = v => typeof v === "number" && isFinite(v);

/* ===== CSV parsing + stats ===== */
function parseCSV(str){
  const lines = String(str||"").trim().split(/\r?\n/).filter(Boolean);
  if(!lines.length) return { headers:[], rows:[] };
  const headers = lines[0].split(",").map(s=>s.trim());
  const rows = lines.slice(1).map(line=>{
    const cols = line.split(",").map(s=>s.trim());
    const obj = {};
    headers.forEach((h,i)=>{
      const v = cols[i] ?? "";
      const num = Number(v.replace(",", "."));
      obj[h] = (!isNaN(num) && v!=="") ? num : v;
    });
    return obj;
  });
  return { headers, rows };
}
function statsForNumericColumns(rows){
  const nums = {};
  rows.forEach(r=>{
    Object.entries(r).forEach(([k,v])=>{
      if(isNum(v)){ (nums[k] ||= []).push(v); }
    });
  });
  const out = {};
  for(const [k,arr] of Object.entries(nums)){
    const n=arr.length; if(!n) continue;
    const sorted=[...arr].sort((a,b)=>a-b);
    const sum=arr.reduce((a,b)=>a+b,0);
    const mean=sum/n;
    const min=sorted[0], max=sorted[n-1];
    const median = n%2 ? sorted[(n-1)/2] : (sorted[n/2-1]+sorted[n/2])/2;
    const varSample = arr.reduce((a,b)=>a+(b-mean)**2,0)/(n-1||1);
    const stdev = Math.sqrt(varSample);
    out[k] = { n, min, max, mean, median, stdev, sum };
  }
  return out;
}

/* ===== Cache ===== */
let CACHE = { key:"", csv:{headers:[],rows:[]}, csvStats:{}, textoBase:"" };

function clearCache(){ CACHE = { key:"", csv:{headers:[],rows:[]}, csvStats:{}, textoBase:"" }; }

async function loadCache(){
  const textoBasePath = path.join(process.cwd(), "data", "texto_base.js");
  const csvPath       = path.join(process.cwd(), "datos", "decimo.csv");
  const key = `tb:${statMtime(textoBasePath)}|csv:${statMtime(csvPath)}`;
  if (CACHE.key === key && CACHE.csv.rows.length) return CACHE;

  let textoBase = "";
  try {
    const mod = await import("../data/texto_base.js");
    textoBase = String(mod?.TEXTO_BASE ?? "");
  } catch { textoBase = ""; }

  const raw = safeRead(csvPath);
  const csv = parseCSV(raw);
  const csvStats = statsForNumericColumns(csv.rows);
  CACHE = { key, csv, csvStats, textoBase };
  return CACHE;
}

/* ===== Column helpers ===== */
function findNameColumns(headers){
  const cand = [/^nombre(s)?$/i, /^apellid/i, /estudiante/i, /alumn/i];
  const picks = [];
  headers.forEach(h=>{ if (cand.some(rx=>rx.test(h))) picks.push(h); });
  if (!picks.length) {
    const byContains = headers.find(h=>/nombre/i.test(h));
    if (byContains) picks.push(byContains);
  }
  return picks;
}
function findParallelColumn(headers){
  return headers.find(h=>/paralelo|secci[oó]n|curso/i.test(h)) || null;
}
function findNumericColumn(headers, q){
  // detecta la columna numérica mencionada en la pregunta
  const lower = q.toLowerCase();
  const scored = headers
    .map(h=>({h, score: lower.includes(h.toLowerCase()) ? h.length : 0}))
    .filter(x=>x.score>0)
    .sort((a,b)=>b.score-a.score);
  return scored.length ? scored[0].h : null;
}

/* ===== Fast paths (sin GPT) ===== */
function looksListStudents(q){ return /(lista|listado|muestr[a|e]|dime)\s+.*(estudiant|alumn)/i.test(q); }
function looksAverage(q){ return /(promedio|media|average)/i.test(q); }
function looksTop(q){ return /(top\s*\d+|mejores\s*\d+)/i.test(q); }
function looksBottom(q){ return /(peores\s*\d+)/i.test(q); }
function extractN(q, def=10){
  const m = q.match(/(top|mejores|peores)\s*(\d+)/i);
  return m ? Math.max(1, parseInt(m[2],10)) : def;
}
function filterByParallel(rows, parCol, q){
  if(!parCol) return rows;
  if (/paralelo\s*A\b/i.test(q)) return rows.filter(r=>String(r[parCol]).toUpperCase().includes("A"));
  if (/paralelo\s*B\b/i.test(q)) return rows.filter(r=>String(r[parCol]).toUpperCase().includes("B"));
  return rows;
}
function fullNameFrom(row, nameCols){
  const parts = nameCols.map(c=>row[c]).filter(Boolean);
  return parts.join(" ").replace(/\s+/g," ").trim();
}
function fastAnswer(question, csv){
  const q = String(question||"");
  const namesCols = findNameColumns(csv.headers);
  const parCol = findParallelColumn(csv.headers);

  // 1) Lista de estudiantes (global o por A/B)
  if (looksListStudents(q) && namesCols.length) {
    const filtered = filterByParallel(csv.rows, parCol, q);
    const items = filtered.map(r=>fullNameFrom(r, namesCols)).filter(Boolean);
    const uniq = [...new Set(items)].sort((a,b)=>a.localeCompare(b, 'es'));
    return {
      general: `Se listan ${uniq.length} estudiantes${parCol? " ("+( /A\b/i.test(q)?"Paralelo A": /B\b/i.test(q)?"Paralelo B":"A y B")+ ")" : ""}.`,
      lists: [{ title: "Estudiantes de Décimo", items: uniq }],
      tables: [{
        title: "Listado de estudiantes",
        columns: ["Estudiante"],    // el front añade # automáticamente
        rows: uniq.map(n=>[n])
      }]
    };
  }

  // 2) Promedio de <col> (global o por A/B)
  if (looksAverage(q)) {
    const col = findNumericColumn(csv.headers, q);
    if (col) {
      const filtered = filterByParallel(csv.rows, parCol, q);
      const vals = filtered.map(r=>r[col]).filter(isNum);
      const n=vals.length, mean = vals.reduce((a,b)=>a+b,0)/(n||1);
      return {
        general: `Promedio de ${col}${parCol? " ("+( /A\b/i.test(q)?"Paralelo A": /B\b/i.test(q)?"Paralelo B":"A y B") +")":""}: ${mean.toFixed(2)} (n=${n}).`,
        tables:[{
          title:`Promedio de ${col}`,
          columns:["Métrica","Valor"],
          rows:[["n", String(n)], ["Promedio", mean.toFixed(4)]]
        }],
        lists:[]
      };
    }
  }

  // 3) Top N / Mejores N de <col>
  if (looksTop(q)) {
    const N = extractN(q, 10);
    const col = findNumericColumn(csv.headers, q);
    if (col && namesCols.length) {
      const filtered = filterByParallel(csv.rows, parCol, q)
        .filter(r=>isNum(r[col]));
      filtered.sort((a,b)=>b[col]-a[col]);
      const top = filtered.slice(0, N).map((r)=>[ fullNameFrom(r, namesCols), r[col] ]);
      return {
        general: `Top ${Math.min(N, top.length)} en ${col}.`,
        tables:[{
          title:`Top ${N} en ${col}`,
          columns:["Estudiante", col],
          rows: top.map(([n,v])=>[n, String(v)])
        }],
        lists:[]
      };
    }
  }

  // 4) Peores N de <col>
  if (looksBottom(q)) {
    const N = extractN(q, 10);
    const col = findNumericColumn(csv.headers, q);
    if (col && namesCols.length) {
      const filtered = filterByParallel(csv.rows, parCol, q)
        .filter(r=>isNum(r[col]));
      filtered.sort((a,b)=>a[col]-b[col]);
      const bot = filtered.slice(0, N).map((r)=>[ fullNameFrom(r, namesCols), r[col] ]);
      return {
        general: `Peores ${Math.min(N, bot.length)} en ${col}.`,
        tables:[{
          title:`Peores ${N} en ${col}`,
          columns:["Estudiante", col],
          rows: bot.map(([n,v])=>[n, String(v)])
        }],
        lists:[]
      };
    }
  }

  return null;
}

/* ===== OpenAI ===== */
async function callOpenAI({ question, cache, model, apiKey }){
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });

  const system = `
Eres una analista experta. Responde SIEMPRE en español (MX/EC).
NUNCA digas "no puedo"; si faltan datos, explica asunciones razonables y calcula con lo disponible.
Realiza cálculos psicométricos y estadísticos (media, mediana, percentiles aproximados, desviación estándar, correlaciones simples si aplica), promedios, progresiones y razonamientos lógicos.
Cuando se soliciten listas o tablas, devuelve tablas en JSON.
Devuelve EXCLUSIVAMENTE JSON válido:
{
  "general": "<texto>",
  "tables": [{"title":"...","columns":["Col1","Col2"],"rows":[["v1","v2"]]}],
  "lists": [{"title":"...","items":["item1","item2"]}]
}
`.trim();

  const { headers, rows } = cache.csv;
  const sample = rows.slice(0, 20);
  const csvStats = cache.csvStats;
  const textoBase = cache.textoBase;

  const user = `
PREGUNTA: ${String(question||"").replaceAll("*","")}

Contexto del CSV decimo.csv:
- Asunción/guía: 48 estudiantes (paralelos A y B) y 18 columnas de calificaciones/puntuaciones.
- Cabeceras: ${JSON.stringify(headers)}
- Muestra (primeras 20 filas): ${JSON.stringify(sample)}
- Estadísticos por columna numérica: ${JSON.stringify(csvStats)}

TEXTO BASE (conceptual/metodológico):
${clip(textoBase, 20000)}
`.trim();

  const resp = await client.chat.completions.create({
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    response_format: { type: "json_object" }
  });

  const content = resp.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(content); }
  catch { return { general: content, tables: [], lists: [] }; }
}

/* ===== Handler ===== */
export default async function handler(req, res){
  if(req.method==="OPTIONS") return res.status(200).end();
  try{
    const body = req.method==="POST" ? (req.body||{}) : (req.query||{});
    const question = String(body.question || body.q || "");
    const model = String(body.model || "");
    const apiKey = process.env.open_ai_key || process.env.OPENAI_API_KEY;
    const flush = body.flush || req.query.flush;

    // flush de cache manual (y warmup corto)
    if (flush) { clearCache(); }

    if(!apiKey) return res.status(500).json({ ok:false, error:"Falta open_ai_key/OPENAI_API_KEY" });

    // warmup sin costo (no requiere question real)
    if (question === "__warmup") {
      await loadCache();
      return res.status(200).json({ ok:true, warmup:true });
    }
    if(!question.trim()) return res.status(400).json({ ok:false, error:"Falta la pregunta (question|q)" });

    const cache = await loadCache();

    // FAST PATHS (sin GPT) para máxima rapidez
    const quick = fastAnswer(question, cache.csv);
    if (quick) {
      return res.status(200).json({
        ok:true,
        source:{ fast:true, headers: cache.csv.headers, hasCSV: !!cache.csv.rows.length },
        answer: quick
      });
    }

    // GPT con contexto mínimo si la consulta es compleja
    const answer = await callOpenAI({ question, cache, model, apiKey });
    return res.status(200).json({
      ok:true,
      source:{ fast:false, headers: cache.csv.headers, hasCSV: !!cache.csv.rows.length },
      answer
    });
  }catch(err){
    console.error("answer.js error:", err);
    return res.status(200).json({ ok:false, error:String(err?.message||err) });
  }
}
