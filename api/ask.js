// pages/api/ask.js
// Determinista para filtros (==, >, >=, <, <=, entre) y ranking/orden por métrica.
// Si no aplica determinista → GPT (con historia de los últimos 10 min).
// Soporta fuentes: body.src = [csv|pdf|url|/datos/...]. También legacy file=decimo.csv.
// Requiere: npm i pdf-parse

import pdfParse from "pdf-parse";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { ts, text }

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

// ====== CSV ======
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
function findCol(headers, aliases){
  const H = headers.map(h => norm(h));
  let best = -1, score = -1;
  for (let i=0;i<H.length;i++){
    const h = H[i];
    for (const a of aliases){
      if (h === a || h.includes(a) || a.includes(h)){
        const s = (h===a?3:h.includes(a)||a.includes(h)?2:1);
        if (s>score){ score=s; best=i; }
      }
    }
  }
  return best;
}
function num(v){
  const n = Number(String(v).replace(/[^\d.-]/g,""));
  return Number.isNaN(n) ? null : n;
}

// ====== Intents ======
const FIELD_MAP = {
  asertividad: ["asertividad","asertivid","asertiv"],
  empatia: ["empatia","empatía","empatia emocional","empatia social","empatia total","empatia_","empatia-"],
  agresion: ["agresion","agresión","agresividad","agresion total","agresion_","agresion-"],
  liderazgo: ["liderazgo","liderazg","lider"],                 // <== agregado
  autoestima: ["autoestima"],
  tension: ["tension","tensión","manejo de la tension","manejo de la tensión"],
  bienestar: ["bienestar","bienestar fisico","bienestar físico"],
  promedio: ["promedio","media","avg","average"]
};

function parseSimpleFilter(query){
  const q = norm(query);
  let field=null, aliases=null;
  for (const [k,als] of Object.entries(FIELD_MAP)){
    if (als.some(a => q.includes(a))){ field=k; aliases=als; break; }
  }
  if (!field) return null;

  const mBetween = q.match(/entre\s+(\d+)\s+y\s+(\d+)/);
  if (mBetween) return { field, aliases, cond:"between", a:+mBetween[1], b:+mBetween[2] };

  const mGe = q.match(/(>=|mayor\s+o\s+igual|igual\s+o\s+mayor)\s+a?\s*(\d+)/);
  if (mGe) return { field, aliases, cond:">=", x:+mGe[2] };

  const mLe = q.match(/(<=|menor\s+o\s+igual|igual\s+o\s+menor)\s+a?\s*(\d+)/);
  if (mLe) return { field, aliases, cond:"<=", x:+mLe[2] };

  const mGt = q.match(/(>|mayor)\s+a?\s*(\d+)/);
  if (mGt) return { field, aliases, cond:">", x:+mGt[2] };

  const mLt = q.match(/(<|menor)\s+a?\s*(\d+)/);
  if (mLt) return { field, aliases, cond:"<", x:+mLt[2] };

  const mEq = q.match(/(?:igual\s+a\s*)?(\d+)\s*(?:puntos?|pts?)?/);
  if (mEq) return { field, aliases, cond:"=", x:+mEq[1] };

  return null;
}
function parseSelectColumns(query){
  const q = norm(query);
  const cols = new Set();
  const want = (name, arr) => arr.some(a => q.includes(a)) ? cols.add(name) : null;
  want("Nombre", ["nombre","estudiante","alumno","nombres","apellidos"]);
  want("Curso", ["curso","grado"]);
  want("Paralelo", ["paralelo","seccion","sección"]);
  want("Edad", ["edad"]);
  for (const [k,als] of Object.entries(FIELD_MAP)){
    const label = k[0].toUpperCase()+k.slice(1);
    if (als.some(a => q.includes(a))) cols.add(label);
  }
  return Array.from(cols);
}
function parseOrder(query){
  const q = norm(query);
  let dir = "desc";
  if (/\b(asc|ascendente|menor a mayor|de menor a mayor)\b/.test(q)) dir = "asc";
  if (/\b(desc|descendente|mayor a menor|de mayor a menor)\b/.test(q)) dir = "desc";
  let field = null;
  const m = q.match(/orden(?:ar)?(?:\s+por)?\s+([a-z0-9 ]+)/);
  if (m) field = m[1].trim();
  if (!field){
    for (const [k,als] of Object.entries(FIELD_MAP)){
      if (als.some(a => q.includes(a))){ field=k; break; }
    }
  }
  return { field, dir };
}
function parseLimit(query){
  const q = norm(query);
  const m1 = q.match(/\btop\s+(\d{1,3})\b/);
  const m2 = q.match(/\bprimer(?:o|a|os|as)?\s+(\d{1,3})\b/);
  const m3 = q.match(/\b(maximo|max)\s+(\d{1,3})\b/);
  const n = m1?.[1] || m2?.[1] || m3?.[2];
  return n ? Number(n) : null;
}

