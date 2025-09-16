// api/ask.js — v26: GPT-5 con debug real (no enmascara errores), caché CSV y flags
// - Muestra el error real de OpenAI (401/429/500/etc). Con &debug=1 incluye cuerpo.
// - JSON primero; libre después. Ignora CSV si la pregunta no lo requiere.
// - Flags: t (timeout), nocsv=1, strict=1 (sin fallback).
// - Fallback opcional a gpt-4.1-mini si NO usas &strict=1 y GPT-5 queda mudo.

const fs = require("fs");
const path = require("path");

const VERSION = "gpt5-csv-direct-main-26";
const PRIMARY_MODEL  = process.env.OPENAI_MODEL || "gpt-5";
const FALLBACK_MODEL = "gpt-4.1-mini"; // opcional, sólo si NO usas &strict=1
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

// ===== Utils =====
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
function safeJSON(x, fb={}){ try{ return typeof x==="string"? JSON.parse(x): (x||fb);}catch{ return fb; } }
function ensureObject(x){
  if (!x || typeof x!=="object" || Array.isArray(x)) return { respuesta: String(x||"").trim() || "" };
  if (typeof x.respuesta!=="string") x.respuesta = x.respuesta? String(x.respuesta): "";
  return x;
}
function extractFirstJSONBlock(text){
  const start = text.indexOf("{"); if (start<0) return null;
  let d=0;
  for (let i=start;i<text.length;i++){
    const ch=text[i];
    if (ch==="{") d++;
    if (ch==="}") { d--; if (d===0){ const cand=text.slice(start,i+1); try{ return JSON.parse(cand);}catch{} break; } }
  }
  return null;
}
const now = ()=>Date.now();

// ===== CSV caché =====
let CSV_CACHE = null;
function detectDelimiter(sample){
  const head = sample.split(/\r?\n/).slice(0,3).join("\n");
  const counts = [[",",(head.match(/,/g)||[]).length],[";",(head.match(/;/g)||[]).length],["\t",(head.match(/\t/g)||[]).length]]
    .sort((a,b)=>b[1]-a[1]);
  return counts[0][1]? counts[0][0]: ",";
}
function loadCSVFresh(){
  const tries = [path.join(process.cwd(),"api","data.csv"), path.join(process.cwd(),"data.csv")];
  for (const filePath of tries){
    if (fs.existsSync(filePath)){
      const csv = fs.readFileSync(filePath,"utf8");
      const d = detectDelimiter(csv);
      const lines = csv.split(/\r?\n/).filter(Boolean);
      if (!lines.length) throw new Error("CSV vacío.");
      const headers = lines[0].split(d).map(s=>s.trim());
      const rowsCount = Math.max(0, lines.length-1);
      return { csv, headers, rowsCount, filePath, delimiter:d, loadedAt: now() };
    }
  }
  throw new Error("CSV no encontrado. Sube api/data.csv o data.csv al repo.");
}
function getCSV(){
  if (CSV_CACHE && (now() - CSV_CACHE.loadedAt < 10*60*1000)) return CSV_CACHE;
  CSV_CACHE = loadCSVFresh();
  return CSV_CACHE;
}

