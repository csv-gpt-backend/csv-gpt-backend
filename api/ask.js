// /api/ask.js
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const PDF_URLS = [
  process.env.PDF_LEXIUM_URL || "https://csv-gpt-backend.vercel.app/lexium.pdf",
  process.env.PDF_EVALUACIONES_URL || "https://csv-gpt-backend.vercel.app/evaluaciones.pdf",
];

const CACHE_MS = 5 * 60 * 1000;
const cacheCSV = new Map();
const sessions = new Map();   // 10 min

function sid(req){
  const ua=(req.headers["user-agent"]||"").slice(0,80);
  const ip=req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"ip";
  return `${ip}|${ua}`;
}
function getSess(id){
  const now=Date.now(); const it=sessions.get(id);
  if(it && now-it.ts <= (10*60*1000)) return it;
  const fresh={ ts:now, history:[] }; sessions.set(id,fresh); return fresh;
}
function safeFile(s,def="decimo.csv"){
  const x=(s||"").toString().trim(); if(!x) return def;
  if(x.includes("..")||x.includes("/")||x.includes("\\")) return def;
  return x;
}
async function getCSV(pubUrl){
  const hit=cacheCSV.get(pubUrl); const now=Date.now();
  if(hit && now-hit.ts < CACHE_MS) return hit.text;
  const r=await fetch(pubUrl); if(!r.ok) throw new Error(`No pude leer CSV ${pubUrl} (HTTP ${r.status})`);
  const text=await r.text(); cacheCSV.set(pubUrl,{ts:now,text}); return text;
}
async function tryExtractPDF(url){
  try{
    const pdfParse=(await import("pdf-parse")).default;
    const r=await fetch(url); if(!r.ok) return "";
    const buf=await r.arrayBuffer(); const data=await pdfParse(Buffer.from(buf));
    return data?.text||"";
  }catch{return "";}
}
function sysPrompt(){
  return [
    "Eres asesora educativa (es-MX), clara y ejecutiva.",
    "Dispones de: (1) CSV completo con columnas variables; (2) texto de 2 PDFs.",
    "No menciones que analizas CSV o PDFs.",
    "Usa datos REALES. Si falta info, dilo.",
    "Si piden 'lista/enlistar/tabla', devuelve tabla numerada (#) y ordenada.",
    "Si no piden tabla, da explicación breve (~150-180 palabras).",
    "Para 'grupos homogéneos' usa clustering simple con distancias sobre columnas relevantes (Agresión, Empatía, etc.).",
    "Para correlación usa Pearson/Spearman con r o r² e interpretación.",
    "No dupliques misma info arriba y abajo. Evita asteriscos.",
  ].join(" ");
}
function userPrompt(q, csv, pdfs){
  const bundle = [
    `PREGUNTA: ${q}`,
    "",
    "CSV completo (entre triple backticks):",
    "```csv", csv, "```"
  ];
  if(pdfs?.length){
    bundle.push("", "EXTRACTOS DE PDFs (texto plano, NO lo menciones explícitamente):");
    pdfs.forEach((t,i)=>{ if(t?.trim()){ const c=t.length>20000?t.slice(0,20000)+"\n[...]":t; bundle.push("",`--- PDF ${i+1} ---`,c); } });
  }
  return bundle.join("\n");
}
async function callOpenAI(messages){
  if(!API_KEY) return { ok:false, text:"Falta OPENAI_API_KEY en Vercel." };
  const r=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature:0.35 })
  });
  const data=await r.json().catch(()=>null);
  const text=data?.choices?.[0]?.message?.content?.trim()||`No pude consultar OpenAI (HTTP ${r.status}).`;
  return { ok:true, text };
}

export default async function handler(req,res){
  try{
    const q=(req.query.q||req.body?.q||"").toString().trim()||"ping";
    const file=safeFile(req.query.file||req.query.f||"decimo.csv");

    const proto=req.headers["x-forwarded-proto"]||"https";
    const host=req.headers.host;
    const publicUrl=`${proto}://${host}/datos/${encodeURIComponent(file)}`;

    const csv=await getCSV(publicUrl);
    const pdfTexts=[];
    for(const url of PDF_URLS){ try{ const t=await tryExtractPDF(url); if(t?.trim()) pdfTexts.push(t); }catch{} }

    const id=sid(req); const s=getSess(id);
    if(s.history.length>12) s.history.splice(0,s.history.length-12);

    const messages=[
      {role:"system", content: sysPrompt()},
      ...s.history,
      {role:"user", content: userPrompt(q,csv,pdfTexts)}
    ];
    const ai=await callOpenAI(messages);

    s.ts=Date.now();
    s.history.push({role:"user", content:q});
    s.history.push({role:"assistant", content: ai.text});

    const lines=csv.split(/\r?\n/).filter(Boolean).length;
    return res.status(200).json({ text: ai.text, archivo:file, filas_aprox:lines, formato:"texto" });
  }catch(e){
    console.error(e);
    return res.status(200).json({ text:"No se encontró respuesta.", error:String(e) });
  }
}
