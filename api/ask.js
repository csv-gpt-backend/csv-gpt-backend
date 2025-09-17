// /api/ask.js — Modo datos reales: Planner (GPT) + Executor (JS) + Post-Explicación
// Lee /public/datos/<file>.csv, GPT devuelve un PLAN JSON, aquí se ejecuta sobre el CSV.
// Devuelve: tabla real (formato:"json") + nota (teoría/explicación). Sin "inventos".

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { ts, text }

function safeFileParam(s, def = "decimo.csv") {
  const x = (s || "").toString().trim();
  if (!x) return def;
  if (x.includes("..") || x.includes("/") || x.includes("\\")) return def;
  return x;
}

async function getCSVText(publicUrl) {
  const hit = cache.get(publicUrl);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_MS) return hit.text;

  const r = await fetch(publicUrl);
  if (!r.ok) throw new Error(`No pude leer CSV ${publicUrl} (HTTP ${r.status})`);
  const text = await r.text();
  cache.set(publicUrl, { ts: now, text });
  return text;
}

/* ====== CSV & Estadística ====== */
function pickDelimiter(sampleLines) {
  const c = [",",";","\t","|"]; let best=",", score=-1;
  for (const d of c){ let sc=0; for (const l of sampleLines){ const p=l.split(d); if(p.length>1) sc+=p.length; } if(sc>score){ score=sc; best=d; } }
  return best;
}
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length);
  if (lines.length < 2) return { headers: [], rows: [] };
  const d = pickDelimiter(lines.slice(0,10));
  const rows = lines.map(l => l.split(d).map(c=>c.trim()));
  const headers = rows[0];
  const body = rows.slice(1).map(r => {
    const o = {}; headers.forEach((h,i)=> o[h] = r[i] ?? ""); return o;
  });
  return { headers, rows: body };
}
function toNum(v){ const n = parseFloat(String(v??"").replace(/[^0-9.\-]+/g,"")); return Number.isFinite(n)?n:null; }
function isMostlyNumeric(arr){ const nums=arr.map(toNum).filter(v=>v!==null); return nums.length/arr.length >= 0.6; }
function percentile(arr, p){
  const v = arr.map(toNum).filter(x=>x!==null).sort((a,b)=>a-b);
  if(!v.length) return null;
  if (p<=0) return v[0]; if (p>=100) return v[v.length-1];
  const rank=(p/100)*(v.length-1); const lo=Math.floor(rank), hi=Math.ceil(rank), w=rank-lo;
  return v[lo]*(1-w) + v[hi]*w;
}
function mean(arr){ const v=arr.map(toNum).filter(x=>x!==null); return v.length? v.reduce((a,b)=>a+b,0)/v.length : null; }
function corrPearson(xArr,yArr){
  const x=[],y=[]; for(let i=0;i<xArr.length;i++){ const a=toNum(xArr[i]), b=toNum(yArr[i]); if(a!==null&&b!==null){ x.push(a); y.push(b);} }
  const n=x.length; if(n<3) return {r:NaN,r2:NaN,n};
  const mx=mean(x), my=mean(y); let num=0,dx=0,dy=0;
  for(let i=0;i<n;i++){ const ax=x[i]-mx, by=y[i]-my; num+=ax*by; dx+=ax*ax; dy+=by*by; }
  const den = Math.sqrt(dx*dy); const r = den? num/den : NaN; return { r, r2: r*r, n };
}

/* ====== Planner (GPT) ====== */
function buildSchema(headers, rows){
  return headers.map(h=>{
    const col = rows.map(r=>r[h]);
    return { name:h, type: isMostlyNumeric(col)?"number":"string", sample: Array.from(new Set(col)).slice(0,6) };
  });
}

const SYSTEM_PLANNER = `
Eres un planificador de consultas sobre un CSV. Devuelve SOLO JSON válido:

{
  "mode": "table" | "correlation",
  "select": ["colA","colB",...],     // opcional; si falta, usa todas
  "filters": [{"col":"Col","op":"==|!=|>|>=|<|<=|contains|in","value":any}],
  "orderBy": [{"col":"Col","dir":"asc|desc"}],
  "limit": 10,
  "computed": [ {"as":"IndiceGlobal","op":"mean","cols":[...]} ],
  "percentileFilters": [ {"col":"Col","op":">=","p":80} ],
  "quintile": {"col":"Col","index":1..5},
  "correlation": { "autoTop": 10 }, // o "pairs":[{"x":"ColX","y":"ColY"}]
  "explanation": "texto breve"
}

Reglas:
- Usa SOLO nombres de "schema".
- “Mejores usando todas las habilidades” → computed mean de TODAS las numéricas (excluye Edad/Curso/Paralelo si existen).
- “Quintil más alto” → quintile.index = 5 (≥P80).
- Correlaciones globales → mode:"correlation", correlation.autoTop ~10.
- Incluye siempre "explanation".`;

async function callPlanner(messages) {
  if (!API_KEY) throw new Error("Falta OPENAI_API_KEY.");
  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0, messages })
  });
  const data = await r.json().catch(()=>null);
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

