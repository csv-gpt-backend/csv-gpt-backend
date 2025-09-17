// api/ask.js — Backend con planificación LLM (GPT-5) + ejecución local sobre CSV.
// CommonJS (Vercel Serverless). No uses Edge runtime aquí.

const fs = require("fs").promises;
const path = require("path");

// ================= CSV utilities =================
function detectDelimiter(line){const c=[",",";","\t","|"];let b={d:",",n:0};for(const d of c){const n=line.split(d).length;if(n>b.n)b={d,n}}return b.d}
function splitCSVLine(line,d){const o=[];let c="",q=false;for(let i=0;i<line.length;i++){const ch=line[i];if(ch==='"'){if(q&&line[i+1]==='"'){c+='"';i++}else q=!q}else if(ch===d&&!q){o.push(c);c=""}else c+=ch}o.push(c);return o.map(s=>s.trim())}
function parseCSV(text){
  const lines=text.replace(/\r/g,"").split("\n").filter(l=>l.length>0);
  if(!lines.length) return { headers:[], rows:[], delimiter:"," };
  const delimiter=detectDelimiter(lines[0]);
  const headers=splitCSVLine(lines[0], delimiter);
  const rows=[];
  for(let i=1;i<lines.length;i++){
    const vals=splitCSVLine(lines[i], delimiter), obj={};
    headers.forEach((h,idx)=>{ obj[h]=vals[idx]??""; });
    rows.push(obj);
  }
  return { headers, rows, delimiter };
}
const norm = s => String(s??"").normalize("NFD").replace(/\p{Diacritic}/gu,"").toUpperCase().trim();
function toNum(v){ if(v==null) return null; const s=String(v).replace(",","."); const n=Number(s); return Number.isFinite(n)?n:null; }
function isNumericCol(rows, col){ return rows.some(r => toNum(r[col]) !== null); }
function pickHeader(headers, hint){
  // Busca coincidencia normalizada por contiene
  const H = norm(hint);
  let best = headers.find(h => norm(h) === H) || headers.find(h => norm(h).includes(H));
  if (best) return best;
  // Sinónimos comunes
  const syn = {
    NOMBRE:["NOMBRE","ESTUDIANTE","ALUMNO"],
    CURSO:["CURSO","GRADO","NIVEL"],
    PARALELO:["PARALELO","SECCION","SECCIÓN","GRUPO"],
    PROMEDIO:["PROMEDIO","NOTA","PUNTAJE","SCORE","CALIFICACION","CALIFICACIÓN","TOTAL"]
  };
  for (const k of Object.keys(syn)){
    if (syn[k].some(s => H.includes(norm(s)))) {
      best = headers.find(h => syn[k].some(s => norm(h).includes(norm(s))));
      if (best) return best;
    }
  }
  return null;
}
function mapToExistingHeader(headers, candidate){
  // candidate podría venir “Promedio habilidades interpersonales…”
  const N = norm(candidate);
  return (
    headers.find(h => norm(h) === N) ||
    headers.find(h => norm(h).includes(N)) ||
    headers.find(h => N.includes(norm(h))) || // por si el modelo devuelve una versión abreviada
    pickHeader(headers, candidate)
  );
}
function filterRows(rows, filters){
  // filters: [{column, op, value}]
  let out = rows;
  for (const f of (filters||[])){
    const { column, op="eq", value } = f;
    if (!column) continue;
    out = out.filter(r=>{
      const v = r[column];
      if (v == null) return false;
      const vn = norm(v), valn = norm(value);
      const num = toNum(v), valNum = toNum(value);
      switch(op){
        case "eq":   return vn === valn || v === value;
        case "like": return vn.includes(valn);
        case "gt":   return (num!=null && valNum!=null) ? (num > valNum) : false;
        case "gte":  return (num!=null && valNum!=null) ? (num >= valNum) : false;
        case "lt":   return (num!=null && valNum!=null) ? (num < valNum) : false;
        case "lte":  return (num!=null && valNum!=null) ? (num <= valNum) : false;
        default:     return true;
      }
    });
  }
  return out;
}
function sortRows(rows, sort){
  // sort: [{column, dir:'desc'|'asc'}]
  if (!Array.isArray(sort) || !sort.length) return rows;
  const s = sort[0];
  const col = s.column, dir = (s.dir||"desc").toLowerCase();
  const arr = [...rows];
  const numCol = isNumericCol(rows, col);
  arr.sort((a,b)=>{
    if (numCol){
      const A = toNum(a[col]) ?? -Infinity, B = toNum(b[col]) ?? -Infinity;
      return dir==="desc" ? (B-A) : (A-B);
    } else {
      const A = String(a[col]??""), B = String(b[col]??"");
      return dir==="desc" ? B.localeCompare(A) : A.localeCompare(B);
    }
  });
  return arr;
}
function projectRows(rows, select){
  if (!Array.isArray(select) || !select.length) return rows;
  return rows.map(r=>{ const o={}; for (const k of select){ o[k]=r[k]; } return o; });
}