// ====== Determinista: filtro ======
function deterministicQuery(query, csvText){
  const intent = parseSimpleFilter(query);
  if (!intent) return null;

  const rows = parseCSVToRows(csvText);
  if (!(rows && rows.length>=2)) return null;
  const headers = rows[0];

  const metricIdx = findCol(headers, intent.aliases);
  if (metricIdx === -1) return null;

  const nameIdx = findCol(headers, ["nombre","estudiante","alumno","nombres","apellidos","estudiantes","name"]);
  const cursoIdx = findCol(headers, ["curso","grado"]);
  const paraIdx  = findCol(headers, ["paralelo","seccion","sección"]);
  const edadIdx  = findCol(headers, ["edad"]);

  const wanted = parseSelectColumns(query);
  const wantAll = wanted.length === 0;

  function labelToIdx(label){
    const lbl = norm(label);
    if (lbl==="nombre") return nameIdx;
    if (lbl==="curso")  return cursoIdx;
    if (lbl==="paralelo") return paraIdx;
    if (lbl==="edad")   return edadIdx;
    for (const [k,als] of Object.entries(FIELD_MAP)){
      const lab = k[0].toUpperCase()+k.slice(1);
      if (norm(lab)===lbl) return findCol(headers, als);
    }
    return headers.findIndex(h => norm(h)===lbl);
  }
  const selectedIdx = (wantAll ? [] : wanted.map(labelToIdx).filter(i=>i>=0));

  function passes(v){
    const n = num(v); if (n==null) return false;
    switch(intent.cond){
      case "=":  return n === intent.x;
      case ">=": return n >= intent.x;
      case "<=": return n <= intent.x;
      case ">":  return n >  intent.x;
      case "<":  return n <  intent.x;
      case "between": return n >= Math.min(intent.a,intent.b) && n <= Math.max(intent.a,intent.b);
      default: return false;
    }
  }

  let data = [];
  for (let i=1;i<rows.length;i++){
    const r = rows[i];
    if (passes(r[metricIdx])){
      const obj = {};
      if (wantAll){
        if (nameIdx !== -1) obj["Nombre"] = r[nameIdx];
        const metricLabel = headers[metricIdx] || intent.aliases[0].toUpperCase();
        obj[metricLabel] = r[metricIdx];
      }else{
        for (const idx of selectedIdx){
          const label = headers[idx] || `Col_${idx+1}`;
          obj[label] = r[idx];
        }
      }
      data.push(obj);
    }
  }

  // Orden
  const { field:orderFieldHint, dir } = parseOrder(query);
  if (orderFieldHint){
    let idx = headers.findIndex(h => norm(h).includes(norm(orderFieldHint)));
    if (idx===-1){
      for (const [k,als] of Object.entries(FIELD_MAP)){
        if (als.some(a => norm(orderFieldHint).includes(a))){ idx = findCol(headers, als); break; }
      }
    }
    if (idx!==-1){
      const label = headers[idx];
      data.sort((a,b)=>{
        const na = num(a[label]); const nb = num(b[label]);
        const va = (na==null? -Infinity : na);
        const vb = (nb==null? -Infinity : nb);
        return dir==="asc" ? (va - vb) : (vb - va);
      });
    }
  }

  const N = parseLimit(query);
  if (N && N>0) data = data.slice(0, N);

  return { items: data };
}

