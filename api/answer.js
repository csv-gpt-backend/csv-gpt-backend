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
      if(typeof v === "number" && isFinite(v)){
        (nums[k] ||= []).push(v);
      }
    });
  });
  const out = {};
  for(const [k,arr] of Object.entries(nums)){
    const n=arr.length;
    if(!n) continue;
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

async function loadCache(){
  const textoBasePath = path.join(process.cwd(), "data", "texto_base.js");
  const csvPath       = path.join(process.cwd(), "datos", "decimo.csv");
  const key = `tb:${statMtime(textoBasePath)}|csv:${statMtime(csvPath)}`;
  if (CACHE.key === key) return CACHE;

  // texto base (conceptual)
  let textoBase = "";
  try {
    const mod = await import("../data/texto_base.js");
    textoBase = String(mod?.TEXTO_BASE ?? "");
  } catch { textoBase = ""; }

  // csv
  const raw = safeRead(csvPath);
  const csv = parseCSV(raw);
  const csvStats = statsForNumericColumns(csv.rows);

  CACHE = { key, csv, csvStats, textoBase };
  return CACHE;
}

/* ===== Fast path: responde sin GPT para consultas típicas ===== */
function looksLikeListOfStudents(q){ return /(lista|listado|muestr[a|e]|dime)\s+.*(estudiant|alumn)/i.test(q); }
function findNameColumns(headers){
  // columnas típicas que contienen nombres/apellidos
  const cand = [/^nombre(s)?$/i, /^apellid/i, /estudiante/i, /alumn/i];
  const picks = [];
  headers.forEach(h=>{
    if (cand.some(rx=>rx.test(h))) picks.push(h);
  });
  // fallback: una sola columna que contenga "nombre"
  if (!picks.length) {
    const byContains = headers.find(h=>/nombre/i.test(h));
    if (byContains) picks.push(byContains);
  }
  return picks;
}
function fastAnswerIfPossible(question, csv){
  const q = String(question||"");
  if (looksLikeListOfStudents(q)) {
    const namesCols = findNameColumns(csv.headers);
    if (!namesCols.length) return null;

    // Construir nombre completo usando las columnas encontradas
    const items = [];
    csv.rows.forEach(r=>{
      const parts = namesCols.map(c=>r[c]).filter(Boolean);
      const name = parts.join(" ").replace(/\s+/g," ").trim();
      if (name) items.push(name);
    });
    const uniq = [...new Set(items)].sort((a,b)=>a.localeCompare(b, 'es'));

    return {
      ok: true,
      answer: {
        general: `Se listan ${uniq.length} estudiantes encontrados en decimo.csv.`,
        lists: [{ title: "Estudiantes de Décimo", items: uniq }],
        tables: [{
          title: "Listado de estudiantes",
          columns: ["#","Estudiante"],
          rows: uniq.map((n,i)=>[String(i+1), n])
        }]
      },
      source: { fast: true, used: "csv-only" }
    };
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

  // Contexto mínimo para ir rápido: headers + stats + una muestra pequeña
  const { headers, rows } = cache.csv;
  const sample = rows.slice(0, 20); // pequeña muestra ilustrativa
  const csvStats = cache.csvStats;
  const textoBase = cache.textoBase;

  const user = `
PREGUNTA: ${String(question||"").replaceAll("*","")}

CSV: decimo.csv
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
    // sin temperature para compatibilidad; JSON directo
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

    if(!apiKey) return res.status(500).json({ ok:false, error:"Falta open_ai_key/OPENAI_API_KEY" });
    if(!question.trim()) return res.status(400).json({ ok:false, error:"Falta la pregunta (question|q)" });

    // Cache
    const cache = await loadCache();

    // FAST PATH (sin GPT) para consultas típicas
    const quick = fastAnswerIfPossible(question, cache.csv);
    if (quick) return res.status(200).json(quick);

    // Si no aplica fast path, usa GPT con contexto ligero para ir más rápido
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
