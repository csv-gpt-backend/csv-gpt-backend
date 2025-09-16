// api/ask.js — SOLO GPT-5, NL → columnas reales (sin nada predefinido)
// v24: el modelo mapea sinónimos a headers reales, explica cuál usó, y
//      ignora el CSV si la petición no lo requiere (p.ej. "Escribe OK").

const fs = require("fs");
const path = require("path");

const VERSION = "gpt5-csv-direct-main-24";
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
  let d=0;
  for (let i=start;i<text.length;i++){
    const ch=text[i];
    if (ch==="{") d++;
    if (ch==="}") { d--; if (d===0){ const cand=text.slice(start,i+1); try{ return JSON.parse(cand);}catch{} break; } }
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
      const lines = csv.split(/\r?\n/).filter(Boolean);
      if (!lines.length) throw new Error("CSV vacío.");
      const headers = lines[0].split(d).map(s=>s.trim());
      const rowsCount = Math.max(0, lines.length-1);
      return { csv, filePath, headers, rowsCount, delimiter:d, source:"fs" };
    }
  }
  throw new Error("CSV no encontrado. Sube api/data.csv o data.csv al repo.");
}

// ---------- OpenAI (chat/completions) ----------
async function chatOnce({ system, user, timeoutMs, wantJSON=false }){
  const ac = new AbortController();
  const timer = setTimeout(()=>ac.abort(), timeoutMs);
  const payload = {
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user   }
    ]
    // Sin temperature, sin max_tokens → más estable
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
      throw new Error(`OpenAI(chat) ${r.status}: ${t}`);
    }
    const data = await r.json();
    return (data?.choices?.[0]?.message?.content || "").trim();
  }catch(e){
    clearTimeout(timer);
    if (e.name==="AbortError") throw new Error(`Timeout (~${Math.round(timeoutMs/1000)}s)`);
    throw e;
  }
}

async function ask({ system, user, timeoutMs }){
  // 1) Libre
  let txt=""; try{ txt = await chatOnce({ system, user, timeoutMs, wantJSON:false }); }catch{}
  // 2) JSON si no habló
  if (!txt){ try{ txt = await chatOnce({ system, user, timeoutMs, wantJSON:true  }); }catch{} }

  if (!txt) return { _empty: true };

  // Parse robusto
  try{
    const obj = ensureObject(JSON.parse(txt));
    if (!obj.respuesta && !obj.tabla) obj.respuesta="OK";
    return obj;
  }catch{
    const block = extractFirstJSONBlock(txt);
    if (block){ const obj=ensureObject(block); if (!obj.respuesta && !obj.tabla) obj.respuesta="OK"; return obj; }
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

    // timeout por defecto 60s (subible con &t=90000)
    const tParam = parseInt(url.searchParams.get("t")||"",10);
    const timeoutMs = Number.isFinite(tParam)? tParam : 60000;

    if (!q || ql==="ping") return sendJSON(res,200,{ok:true});
    if (ql==="version")   return sendJSON(res,200,{version: VERSION});
    if (ql==="model")     return sendJSON(res,200,{model: MODEL});

    const data = loadCSV();
    if (ql==="diag"){
      return sendJSON(res,200,{ source:data.source, filePath:data.filePath, rows:data.rowsCount, headers:data.headers });
    }

    // ---- SYSTEM: NL libre → mapear a headers reales; ignorar CSV si no se necesita
    const system = `Responde SIEMPRE en JSON válido con:
{
  "respuesta": "texto breve en español",
  "tabla": { "headers": [..], "rows": [[..], ..] }
}
Reglas:
- Si la solicitud del usuario NO requiere leer el CSV (p.ej., "Escribe OK en respuesta"),
  IGNORA el CSV y cumple EXACTAMENTE lo pedido en "respuesta".
- Si la solicitud SÍ requiere el CSV, usa SOLO los encabezados reales. Interpreta sinónimos y lenguaje natural
  (p.ej., "autoconfianza"→"AUTOESTIMA", "cursos"→"CURSO"). Mapea términos de la pregunta al encabezado más cercano
  de <HEADERS> por similitud semántica. Indica en "respuesta" qué columnas reales usaste.
- Si hay ambigüedad fuerte o ninguna columna encaja, dilo claramente en "respuesta" y sugiere opciones.
- No inventes columnas ni valores. No incluyas nada fuera del JSON.`;

    // listamos headers para que el modelo pueda mapear sinónimos
    const headersList = data.headers.map(h => `- ${h}`).join("\n");

    const user = `<HEADERS>
${headersList}
</HEADERS>

<CSV>
${data.csv}
</CSV>

Pregunta:
${q}`;

    const out = await ask({ system, user, timeoutMs });

    if (out && out._empty){
      return sendJSON(res,200,{ respuesta:"El modelo no respondió. Reintenta o añade &t=90000 para más tiempo." });
    }
    return sendJSON(res,200,out);

  }catch(err){
    return sendJSON(res,500,{error:String(err.message||err)});
  }
};
