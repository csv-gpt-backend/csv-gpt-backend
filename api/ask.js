// /api/ask.js  (MODO SEGURO: solo CSV + memoria 10min)
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

const CACHE_MS = 5 * 60 * 1000;
const csvCache = new Map();
const sessions = new Map(); // memoria 10 minutos

function sid(req){
  const ua = (req.headers["user-agent"] || "").slice(0,80);
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "ip";
  return `${ip}|${ua}`;
}
function getSess(req){
  const id = sid(req), now = Date.now();
  const it = sessions.get(id);
  if (it && now - it.ts <= 10*60*1000) return it;
  const fresh = { ts: now, history: [] };
  sessions.set(id, fresh); 
  return fresh;
}
function safeFile(s, def = "decimo.csv"){
  const x = (s || "").toString().trim();
  if (!x) return def;
  if (x.includes("..") || x.includes("/") || x.includes("\\")) return def;
  return x;
}
async function fetchCSV(url){
  const hit = csvCache.get(url), now = Date.now();
  if (hit && (now - hit.ts) < CACHE_MS) return hit.text;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No pude leer CSV ${url} (HTTP ${r.status})`);
  const text = await r.text();
  csvCache.set(url, { ts: now, text });
  return text;
}
function systemPrompt(){
  return [
    "Eres asesora educativa (es-MX), clara y ejecutiva.",
    "Dispones de un CSV completo con columnas variables (no menciones que es un CSV).",
    "Usa datos reales. Si falta info, dilo.",
    "Si piden 'lista/enlistar/tabla', devuelve tabla numerada (#) y ordenada.",
    "Para 'grupos homogéneos' usa clustering simple sobre columnas solicitadas.",
    "Para correlación usa Pearson/Spearman con interpretación.",
    "No dupliques información en la respuesta. Evita asteriscos."
  ].join(" ");
}
function userPrompt(q, csvText){
  return [
    `PREGUNTA: ${q}`,
    "",
    "DATOS (entre triple backticks):",
    "```csv",
    csvText,
    "```",
  ].join("\n");
}
async function callOpenAI(messages){
  if (!API_KEY) {
    return { ok:false, text:"Falta OPENAI_API_KEY en Vercel." };
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ "Content-Type":"application/json", Authorization:`Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature:0.35 })
  });
  const raw = await r.text();
  let json; try{ json = JSON.parse(raw) }catch{}
  const text = json?.choices?.[0]?.message?.content?.trim() || raw || `HTTP ${r.status}`;
  return { ok:true, text };
}

export default async function handler(req, res){
  try{
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";
    const file = safeFile(req.query.file || req.query.f || "decimo.csv");

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers.host;
    const csvUrl = `${proto}://${host}/datos/${encodeURIComponent(file)}`;

    // CSV
    const csvText = await fetchCSV(csvUrl);
    const lines = csvText.split(/\r?\n/).filter(Boolean).length;

    // Memoria
    const s = getSess(req);
    if (s.history.length > 12) s.history.splice(0, s.history.length - 12);

    const messages = [
      { role:"system", content: systemPrompt() },
      ...s.history,
      { role:"user", content: userPrompt(q, csvText) }
    ];

    const ai = await callOpenAI(messages);
    s.ts = Date.now();
    s.history.push({ role:"user", content:q });
    s.history.push({ role:"assistant", content: ai.text });

    return res.status(200).json({
      text: ai.text,
      archivo: file,
      filas_aprox: lines,
      formato: "texto"
    });
  }catch(e){
    console.error(e);
    return res.status(200).json({ text:"No se encontró respuesta.", error:String(e) });
  }
}
