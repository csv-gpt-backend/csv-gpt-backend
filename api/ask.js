// /api/ask.js
// Soporta: q=..., src=multi (csv/pdf/url), o file=decimo.csv (fallback).
// Motor determinista para filtros numéricos sobre CSV (==, >, >=, <, <=, entre).
// Extras: seleccionar columnas ("mostrar/desplegar ..."), ordenar ("ordenar por X asc/desc"),
// y límite ("top 5", "primeros 10"). Si no aplica determinista, consulta a OpenAI.
//
// Instala: npm i pdf-parse

import pdfParse from "pdf-parse";

const MODEL =
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";

const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { ts, text }

// ---------- Utilidades generales ----------
function norm(s){
  return (s||"").toString()
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}

function safeJoinPublic(proto, host, pathLike){
  const p = (pathLike||"").toString().replace(/^\/+/,"");
  if (!p || p.includes("..") || p.includes("\\"))
    throw new Error("Ruta insegura.");
  return `${proto}://${host}/${encodeURI(p)}`;
}

function isHttpUrl(x){ return /^https?:\/\//i.test(x||""); }
function isPdf(x){ return /\.pdf(\?|$)/i.test(x||""); }
function isCsv(x){ return /\.csv(\?|$)/i.test(x||""); }

// Cacheado por URL
async function getTextFromUrl(url){
  const hit = cache.get(url);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_MS) return hit.text;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`No pude leer ${url} (HTTP ${r.status})`);

  // PDF
  if (isPdf(url)){
    const buf = await r.arrayBuffer();
    const parsed = await pdfParse(Buffer.from(buf));
    const text = parsed.text || "";
    cache.set(url, { ts: now, text });
    return text;
  }

  // Genérico/CSV como texto
  const text = await r.text();
  cache.set(url, { ts: now, text });
  return text;
}

// ---------- CSV helpers (determinista) ----------
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

// ---------- Parseo de intención (simple y robusto) ----------
const FIELD_MAP = {
  // agrega alias según tus columnas reales
  asertividad: ["asertividad","asertivid","asertiv"],
  empatia:      ["empatia","empatía","empatia emocional","empatia social","empatia total","empatia_","empatia-","empatia total"],
  agresion:     ["agresion","agresión","agresividad","agresion total","agresion_","agresion-"],
  autoestima:   ["autoestima"],
  tension:      ["tension","tensión","manejo de la tension","manejo de la tensión"],
  bienestar:    ["bienestar","bienestar fisico","bienestar físico"],
  // genéricos comunes
  promedio:     ["promedio","media","avg","average"]
};

function parseSimpleFilter(query){
  const q = norm(query);

  // Detectar campo
  let field = null, aliases = null;
  for (const [k,als] of Object.entries(FIELD_MAP)){
    if (als.some(a => q.includes(a))){ field=k; aliases=als; break; }
  }
  if (!field) return null;

  // Condiciones numéricas
  const mBetween = q.match(/entre\s+(\d+)\s+y\s+(\d+)/);
  if (mBetween){
    return { field, aliases, cond:"between", a: Number(mBetween[1]), b: Number(mBetween[2]) };
  }
  const mGe = q.match(/(>=|mayor\s+o\s+igual|igual\s+o\s+mayor)\s+a?\s*(\d+)/);
  if (mGe){ return { field, aliases, cond:">=", x:Number(mGe[2]) }; }
  const mLe = q.match(/(<=|menor\s+o\s+igual|igual\s+o\s+menor)\s+a?\s*(\d+)/);
  if (mLe){ return { field, aliases, cond:"<=", x:Number(mLe[2]) }; }
  const mGt = q.match(/(>|mayor)\s+a?\s*(\d+)/);
  if (mGt){ return { field, aliases, cond:">", x:Number(mGt[2]) }; }
  const mLt = q.match(/(<|menor)\s+a?\s*(\d+)/);
  if (mLt){ return { field, aliases, cond:"<", x:Number(mLt[2]) }; }
  const mEq = q.match(/(?:igual\s+a\s*)?(\d+)\s*(?:puntos?|pts?)?/);
  if (mEq){ return { field, aliases, cond:"=", x:Number(mEq[1]) }; }

  return null;
}

