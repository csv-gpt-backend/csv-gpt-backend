// pages/api/ask.js
// npm i pdf-parse
import pdfParse from "pdf-parse";

/* ========== Config ========== */
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { ts, text }

/* ========== Utils base ========== */
function norm(s){
  return (s||"").toString()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}
function isHttpUrl(x){ return /^https?:\/\//i.test(x||""); }
function isPdf(x){ return /\.pdf(\?|$)/i.test(x||""); }
function isCsv(x){ return /\.csv(\?|$)/i.test(x||""); }
function safeFileParam(s, def = "decimo.csv") {
  const x = (s || "").toString().trim();
  if (!x) return def;
  if (x.includes("..") || x.includes("/") || x.includes("\\")) return def;
  return x;
}
function safeJoinPublic(proto, host, pathLike){
  const p = (pathLike||"").toString().replace(/^\/+/,"");
  if (!p || p.includes("..") || p.includes("\\")) throw new Error("Ruta insegura.");
  return `${proto}://${host}/${encodeURI(p)}`;
}
async function getTextFromUrl(url){
  const hit = cache.get(url);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_MS) return hit.text;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`No pude leer ${url} (HTTP ${r.status})`);

  if (isPdf(url)){
    const buf = await r.arrayBuffer();
    const parsed = await pdfParse(Buffer.from(buf));
    const text = parsed.text || "";
    cache.set(url, { ts: now, text });
    return text;
  }
  const text = await r.text();
  cache.set(url, { ts: now, text });
  return text;
}

/* ========== CSV parsing ========== */
function bestDelimiter(allText){
  const lines = allText.split(/\r?\n/).filter(l=>l.trim().length);
  const cand = [",",";","\t","|"];
  let best=",", ok=0, cols=0;
  for (const d of cand){
    let good=0, c=null;
    for (const line of lines.slice(0,30)){
      const p=line.split(d);
      if (p.length<2) continue;
      if (c==null) c=p.length;
      if (p.length===c) good++;
    }
    if (good>ok){ ok=good; best=d; cols=c||0; }
  }
  return best;
}
function parseCSVToRows(csvText){
  const d = bestDelimiter(csvText);
  const rows = csvText
    .split(/\r?\n/)
    .filter(l => l.trim().length)
    .map(l => l.split(d).map(c=>c.trim()));
  const max = Math.max(...rows.map(r=>r.length));
  return rows.map(r => { const a=r.slice(0,max); while(a.length<max)a.push(""); return a; });
}

/* ========== Sinónimos + Fuzzy resolver ========== */
let SYNONYMS = {
  "nombre": ["nombre","nombres","apellidos","estudiante","alumno","name","nombre del estudiante","estudiantes"],
  "edad": ["edad"],
  "curso": ["curso","grado"],
  "paralelo": ["paralelo","seccion","sección"],

  "autoestima": ["autoestima"],
  "manejo de la tension": ["manejo de la tension","manejo de la tensión","tension","tensión","manejo tension"],
  "bienestar fisico": ["bienestar fisico","bienestar físico","bienestar"],

  "promedio habilidades intrapersonales": [
    "promedio de habilidades intrapersonales",
    "promedio habilidades intrapersonales",
    "intrapersonales promedio"
  ],
  "asertividad": ["asertividad","asertivid","asertiv"],
  "conciencia de los demas": ["conciencia de los demas","conciencia de los demás","conciencia social","conciencia"],
  "empatia": ["empatia","empatía","empatia emocional","empatia social","empatia total"],
  "promedio habilidades interpersonales": [
    "promedio de habilidades interpersonales",
    "promedio  de  habilidades interpersonales",
    "promedio habilidades interpersonales",
    "interpersonales promedio"
  ],
  "motivacion": ["motivacion","motivación"],
  "compromiso": ["compromiso","compromiso academico","compromiso académico","engagement"],
  "administracion del tiempo": [
    "administracion del tiempo","administración del tiempo",
    "gestion del tiempo","gestión del tiempo",
    "manejo del tiempo","planificacion del tiempo","planificación del tiempo",
    "time management"
  ],
  "toma de decisiones": ["toma de decisiones","toma decisiones","decision making"],
  "liderazgo": ["liderazgo","lider"],
  "promedio habilidades para la vida": [
    "promedio de habilidades para la vida",
    "promedio habilidades para la vida",
    "life skills promedio","habilidades para la vida promedio"
  ],
  "promedio inteligencia emocional": [
    "promedio de inteligencia emocional",
    "promedio inteligencia emocional",
    "promedio de iinteligencia emocional",
    "ie promedio","inteligencia emocional promedio"
  ],

  "agresion": ["agresion","agresión","agresividad"],
  "timidez": ["timidez"],
  "propension al cambio": ["propension al cambio","propensión al cambio","apertura al cambio","apertura al cambio (propension)"]
};