// ====== Determinista: ranking (sin filtro) ======
function deterministicRanking(query, csvText){
  const { field, dir } = parseOrder(query);
  if (!field) return null;

  const rows = parseCSVToRows(csvText);
  if (!(rows && rows.length>=2)) return null;
  const headers = rows[0];

  const aliases = FIELD_MAP[field] || [field];
  const metricIdx = findCol(headers, aliases);
  if (metricIdx === -1) return null;

  const nameIdx = findCol(headers, ["nombre","estudiante","alumno","nombres","apellidos","estudiantes","name"]);
  const cursoIdx = findCol(headers, ["curso","grado"]);
  const paraIdx  = findCol(headers, ["paralelo","seccion","sección"]);
  const edadIdx  = findCol(headers, ["edad"]);

  const wanted = parseSelectColumns(query);
  const wantAll = wanted.length === 0;

  function labelToIdx(label){
    const lbl = norm(label);
    if (lbl==="nombre") return nameIdx;
    if (lbl==="curso")  return cursoIdx;
    if (lbl==="paralelo") return paraIdx;
    if (lbl==="edad")   return edadIdx;
    for (const [k,als] of Object.entries(FIELD_MAP)){
      const lab = k[0].toUpperCase()+k.slice(1);
      if (norm(lab)===lbl) return findCol(headers, als);
    }
    return headers.findIndex(h => norm(h)===lbl);
  }
  const selectedIdx = (wantAll ? [] : wanted.map(labelToIdx).filter(i=>i>=0));

  let data = [];
  for (let i=1;i<rows.length;i++){
    const r = rows[i];
    const n = num(r[metricIdx]); if (n==null) continue;

    const obj = {};
    if (wantAll){
      if (nameIdx !== -1) obj["Nombre"] = r[nameIdx];
      const metricLabel = headers[metricIdx] || aliases[0].toUpperCase();
      obj[metricLabel] = r[metricIdx];
    }else{
      for (const idx of selectedIdx){
        const label = headers[idx] || `Col_${idx+1}`;
        obj[label] = r[idx];
      }
      const mlabel = headers[metricIdx] || aliases[0].toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(obj, mlabel)) obj[mlabel] = r[metricIdx];
    }
    data.push(obj);
  }

  const metricLabel = headers[metricIdx];
  data.sort((a,b)=>{
    const na = num(a[metricLabel]); const nb = num(b[metricLabel]);
    const va = (na==null? -Infinity : na);
    const vb = (nb==null? -Infinity : nb);
    return dir==="asc" ? (va - vb) : (vb - va);
  });

  const N = parseLimit(query);
  if (N && N>0) data = data.slice(0, N);

  return { items: data };
}

// ====== OpenAI ======
function systemPromptText(){
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Tendrás varias fuentes (CSV y PDF). No inventes datos.",
    "Si no hay información en las fuentes, responde con conocimiento general pero acláralo.",
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

// ====== Handler ======
export default async function handler(req, res){
  try{
    const method = req.method || "GET";
    // Soporta POST JSON o GET query
    const body = method === "POST" ? (req.body||{}) : {};
    const q = (body.q || req.query.q || "").toString().trim() || "ping";

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers.host;

    // Fuentes
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

    // 1) Determinista con filtro
    const firstCsv = sources.find(s => s.type==="csv");
    if (firstCsv){
      const det = deterministicQuery(q, firstCsv.text);
      if (det){
        if (!det.items.length){
          return res.status(200).json({ text: "[]", formato:"json", aviso:"" });
        }
        return res.status(200).json({
          text: JSON.stringify(det.items, null, 2),
          formato: "json",
          aviso: ""
        });
      }
      // 2) Determinista ranking
      const rank = deterministicRanking(q, firstCsv.text);
      if (rank){
        if (!rank.items.length){
          return res.status(200).json({ text: "[]", formato:"json", aviso:"" });
        }
        return res.status(200).json({
          text: JSON.stringify(rank.items, null, 2),
          formato: "json",
          aviso: ""
        });
      }
    }

    // 3) Fallback GPT (con historia)
    const history = Array.isArray(body.history) ? body.history : [];
    const messages = [
      { role: "system", content: systemPromptText() },
      { role: "user", content: buildUserPrompt(q, sources, history) },
    ];
    const ai = await callOpenAI(messages);

    return res.status(200).json({
      text: ai.text,
      formato: "texto",
      aviso: ""
    });
  }catch(e){
    console.error(e);
    return res.status(500).json({ text:"Error interno.", details:String(e) });
  }
}
