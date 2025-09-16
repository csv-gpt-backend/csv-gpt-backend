// api/ask.js — GPT-5 robusto con caché de CSV y reintentos
// v25: JSON primero, caché CSV, timeout alto, flags nocsv/strict, fallback opcional

const fs = require("fs");
const path = require("path");

const VERSION = "gpt5-csv-direct-main-25";
const PRIMARY_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const FALLBACK_MODEL = "gpt-4.1-mini"; // opcional; se usa solo si NO pones &strict=1 y GPT-5 no responde
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

// ====== CORS / helpers ======
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
  let d=0;
  for (let i=start;i<text.length;i++){
    const ch=text[i];
    if (ch==="{") d++;
    if (ch==="}") { d--; if (d===0){ const cand=text.slice(start,i+1); try{ return JSON.parse(cand);}catch{} break; } }
  }
  return null;
}
function now(){ return Date.now(); }

// ====== CSV cache ======
let CSV_CACHE = null; // { csv, headers, rowsCount, filePath, delimiter, loadedAt }

function detectDelimiter(sample){
  const head = sample.split(/\r?\n/).slice(0,3).join("\n");
  const counts = [[",",(head.match(/,/g)||[]).length],[";",(head.match(/;/g)||[]).length],["\t",(head.match(/\t/g)||[]).length]]
    .sort((a,b)=>b[1]-a[1]);
  return counts[0][1]? counts[0][0]: ",";
}
function loadCSVFresh(){
  const tries=[path.join(process.cwd(),"api","data.csv"), path.join(process.cwd(),"data.csv")];
  for (const filePath of tries){
    if (fs.existsSync(filePath)){
      const csv=fs.readFileSync(filePath,"utf8");
      const d=detectDelimiter(csv);
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
  // simple caché en memoria por ~10 min
  if (CSV_CACHE && (now() - CSV_CACHE.loadedAt < 10*60*1000)) return CSV_CACHE;
  CSV_CACHE = loadCSVFresh();
  return CSV_CACHE;
}

// ====== OpenAI chat ======
async function chatOnce({ model, system, user, timeoutMs, wantJSON=false }){
  const ac = new AbortController();
  const timer = setTimeout(()=>ac.abort(), timeoutMs);
  const payload = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user   }
    ]
    // sin temperature/top_p/max_tokens: GPT-5 prefiere defaults
  };
  if (wantJSON) payload.response_format = { type: "json_object" };

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
    clearTimeout(timer);
    if (!r.ok){
      const t = await r.text().catch(()=> "");
      throw new Error(`OpenAI ${model} ${r.status}: ${t}`);
    }
    const data = await r.json();
    return (data?.choices?.[0]?.message?.content || "").trim();
  }catch(e){
    clearTimeout(timer);
    if (e.name==="AbortError") throw new Error(`Timeout (~${Math.round(timeoutMs/1000)}s)`);
    throw e;
  }
}

function parseTextToJSON(txt){
  try{
    const obj = ensureObject(JSON.parse(txt));
    if (!obj.respuesta && !obj.tabla) obj.respuesta = "OK";
    return obj;
  }catch{
    const block = extractFirstJSONBlock(txt);
    if (block){ const obj=ensureObject(block); if (!obj.respuesta && !obj.tabla) obj.respuesta="OK"; return obj; }
    return { respuesta: txt };
  }
}

async function askLLM({ model, system, user, timeoutMs }){
  // 1) JSON primero
  let txt = "";
  try{ txt = await chatOnce({ model, system, user, timeoutMs, wantJSON:true }); }catch(_){}
  // 2) Libre si quedó mudo
  if (!txt){ try{ txt = await chatOnce({ model, system, user, timeoutMs, wantJSON:false }); }catch(_){ } }
  if (!txt) return { _empty: true };
  return parseTextToJSON(txt);
}

// ====== handler ======
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

    const tParam  = parseInt(url.searchParams.get("t")||"",10);
    const strict  = url.searchParams.get("strict")==="1";
    const nocsv   = url.searchParams.get("nocsv")==="1";

    const timeoutMs = Number.isFinite(tParam)? tParam : 90000; // 90s por defecto

    if (!q || ql==="ping")    return sendJSON(res,200,{ok:true});
    if (ql==="version")       return sendJSON(res,200,{version: VERSION});
    if (ql==="model")         return sendJSON(res,200,{model: PRIMARY_MODEL});

    const data = getCSV();
    if (ql==="diag"){
      return sendJSON(res,200,{
        source:"fs",
        filePath:data.filePath,
        rows:data.rowsCount,
        headers:data.headers
      });
    }

    // System robusto
    const system = `Responde SIEMPRE en JSON válido:
{
  "respuesta": "texto breve en español",
  "tabla": { "headers": [..], "rows": [[..], ..] }
}
Reglas:
- Si la solicitud NO requiere leer el CSV (p.ej. "Escribe OK"), IGNORA el CSV y cumple exactamente lo pedido en "respuesta".
- Si la solicitud SÍ requiere el CSV, usa solo los encabezados reales. Interpreta sinónimos y lenguaje natural.
- Si hay ambigüedad o columnas no coinciden, dilo explícitamente y sugiere cuáles podría usar.
- Nada fuera del JSON.`;

    // Construcción del mensaje de usuario:
    let userParts = [];
    // headers ayudan al mapeo semántico
    userParts.push("<HEADERS>\n" + data.headers.map(h=>`- ${h}`).join("\n") + "\n</HEADERS>");
    if (!nocsv){
      userParts.push("<CSV>\n" + data.csv + "\n</CSV>");
    }else{
      userParts.push("<CSV_OMITIDO/>");
    }
    userParts.push("Pregunta:\n" + q);
    const user = userParts.join("\n\n");

    // 1) GPT-5
    let out = await askLLM({ model: PRIMARY_MODEL, system, user, timeoutMs });

    // 2) Opcional: fallback si mudo y NO hay strict=1
    if (out && out._empty && !strict){
      try{
        out = await askLLM({ model: FALLBACK_MODEL, system, user, timeoutMs });
        if (out && !out._empty){
          out.respuesta = (out.respuesta||"") + " (fallback)";
        }
      }catch(err){ /* ignorar */ }
    }

    if (out && out._empty){
      return sendJSON(res,200,{
        respuesta: "El modelo no respondió a tiempo. Reintenta o añade &t=120000. Si es trivial, puedes usar &nocsv=1.",
        hint: { strict, nocsv, timeoutMs }
      });
    }
    return sendJSON(res,200,out);

  }catch(err){
    return sendJSON(res,500,{error:String(err.message||err)});
  }
};
