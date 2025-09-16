// api/ask_gpt.js — CSV → GPT-5 (Responses API) con CORS
// Env var aceptadas (usa una): OPENAI_API_KEY / OPENAI_KEY / OPENAI_API / CLAVE_API_DE_OPENAI / API_KEY

const fs = require('fs');
const path = require('path');

const BUILD_TAG = 'gpt5-only-2025-09-16';

// --- API key (acepta varios nombres) ---
const ENV_KEYS = ['OPENAI_API_KEY','OPENAI_KEY','OPENAI_API','CLAVE_API_DE_OPENAI','API_KEY'];
let USED_ENV = null;
function pickKey(){
  for (const k of ENV_KEYS){
    const v = process.env[k];
    if (v && String(v).trim()){ USED_ENV = k; return String(v).trim(); }
  }
  return '';
}
const OPENAI_API_KEY = pickKey();

// --- utilidades CSV ---
const norm = s => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toUpperCase().trim();
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
    const cols = line.split(delim); // suficiente para CSV simple
    const r = {};
    for (let j=0;j<headersNorm.length;j++) r[headersNorm[j]] = (cols[j] ?? '').trim();
    rows.push(r);
  }
  return { rows, headersRaw, headersNorm };
}

let CACHE = null; // { rows, headersRaw, headersNorm, filePath }
function loadOnce(){
  if (CACHE) return CACHE;
  const candidates = [
    path.join(__dirname, 'data.csv'),      // /api/data.csv
    path.join(__dirname, '..', 'data.csv') // /data.csv
  ];
  for (const fp of candidates){
    if (fs.existsSync(fp)){
      const txt = fs.readFileSync(fp, 'utf8');
      CACHE = { ...parseCSV(txt), filePath: fp };
      return CACHE;
    }
  }
  CACHE = { rows: [], headersRaw: [], headersNorm: [], filePath: null };
  return CACHE;
}

function setCORS(res, origin='*'){
  res.setHeader('Access-Control-Allow-Origin', origin); // luego limita a tu dominio Wix
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function buildRowsForLLM(rows, headersRaw, headersNorm){
  const out = [];
  for (const r of rows){
    const o = {};
    for (let i=0;i<headersRaw.length;i++){
      const raw = headersRaw[i], key = headersNorm[i];
      const n = toNum(r[key]);
      o[raw] = Number.isFinite(n) ? n : r[key];
    }
    out.push(o);
  }
  return out;
}

async function askOpenAI(question, table, formatPref){
  if (!OPENAI_API_KEY) return { error: `Falta API key. Usa una de: ${ENV_KEYS.join(' / ')}` };

  const dataForLLM = buildRowsForLLM(table.rows, table.headersRaw, table.headersNorm);

  const system = [
    'Eres un analista de datos experto y SIEMPRE respondes en español.',
    'Usa solo la tabla proporcionada; si algo no está en los datos, dilo.',
    'Razona con rigor (promedios, conteos, %, rankings, comparaciones).',
    'Incluye tamaño de muestra (n) y redondea a 2 decimales cuando ayude.'
  ].join(' ');

  const user = [
    `Pregunta: ${question}`,
    `Columnas: ${JSON.stringify(table.headersRaw.length ? table.headersRaw : table.headersNorm)}`,
    `Filas: ${dataForLLM.length}`,
    (formatPref === 'tabla'
      ? 'Devuelve una tabla Markdown cuando aplique y un breve comentario.'
      : 'Responde en texto claro; usa viñetas si ayuda.'
    ),
    'Datos (JSON por fila):',
    JSON.stringify(dataForLLM)
  ].join('\n');

  const payload = {
    model: 'gpt-5-mini', // o 'gpt-5'
    input: [
      { role: 'system', content: system },
      { role: 'user',   content: user   }
    ],
    max_output_tokens: 900,
    temperature: 0.1
  };

  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
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
  const format = String(req.query.format || '').trim().toLowerCase(); // ?format=tabla

  if (!q)                      return res.status(200).json({ respuesta: 'Escribe tu pregunta. Pruebas: ping, diag, env, version' });
  if (q.toLowerCase() === 'ping')    return res.status(200).json({ ok: true });
  if (q.toLowerCase() === 'version') return res.status(200).json({ build: BUILD_TAG });
  if (q.toLowerCase() === 'env')     return res.status(200).json({ openai_key_present: Boolean(OPENAI_API_KEY), using_env_name: USED_ENV || null });

  const data = loadOnce();
  if (q.toLowerCase() === 'diag') {
    return res.status(200).json({
      file: data.filePath,
      rows: data.rows.length,
      headers: data.headersRaw.length ? data.headersRaw : data.headersNorm
    });
  }

  if (!data.filePath)    return res.status(404).json({ error: 'No encontré data.csv (ponlo en /api/data.csv o /data.csv).' });
  if (!data.rows.length) return res.status(404).json({ error: 'data.csv está vacío o sin filas válidas.' });

  try {
    const out = await askOpenAI(q, data, format);
    if (out.error) return res.status(502).json({ error: out.error });
    return res.status(200).json({ respuesta: out.text });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