// ===== OpenAI =====
async function chatOnce({ model, system, user, timeoutMs, wantJSON }){
  const ac = new AbortController();
  const timer = setTimeout(()=>ac.abort(), timeoutMs);
  const payload = {
    model,
    messages: [
      { role:"system", content: system },
      { role:"user",   content: user   }
    ]
    // sin temperature/top_p/max_tokens
  };
  if (wantJSON) payload.response_format = { type:"json_object" };

  try{
    const r = await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      signal: ac.signal,
      headers:{
        "Content-Type":"application/json",
        "Authorization":`Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const status = r.status;
    const ok = r.ok;
    const text = await r.text().catch(()=> "");

    clearTimeout(timer);

    if (!ok){
      // Devuelve error detallado (no lo ocultamos)
      return { ok:false, status, body:text };
    }
    const data = safeJSON(text, null);
    const content = (data?.choices?.[0]?.message?.content || "").trim();
    return { ok:true, content };
  }catch(e){
    clearTimeout(timer);
    // Timeout o error de red
    return { ok:false, status:0, body:String(e && e.message ? e.message : e) };
  }
}

function parseToJSON(txt){
  try{
    const obj = ensureObject(JSON.parse(txt));
    if (!obj.respuesta && !obj.tabla) obj.respuesta = "OK";
    return obj;
  }catch{
    const blk = extractFirstJSONBlock(txt);
    if (blk){ const obj=ensureObject(blk); if (!obj.respuesta && !obj.tabla) obj.respuesta="OK"; return obj; }
    return { respuesta: txt };
  }
}

async function askLLM({ model, system, user, timeoutMs }){
  const errors = [];

  // 1) JSON
  let r = await chatOnce({ model, system, user, timeoutMs, wantJSON:true });
  if (r.ok && r.content) return { out: parseToJSON(r.content), errors };

  if (!r.ok) errors.push({ attempt:"json", model, status:r.status, body:r.body });

  // 2) Libre
  r = await chatOnce({ model, system, user, timeoutMs, wantJSON:false });
  if (r.ok && r.content) return { out: parseToJSON(r.content), errors };

  if (!r.ok) errors.push({ attempt:"text", model, status:r.status, body:r.body });

  return { out:null, errors };
}

// ===== Handler =====
module.exports = async (req,res)=>{
  try{
    if (req.method==="OPTIONS"){ setCORS(res); res.statusCode=204; return res.end(); }

    const url = new URL(req.url, `http://${req.headers.host}`);
    let q = url.searchParams.get("q") || "";
    if (!q && req.method!=="GET"){
      const b = typeof req.body==="string"? safeJSON(req.body): (req.body||{});
      q = (b.q||"");
    }
    q = String(q||"").trim();
    const ql = q.toLowerCase();

    const tParam = parseInt(url.searchParams.get("t")||"",10);
    const strict = url.searchParams.get("strict")==="1";
    const nocsv  = url.searchParams.get("nocsv")==="1";
    const debug  = url.searchParams.get("debug")==="1";

    const timeoutMs = Number.isFinite(tParam)? tParam : 120000; // 120s

    if (!q || ql==="ping")  return sendJSON(res,200,{ok:true});
    if (ql==="version")     return sendJSON(res,200,{version: VERSION});
    if (ql==="model")       return sendJSON(res,200,{model: PRIMARY_MODEL});

    const data = getCSV();
    if (ql==="diag"){
      return sendJSON(res,200,{ source:"fs", filePath:data.filePath, rows:data.rowsCount, headers:data.headers });
    }

    const system = `Responde SIEMPRE en JSON válido:
{
  "respuesta": "texto breve en español",
  "tabla": { "headers": [..], "rows": [[..], ..] }
}
Reglas:
- Si la solicitud NO requiere leer el CSV (p.ej. "Escribe OK"), IGNORA el CSV y cumple exactamente lo pedido en "respuesta".
- Si la solicitud SÍ requiere el CSV, usa sólo encabezados reales. Interpreta sinónimos y lenguaje natural.
- Si hay ambigüedad o columnas no coinciden, dilo explícitamente y sugiere cuáles usar.
- Nada fuera del JSON.`;

    let user = "";
    user += "<HEADERS>\n" + data.headers.map(h=>`- ${h}`).join("\n") + "\n</HEADERS>\n\n";
    user += (nocsv ? "<CSV_OMITIDO/>\n\n" : "<CSV>\n" + data.csv + "\n</CSV>\n\n");
    user += "Pregunta:\n" + q;

    // 1) GPT-5
    let { out, errors } = await askLLM({ model: PRIMARY_MODEL, system, user, timeoutMs });

    // 2) Fallback opcional
    if (!out && !strict){
      const fb = await askLLM({ model: FALLBACK_MODEL, system, user, timeoutMs });
      errors = errors.concat(fb.errors||[]);
      if (fb.out){
        fb.out.respuesta = (fb.out.respuesta||"") + " (fallback)";
        out = fb.out;
      }
    }

    if (!out){
      // Si falla, devolvemos los errores reales (y en debug, cuerpo completo)
      const brief = errors.map(e => ({
        attempt: e.attempt,
        model: e.model,
        status: e.status
      }));
      const payload = {
        respuesta: "No se obtuvo respuesta del modelo.",
        hint: "Reintenta o sube t=120000. Si es trivial, usa nocsv=1.",
        errors: brief
      };
      if (debug) payload.debug = errors; // cuerpo crudo
      return sendJSON(res,200,payload);
    }

    return sendJSON(res,200,out);

  }catch(err){
    return sendJSON(res,500,{error:String(err.message||err)});
  }
};
