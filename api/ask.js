// api/ask.js — Vercel Serverless (Node 18+)
// v18: fallback local para "grupos de 5" con AGRESION y EMPATIA
const fs = require("fs");
const path = require("path");

// ===== Build/version =====
const VERSION = "gpt5-csv-direct-main-18";
const MODEL   = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

// ---------- util ----------
function setCORS(res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type, Authorization");
  res.setHeader("Cache-Control","no-store, no-cache, max-age=0, must-revalidate");
}
function sendJSON(res, code, obj){
  setCORS(res);
  res.statusCode = code;
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}
function safeJSON(x, fallback = {}){ try{ return typeof x==="string"? JSON.parse(x): (x||fallback);}catch{ return fallback; } }
function ensureObject(x){
  if (!x || typeof x!=="object" || Array.isArray(x)) return { respuesta: String(x||"").trim() || "" };
  if (typeof x.respuesta!=="string") x.respuesta = x.respuesta? String(x.respuesta): "";
  return x;
}
function extractFirstJSONBlock(text){
  const start = text.indexOf("{"); if (start<0) return null;
  let depth=0;
  for (let i=start;i<text.length;i++){
    const ch = text[i];
    if (ch==="{") depth++;
    if (ch==="}") { depth--; if (depth===0){ const cand=text.slice(start,i+1); try{ return JSON.parse(cand);}catch{} break; } }
  }
  return null;
}
const norm = s => (s||"").toString().normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim();

// ---------- CSV I/O ----------
function detectDelimiter(sample){
  const head = sample.split(/\r?\n/).slice(0,3).join("\n");
  const counts = [[",",(head.match(/,/g)||[]).length],[";",(head.match(/;/g)||[]).length],["\t",(head.match(/\t/g)||[]).length]]
    .sort((a,b)=>b[1]-a[1]);
  return counts[0][1]? counts[0][0]: ",";
}
function loadCSVFromFS(){
  const tries=[path.join(process.cwd(),"api","data.csv"), path.join(process.cwd(),"data.csv")];
  for (const filePath of tries){
    if (fs.existsSync(filePath)){
      const csv=fs.readFileSync(filePath,"utf8");
      const d=detectDelimiter(csv);
      const lines = csv.split(/\r?\n/).filter(l => l.length>0);
      if (lines.length===0) throw new Error("CSV vacío.");
      const headers = lines[0].split(d).map(s=>s.trim());
      const rowsNum = lines.slice(1).map(l => l.split(d));
      const rows = rowsNum.map(arr => {
        const o = {};
        headers.forEach((h, i) => o[h] = (arr[i] ?? "").trim());
        return o;
      });
      return { csv, filePath, rowsCount: rows.length, headers, rows, source:"fs", delimiter:d };
    }
  }
  throw new Error("CSV no encontrado. Sube api/data.csv o data.csv al repo.");
}

// ---------- OpenAI (Responses API) ----------
function getTextFromResponses(data){
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  if (Array.isArray(data?.output)){
    const parts=[];
    for (const item of data.output){
      if (Array.isArray(item?.content)){
        for (const c of item.content){
          const txt = (c?.text || c?.content || "").toString();
          if (txt) parts.push(txt);
        }
      }
    }
    const joined = parts.join("").trim();
    if (joined) return joined;
  }
  if (Array.isArray(data?.content)){
    const t = data.content.map(c => c?.text || "").join("").trim();
    if (t) return t;
  }
  return "";
}
async function callResponses({ system, user, maxTokens, timeoutMs }){
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(), timeoutMs);
  const payload={
    model: MODEL,
    input: [
      { role: "system", content: [{ type:"input_text", text: system }] },
      { role: "user",   content: [{ type:"input_text", text: user   }] }
    ],
    max_output_tokens: Math.max(64, Math.min(maxTokens, 2000))
  };
  try{
    const r = await fetch("https://api.openai.com/v1/responses",{
      method:"POST", signal:ac.signal,
      headers:{ "Content-Type":"application/json","Authorization":`Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(payload)
    });
    clearTimeout(timer);
    if (!r.ok){ const t=await r.text().catch(()=> ""); throw new Error(`OpenAI(responses) ${r.status}: ${t}`); }
    const data = await r.json();
    return getTextFromResponses(data);
  }catch(e){ clearTimeout(timer); if (e.name==="AbortError") throw new Error(`Timeout (~${Math.round(timeoutMs/1000)}s)`); throw e; }
}

// ---------- OpenAI (Chat Completions fallback) ----------
async function callChat({ system, user, maxTokens, timeoutMs }){
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(), timeoutMs);
  const payload={
    model: MODEL,
    max_completion_tokens: Math.max(64, Math.min(maxTokens, 1200)),
    messages:[ {role:"system", content: system},{role:"user", content: user} ]
  };
  try{
    const r = await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST", signal:ac.signal,
      headers:{ "Content-Type":"application/json","Authorization":`Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(payload)
    });
    clearTimeout(timer);
    if (!r.ok){ const t=await r.text().catch(()=> ""); throw new Error(`OpenAI(chat) ${r.status}: ${t}`); }
    const data = await r.json();
    return (data?.choices?.[0]?.message?.content || "").trim();
  }catch(e){ clearTimeout(timer); if (e.name==="AbortError") throw new Error(`Timeout (~${Math.round(timeoutMs/1000)}s)`); throw e; }
}