// =============== GPT planner ===============
async function planWithLLM({ q, headers, sample }) {
  // Importante: usamos Responses API; el modelo lo pones con env LLM_MODEL
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");

  const model = process.env.LLM_MODEL || "gpt-5-thinking"; // ajusta al que tengas habilitado

  const system = [
    "Eres una analista de datos en español (México).",
    "Tu tarea es LEER la intención del usuario y devolver SOLO un JSON con el plan para operar sobre una tabla CSV del colegio.",
    "No digas frases como 'según el CSV'; evita asteriscos; no uses excusas.",
    "Si piden listas/listados/tablas de estudiantes: incluye 'intent':'table' y define 'select', 'filters', 'sort', 'limit'.",
    "Si piden ranking/orden: pon sort por la métrica adecuada (desc).",
    "Si piden 'décimo A/B': filtra por CURSO=DECIMO y PARALELO=A/B.",
    "Si piden una métrica (ej. AGRESIÓN, EMPATÍA, TIMIDEZ, AUTOESTIMA, PROMEDIO…): inclúyela en 'select' y también en 'sort', si procede.",
    "Si piden cálculos (promedios, correlaciones sencillas), añade 'calc' con { type, column(s) }.",
    "Responde SIEMPRE un objeto JSON válido, sin texto extra.",
    "Esquema:",
    "{ intent: 'table'|'summary'|'calc'|'unknown', select: [..], filters:[{column:'',op:'eq|like|gt|gte|lt|lte',value:''}], sort:[{column:'',dir:'desc|asc'}], limit: number, calc:{ type:'avg|sum|min|max|corr', columns:['colX','colY'] } }",
  ].join("\n");

  const prompt = [
    `Encabezados disponibles: ${JSON.stringify(headers)}`,
    `Muestra (5 filas): ${JSON.stringify(sample)}`,
    `Pregunta: ${q}`
  ].join("\n\n");

  const payload = {
    model,
    response_format: { type: "json_object" },
    input: [
      { role: "system", content: system },
      { role: "user", content: prompt }
    ]
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const jr = await r.json();
  const text = jr.output_text || jr.content?.[0]?.text || jr.choices?.[0]?.message?.content || "{}";
  let plan;
  try { plan = JSON.parse(text); } catch { plan = { intent: "unknown" }; }
  return plan;
}

// =============== HTTP Handler ===============
async function readCSVFromFsOrHttp(file, req){
  const fsPath = path.join(process.cwd(), "public", "datos", file);
  try { return await fs.readFile(fsPath, "utf8"); }
  catch {
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
    const proto = host.includes("localhost") ? "http" : "https";
    const url = `${proto}://${host}/datos/${encodeURIComponent(file)}`;
    const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status} al leer ${url}`);
    return await r.text();
  }
}

module.exports = async (req, res) => {
  const q = String(req.query?.q || "");
  const file = String(req.query?.file || "decimo.csv");
  const limit = Number(req.query?.limit || 200);

  try {
    // 1) Cargar CSV
    const raw = await readCSVFromFsOrHttp(file, req);
    const { headers, rows } = parseCSV(raw);
    if (!rows.length) return res.status(200).json({ rows: [], message: "No hay datos." });

    // 2) Pedir a GPT-5 un PLAN (no un texto) para operar sobre la tabla
    const sample = rows.slice(0, 5);
    const plan = await planWithLLM({ q, headers, sample });

    // 3) Normalizar columnas del plan a headers reales
    let select = (plan.select || []).map(c => mapToExistingHeader(headers, c)).filter(Boolean);
    let filters = (plan.filters || []).map(f => ({
      column: mapToExistingHeader(headers, f.column) || f.column,
      op: f.op || "eq",
      value: f.value
    })).filter(f => f.column);
    let sort = (plan.sort || []).map(s => ({
      column: mapToExistingHeader(headers, s.column) || s.column,
      dir: s.dir || "desc"
    })).filter(s => s.column);

    // Heurísticas extra por si no vino nada claro:
    // décimo a/b
    const qlow = q.toLowerCase();
    const colCurso = mapToExistingHeader(headers, "Curso");
    const colPar   = mapToExistingHeader(headers, "Paralelo");
    if ((/d[eé]cimo|decimo/).test(qlow) && colCurso) filters.push({ column: colCurso, op:"like", value:"DECIMO" });
    const mPar = qlow.match(/\b(paralelo|secci[oó]n|grupo)\s*([ab])\b/i) || qlow.match(/d[eé]cimo\s*([ab])\b/i);
    if (mPar && colPar) filters.push({ column: colPar, op:"eq", value: mPar[2]?.toUpperCase?.() || mPar[1]?.toUpperCase?.() });

    // métrica típica si piden ranking/orden
    const wantsRanking = /(ranking|mayor a menor|ordenar|top|rank)/.test(qlow);
    if (!sort.length && wantsRanking){
      // busca un candidato de métrica
      const metricHints = ["Calificación","CALIFICACION","Calificacion","Promedio","Nota","Puntaje","Score","Total","AGRESIÓN","AGRESION","EMPATÍA","EMPATIA"];
      const metric = headers.find(h => metricHints.some(w => norm(h).includes(norm(w))));
      if (metric) sort = [{ column: metric, dir: "desc" }];
    }

    // 4) Ejecutar el plan sobre TODA la tabla
    let data = filterRows(rows, filters);
    if (sort.length) data = sortRows(data, sort);
    if (!select.length) {
      // Si piden listas/tablas de estudiantes, prioriza nombre + métrica(s)
      const colNombre = mapToExistingHeader(headers, "Nombre") || headers[0];
      const metric = sort[0]?.column || headers.find(h => isNumericCol(data, h)) || null;
      select = [colNombre];
      if (metric && !select.includes(metric)) select.push(metric);
      if (colPar && !select.includes(colPar)) select.push(colPar);
      if (colCurso && !select.includes(colCurso)) select.push(colCurso);
    }
    data = projectRows(data, select);
    data = data.slice(0, Number.isFinite(limit) ? limit : 200);

    // 5) Cálculos opcionales (promedio/corr simples)
    let calcResult = null;
    if (plan.calc && plan.calc.type && Array.isArray(plan.calc.columns)) {
      const cols = plan.calc.columns.map(c => mapToExistingHeader(headers, c)).filter(Boolean);
      const type = plan.calc.type;
      if (type === "avg" && cols[0]) {
        const arr = rows.map(r => toNum(r[cols[0]])).filter(n => n!=null);
        const avg = arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
        calcResult = { type, column: cols[0], value: avg };
      }
      if (type === "corr" && cols[0] && cols[1]) {
        const xs = rows.map(r => toNum(r[cols[0]])).filter(n => n!=null);
        const ys = rows.map(r => toNum(r[cols[1]])).filter(n => n!=null);
        const n = Math.min(xs.length, ys.length);
        if (n>1){
          const x = xs.slice(0,n), y = ys.slice(0,n);
          const mx = x.reduce((a,b)=>a+b,0)/n, my = y.reduce((a,b)=>a+b,0)/n;
          let num=0, dx=0, dy=0;
          for (let i=0;i<n;i++){ const X=x[i]-mx, Y=y[i]-my; num+=X*Y; dx+=X*X; dy+=Y*Y; }
          const r = (dx>0 && dy>0) ? (num/Math.sqrt(dx*dy)) : null;
          calcResult = { type, columns: [cols[0], cols[1]], r };
        }
      }
    }

    // 6) Mensaje resumido para TTS (sin asteriscos, sin “según el CSV”)
    //   *El texto detallado lo arma GPT; aquí generamos uno neutro y corto para la locución.*
    let tts = "";
    if (data.length) {
      const colNames = Object.keys(data[0]);
      const metricName = colNames.find(k => isNumericCol(data, k) && norm(k)!==norm(colNames[0])) || colNames[1] || "";
      if (wantsRanking && metricName) {
        tts = `Mostrando ${data.length} estudiantes ordenados por ${metricName}.`;
      } else {
        tts = `Mostrando ${data.length} resultados.`;
      }
    } else {
      tts = "No encontré resultados con esos criterios.";
    }
    if (calcResult && calcResult.type === "avg") {
      if (toNum(calcResult.value) != null) tts += ` Promedio de ${calcResult.column}: ${calcResult.value.toFixed(2)}.`;
    }
    if (calcResult && calcResult.type === "corr" && calcResult.r != null) {
      tts += ` Correlación entre ${calcResult.columns[0]} y ${calcResult.columns[1]}: ${calcResult.r.toFixed(3)}.`;
    }

    // 7) Responder al front
    res.setHeader("Content-Type","application/json; charset=utf-8");
    return res.status(200).json({
      rows: data,
      speak: tts,
      plan, // útil para depurar (qué entendió GPT-5)
    });

  } catch (err) {
    console.error("ask.js error:", err);
    return res.status(200).json({
      error: true,
      message: "No se encontró respuesta (backend)",
      details: err?.message
    });
  }
};
