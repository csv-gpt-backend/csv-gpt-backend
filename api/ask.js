// api/ask.js — Serverless Node + CORS + GPT-5 razonando sobre tu CSV
// Requiere en Vercel una env var con tu clave (cualquiera de estas):
// OPENAI_API_KEY / OPENAI_KEY / CLAVE_API_DE_OPENAI / OPENAI_API

const fs = require('fs');
const path = require('path');

const BUILD_TAG = 'gpt5-v2-2025-09-16';

// ==== detectar API key (aceptamos varios nombres) ====
const ENV_KEYS = ['OPENAI_API_KEY','OPENAI_KEY','CLAVE_API_DE_OPENAI','OPENAI_API','API_KEY'];
let USED_ENV = null;
function pickKey() {
  for (const k of ENV_KEYS) {
    const v = process.env[k];
    if (v && String(v).trim()) { USED_ENV = k; return String(v).trim(); }
  }
  return '';
}
const OPENAI_API_KEY = pickKey();

// ==== utilidades CSV ====
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
  res.setHeader('Access-Control-Allow-Origin', origin); // luego cámbialo por tu dominio Wix
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

// Prepara filas para el LLM con claves humanas y números casteados
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

// ==== llamada a GPT-5 (Responses API) ====
async function askOpenAI(question, table){
  if (!OPENAI_API_KEY) return { error: `No encuentro tu API key. Define una env var: ${ENV_KEYS.join(' / ')}` };

  const payload = {
    model: 'gpt-5-mini', // cambia a 'gpt-5' si quieres más capacidad
    input: [
      { role: 'system', content:
        'Eres un analista de datos experto. Responde SIEMPRE en español. ' +
        'Usa únicamente la tabla proporcionada; si faltan datos, dilo. ' +
        'Razona con rigor lógico y matemático: promedios, conteos, %,' +
        ' rankings y comparaciones según corresponda. ' +
        'Incluye los números clave (n, medias, etc.) y redondea a 2 decimales.'
      },
      { role: 'user', content:
        [
          `Pregunta: ${question}`,
          `Columnas: ${JSON.stringify(table.headersRaw.length ? table.headersRaw : table.headersNorm)}`,
          `Filas: ${table.rows.length}`,
          'Datos (JSON por fila):',
          JSON.stringify(buildRowsForLLM(table.rows, table.headersRaw, table.headersNorm))
        ].join('\n')
      }
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

// ==== handler ====
module.exports = async (req, res) => {
  setCORS(res, req.headers.origin || '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = String(req.query.q || '').trim();

  // endpoints de diagnóstico sencillos
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
  if (!data.filePath)   return res.status(404).json({ error: 'No encontré data.csv (colócalo en /api/data.csv o /data.csv).' });
  if (!data.rows.length) return res.status(404).json({ error: 'data.csv está vacío o sin filas válidas.' });

  try {
    const out = await askOpenAI(q, data);
    if (out.error) return res.status(502).json({ error: out.error });
    return res.status(200).json({ respuesta: out.text });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
};