async function askStable({ system, user, maxTokens=600, timeoutMs=45000 }){
  let txt="";
  try{ txt = await callResponses({ system, user, maxTokens, timeoutMs }); }catch{}
  if (!txt){ try{ txt = await callChat({ system, user, maxTokens: Math.max(maxTokens,700), timeoutMs }); }catch{} }
  if (!txt) return { _empty: true, respuesta: "Sin contenido del modelo (Responses+Chat)." };

  try{
    const obj = ensureObject(JSON.parse(txt));
    if (!obj.respuesta && !obj.tabla) obj.respuesta = "Resultado generado.";
    return obj;
  }catch{
    const block = extractFirstJSONBlock(txt);
    if (block){ const obj=ensureObject(block); if (!obj.respuesta && !obj.tabla) obj.respuesta="Resultado recuperado."; return obj; }
    return { respuesta: txt };
  }
}

// ---------- Local engine: grupos de 5 con AGRESION y EMPATIA ----------
function findHeader(headers, candidates){
  const H = headers.map(h => ({ raw: h, n: norm(h) }));
  for (const cand of candidates){
    const nc = norm(cand);
    const hit = H.find(h => h.n === nc);
    if (hit) return hit.raw;
  }
  // búsqueda “contiene”
  for (const cand of candidates){
    const nc = norm(cand);
    const hit = H.find(h => h.n.includes(nc));
    if (hit) return hit.raw;
  }
  return null;
}
function toNumber(x){ const n = Number(String(x).replace(",",".").trim()); return Number.isFinite(n)? n: NaN; }
function zscore(arr){
  const valid = arr.filter(v => Number.isFinite(v));
  const mean = valid.reduce((a,b)=>a+b,0) / (valid.length || 1);
  const sd = Math.sqrt(valid.reduce((a,b)=>a+(b-mean)*(b-mean),0) / (valid.length || 1)) || 1;
  return arr.map(v => Number.isFinite(v)? (v-mean)/sd : 0);
}
function gruposHomogeneos5(rows, nameKey, v1Key, v2Key){
  // extrae números
  const v1 = rows.map(r => toNumber(r[v1Key]));
  const v2 = rows.map(r => toNumber(r[v2Key]));
  const z1 = zscore(v1);
  const z2 = zscore(v2);
  // score combinado
  const scores = z1.map((z,i) => (z + z2[i]) / 2);
  // ordenar por score ascendente para grupos "homogéneos"
  const idx = scores.map((s,i)=>({i,s})).sort((a,b)=>a.s-b.s).map(o=>o.i);
  const ordered = idx.map(i => ({ nombre: rows[i][nameKey], score: scores[i] }));
  // armar grupos consecutivos de 5
  const groups = [];
  let g = 1;
  for (let i=0; i<ordered.length; i+=5){
    const chunk = ordered.slice(i, i+5);
    for (const it of chunk){
      groups.push([`Grupo ${g}`, it.nombre || ""]);
    }
    g++;
  }
  return { headers: ["Grupo","NOMBRE"], rows: groups };
}
function maybeLocalGroups(query, dataset){
  const q = norm(query);
  if (!/GRUP|EQUIP/.test(q)) return null;
  // debe mencionar ambas variables
  if (!/AGRESION/.test(q) || !/EMPATIA/.test(q)) return null;

  const headers = dataset.headers;
  const nameKey = findHeader(headers, ["NOMBRE","NOMBRES","ALUMNO","ESTUDIANTE"]);
  const v1Key   = findHeader(headers, ["AGRESION"]);
  const v2Key   = findHeader(headers, ["EMPATIA","EMPATÍA"]);
  if (!nameKey || !v1Key || !v2Key) return { respuesta: "No se encontraron columnas NOMBRE / AGRESION / EMPATIA." };

  const tabla = gruposHomogeneos5(dataset.rows, nameKey, v1Key, v2Key);
  return {
    respuesta: `Grupos homogéneos de 5 formados con ${v1Key} y ${v2Key}.`,
    tabla
  };
}

