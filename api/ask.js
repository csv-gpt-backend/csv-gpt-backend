// api/ask.js — Serverless Node (CommonJS) + CORS + GPT-5 sobre tu CSV
// Requiere en Vercel: OPENAI_API_KEY (Settings → Environment Variables)

const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

let CACHE = null; // { rows, headersRaw, headersNorm, filePath }

const norm = s => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();
const toNum = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const detectDelimiter = first => ((first.match(/;/g)||[]).length > (first.match(/,/g)||[]).length) ? ';' : ',';

function parseCSV(text){
  const lines = text.replace(/\r/g,'').trim().split('\n');
  if (!lines.length) return { rows: [], headersRaw: [], headersNorm: [] };
  const delim = detectDelimiter(lines[0] || '');
  const headersRaw = (lines[0] || '').split(delim).map(h => h.trim());
  const headersNorm = headersRaw.map(norm);
  const rows = [];
  for (let i=1;i<lines.length;i++){
    const line = lines[i]; if (!line?.trim()) continue;
    const cols = line.split(delim);
    const r = {};
    for (let j=0;j<headersNorm.length;j++) r[headersNorm[j]] = (cols[j] ?? '').trim();
    rows.push(r);
  }
  return { rows, headersRaw, headersNorm };
}

function loadOnce(){
  if (CACHE) return CACHE;
  const candidates = [
    path.join(__dirname, 'data.csv'),      // /api/data.csv
    path.join(__dirname, '..', 'data.csv') // /data.csv
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
  res.setHeader('Access-Control-Allow-Origin', origin); // pon tu dominio de Wix cuando quede estable
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

// Convierte cada fila a objeto con claves "humanas" y castea números
function buildRowsForLLM(rows, headersRaw, headersNorm){
  const out = [];
  for (const r of rows){
    const obj = {};
    for (let i=0;i<headersRaw.length;i++){
      const keyRaw = headersRaw[i], keyNorm = headersNorm[i];
      const n = toNum(r[keyNorm]);
      obj[keyRaw] = Number.isFinite(n) ? n : r[keyNorm];
    }
    out.push(obj);
  }
  return out;
}

async function askOpenAI(question, table){
  if (!OPENAI_API_KEY) return { error: 'OPENAI_API_KEY no configurada en Vercel.' };

  const dataForLLM = buildRowsForLLM(table.rows, table.headersRaw, table.headersNorm);

  const system = [
    'Eres un analista de datos experto y respondes SIEMPRE en español.',
    'Usa únicamente la tabla proporcionada; si faltan datos, dilo.',
    'Aplica razonamiento lógico y matemático: promedios, conteos, porcentajes, rankings, comparaciones.',
    'Muestra los cálculos clave de forma breve y cita el tamaño de muestra (n).',
    'Redondea a 2 decimales cuando sea útil.'
  ].join(' ');

  const user = [
    `Pregunta: ${question}`,
    `Columnas: ${JSON.stringify(table.headersRaw.length ? table.headersRaw : table.headersNorm)}`,
    `Filas: ${dataForLLM.length}`,
    `Datos (JSON por fila):`,
    JSON.stringify(dataForLLM)
  ].join('\n');

  const payload = {
    model: 'gpt-5-mini',          // si prefieres más capacidad, usa 'gpt-5'
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

  const body = await r.json().catch(()=> ({}));
  const text = body?.output_text
            || body?.content?.map?.(p => p?.text)?.filter(Boolean)?.join('\n')
            || body?.choices?.[0]?.message?.content
            || (body?.error ? `${body.error.type || ''}: ${body.error.message || ''}` : '');

  if (!r.ok) return { error: `OpenAI HTTP ${r.status} ${r.statusText} — ${text || JSON.stringify(body)}` };
  if (!text)   return { error: `OpenAI respondió sin texto utilizable: ${JSON.stringify(body)}` };
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
    const out = await askOpenAI(q, data);
    if (out.error) return res.status(502).json({ error: out.error });
    return res.status(200).json({ respuesta: out.text });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