function parseSelectColumns(query){
  const q = norm(query);
  // detecta palabras después de "mostrar", "desplegar", "columnas", "campos"
  const cols = new Set();
  const want = (name, arr) => arr.some(a => q.includes(a)) ? cols.add(name) : null;

  want("Nombre", ["nombre","estudiante","alumno","nombres","apellidos"]);
  want("Curso", ["curso","grado"]);
  want("Paralelo", ["paralelo","seccion","sección"]);
  want("Edad", ["edad"]);
  // métricas
  for (const [key, als] of Object.entries(FIELD_MAP)){
    const label = key[0].toUpperCase()+key.slice(1);
    if (als.some(a => q.includes(a))) cols.add(label);
  }
  // retorno como array de labels a buscar en headers
  return Array.from(cols);
}

function parseOrder(query){
  const q = norm(query);
  const m = q.match(/ordenar\s+por\s+([a-z0-9 ]+)/);
  let dir = "desc";
  if (/\b(asc|ascendente|menor a mayor)\b/.test(q)) dir = "asc";
  if (/\b(desc|descendente|mayor a menor)\b/.test(q)) dir = "desc";

  let field = null;
  if (m) field = m[1].trim();
  // También acepta "ranking de asertividad" → ordenar por asertividad desc
  if (!field){
    for (const [k,als] of Object.entries(FIELD_MAP)){
      if (als.some(a => q.includes(a))){ field = k; break; }
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

// Filtrado determinista del CSV + selección/orden/limit
function deterministicQuery(query, csvText){
  const intent = parseSimpleFilter(query);
  if (!intent) return null;

  const rows = parseCSVToRows(csvText);
  if (!(rows && rows.length>=2)) return null;
  const headers = rows[0];

  // Indices métricos y de columnas pedidas
  const metricIdx = findCol(headers, intent.aliases);
  if (metricIdx === -1) return null;

  // Columnas estándar útiles
  const nameIdx = findCol(headers, ["nombre","estudiante","alumno","nombres","apellidos","estudiantes","name"]);
  const cursoIdx = findCol(headers, ["curso","grado"]);
  const paraIdx  = findCol(headers, ["paralelo","seccion","sección"]);
  const edadIdx  = findCol(headers, ["edad"]);

  // Selección solicitada
  const wanted = parseSelectColumns(query); // labels
  const wantAll = wanted.length === 0;

  // Mapea label→idx
  function labelToIdx(label){
    const lbl = norm(label);
    if (lbl==="nombre") return nameIdx;
    if (lbl==="curso")  return cursoIdx;
    if (lbl==="paralelo") return paraIdx;
    if (lbl==="edad")   return edadIdx;
    // métricas
    for (const [k,als] of Object.entries(FIELD_MAP)){
      const lab = k[0].toUpperCase()+k.slice(1);
      if (norm(lab)===lbl) return findCol(headers, als);
    }
    // fallback: buscar por título literal
    return headers.findIndex(h => norm(h)===lbl);
  }

  const selectedIdx = (wantAll ? [] : wanted.map(labelToIdx).filter(i=>i>=0));

  function passes(v){
    const n = Number(String(v).replace(/[^\d.-]/g,""));
    if (Number.isNaN(n)) return false;
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

  // Recolectar filas que cumplen
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

  // Ordenar
  const { field:orderFieldHint, dir } = parseOrder(query);
  if (orderFieldHint){
    let idx = -1;
    // por label explícito
    idx = headers.findIndex(h => norm(h).includes(norm(orderFieldHint)));
    // por aliases de métricas
    if (idx===-1){
      for (const [k,als] of Object.entries(FIELD_MAP)){
        if (als.some(a => norm(orderFieldHint).includes(a))){
          idx = findCol(headers, als); break;
        }
      }
    }
    if (idx!==-1){
      const label = headers[idx];
      data.sort((a,b)=>{
        const na = Number(String(a[label]).replace(/[^\d.-]/g,""));
        const nb = Number(String(b[label]).replace(/[^\d.-]/g,""));
        const va = Number.isNaN(na) ? -Infinity : na;
        const vb = Number.isNaN(nb) ? -Infinity : nb;
        return dir==="asc" ? (va - vb) : (vb - va);
      });
    }
  }

  // Límite
  const N = parseLimit(query);
  if (N && N>0) data = data.slice(0, N);

  return { items: data };
}

// ---------- OpenAI ----------
function systemPromptText(){
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Tendrás varias fuentes (CSV y PDF).",
    "No inventes datos; si falta info, dilo. Si hay cifras, respétalas.",
    "Si el usuario pide lista/tabla y no te doy una tabla explícita, responde en texto (el front estructura si hace falta).",
    "Responde breve (~150-180 palabras)."
  ].join(" ");
}

function buildUserPrompt(query, sources){
  // Une todas las fuentes, cada una etiquetada
  const parts = [`PREGUNTA: ${query}`, "", "FUENTES:"];
  for (const s of sources){
    if (s.type === "csv"){
      parts.push(`--- CSV: ${s.label} ---`);
      parts.push("```csv");
      parts.push(s.text);
      parts.push("```");
    }else if (s.type === "pdf"){
      parts.push(`--- PDF (texto extraído): ${s.label} ---`);
      parts.push(s.text.slice(0, 120000)); // tope razonable
    }else{
      parts.push(`--- TEXTO: ${s.label} ---`);
      parts.push(s.text.slice(0, 120000));
    }
  }
  return parts.join("\n");
}

async function callOpenAI(messages){
  if (!API_KEY){
    return { ok:false, text:"Falta configurar OPENAI_API_KEY en Vercel." };
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.25,
    }),
  });
  const data = await r.json().catch(()=>null);
  const text =
    data?.choices?.[0]?.message?.content?.trim() ||
    `No pude consultar OpenAI (HTTP ${r.status}).`;
  return { ok:true, text };
}

