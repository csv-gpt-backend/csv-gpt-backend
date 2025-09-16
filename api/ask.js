// api/ask.js — Vercel Serverless (Node 18+)
// v19: Detección dinámica de columnas según la PREGUNTA (sin predefinir nombres)
// - Si la pregunta pide "grupos/equipos de N usando X y Y", forma grupos localmente
//   detectando las dos columnas numéricas que mejor emparejen con X e Y.
// - Mantiene pipeline GPT-5 (Responses -> Chat) y fallback robusto.

const fs = require("fs");
const path = require("path");

// ===== Build/version =====
const VERSION = "gpt5-csv-direct-main-19";
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
const deburr = (s="") => s.normalize("NFD").replace(/[\u0300-\u036f]/g,"");
const norm   = (s="") => deburr(String(s)).toLowerCase().trim();

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
      const rowsArr = lines.slice(1).map(l => l.split(d));
      const rows = rowsArr.map(arr => {
        const o = {};
        headers.forEach((h, i) => o[h] = (arr[i] ?? "").trim());
        return o;
      });
      return { csv, filePath, headers, rows, rowsCount: rows.length, delimiter:d, source:"fs" };
    }
  }
  throw new Error("CSV no encontrado. Sube api/data.csv o data.csv al repo.");
}

// ---------- Similaridad sencilla (sin librerías externas) ----------
const STOP = new Set([
  "de","del","la","las","los","el","en","por","para","con","y","o","u","a","al",
  "un","una","unos","unas","que","como","segun","según","sobre","se","si","sí"
]);
function tokenize(s){
  return norm(s).split(/[^a-z0-9]+/).filter(t => t && t.length>2 && !STOP.has(t));
}
function lcp(a,b){ // longest common prefix len (rápido)
  let i=0; const L=Math.min(a.length,b.length);
  while(i<L && a[i]===b[i]) i++; return i;
}
function tokenOverlapScore(a,b){
  const A=new Set(tokenize(a)), B=new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter=0; for(const t of A) if(B.has(t)) inter++;
  return inter / Math.max(A.size,B.size);
}
function fuzzyScore(needle, hay){ // combina includes + prefijo + solapamiento
  const n = norm(needle), h = norm(hay);
  let s = 0;
  if (!n || !h) return 0;
  if (h.includes(n)) s += 1.2;
  if (n.includes(h)) s += 0.8;
  s += Math.min(lcp(n,h)/10, 1);
  s += tokenOverlapScore(n,h) * 2;
  // bonus por compartir raíz (4 chars) cuando hay pocas letras
  if (n.length>=4 && h.includes(n.slice(0,4))) s += 0.5;
  return s;
}

// ¿Columna “nombre/persona”? sin predefinir exactos: detecta por semántica
function isNameLike(header){
  const h = norm(header);
  return /(nombre|nombres|alumn|estudiant|person|apellid|full|name)/.test(h);
}
function isNumericColumn(rows, key){
  let ok=0, total=0;
  for (let i=0; i<rows.length && i<50; i++){
    const v = rows[i][key];
    if (v!==undefined && v!==""){
      total++;
      const n = Number(String(v).replace(",","."));
      if (Number.isFinite(n)) ok++;
    }
  }
  return total>0 && ok/total>=0.6; // mayormente numérica
}

// Empareja un texto de la pregunta con el header que más se le parezca (numérica opcional)
function bestHeaderMatch(queryText, headers, rows, requireNumeric=false, denySet = new Set()){
  let bestKey=null, best=0;
  for (const h of headers){
    if (denySet.has(h)) continue;
    if (requireNumeric && !isNumericColumn(rows,h)) continue;
    const sc = fuzzyScore(queryText, h);
    if (sc>best){ best=sc; bestKey=h; }
  }
  return bestKey;
}

// Extrae “grupos/equipos de N usando X y Y” (muy tolerante)
function parseGroupingIntent(q){
  const s = norm(q);
  if (!/(grup|equip)/.test(s)) return null;
  // tamaño de grupo (opcional; por defecto 5)
  let size = 5;
  const mSize = s.match(/de\s+(\d{1,2})/);
  if (mSize) size = Math.max(2, Math.min(20, parseInt(mSize[1],10)));
  // variables X y Y (buscar segmento después de 'usando|utilizando|con|basado en|en base a')
  const mVars = s.match(/(?:usando|utilizando|con|basado\s+en|en\s+base\s+a)\s+(.+?)$/);
  if (!mVars) return { size, vars: [] };
  const tail = mVars[1].replace(/[.,;:]+/g," ").trim();
  // intentar separar por ' y ' (última conjunción)
  let X="", Y="";
  const idxY = tail.lastIndexOf(" y ");
  if (idxY>0){ X=tail.slice(0,idxY).trim(); Y=tail.slice(idxY+3).trim(); }
  else{
    // fallback: separar por coma
    const parts = tail.split(/\s*,\s*/).filter(Boolean);
    if (parts.length>=2){ X=parts[0]; Y=parts[1]; }
    else if (parts.length===1){ X=parts[0]; }
  }
  // limpia artículos sueltos
  X = X.replace(/\b(de|la|el|los|las)\b/gi,"").trim();
  Y = Y.replace(/\b(de|la|el|los|las)\b/gi,"").trim();
  const vars = [X,Y].filter(Boolean);
  return { size, vars };
}