function lev(a,b){
  a = norm(a); b = norm(b);
  const m = Array(a.length+1).fill(0).map(()=>Array(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++) m[i][0]=i;
  for(let j=0;j<=b.length;j++) m[0][j]=j;
  for(let i=1;i<=a.length;i++){
    for(let j=1;j<=b.length;j++){
      const cost = a[i-1]===b[j-1]?0:1;
      m[i][j] = Math.min(m[i-1][j]+1, m[i][j-1]+1, m[i-1][j-1]+cost);
    }
  }
  return m[a.length][b.length];
}
function resolveColumn(queryTerm, headers){
  const q = norm(queryTerm);
  const H = headers.map(h => ({raw:h, n:norm(h)}));

  for (const {raw,n} of H) if (n.includes(q) || q.includes(n)) return { idx: headers.indexOf(raw), label: raw };

  let cand = new Set();
  for (const [canon, aliases] of Object.entries(SYNONYMS)){
    if (canon===q || aliases.some(a => q.includes(norm(a)) || norm(a).includes(q))) {
      aliases.forEach(a => cand.add(norm(a)));
      cand.add(canon);
    }
  }
  if (cand.size){
    let best = {score: Infinity, idx:-1, label:null};
    for (const {raw,n} of H){
      for (const a of cand){
        const d = lev(a, n);
        if (d < best.score){ best = {score:d, idx: headers.indexOf(raw), label: raw}; }
      }
    }
    if (best.idx !== -1) return best;
  }
  let best = {score: Infinity, idx:-1, label:null};
  for (const {raw,n} of H){
    const d = lev(q, n);
    if (d < best.score){ best = {score:d, idx: headers.indexOf(raw), label: raw}; }
  }
  return best.idx !== -1 ? best : { idx:-1, label:null };
}
function composeName(headers, row){
  const hNorm = headers.map(norm);
  const idxNombre = hNorm.findIndex(h => ["nombre","name","estudiante","alumno","nombre del estudiante"].includes(h));
  if (idxNombre !== -1 && String(row[idxNombre]||"").trim()) return String(row[idxNombre]).trim();

  const iN = hNorm.findIndex(h => ["nombres","nombre s"].includes(h));
  const iA = hNorm.findIndex(h => ["apellidos","apellido s"].includes(h));
  const nn = (iN !== -1 ? String(row[iN]||"").trim() : "");
  const aa = (iA !== -1 ? String(row[iA]||"").trim() : "");
  const full = [nn,aa].filter(Boolean).join(" ").trim();
  if (full) return full;

  for (let i=0;i<row.length;i++){
    const cell = String(row[i]||"").trim();
    if (cell && /[a-zA-Z]/.test(cell) && !/^\d+(\.\d+)?$/.test(cell)) return cell;
  }
  return "";
}

/* ========== Estadística / Plan ========== */
function percentile(values, p){
  const v = values.map(Number).filter(x => Number.isFinite(x)).sort((a,b)=>a-b);
  if (!v.length) return null;
  if (p<=0) return v[0]; if (p>=100) return v[v.length-1];
  const rank = (p/100)*(v.length-1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  const w = rank - lo;
  return v[lo]*(1-w) + v[hi]*w;
}
function mean(values){
  const v = values.map(Number).filter(x => Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((a,b)=>a+b,0)/v.length;
}
function stdev(values){
  const v = values.map(Number).filter(x => Number.isFinite(x));
  if (!v.length) return null;
  const m = mean(v);
  const varsum = v.reduce((s,x)=>s+(x-m)*(x-m),0)/v.length;
  return Math.sqrt(varsum);
}
function zscoreSeries(values){
  const v = values.map(Number).filter(x => Number.isFinite(x));
  const m = mean(v), sd = stdev(v)||1e-9;
  return values.map(x => Number.isFinite(+x) ? (+x - m)/sd : null);
}

function executePlan(headers, rows, plan){
  const getIdx = (colName) => {
    const {idx} = resolveColumn(colName, headers);
    return idx;
  };

  let data = rows.slice(1).map(r => r.slice());

  for (const f of (plan.filter||[])){
    const idx = getIdx(f.col); if (idx<0) continue;
    const op = (f.op||"=").trim(); const val = +f.value;
    data = data.filter(r => {
      const x = +String(r[idx]).replace(/[^\d.-]/g,"");
      if (!Number.isFinite(x)) return false;
      return op==="=" ? x===val :
             op===">="? x>=val :
             op==="<="? x<=val :
             op===">" ? x> val :
             op==="<" ? x< val :
             op==="between" ? (x>=Math.min(f.a,f.b) && x<=Math.max(f.a,f.b))
             : false;
    });
  }

  for (const c of (plan.compute||[])){
    const idx = getIdx(c.col); if (idx<0) continue;
    const vals = data.map(r => +String(r[idx]).replace(/[^\d.-]/g,"")).filter(Number.isFinite);
    if (c.op==="percentile"){
      const p = Number(c.p)||50;
      const pv = percentile(vals, p);
      const label = c.as || (`P${p}_${headers[idx]}`);
      headers.push(label);
      data.forEach(r => r.push(pv));
    } else if (c.op==="zscore"){
      const zs = zscoreSeries(data.map(r => +String(r[idx]).replace(/[^\d.-]/g,"")));
      const label = c.as || (`Z_${headers[idx]}`);
      headers.push(label);
      data.forEach((r,i) => r.push(zs[i]));
    }
  }

  for (const s of (plan.sort||[]).slice().reverse()){
    const idx = getIdx(s.col); if (idx<0) continue;
    const dir = (s.dir||"desc").toLowerCase()==="asc" ? 1 : -1;
    data.sort((a,b)=>{
      const na = +String(a[idx]).replace(/[^\d.-]/g,"");
      const nb = +String(b[idx]).replace(/[^\d.-]/g,"");
      const va = Number.isFinite(na) ? na : -Infinity;
      const vb = Number.isFinite(nb) ? nb : -Infinity;
      return dir*(va - vb);
    });
  }

  if (Number.isFinite(+plan.limit) && +plan.limit>0) data = data.slice(0, +plan.limit);

  if (Array.isArray(plan.select) && plan.select.length){
    const idxs = plan.select.map(getIdx).filter(i=>i>=0);
    const head = idxs.map(i=>headers[i]);
    const body = data.map(r => idxs.map(i=>r[i]));
    return [head, ...body];
  }

  return [headers, ...data];
}

/* ========== Parser → Plan ========== */
function parseNumeric(query){
  const q = norm(query);
  const between = q.match(/entre\s+(\d+)\s+y\s+(\d+)/);
  if (between) return {op:"between", a:+between[1], b:+between[2]};
  const ge = q.match(/(>=|mayor\s+o\s+igual|igual\s+o\s+mayor)\s+a?\s*(\d+)/);
  if (ge) return {op:">=", value:+ge[2]};
  const le = q.match(/(<=|menor\s+o\s+igual|igual\s+o\s+menor)\s+a?\s*(\d+)/);
  if (le) return {op:"<=", value:+le[2]};
  const gt = q.match(/(>|mayor)\s+a?\s*(\d+)/);
  if (gt) return {op:">", value:+gt[2]};
  const lt = q.match(/(<|menor)\s+a?\s*(\d+)/);
  if (lt) return {op:"<", value:+lt[2]};
  const eq = q.match(/(?:igual\s+a\s*)?(\d+)\s*(?:puntos?|pts?)?/);
  if (eq) return {op:"=", value:+eq[1]};
  return null;
}
function parseOrderDir(query){
  const q = norm(query);
  if (/\b(asc|ascendente|menor a mayor|de menor a mayor)\b/.test(q)) return "asc";
  return "desc";
}
function parseLimit(query){
  const q = norm(query);
  const m1 = q.match(/\btop\s+(\d{1,3})\b/);
  const m2 = q.match(/\bprimer(?:o|a|os|as)?\s+(\d{1,3})\b/);
  const m3 = q.match(/\b(maximo|max)\s+(\d{1,3})\b/);
  const n = m1?.[1] || m2?.[1] || m3?.[2];
  return n ? Number(n) : null;
}
function parseSelect(query){
  const q = norm(query);
  const cols = new Set();
  for (const canon of Object.keys(SYNONYMS)){
    const aliases = (SYNONYMS[canon]||[]).concat([canon]);
    if (aliases.some(a => q.includes(norm(a)))) cols.add(canon);
  }
  return Array.from(cols);
}
function detectMetric(query){
  const q = norm(query);
  let best = null;
  for (const k of Object.keys(SYNONYMS)){
    if (SYNONYMS[k].some(a => q.includes(norm(a))) || q.includes(k)) {
      if (["nombre","curso","paralelo","edad"].includes(k)) continue;
      best = k; break;
    }
  }
  return best;
}
function detectPercentileOps(query){
  const q = norm(query);
  const ops = [];
  const rx = /\bp\s*(\d{2})\b/g;
  let m;
  while ((m = rx.exec(q))){
    const p = +m[1];
    if (p>=1 && p<=99) ops.push({op:"percentile", p, as:`P${p}`});
  }
  if (/percentil\s+(\d{1,3})/.test(q)){
    const p = +q.match(/percentil\s+(\d{1,3})/)[1];
    if (p>=1 && p<=99) ops.push({op:"percentile", p, as:`P${p}`});
  }
  if (/\bz\s*score\b/.test(q)) ops.push({op:"zscore"});
  return ops;
}
function extractMetricTermFree(query){
  const q = norm(query);
  const pats = [
    /\bpor\s+([a-z0-9 ñáéíóú]{3,40})\b/,
    /\ben\s+funcion\s+de\s+([a-z0-9 ñáéíóú]{3,40})\b/,
    /\btomando\s+en\s+cuenta\s+([a-z0-9 ñáéíóú]{3,40})\b/,
    /\ben\s+base\s+a\s+([a-z0-9 ñáéíóú]{3,40})\b/
  ];
  for (const rx of pats){
    const m = q.match(rx);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}
function buildPlanFromQuery(query, headers){
  let metric = detectMetric(query);
  if (!metric){
    const term = extractMetricTermFree(query);
    if (term) metric = term;
  }

  const cmp = parseNumeric(query);
  const dir = parseOrderDir(query);
  const limit = parseLimit(query);
  const selectWords = parseSelect(query);
  const compute = detectPercentileOps(query);

  if (!metric && !cmp && !/orden|ranking|mayor|menor/.test(norm(query)) && !selectWords.length && !compute.length){
    return null;
  }

  let select = selectWords.length ? selectWords.slice() : ["nombre","curso","paralelo"];
  if (metric && !select.includes(metric)) select.push(metric);

  const plan = {
    select,
    filter: [],
    sort: [],
    limit: limit || undefined,
    compute: compute.length ? compute.map(c=>({...c, col: metric||select[select.length-1]})) : []
  };

  if (metric && cmp) plan.filter.push({ col: metric, ...cmp });
  if (metric && /orden|ranking|mayor|menor/.test(norm(query))){
    plan.sort.push({ col: metric, dir });
  }
  return plan;
}

/* ========== OpenAI fallback ========== */
function systemPromptText(){
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Tendrás varias fuentes (CSV y PDF). No inventes datos.",
    "Si no hay información en las fuentes, responde con conocimiento general y acláralo.",
    "Responde breve (~150-180 palabras)."
  ].join(" ");
}
function buildUserPrompt(query, sources, history){
  const parts = [];
  if (history && history.length){
    parts.push("CONTEXTO DE LA CONVERSACIÓN (últimos 10 min):");
    history.slice(-8).forEach(h => {
      parts.push(`- Usuario: ${h.q}`);
      parts.push(`  Resumen previo: ${String(h.text).slice(0,400)}`);
    });
    parts.push("");
  }
  parts.push(`PREGUNTA: ${query}`);
  parts.push("");
  parts.push("FUENTES:");
  for (const s of sources){
    if (s.type === "csv"){
      parts.push(`--- CSV: ${s.label} ---`);
      parts.push("```csv"); parts.push(s.text); parts.push("```");
    }else if (s.type === "pdf"){
      parts.push(`--- PDF (texto extraído): ${s.label} ---`);
      parts.push(s.text.slice(0,120000));
    }else{
      parts.push(`--- TEXTO: ${s.label} ---`);
      parts.push(s.text.slice(0,120000));
    }
  }
  return parts.join("\n");
}
async function callOpenAI(messages){
  if (!API_KEY) return { ok:false, text:"Falta configurar OPENAI_API_KEY en Vercel." };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type":"application/json", Authorization:`Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.25 })
  });
  const data = await r.json().catch(()=>null);
  const text = data?.choices?.[0]?.message?.content?.trim() || `No pude consultar OpenAI (HTTP ${r.status}).`;
  return { ok:true, text };
}

/* ========== Handler ========== */
export default async function handler(req, res){
  try{
    const method = req.method || "GET";
    const body = method === "POST" ? (req.body||{}) : {};
    const q = (body.q || req.query.q || "").toString().trim() || "ping";

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers.host;

    let srcs = body.src || req.query.src;
    if (srcs && !Array.isArray(srcs)) srcs = [srcs];
    const sources = [];
    if (Array.isArray(srcs) && srcs.length){
      for (const raw of srcs){
        try{
          const label = raw.toString();
          const url = isHttpUrl(label) ? label : safeJoinPublic(proto, host, label);
          const text = await getTextFromUrl(url);
          sources.push({ type: isPdf(url) ? "pdf" : (isCsv(url) ? "csv" : "text"), label, text });
        }catch(e){
          sources.push({ type:"text", label:String(raw), text:`[AVISO] No pude leer ${raw}: ${String(e)}` });
        }
      }
    }else{
      const file = safeFileParam(req.query.file || req.query.f || "decimo.csv");
      const publicUrl = `${proto}://${host}/datos/${encodeURIComponent(file)}`;
      const csvText = await getTextFromUrl(publicUrl);
      sources.push({ type:"csv", label:file, text: csvText });
    }

    const firstCsv = sources.find(s => s.type==="csv");
    if (firstCsv){
      const rows = parseCSVToRows(firstCsv.text);
      if (rows && rows.length>=2){
        const headers = rows[0];
        const plan = buildPlanFromQuery(q, headers);
        if (plan){
          const table = executePlan(headers.slice(), rows, plan);
          if (!table || table.length<=1){
            return res.status(200).json({ text:"[]", formato:"json", aviso:"" });
          }
          const head = table[0].map(String);
          const nameIdx = head.findIndex(h => norm(h)==="nombre");
          if (nameIdx === -1){
            const h2 = ["Nombre", ...head];
            const bodyRows = table.slice(1).map(r => [composeName(headers, r), ...r]);
            return res.status(200).json({ text: JSON.stringify([h2, ...bodyRows], null, 2), formato: "json", aviso: "" });
          }
          return res.status(200).json({ text: JSON.stringify(table, null, 2), formato: "json", aviso: "" });
        }
      }
    }

    const history = Array.isArray(body.history) ? body.history : [];
    const messages = [
      { role: "system", content: systemPromptText() },
      { role: "user", content: buildUserPrompt(q, sources, history) },
    ];
    const ai = await callOpenAI(messages);

    return res.status(200).json({ text: ai.text, formato: "texto", aviso: "" });
  }catch(e){
    console.error(e);
    return res.status(500).json({ text:"Error interno.", details:String(e) });
  }
}