/* ====== Post-explicación (teoría) ====== */
async function postExplain({ userQ, mode, plan, meta }) {
  if (!API_KEY) return "";
  const sys = `Eres una asesora educativa (es-MX). Escribe una EXPLICACIÓN breve, correcta y didáctica del resultado YA CALCULADO.
No inventes números nuevos: usa SOLO lo que viene en "meta". Incluye teoría (matemática/estadística, psicometría) e interpretación pedagógica.
Extensión: 120–180 palabras, tono profesional y claro.`;
  const user = `Pregunta: ${userQ}
Modo: ${mode}
Plan: ${JSON.stringify(plan ?? {}, null, 2)}
Meta (resumen de lo calculado): ${JSON.stringify(meta ?? {}, null, 2)}
Recuerda: NO inventes valores. Explica con base en "meta".`;
  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST", headers:{ "Content-Type":"application/json", Authorization:`Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, messages:[{role:"system",content:sys},{role:"user",content:user}] })
  });
  const data = await r.json().catch(()=>null);
  return data?.choices?.[0]?.message?.content?.trim() || "";
}
function buildMetaForExplanation({ mode, plan, headers, rows, table, extra }) {
  const meta = { filas: rows.length, columnas: headers, select: extra?.selectCols ?? headers };
  if (mode === "correlation" && extra?.topCorr) meta.topCorrelaciones = extra.topCorr.slice(0,5);
  if (extra?.quintilInfo) meta.quintil = extra.quintilInfo; // {col,index,Pcut}
  if (extra?.kpis) meta.kpis = extra.kpis;
  return meta;
}

/* ====== Ejecutor de PLAN ====== */
function normalizeOp(op){ return String(op||"").toLowerCase(); }
function applyFilters(rows, filters=[]){
  if(!filters.length) return rows;
  return rows.filter(row => filters.every(f=>{
    const v=row[f.col], op=normalizeOp(f.op), val=f.value, n=toNum(v), nv=toNum(val);
    if(op==="contains") return String(v??"").toLowerCase().includes(String(val??"").toLowerCase());
    if(op==="in") return Array.isArray(val) ? val.map(String).includes(String(v)) : false;
    if(n!==null && nv!==null){
      if(op==="==") return n===nv; if(op==="!=") return n!==nv; if(op===">") return n>nv; if(op===">=") return n>=nv; if(op==="<") return n<nv; if(op==="<=") return n<=nv;
    }
    if(op==="==") return String(v)===String(val);
    if(op==="!=") return String(v)!==String(val);
    return true;
  }));
}
function applyPercentileFilters(rows, pf=[]){
  if(!pf.length) return rows;
  let out=rows;
  for(const f of pf){
    const cut = percentile(out.map(r=>r[f.col]), f.p);
    out = out.filter(r=>{
      const n=toNum(r[f.col]); if(n===null || cut===null) return false;
      if(f.op=== ">=") return n>=cut; if(f.op==="<=") return n<=cut; if(f.op===">") return n>cut; if(f.op==="<") return n<cut; if(f.op==="==") return n===cut;
      return true;
    });
  }
  return out;
}
function applyQuintile(rows, qSpec){
  if(!qSpec || !qSpec.col || !qSpec.index) return rows;
  const q=Math.max(1,Math.min(5,qSpec.index)); const pLo=(q-1)*20, pHi=q*20;
  const arr=rows.map(r=>r[qSpec.col]); const cutLo=percentile(arr,pLo), cutHi=percentile(arr,pHi);
  if(q===5) return rows.filter(r=>{ const n=toNum(r[qSpec.col]); return n!==null && n>=cutLo; });
  return rows.filter(r=>{ const n=toNum(r[qSpec.col]); return n!==null && n>=cutLo && n<=cutHi; });
}
function addComputed(rows, computed=[]){
  if(!computed.length) return rows;
  return rows.map(r=>{
    const o={...r};
    for(const c of computed){
      const as=c.as||"computed", cols=Array.isArray(c.cols)?c.cols:[], vals=cols.map(k=>toNum(r[k])).filter(x=>x!==null);
      if(!vals.length){ o[as]=""; continue; }
      const op=String(c.op||"").toLowerCase();
      if(op==="mean"||op==="avg") o[as]=mean(vals);
      else if(op==="sum") o[as]=vals.reduce((a,b)=>a+b,0);
      else if(op==="min") o[as]=Math.min(...vals);
      else if(op==="max") o[as]=Math.max(...vals);
      else o[as]=mean(vals);
    }
    return o;
  });
}
function applyOrderLimit(rows, orderBy=[], limit){
  let arr=rows.slice();
  if(orderBy.length){
    arr.sort((a,b)=>{
      for(const o of orderBy){
        const col=o.col, dir=String(o.dir||"asc").toLowerCase();
        const av=a[col], bv=b[col], an=toNum(av), bn=toNum(bv);
        let cmp=0; if(an!==null && bn!==null) cmp=an-bn; else cmp=String(av).localeCompare(String(bv));
        if(cmp!==0) return dir==="desc"? -cmp : cmp;
      }
      return 0;
    });
  }
  if(typeof limit==="number" && limit>=0) arr=arr.slice(0,limit);
  return arr;
}
function objectsToArray(headers, objs){
  const rows=[headers]; for(const o of objs) rows.push(headers.map(h=>(o[h] ?? "").toString())); return rows;
}
function computeCorrelations(headers, rows, opt){
  const numericCols = headers.filter(h => isMostlyNumeric(rows.map(r=>r[h])));
  const out=[];
  const top = Math.max(1, Math.min(50, opt?.autoTop ?? 10));
  for(let i=0;i<numericCols.length;i++){
    for(let j=i+1;j<numericCols.length;j++){
      const a=numericCols[i], b=numericCols[j];
      const {r,r2,n}=corrPearson(rows.map(r=>r[a]), rows.map(r=>r[b]));
      if(Number.isFinite(r)) out.push({X:a,Y:b,r,R2:r2,n});
    }
  }
  out.sort((u,v)=>Math.abs(v.r)-Math.abs(u.r)); out.splice(top);
  const hdr=["#","X","Y","r","R² (%)","n"];
  const arr=out.map((o,i)=>[i+1,o.X,o.Y,o.r.toFixed(3),(o.R2*100).toFixed(1),o.n]);
  return { table:[hdr,...arr], pairs: out };
}

