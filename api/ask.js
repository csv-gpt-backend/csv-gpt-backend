// api/ask.js  — Vercel Serverless
const fs = require("fs");
const path = require("path");

const VERSION = "gpt5-csv-direct-main-7"; // <- esto debe salir en ?q=version
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

function hdr(res){
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
}
function send(res, code, obj){
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  hdr(res);
  res.end(JSON.stringify(obj));
}
function detectDelimiter(sample){
  const head = sample.split(/\r?\n/).slice(0,3).join("\n");
  const opts = [[",", (head.match(/,/g)||[]).length],
                [";", (head.match(/;/g)||[]).length],
                ["\t",(head.match(/\t/g)||[]).length]];
  opts.sort((a,b)=>b[1]-a[1]);
  return opts[0][1] ? opts[0][0] : ",";
}
function loadCSV(){
  const tries = [path.join(process.cwd(),"api","data.csv"),
                 path.join(process.cwd(),"data.csv")];
  for (const f of tries){
    if (fs.existsSync(f)){
      const csv = fs.readFileSync(f,"utf8");
      const d = detectDelimiter(csv);
      const header = (csv.split(/\r?\n/).find(Boolean)||"").split(d).map(s=>s.trim());
      const rows = Math.max(0, csv.split(/\r?\n/).filter(Boolean).length - 1);
      return { csv, filePath:f, rows, headers:header };
    }
  }
  throw new Error("CSV no encontrado (api/data.csv o data.csv).");
}
async function askOpenAI(system, user){
  const payload = {
    model: "gpt-4o", // <-- si tienes GPT-5 en API, cambia a "gpt-5"
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [{ role:"system", content:system }, { role:"user", content:user }]
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(text); } catch { return { respuesta: text }; }
}

module.exports = async (req, res) => {
  try{
    if (req.method === "OPTIONS"){ hdr(res); res.statusCode = 204; return res.end(); }

    // obtener q de forma robusta
    let q = "";
    try { q = new URL(req.url, `http://${req.headers.host}`).searchParams.get("q") || ""; } catch {}
    if (!q && req.method !== "GET") q = (req.body?.q || "");
    q = (q||"").toString().trim();
    const ql = q.toLowerCase();

    // ---- SHORT-CIRCUIT health ----
    if (!q || ql === "ping")     return send(res,200,{ ok:true });
    if (ql === "version")        return send(res,200,{ version: VERSION });

    // ---- CSV (inline o archivo) ----
    let csv, filePath, rows, headers, source="fs";
    const inline = req.method !== "GET" ? (req.body?.csv ?? null) : null;
    if (typeof inline === "string" && inline.trim()){
      csv = inline; filePath="(inline)"; source="inline";
      const d = detectDelimiter(csv);
      headers = (csv.split(/\r?\n/).find(Boolean)||"").split(d).map(s=>s.trim());
      rows = Math.max(0, csv.split(/\r?\n/).filter(Boolean).length - 1);
    } else {
      ({csv, filePath, rows, headers} = loadCSV());
    }
    if (ql === "diag") return send(res,200,{ source, filePath, url:null, rows, headers });

    if (!OPENAI_API_KEY) return send(res,500,{ error:"Falta OPENAI_API_KEY en Vercel (Production)" });

    // ---- Prompt para análisis directo del CSV ----
    const system = `
Eres un analista de datos. Responde SOLO JSON válido:
{
  "respuesta": "texto claro en español",
  "tabla": { "headers": [...], "rows": [[...], ...] },
  "stats": { "n": <int>, "mean": <num> }
}
- Recibirás el CSV completo entre <CSV>...</CSV>.
- Acepta sinónimos y variaciones (acentos, mayúsculas, etc.).
- "por separado"/"por paralelo" => agrupa por columna de paralelo (A,B).
- Ranking = mayor→menor con n y promedio. Nada de Markdown.`;
    const user = `<CSV>\n${csv}\n</CSV>\n\nPregunta:\n${q}`;

    const out = await askOpenAI(system, user);
    return send(res,200,out);

  }catch(err){
    return send(res,500,{ error: String(err.message||err) });
  }
};