// ---------- Handler ----------
export default async function handler(req, res){
  try{
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";

    // Recolectar fuentes: src=multi o file=csv (legacy)
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers.host;

    let srcs = req.query.src;
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
          // sigue con el resto, pero agrega aviso
          sources.push({ type:"text", label: String(raw), text: `[AVISO] No pude leer ${raw}: ${String(e)}` });
        }
      }
    }else{
      // Legacy: file=decimo.csv (en /public/datos/)
      const file = safeFileParam(req.query.file || req.query.f || "decimo.csv");
      const publicUrl = `${proto}://${host}/datos/${encodeURIComponent(file)}`;
      const csvText = await getTextFromUrl(publicUrl);
      sources.push({ type:"csv", label:file, text: csvText });
    }

    // --------- Ruta determinista (si hay al menos un CSV) ---------
    const firstCsv = sources.find(s => s.type==="csv");
    if (firstCsv){
      const det = deterministicQuery(q, firstCsv.text);
      if (det){
        // Entregamos JSON estructurado para que el front lo tabule/enumere
        return res.status(200).json({
          text: JSON.stringify(det.items, null, 2),
          fuentes: sources.map(s=>({type:s.type,label:s.label})),
          formato: "json"
        });
      }
    }

    // --------- Fallback: consulta a OpenAI con todas las fuentes ---------
    const messages = [
      { role: "system", content: systemPromptText() },
      { role: "user", content: buildUserPrompt(q, sources) },
    ];
    const ai = await callOpenAI(messages);

    return res.status(200).json({
      text: ai.text,
      fuentes: sources.map(s=>({type:s.type,label:s.label})),
      formato: "texto"
    });
  }catch(e){
    console.error(e);
    return res.status(500).json({ text:"Error interno.", details:String(e) });
  }
}

// ---------- Legacy helper (solo para compatibilidad con file=) ----------
function safeFileParam(s, def = "decimo.csv") {
  const x = (s || "").toString().trim();
  if (!x) return def;
  if (x.includes("..") || x.includes("/") || x.includes("\\")) return def;
  return x;
}