// z-score y grupos
function toNumber(x){ const n = Number(String(x).replace(",",".").trim()); return Number.isFinite(n)? n: NaN; }
function zscore(arr){
  const valid = arr.filter(v => Number.isFinite(v));
  const mean = valid.reduce((a,b)=>a+b,0) / (valid.length || 1);
  const sd = Math.sqrt(valid.reduce((a,b)=>a+(b-mean)*(b-mean),0) / (valid.length || 1)) || 1;
  return arr.map(v => Number.isFinite(v)? (v-mean)/sd : 0);
}
function gruposHomogeneos(rows, nameKey, k1, k2, groupSize){
  const v1 = rows.map(r => toNumber(r[k1]));
  const v2 = rows.map(r => toNumber(r[k2]));
  const z1 = zscore(v1), z2 = zscore(v2);
  const scores = z1.map((z,i) => (z + z2[i]) / 2);
  const idx = scores.map((s,i)=>({i,s})).sort((a,b)=>a.s-b.s).map(o=>o.i);
  const ordered = idx.map(i => ({ nombre: rows[i][nameKey] || "", score: scores[i] }));
  const headers = ["Grupo","NOMBRE"];
  const out = [];
  let g=1;
  for (let i=0; i<ordered.length; i+=groupSize){
    const chunk = ordered.slice(i, i+groupSize);
    for (const it of chunk) out.push([`Grupo ${g}`, it.nombre]);
    g++;
  }
  return { headers, rows: out };
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

    // CSV (desde FS; si quisieras aceptar CSV inline por POST, puedes reactivar el bloque)
    const dataset = loadCSVFromFS(); // {headers, rows, rowsCount...}

    if (ql==="diag"){
      return sendJSON(res,200,{ source: dataset.source, filePath: dataset.filePath, rows: dataset.rowsCount, headers: dataset.headers });
    }

    // ===== Motor LOCAL si la pregunta pide grupos/equipos de N usando X y Y =====
    const intent = parseGroupingIntent(q);
    if (intent){
      const { size, vars } = intent; // vars puede ser [X,Y] o [X] o []
      // 1) detecta columna de "nombre" (para mostrar en tabla)
      let nameKey = null;
      // mejor candidato por heurística
      let bestName=null, bestN=0;
      for (const h of dataset.headers){
        const nLike = isNameLike(h) ? 1.0 : 0.0;
        const sc = nLike + tokenOverlapScore(h, "nombre estudiante alumno persona apellidos name");
        if (sc>bestN){ bestN=sc; bestName=h; }
      }
      nameKey = bestName || dataset.headers[0]; // fallback: primera columna

      // 2) detecta las dos columnas numéricas que mejor emparejen con X y Y
      let k1=null, k2=null;
      const deny = new Set();
      if (vars.length>=1){
        k1 = bestHeaderMatch(vars[0], dataset.headers, dataset.rows, true, deny);
        if (k1) deny.add(k1);
      }
      if (vars.length>=2){
        k2 = bestHeaderMatch(vars[1], dataset.headers, dataset.rows, true, deny);
        if (k2) deny.add(k2);
      }
      // Si no extrajo dos, completa con las mejores numéricas restantes
      const numericKeys = dataset.headers.filter(h => !deny.has(h) && isNumericColumn(dataset.rows,h));
      if (!k1 && numericKeys.length) { k1 = numericKeys[0]; deny.add(k1); }
      if (!k2 && numericKeys.length>1){ k2 = numericKeys.find(h => h!==k1); }
      // Si aún falta alguna, no podemos agrupar
      if (!k1 || !k2){
        return sendJSON(res,200,{
          respuesta: "No pude identificar dos columnas numéricas a partir de la pregunta y los encabezados del CSV.",
          debug: { varsDetectadas: vars, numericCandidatas: numericKeys?.slice(0,5) }
        });
      }

      const tabla = gruposHomogeneos(dataset.rows, nameKey, k1, k2, size || 5);
      return sendJSON(res,200,{
        respuesta: `Grupos homogéneos de ${size||5} formados con columnas "${k1}" y "${k2}".`,
        tabla
      });
    }

    // ===== Si NO es caso de agrupamiento, usa el pipeline GPT-5 =====
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

    // Para compactar: formateamos CSV de vuelta a texto simple (no enviamos todo si es enorme)
    const csvText = [
      dataset.headers.join(","),
      ...dataset.rows.map(r => dataset.headers.map(h => (r[h] ?? "")).join(","))
    ].join("\n");

    const user = `<CSV>
${csvText}
</CSV>

Pregunta:
${q}`;

    const out = await askStable({ system, user, maxTokens, timeoutMs });
    if (out && out._empty){
      return sendJSON(res,200,{ respuesta:"El modelo no respondió y la consulta no coincide con el caso local. Ajusta &max/&t o simplifica la instrucción." });
    }
    return sendJSON(res,200,out);

  }catch(err){
    return sendJSON(res,500,{error:String(err.message||err)});
  }
};
