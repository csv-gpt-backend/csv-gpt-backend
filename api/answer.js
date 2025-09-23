// /api/answer.js
// Usa: /data/texto_base.js y /datos/decimo.csv
// Requiere: open_ai_key (u OPENAI_API_KEY)

import fs from "fs";
import path from "path";

export const config = { runtime: "nodejs" };

/* ===== Helpers ===== */
const clip = (s, max=90000) => String(s||"").length>max ? String(s||"").slice(0,max)+"\n[... recortado ...]" : String(s||"");
const safeRead = p => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const statMtime = p => { try { return fs.statSync(p).mtimeMs || 0; } catch { return 0; } };

/* ===== Cache ===== */
let CACHE = { key:"", corpus:null, csvStats:null };

/* ===== CSV parsing + stats ===== */
function parseCSV(str){
  // Simple: separa por líneas y comas. Si tu CSV tiene comillas/; complejos, cambialo por un parser.
  const lines = str.trim().split(/\r?\n/);
  if(!lines.length) return { headers:[], rows:[] };
  const headers = lines[0].split(",").map(s=>s.trim());
  const rows = lines.slice(1).map(line=>{
    const cols = line.split(",").map(s=>s.trim());
    const obj = {};
    headers.forEach((h,i)=>{
      const v = cols[i] ?? "";
      const num = Number(v.replace(",", "."));
      obj[h] = !isNaN(num) && v!=="" ? num : v;
    });
    return obj;
  });
  return { headers, rows };
}
function statsForNumericColumns(rows){
  const nums = {};
  rows.forEach(r=>{
    Object.entries(r).forEach(([k,v])=>{
      if(typeof v === "number" && isFinite(v)){
        (nums[k] ||= []).push(v);
      }
    });
  });
  const out = {};
  for(const [k,arr] of Object.entries(nums)){
    const n=arr.length;
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

/* ===== Load + cache ===== */
async function gatherLocalCorpusCached(){
  const textoBasePath = path.join(process.cwd(), "data", "texto_base.js");
  const csvPath       = path.join(process.cwd(), "datos", "decimo.csv");
  const cacheKey = `tb:${statMtime(textoBasePath)}|csv:${statMtime(csvPath)}`;

  if(CACHE.key===cacheKey && CACHE.corpus){
    return CACHE;
  }

  // Texto embebido
  let textoBase="";
  try{
    const mod = await import("../data/texto_base.js");
    textoBase = String(mod?.TEXTO_BASE ?? "");
  }catch{ textoBase=""; }

  // CSV + stats
  const csvRaw = safeRead(csvPath);
  const { headers, rows } = parseCSV(csvRaw);
  const csvStats = statsForNumericColumns(rows);

  const corpus = {
    textoBase: clip(textoBase, 120000),
    csvRaw: clip(csvRaw, 120000),
    csvHeaders: headers,
    csvPreview: rows.slice(0, 50) // vista rápida para contexto
  };

  CACHE = { key: cacheKey, corpus, csvStats };
  return CACHE;
}

/* ===== OpenAI ===== */
async function callOpenAI({ question, cache, model, apiKey }){
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });

  const system = `
Eres una analista experta. Responde SIEMPRE en español (MX/EC) con precisión y calma.
NUNCA digas "no puedo"; si faltan datos, explica asunciones razonables y calcula con lo disponible.
Realiza cálculos psicométricos, estadísticos (media, mediana, percentiles aproximados, desviación estándar, correlaciones simples si aplica), promedios, regresiones muy simples y razonamientos lógicos.
Cuando se soliciten listas/tablas, entrégalos en JSON-tabla.
Devuelve EXCLUSIVAMENTE JSON válido con:
{
  "general": "<texto explicando el razonamiento y resultados>",
  "tables": [
    {"title":"...", "columns":["Col1","Col2"], "rows":[["v1","v2"]]}
  ],
  "lists": [
    {"title":"...", "items":["item1","item2"]}
  ]
}
`.trim();

  const { textoBase, csvRaw, csvHeaders, csvPreview } = cache.corpus;
  const csvStats = cache.csvStats;

  const user = `
PREGUNTA: ${String(question||"").replaceAll("*","")}

FUENTE: CSV decimo.csv (crudo, primeras filas y cabeceras incluidas)
- Cabeceras: ${JSON.stringify(csvHeaders)}
- Muestra (primeras filas): ${JSON.stringify(csvPreview)}
- Estadísticos por columna numérica: ${JSON.stringify(csvStats)}

TEXTO BASE (información conceptual/metodológica):
${textoBase || "(vacío)"} 
`.trim();

  const resp = await client.chat.completions.create({
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    // sin temperature para compatibilidad/rapidez
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
    const question = String(body.question||body.q||"");
    const model = String(body.model||"");
    const apiKey = process.env.open_ai_key || process.env.OPENAI_API_KEY;
    if(!apiKey) return res.status(500).json({ ok:false, error:"Falta open_ai_key/OPENAI_API_KEY" });
    if(!question.trim()) return res.status(400).json({ ok:false, error:"Falta la pregunta (question|q)" });

    const cache = await gatherLocalCorpusCached();
    const answer = await callOpenAI({ question, cache, model, apiKey });

    return res.status(200).json({
      ok:true,
      source:{
        hasTXT: !!cache.corpus.textoBase,
        hasCSV: !!cache.corpus.csvRaw,
        csvHeaders: cache.corpus.csvHeaders
      },
      answer
    });
  }catch(err){
    console.error("answer.js error:", err);
    return res.status(200).json({ ok:false, error:String(err?.message||err) });
  }
}
