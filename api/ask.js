// api/ask.js — SOLO GPT-5 (sin lógica local)
// v20: pipeline robusto Responses -> Chat -> Responses(JSON) -> Chat(JSON)

const fs = require("fs");
const path = require("path");

// ===== Build/version =====
const VERSION = "gpt5-csv-direct-main-20";
const MODEL   = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

// ---------- utils ----------
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

// ---------- CSV ----------
function detectDelimiter(sample){
  const head = sample.split(/\r?\n/).slice(0,3).join("\n");
  const counts = [[",",(head.match(/,/g)||[]).length],[";",(head.match(/;/g)||[]).length],["\t",(head.match(/\t/g)||[]).length]]
    .sort((a,b)=>b[1]-a[1]);
  return counts[0][1]? counts[0][0]: ",";
}
function loadCSV(){
  const tries=[path.join(process.cwd(),"api","data.csv"), path.join(process.cwd(),"data.csv")];
  for (const filePath of tries){
    if (fs.existsSync(filePath)){
      const csv=fs.readFileSync(filePath,"utf8");
      const d=detectDelimiter(csv);
      const lines = csv.split(/\r?\n/).filter(l => l.length>0);
      if (!lines.length) throw new Error("CSV vacío.");
      const headers = lines[0].split(d).map(s=>s.trim());
      const rowsCount = Math.max(0, lines.length-1);
      return { csv, filePath, headers, rowsCount, delimiter: d, source:"fs" };
    }
  }
  throw new Error("CSV no encontrado. Sube api/data.csv o data.csv al repo.");
}

// ---------- OpenAI helpers ----------
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

async function callResponses({ system, user, maxTokens, timeoutMs, json=false }){
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(), timeoutMs);
  const payload={
    model: MODEL,
    input: [
      { role: "system", content: [{ type:"input_text", text: system }] },
      { role: "user",   content: [{ type:"input_text", text: user   }] }
    ],
    max_output_tokens: Math.max(64, Math.min(maxTokens, 2000))
  };
  if (json) payload.response_format = { type: "json_object" };

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

async function callChat({ system, user, maxTokens, timeoutMs, json=false }){
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(), timeoutMs);
  const payload={
    model: MODEL,
    max_completion_tokens: Math.max(64, Math.min(maxTokens, 1200)),
    messages:[ {role:"system", content: system},{role:"user", content: user} ]
  };
  if (json) payload.response_format = { type: "json_object" };

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

async function askGPT5Only({ system, user, maxTokens=600, timeoutMs=45000 }){
  // 1) Responses libre
  let txt = "";
  try{ txt = await callResponses({ system, user, maxTokens, timeoutMs, json:false }); }catch{}
  // 2) Chat libre
  if (!txt){ try{ txt = await callChat({ system, user, maxTokens, timeoutMs, json:false }); }catch{} }
  // 3) Responses JSON
  if (!txt){ try{ txt = await callResponses({ system, user, maxTokens, timeoutMs, json:true  }); }catch{} }
  // 4) Chat JSON
  if (!txt){ try{ txt = await callChat({ system, user, maxTokens, timeoutMs, json:true  }); }catch{} }

  if (!txt) return { _empty: true, respuesta: "El modelo no devolvió contenido (Responses+Chat). Prueba con &max=700&t=50000 o simplifica la solicitud." };

  // Parseo robusto: JSON directo → JSON embebido → texto
  try{
    const obj = ensureObject(JSON.parse(txt));
    if (!obj.respuesta && !obj.tabla) obj.respuesta = "Resultado generado.";
    return obj;
  }catch{
    const block = extractFirstJSONBlock(txt);
    if (block){ const obj=ensureObject(block); if (!obj.respuesta && !obj.tabla) obj.respuesta="Resultado generado."; return obj; }
    return { respuesta: txt };
  }
}

// ---------- handler ----------
module.exports = async (req,res)=>{
  try{
    if (req.method==="OPTIONS"){ setCORS(res); res.statusCode=204; return res.end(); }

    const url = new URL(req.url, `http://${req.headers.host}`);
    let q = url.searchParams.get("q") || "";
    if (!q && req.method!=="GET"){
      const b = typeof req.body==="string"? safeJSON(req.body): (req.body||{});
      q = (b.q||"");
    }
    q = q.toString().trim();
    const ql = q.toLowerCase();

    const maxParam = parseInt(url.searchParams.get("max")||"",10);
    const tParam   = parseInt(url.searchParams.get("t")  ||"",10);
    const maxTokens = Number.isFinite(maxParam)? maxParam: 600;
    const timeoutMs = Number.isFinite(tParam)? tParam: 45000;

    if (!q || ql==="ping") return sendJSON(res,200,{ok:true});
    if (ql==="version")   return sendJSON(res,200,{version: VERSION});
    if (ql==="model")     return sendJSON(res,200,{model: MODEL});

    // Carga CSV y deja consultar "diag"
    const data = loadCSV();
    if (ql==="diag"){
      return sendJSON(res,200,{ source:data.source, filePath:data.filePath, rows:data.rowsCount, headers:data.headers });
    }

    // Prompt SOLO GPT-5
    const system = `
Eres un analista que responde SOLO en JSON válido con el siguiente formato:
{
  "respuesta": "texto breve en español",
  "tabla": { "headers": [..], "rows": [[..], ..] }
}
Reglas:
- El CSV está entre <CSV>...</CSV>. La 1ª fila son encabezados reales; usa solo esos nombres.
- Si piden "tabla", devuélvela en "tabla"; si no, puedes responder solo en "respuesta".
- Si no puedes realizar algo (p.ej., no encuentras columnas), explica con claridad en "respuesta".
- No envíes nada fuera del JSON.`;

    // Le pasamos el CSV tal cual
    const user = `<CSV>
${data.csv}
</CSV>

Pregunta:
${q}`;

    const out = await askGPT5Only({ system, user, maxTokens, timeoutMs });

    if (out && out._empty){
      return sendJSON(res,200,{ respuesta:"El modelo no respondió. Sube &max=700&t=50000 o intenta una pregunta más concreta." });
    }
    return sendJSON(res,200,out);

  }catch(err){
    return sendJSON(res,500,{error:String(err.message||err)});
  }
};
