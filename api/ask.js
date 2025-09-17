// api/ask.js — GPT-5 + fallback + debug
// CommonJS (Vercel)

const fs = require("fs").promises;
const path = require("path");

// ---------- CSV utils ----------
function detectDelim(line){const c=[",",";","\t","|"];let b={d:",",n:0};for(const d of c){const n=line.split(d).length;if(n>b.n)b={d,n}}return b.d}
function split(line,d){const o=[];let cur="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(q&&line[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(ch===d&&!q){o.push(cur);cur="";}else cur+=ch;}o.push(cur);return o;}
function parseCSV(text){
  const rows=text.replace(/\r/g,"").split("\n").filter(Boolean);
  if(!rows.length) return {headers:[],rows:[]};
  const d=detectDelim(rows[0]);
  const headers=split(rows[0],d).map(s=>s.trim());
  const out=[];
  for(let i=1;i<rows.length;i++){
    const vals=split(rows[i],d); const o={}; headers.forEach((h,j)=>o[h]=(vals[j]??"").trim()); out.push(o);
  }
  return {headers,rows:out};
}
const norm=s=>String(s??"").normalize("NFD").replace(/\p{Diacritic}/gu,"").toUpperCase().trim();
const toNum=v=>{if(v==null)return null;const n=Number(String(v).replace(",",".").trim());return Number.isFinite(n)?n:null;}
const isNumeric=(rows,col)=>rows.some(r=>toNum(r[col])!==null);

// ---------- CSV loader ----------
async function readCSV(file, req){
  const local=path.join(process.cwd(),"public","datos",file);
  try{ return await fs.readFile(local,"utf8"); }
  catch{
    const host=req.headers["x-forwarded-host"]||req.headers.host||"localhost:3000";
    const proto=host.includes("localhost")?"http":"https";
    const url=`${proto}://${host}/datos/${encodeURIComponent(file)}`;
    const r=await fetch(url); if(!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.text();
  }
}

// ---------- OpenAI callers ----------
async function callResponses({model, system, user, apiKey}){
  try{
    const r=await fetch("https://api.openai.com/v1/responses",{
      method:"POST",
      headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},
      body:JSON.stringify({model, response_format:{type:"json_object"}, input:[{role:"system",content:system},{role:"user",content:user}]})
    });
    const j=await r.json();
    if(!r.ok) return {ok:false, error:(j.error?.message||`HTTP ${r.status}`)};
    const text = j.output_text || j.content?.[0]?.text || j.choices?.[0]?.message?.content;
    if(!text) return {ok:false, error:"Respuesta vacía del endpoint Responses"};
    return {ok:true, text};
  }catch(e){ return {ok:false, error:String(e)} }
}

async function callChat({model, system, user, apiKey}){
  try{
    const r=await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},
      body:JSON.stringify({model, messages:[{role:"system",content:system},{role:"user",content:user}], temperature:0})
    });
    const j=await r.json();
    if(!r.ok) return {ok:false, error:(j.error?.message||`HTTP ${r.status}`)};
    const text = j.choices?.[0]?.message?.content;
    if(!text) return {ok:false, error:"Respuesta vacía de Chat Completions"};
    return {ok:true, text};
  }catch(e){ return {ok:false, error:String(e)} }
}

// ---------- LLM prompt ----------
function buildSystem(){
  return [
    "Eres analista de datos (es-MX). Lee un CSV (encabezados + filas) y responde SOLO JSON.",
    "Nunca uses asteriscos ni frases como 'según el CSV'.",
    "Si piden listas/tablas/rankings: devuelve {intent:'table', speak, message, table:{columns, rows:[[...]]}}.",
    "Si piden cálculos (promedio, correlación, conteos…): devuelve {intent:'calc', speak, message} y tabla SOLO si la piden.",
    "Respeta tildes: 'propension' == 'PROPENSIÓN', etc. No inventes columnas.",
    "Formato JSON ESTRICTO:",
    "{ \"intent\":\"table|calc|message\", \"speak\":\"...\", \"message\":\"...\", \"table\": {\"columns\":[...], \"rows\":[[...], ...]} }"
  ].join("\n");
}
function buildUser(q, headers, csvText){
  return `Pregunta del usuario: ${q}

Encabezados:
${JSON.stringify(headers)}

CSV_DATA_START
${csvText}
CSV_DATA_END`;
}

