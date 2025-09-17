// api/ask.js — GPT-5 planner + heurística. CommonJS (Vercel).

const fs = require("fs").promises;
const path = require("path");

// ---------- CSV ----------
function detectDelimiter(line){const c=[",",";","\t","|"];let b={d:",",n:0};for(const d of c){const n=line.split(d).length;if(n>b.n)b={d,n}}return b.d}
function splitCSVLine(line,d){const o=[];let c="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(q&&line[i+1]==='"'){c+='"';i++}else q=!q}else if(ch===d&&!q){o.push(c);c=""}else c+=ch}o.push(c);return o.map(s=>s.trim())}
function parseCSV(text){const L=text.replace(/\r/g,"").split("\n").filter(l=>l.length>0);if(!L.length)return{headers:[],rows:[],delimiter:","};const d=detectDelimiter(L[0]);const h=splitCSVLine(L[0],d);const r=[];for(let i=1;i<L.length;i++){const v=splitCSVLine(L[i],d),o={};h.forEach((H,j)=>o[H]=v[j]??"");r.push(o)}return{headers:h,rows:r,delimiter:d}}
const norm=s=>String(s??"").normalize("NFD").replace(/\p{Diacritic}/gu,"").toUpperCase().trim();
function toNum(v){if(v==null)return null;const s=String(v).replace(",","."),n=Number(s);return Number.isFinite(n)?n:null}
function isNumericCol(rows,col){return rows.some(r=>toNum(r[col])!==null)}
function mapHeader(headers,cand){
  const N=norm(cand);
  return headers.find(h=>norm(h)===N)||
         headers.find(h=>norm(h).includes(N))||
         headers.find(h=>N.includes(norm(h)))||null;
}

// ---------- LLM planner (opcional) ----------
async function planWithLLM(q, headers, sample){
  const key=process.env.OPENAI_API_KEY;
  if(!key) return null;
  const model=process.env.LLM_MODEL||"gpt-5-thinking";
  const system = [
    "Eres analista de datos (es-MX). Devuelve SOLO JSON válido con un plan para operar una tabla.",
    "Esquema: {intent:'table'|'calc'|'summary'|'unknown', select:[...], filters:[{column,op,value}], sort:[{column,dir}], limit:number, calc:{type:'avg|sum|min|max|corr',columns:[...]}}",
    "Si piden listas/tablas/ranking, usa intent:'table', incluye 'select', 'filters' (décimo/paralelo), y 'sort' por la métrica.",
    "Evita frases; no devuelvas texto, solo JSON."
  ].join("\n");
  const prompt = `Headers: ${JSON.stringify(headers)}\nSample: ${JSON.stringify(sample)}\nPregunta: ${q}`;
  const r = await fetch("https://api.openai.com/v1/responses", {
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:JSON.stringify({model, response_format:{type:"json_object"}, input:[{role:"system",content:system},{role:"user",content:prompt}]})
  });
  const jr=await r.json();
  const txt = jr.output_text || jr.content?.[0]?.text || jr.choices?.[0]?.message?.content || "{}";
  try{ return JSON.parse(txt); }catch{ return null; }
}

// ---------- Fallback heurístico ----------
function planHeuristic(q, headers){
  const ql=q.toLowerCase();
  const wantsList   = /\b(lista|listado|tabla|estudiante|estudiantes|ranking|ordenar|top|rank)\b/.test(ql);
  const plan = { intent: wantsList ? "table" : "summary", select: [], filters: [], sort: [], limit: 200 };

  // décimo A/B
  const colCurso=mapHeader(headers,"Curso"), colPar=mapHeader(headers,"Paralelo");
  if(/d[eé]cimo|decimo/.test(ql) && colCurso) plan.filters.push({column:colCurso, op:"like", value:"DECIMO"});
  const mPar = ql.match(/\b(paralelo|secci[oó]n|grupo)\s*([ab])\b/i) || ql.match(/d[eé]cimo\s*([ab])\b/i);
  if(mPar && colPar) plan.filters.push({column:colPar, op:"eq", value:(mPar[2]||mPar[1]).toUpperCase()});

  // métricas
  const cand = headers.filter(h=>{
    const H=norm(h);
    return /PROMEDIO|NOTA|PUNTAJE|SCORE|CALIFICACION|TOTAL|AGRESION|EMPATIA|TIMIDEZ|AUTOESTIMA|FISICO|TENSION|ANSIEDAD/.test(H);
  });
  // si el texto menciona una, úsala
  const hit = cand.find(h=> norm(q).includes(norm(h)) ) || cand[0];
  if(hit) { plan.select.push(hit); plan.sort.push({column:hit, dir:"desc"}); }

  // nombre / curso / paralelo
  const colNombre=mapHeader(headers,"Nombre"); if(colNombre) plan.select.unshift(colNombre);
  if(colPar && !plan.select.includes(colPar)) plan.select.push(colPar);
  if(colCurso && !plan.select.includes(colCurso)) plan.select.push(colCurso);

  return plan;
}

function applyPlan(rows, headers, plan){
  let out=[...rows];
  // filtros
  for(const f of (plan.filters||[])){
    const col = mapHeader(headers,f.column)||f.column;
    const op =(f.op||"eq").toLowerCase();
    const val=f.value;
    out = out.filter(r=>{
      const v=r[col]; if(v==null) return false;
      const vn=norm(v), valn=norm(val);
      const n=toNum(v), nv=toNum(val);
      if(op==="eq") return vn===valn || v===val;
      if(op==="like") return vn.includes(valn);
      if(op==="gt") return (n!=null&&nv!=null)?(n>nv):false;
      if(op==="gte") return (n!=null&&nv!=null)?(n>=nv):false;
      if(op==="lt") return (n!=null&&nv!=null)?(n<nv):false;
      if(op==="lte") return (n!=null&&nv!=null)?(n<=nv):false;
      return true;
    });
  }
  // orden
  if(Array.isArray(plan.sort) && plan.sort.length){
    const s=plan.sort[0], col=mapHeader(headers,s.column)||s.column, dir=(s.dir||"desc").toLowerCase();
    const num=isNumericCol(out,col);
    out.sort((a,b)=>{
      if(num){ const A=toNum(a[col])??-Infinity, B=toNum(b[col])??-Infinity; return dir==="desc"?B-A:A-B; }
      const A=String(a[col]??""), B=String(b[col]??""); return dir==="desc"?B.localeCompare(A):A.localeCompare(B);
    });
  }
  // proyección
  let select = (plan.select||[]).map(c=>mapHeader(headers,c)||c).filter(Boolean);
  if(!select.length){
    const name=mapHeader(headers,"Nombre")||headers[0];
    const metric = (plan.sort&&plan.sort[0]) ? (mapHeader(headers,plan.sort[0].column)||plan.sort[0].column) : headers.find(h=>isNumericCol(out,h));
    select=[name]; if(metric && !select.includes(metric)) select.push(metric);
    const par=mapHeader(headers,"Paralelo"), cur=mapHeader(headers,"Curso");
    if(par && !select.includes(par)) select.push(par);
    if(cur && !select.includes(cur)) select.push(cur);
  }
  out = out.map(r=>{ const o={}; select.forEach(k=>o[k]=r[k]); return o; });

  const lim = Number.isFinite(plan.limit)? plan.limit : 200;
  return out.slice(0,lim);
}

// ---------- Read CSV ----------
async function readCSV(file, req){
  const p=path.join(process.cwd(),"public","datos",file);
  try{ return await fs.readFile(p,"utf8"); }
  catch{
    const host=req.headers["x-forwarded-host"]||req.headers.host||"localhost:3000";
    const proto=host.includes("localhost")?"http":"https";
    const url=`${proto}://${host}/datos/${encodeURIComponent(file)}`;
    const r=await fetch(url); if(!r.ok) throw new Error(`HTTP ${r.status} leyendo ${url}`);
    return await r.text();
  }
}

module.exports = async (req,res)=>{
  const q=String(req.query?.q||"");
  const file=String(req.query?.file||"decimo.csv");
  try{
    const raw=await readCSV(file,req);
    const {headers,rows}=parseCSV(raw);
    if(!rows.length) return res.status(200).json({rows:[],speak:"No hay datos."});

    // 1) intentar plan con GPT-5
    let plan = null;
    try{ plan = await planWithLLM(q, headers, rows.slice(0,5)); }catch{}
    // 2) si falla/ausente → heurístico
    if(!plan || !plan.intent) plan = planHeuristic(q, headers);

    const data = applyPlan(rows, headers, plan);

    // frase breve para TTS
    let speak = data.length ? `Mostrando ${data.length} resultados.` : "No hay resultados con esos criterios.";
    if(Array.isArray(plan.sort) && plan.sort[0]){
      const m = mapHeader(headers,plan.sort[0].column)||plan.sort[0].column;
      if(m) speak = `Mostrando ${data.length} estudiantes ordenados por ${m}.`;
    }

    res.setHeader("Content-Type","application/json; charset=utf-8");
    return res.status(200).json({ rows:data, speak, plan });
  }catch(err){
    console.error("ask error:",err);
    return res.status(200).json({ error:true, message:"No hay resultados por ahora.", details:err?.message });
  }
};