/* ====== Handler ====== */
export default async function handler(req, res) {
  try{
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";
    const file = safeFileParam(req.query.file || req.query.f || "decimo.csv");

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers.host;
    const publicUrl = `${proto}://${host}/datos/${encodeURIComponent(file)}`;

    // 1) CSV
    const csvText = await getCSVText(publicUrl);
    const { headers, rows } = parseCSV(csvText);
    if(!headers.length){
      return res.status(200).json({ text:"CSV vacío o ilegible.", archivo:file, formato:"texto" });
    }

    // 2) Esquema → Planner
    const schema = buildSchema(headers, rows);
    const baseMessages = [
      { role:"system", content: SYSTEM_PLANNER },
      { role:"user", content: `Pregunta del usuario:\n${q}\n\nschema:\n${JSON.stringify(schema,null,2)}` }
    ];

    let planText = await callPlanner(baseMessages);
    let plan;
    try { plan = JSON.parse(planText); }
    catch(e) {
      // MODO ESTRICTO: sin JSON válido no devolvemos texto
      return res.status(400).json({ text:"No pude estructurar un plan ejecutable para la consulta.", archivo:file, formato:"texto" });
    }

    const mode = String(plan?.mode || "table").toLowerCase();

    // 3) Ejecutar plan sobre datos reales
    let working = rows.slice();

    if (Array.isArray(plan?.computed) && plan.computed.length) {
      working = addComputed(working, plan.computed);
    }
    if (Array.isArray(plan?.filters) && plan.filters.length) {
      working = applyFilters(working, plan.filters);
    }
    if (Array.isArray(plan?.percentileFilters) && plan.percentileFilters.length) {
      working = applyPercentileFilters(working, plan.percentileFilters);
    }
    if (plan?.quintile) {
      working = applyQuintile(working, plan.quintile);
    }

    let table, selectCols;

    if (mode === "correlation") {
      const { table: t, pairs } = computeCorrelations(headers, working, plan.correlation || {});
      table = t; selectCols = t[0];
      // 4) Post-explicación
      const meta = buildMetaForExplanation({
        mode, plan, headers, rows: working, table, extra: { selectCols, topCorr: pairs }
      });
      const nota = await postExplain({ userQ:q, mode, plan, meta });
      return res.status(200).json({
        text: JSON.stringify(table),
        archivo: file,
        filas_aprox: table.length - 1,
        formato: "json",
        nota
      });
    }

    // Tabla normal
    selectCols = Array.isArray(plan?.select) && plan.select.length ? plan.select : (headers);
    working = applyOrderLimit(working, plan?.orderBy || [], plan?.limit);
    table = objectsToArray(selectCols, working);

    if (table.length <= 1) {
      return res.status(200).json({ text: "No existe información.", archivo: file, filas_aprox: 0, formato: "texto" });
    }

    // (Opcional) meta extra para quintiles
    let extra = { selectCols };
    if (plan?.quintile?.col && plan?.quintile?.index){
      const col = plan.quintile.col;
      const pLo = (plan.quintile.index - 1) * 20;
      const cut = percentile(rows.map(r=>r[col]), pLo);
      extra.quintilInfo = { col, index: plan.quintile.index, Pcut: cut };
    }

    // 4) Post-explicación
    const meta = buildMetaForExplanation({ mode, plan, headers, rows: working, table, extra });
    const nota = await postExplain({ userQ:q, mode, plan, meta });

    return res.status(200).json({
      text: JSON.stringify(table),
      archivo: file,
      filas_aprox: table.length - 1,
      formato: "json",
      nota
    });
  }catch(e){
    console.error(e);
    return res.status(500).json({ text:"Error interno.", details:String(e) });
  }
}
