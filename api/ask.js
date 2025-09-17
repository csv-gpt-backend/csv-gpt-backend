// api/ask.js — Análisis guiado 100% por GPT-5 Thinking con el CSV real.
// CommonJS (Vercel Serverless).

const fs = require("fs").promises;
const path = require("path");

// ------- utilidades CSV (sin suposiciones) -------
function detectDelimiter(line){const c=[",",";","\t","|"];let b={d:",",n:0};for(const d of c){const n=line.split(d).length;if(n>b.n)b={d,n}}return b.d}
function splitCSVLine(line,d){const out=[];let cur="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(q&&line[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(ch===d&&!q){out.push(cur);cur="";}else cur+=ch;}out.push(cur);return out;}
function parseCSV(text){
  const lines=text.replace(/\r/g,"").split("\n").filter(Boolean);
  if(!lines.length) return {headers:[],rows:[]};
  const d=detectDelimiter(lines[0]);
  const headers=splitCSVLine(lines[0],d).map(s=>s.trim());
  const rows=[];
  for(let i=1;i<lines.length;i++){
    const vals=splitCSVLine(lines[i],d);
    const o={}; headers.forEach((h,j)=>o[h]=(vals[j]??"").trim());
    rows.push(o);
  }
  return {headers,rows};
}
const norm=s=>String(s??"").normalize("NFD").replace(/\p{Diacritic}/gu,"").toUpperCase().trim();

// ------- leer CSV desde /public/datos o URL propia -------
async function readCSV(file, req){
  const local=path.join(process.cwd(),"public","datos",file);
  try{ return await fs.readFile(local,"utf8"); }
  catch{
    const host=req.headers["x-forwarded-host"]||req.headers.host||"localhost:3000";
    const proto=host.includes("localhost")?"http":"https";
    const url=`${proto}://${host}/datos/${encodeURIComponent(file)}`;
    const r=await fetch(url);
    if(!r.ok) throw new Error(`HTTP ${r.status} al leer ${url}`);
    return await r.text();
  }
}

// ------- llamada a GPT-5 Thinking -------
async function askLLM({q, headers, csvText}){
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if(!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
  const model = process.env.LLM_MODEL || "gpt-5-thinking";

  const system = [
    "Eres una analista de datos en español (México).",
    "Analiza un archivo CSV de estudiantes (encabezados y filas).",
    "Responde SIEMPRE en JSON estricto y NADA de texto adicional.",
    "Nunca digas frases como 'según el CSV'. No uses asteriscos.",
    "Cuando pidan tablas/listas/rankings, devuelve una tabla: columnas + filas.",
    "Cuando pidan cálculos (promedios, correlaciones, conteos, etc.), devuélvelos en 'message' y 'speak'; solo agrega tabla si realmente se pidió una lista.",
    "Respeta tildes y variantes: trata los nombres de columnas sin distinguir mayúsculas/acentos (e.g. 'propension al cambio' == 'PROPENSIÓN AL CAMBIO').",
    "No inventes columnas. Usa solo las que existan.",
    "",
    "Formato JSON de salida:",
    "{",
    '  "intent": "table" | "calc" | "message",',
    '  "speak": "frase corta para leer en voz alta",',
    '  "message": "texto para mostrar en pantalla",',
    '  "table": { "columns": [..], "rows": [[..],..] } // opcional',
    "}",
  ].join("\n");

  const user = [
    `Pregunta del usuario: ${q}`,
    "Encabezados del CSV:",
    JSON.stringify(headers),
    "",
    "CSV_DATA_START",
    csvText,
    "CSV_DATA_END"
  ].join("\n");

  const payload = {
    model,
    response_format: { type: "json_object" },
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    max_output_tokens: 1200
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const jr = await r.json();
  const text = jr.output_text || jr.content?.[0]?.text || jr.choices?.[0]?.message?.content || "{}";
  let out;
  try { out = JSON.parse(text); }
  catch { out = { intent:"message", speak:"No pude interpretar la solicitud.", message:"No pude interpretar la solicitud." }; }
  // limpiar asteriscos por si acaso
  if(out.speak) out.speak = String(out.speak).replace(/\*/g,"");
  if(out.message) out.message = String(out.message).replace(/\*/g,"");
  return out;
}

// ------- handler HTTP -------
module.exports = async (req, res) => {
  const q    = String(req.query?.q || "").trim();
  const file = String(req.query?.file || "decimo.csv");
  try{
    // 1) leer CSV completo y parsear (también lo pasaremos TAL CUAL a GPT-5)
    const csvText = await readCSV(file, req);
    const { headers } = parseCSV(csvText); // solo para mostrar al modelo
    if(!headers.length) return res.status(200).json({ rows:[], speak:"No hay datos.", message:"No hay datos." });

    // 2) pedir la respuesta 100% al modelo (sin defaults del backend)
    const llm = await askLLM({ q, headers, csvText });

    // 3) adaptar a la UI: si trae tabla, la convertimos en rows [{..}]
    let rows = [];
    if (llm.table && Array.isArray(llm.table.columns) && Array.isArray(llm.table.rows)) {
      const cols = llm.table.columns;
      rows = llm.table.rows.map(r => {
        const obj = {};
        cols.forEach((c, i) => { obj[c] = r[i]; });
        return obj;
      });
    }

    // 4) responder
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      rows,                               // si hay tabla; si no, []
      speak:   llm.speak   || "",         // frase para la voz
      message: llm.message || "",         // texto para el área de resultados
      intent:  llm.intent  || "message"   // útil para depurar en el front si quieres
    });

  }catch(err){
    console.error("ask.js error:", err);
    return res.status(200).json({
      error: true,
      message: "No fue posible procesar la consulta.",
      details: err?.message
    });
  }
};