// ---------- Heurístico (solo si LLM falla) ----------
function fallbackHeuristic(q, headers, rows){
  const qn=norm(q);
  const wantsList = /\b(LISTA|LISTADO|TABLA|ESTUDIANTE|RANK|ORDEN|TOP)\b/.test(qn);
  const hName = headers.find(h=>/NOMBRE|ESTUDIANTE|ALUMNO/i.test(norm(h))) || headers[0];
  // columna pedida explícita
  let col = headers.find(h=> qn.includes(norm(h)));
  // si no, elige una numérica razonable
  if(!col){
    const prefer = headers.filter(h=>/PROMEDIO|NOTA|PUNTAJE|SCORE|CALIFICACION|TOTAL|AGRESION|EMPATIA|TIMIDEZ|AUTOESTIMA|FISICO|TENSION|ANSIEDAD/i.test(norm(h)));
    col = prefer.find(h=>isNumeric(rows,h)) || headers.find(h=>isNumeric(rows,h)) || headers[1] || hName;
  }
  let outRows=[...rows];
  if(/DECIMO|D[EÉ]CIMO/.test(qn)){
    const cCurso = headers.find(h=>/CURSO|GRADO|NIVEL/i.test(norm(h)));
    if(cCurso) outRows = outRows.filter(r=>/DECIMO/i.test(norm(r[cCurso])));
  }
  const mPar = qn.match(/\b(PARALELO|SECCION|SECCIÓN|GRUPO)\s*([AB])\b/);
  if(mPar){
    const cPar = headers.find(h=>/PARALELO|SECCION|SECCIÓN|GRUPO/i.test(norm(h)));
    if(cPar) outRows = outRows.filter(r=> norm(r[cPar])===mPar[2]);
  }
  if(wantsList){
    // ordenar por col
    const numeric = isNumeric(outRows,col);
    outRows.sort((a,b)=>{
      if(numeric){ const A=toNum(a[col])??-Infinity, B=toNum(b[col])??-Infinity; return B-A; }
      return String(b[col]??"").localeCompare(String(a[col]??""));
    });
    const columns = [hName, col].concat(headers.filter(h=>/PARALELO|CURSO/i.test(norm(h))));
    const tableRows = outRows.map(r=>columns.map(c=>r[c]));
    return {
      intent:"table",
      speak:`Mostrando ${tableRows.length} estudiantes ordenados por ${col}.`,
      message:`Listado por ${col}.`,
      table:{ columns: ["#", ...columns], rows: tableRows.map((r,i)=>[i+1, ...r]) }
    };
  }
  // cálculo simple: promedio de X
  if(/\bPROMEDIO\b/.test(qn)){
    const arr = outRows.map(r=>toNum(r[col])).filter(n=>n!=null);
    const avg = arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length) : null;
    return {
      intent:"calc",
      speak: avg!=null ? `Promedio de ${col}: ${avg.toFixed(2)}` : `No encontré datos numéricos en ${col}.`,
      message: avg!=null ? `Promedio de ${col}: ${avg.toFixed(2)}` : `No encontré datos numéricos en la columna ${col}.`
    };
  }
  return { intent:"message", speak:"No tengo suficiente contexto.", message:"No tengo suficiente contexto." };
}

// ---------- Handler ----------
module.exports = async (req,res)=>{
  const q    = String(req.query?.q || "").trim();
  const file = String(req.query?.file || "decimo.csv");
  const debug = String(req.query?.debug||"") === "1";

  const dbg = { step:"start" };

  try{
    const csvText = await readCSV(file, req);
    const {headers, rows} = parseCSV(csvText);
    if(!rows.length){ return res.status(200).json({ rows:[], speak:"No hay datos.", message:"No hay datos.", debug: debug?dbg:undefined }); }
    dbg.csvBytes = csvText.length; dbg.rows = rows.length; dbg.headers = headers;

    // ----- LLM intento 1: Responses API (GPT-5) -----
    const apiKey = process.env.OPENAI_API_KEY || "";
    dbg.keyPresent = Boolean(apiKey);
    const modelPrimary = process.env.LLM_MODEL || "gpt-5-thinking";
    const system = buildSystem(); const user = buildUser(q, headers, csvText);

    let llmOut = null, llmErr = null, used = null;

    if(apiKey){
      const r1 = await callResponses({model:modelPrimary, system, user, apiKey});
      if(r1.ok){
        used = `responses:${modelPrimary}`; dbg.used = used;
        try{ llmOut = JSON.parse(r1.text); }catch(e){ llmErr = "JSON inválido de Responses"; dbg.responsesParseError = String(e); }
      }else{
        dbg.responsesError = r1.error;
      }

      // ----- LLM intento 2: Chat Completions (fallback) -----
      if(!llmOut){
        const fbModel = process.env.LLM_FALLBACK_MODEL || "gpt-4o-mini";
        const r2 = await callChat({model:fbModel, system, user, apiKey});
        if(r2.ok){
          used = `chat:${fbModel}`; dbg.used = used;
          try{ llmOut = JSON.parse(r2.text); }catch(e){ llmErr = "JSON inválido de Chat"; dbg.chatParseError = String(e); }
        }else{
          dbg.chatError = r2.error;
        }
      }
    }else{
      dbg.note = "OPENAI_API_KEY ausente";
    }

    // ----- Si LLM dio algo válido -----
    if(llmOut && (llmOut.intent || llmOut.table || llmOut.message || llmOut.speak)){
      const cols = llmOut.table?.columns;
      const trs  = llmOut.table?.rows;
      let rowsOut = [];
      if(Array.isArray(cols) && Array.isArray(trs)){
        rowsOut = trs.map(r=>{ const o={}; cols.forEach((c,i)=>o[c]=r[i]); return o; });
      }
      return res.status(200).json({
        rows: rowsOut,
        speak: (llmOut.speak||"").replace(/\*/g,""),
        message: (llmOut.message||"").replace(/\*/g,""),
        intent: llmOut.intent || (rowsOut.length?"table":"message"),
        debug: debug?dbg:undefined
      });
    }

    // ----- Fallback heurístico (sin defaults forzados) -----
    dbg.fallback = true;
    const fb = fallbackHeuristic(q, headers, rows);
    let rowsOut = [];
    if(fb.table && fb.table.columns && fb.table.rows){
      rowsOut = fb.table.rows.map(r=>{ const o={}; fb.table.columns.forEach((c,i)=>o[c]=r[i]); return o; });
    }
    return res.status(200).json({
      rows: rowsOut,
      speak: fb.speak,
      message: fb.message,
      intent: fb.intent,
      debug: debug?dbg:undefined
    });

  }catch(err){
    const msg = "No fue posible procesar la consulta.";
    if(debug){ dbg.error = String(err); }
    return res.status(200).json({ error:true, message: msg, details: String(err), debug: debug?dbg:undefined });
  }
};
