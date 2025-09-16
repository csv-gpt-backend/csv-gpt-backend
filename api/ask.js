// api/ask.js — Serverless Node + CORS + GPT-5 razonando sobre tu CSV
// Requisitos en Vercel (Settings → Environment Variables):
//   OPENAI_API_KEY = tu_api_key

const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

let CACHE = null; // { rows, headersRaw, headersNorm, filePath }

const norm = s => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();
const toNumber = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const detectDelimiter = first =>
  ((first.match(/;/g)||[]).length > (first.match(/,/g)||[]).length) ? ';' : ',';

// Lee CSV y guarda dos juegos de headers: crudos (para humanos) y normalizados (para lookup)
function parseCSV(text){
  const lines = text.replace(/\r/g,'').trim().split('\n');
  if (!lines.length) return { rows: [], headersRaw: [], headersNorm: [] };

  const delim = detectDelimiter(lines[0] || '');
  const headersRaw = (lines[0] || '').split(delim).map(h => h.trim());
  const headersNorm = headersRaw.map(norm);

  const rows = [];
  for (let i = 1; i < lines.length; i++){
    const line = lines[i];
    if (!line?.trim()) continue;
    const cols = line.split(delim);
    const row = {};
    for (let j = 0; j < headersNorm.length; j++){
      row[headersNorm[j]] = (cols[j] ?? '').trim();
    }
    rows.push(row);
  }
  return { rows, headersRaw, headersNorm };
}

function loadOnce(){
  if (CACHE) return CACHE;
  const candidates = [
    path.join(__dirname, 'data.csv'),      // /api/data.csv
    path.join(__dirname, '..', 'data.csv') // /data.csv (raíz)
  ];
  for (const fp of candidates){
    if (fs.existsSync(fp)){
      const txt = fs.readFileSync(fp, 'utf8');
      const parsed = parseCSV(txt);
      CACHE = { ...parsed, filePath: fp };
      return CACHE;
    }
  }
  CACHE = { rows: [], headersRaw: [], headersNorm: [], filePath: null };
  return CACHE;
}

function setCORS(res, origin='*'){
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

// Convierte cada fila a objeto con claves "humanas" (headersRaw) y castea números
function buildRowsForLLM(rows, headersRaw, headersNorm){
  const out = [];
  for (const r of rows){
    const obj = {};
    for (let i = 0; i < headersRaw.length; i++){
      const keyRaw  = headersRaw[i];
      const keyNorm = headersNorm[i];
      const val = r[keyNorm];
      const n = toNumber(val);
      obj[keyRaw] = Number.isFinite(n) ? n : val;
    }
    out.push(obj);
  }
  return out;
}

// Llama a OpenAI Responses API con GPT-5 para razonar sobre los datos
async function askGPT5(question, table){
  if (!OPENAI_API_KEY) {
    return { error: 'Falta OPENAI_API_KEY en Vercel > Settings > Environment Variables.' };
  }

  // Compactamos los datos (50 filas está perfecto para enviar tal cual)
  const dataForLLM = buildRowsForLLM(table.rows, table.headersRaw, table.headersNorm);

  const system = [
    'Eres un analista de datos experto. Responde SIEMPRE en español.',
    'Usa únicamente la tabla proporcionada; si algo no está en los datos, dilo claramente.',
    'Razona con rigor lógico y matemático; muestra cálculos clave resumidos (promedios, conteos, %).',
    'Redondea a 2 decimales cuando ayude; indica el tamaño de muestra (n).',
  ].join(' ');

  const user = [
    `Pregunta: ${question}`,
    `Columnas: ${JSON.stringify(table.headersRaw)}`,
    `Filas: ${dataForLLM.length}`,
    `Datos (JSON por fila):`,
    JSON.stringify(dataForLLM)
  ].join('\n');

  const payload = {
    model: 'gpt-5-mini',   // puedes subir a 'gpt-5' si quieres más capacidad
    input: [
      { role: 'system', content: system },
      { role: 'user',   content: user   }
    ],
    max_output_tokens: 800,
    temperature: 0.1
  };

  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const body = await r.json();
  const text = body.output_text
            || body.content?.map?.(p => p?.text)?.filter(Boolean)?.join('\n')
            || body.choices?.[0]?.message?.content
            || JSON.stringify(body);

  if (!r.ok) return { error: `OpenAI HTTP ${r.status}: ${text}` };
  return { text };
}

module.exports = async (req, res) => {
  setCORS(res, req.headers.origin || '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = String(req.query.q || '').trim();
  if (!q) return res.status(200).json({ respuesta: 'Escribe tu pregunta. Pruebas: ping, diag' });
  if (q.toLowerCase() === 'ping') return res.status(200).json({ ok: true });

  const data = loadOnce();
  if (q.toLowerCase() === 'diag') {
    return res.status(200).json({
      file: data.filePath,
      rows: data.rows.length,
      headers: data.headersRaw.length ? data.headersRaw : data.headersNorm
    });
  }
  if (!data.filePath)   return res.status(404).json({ error: 'No encontré data.csv (ponlo en /api/data.csv o /data.csv).' });
  if (!data.rows.length) return res.status(404).json({ error: 'data.csv está vacío o sin filas válidas.' });

  try {
    const out = await askGPT5(q, data);
    if (out.error) return res.status(502).json({ error: out.error });
    return res.status(200).json({ respuesta: out.text });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