// ---------- handler ----------
module.exports = async (req,res)=>{
  try{
    if (req.method==="OPTIONS"){ setCORS(res); res.statusCode=204; return res.end(); }

    const url = new URL(req.url, `http://${req.headers.host}`);
    let q = url.searchParams.get("q") || "";
    if (!q && req.method!=="GET"){ const b = typeof req.body==="string"? safeJSON(req.body): (req.body||{}); q = (b.q||""); }
    q = q.toString().trim();
    const ql = q.toLowerCase();

    const maxParam = parseInt(url.searchParams.get("max")||"",10);
    const tParam   = parseInt(url.searchParams.get("t")  ||"",10);
    const maxTokens = Number.isFinite(maxParam)? maxParam: 600;
    const timeoutMs = Number.isFinite(tParam)? tParam: 45000;

    if (!q || ql==="ping") return sendJSON(res,200,{ok:true});
    if (ql==="version")   return sendJSON(res,200,{version: VERSION});
    if (ql==="model")     return sendJSON(res,200,{model: MODEL});

    // CSV
    const dataset = loadCSVFromFS(); // { headers, rows, ... }

    if (ql==="diag"){
      return sendJSON(res,200,{ source: dataset.source, filePath: dataset.filePath, rows: dataset.rowsCount, headers: dataset.headers });
    }

    // ----- 1) Intento local si la pregunta es de "grupos ..." -----
    const local = maybeLocalGroups(q, dataset);
    if (local) return sendJSON(res,200, local);

    // ----- 2) Si no es caso local, usamos GPT-5 estable -----
    const system = `
Eres un analista de datos. Devuelve JSON válido y conciso:
{
  "respuesta": "texto breve en español",
  "tabla": { "headers": [..], "rows": [[..], ..] }
}
Reglas:
- El CSV viene entre <CSV>...</CSV>. La primera fila son encabezados.
- Acepta sinónimos (acentos/mayúsculas); "por separado" = agrupar por "PARALELO".
- "ranking" => máx 10 filas (mayor→menor) + columna "posición".
- Si la consulta es inválida o no hay datos: {"respuesta":"No encontrado"}.
- No devuelvas Markdown ni texto fuera del JSON.`;

    const user = `<CSV>
${dataset.headers.join(",")}
${dataset.rows.map(r => dataset.headers.map(h => (r[h] ?? "")).join(",")).join("\n")}
</CSV>

Pregunta:
${q}`;

    const out = await askStable({ system, user, maxTokens, timeoutMs });

    // ----- 3) Si GPT-5 quedó mudo, devolvemos un mensaje útil en vez de "{}" -----
    if (out && out._empty) {
      return sendJSON(res,200,{ respuesta:"Respuesta generada por respaldo local no disponible para esta consulta y el modelo no respondió. Prueba con &max=700&t=50000 o formula una consulta más corta." });
    }
    return sendJSON(res,200, out);

  }catch(err){
    return sendJSON(res,500,{error:String(err.message||err)});
  }
};
