// api/ask.js
// export const config = { runtime: 'nodejs20.x' }; // descomenta si lo necesitas

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;
const MODEL = (process.env.OPENAI_MODEL || 'gpt-5-mini').trim();

// Rutas de datos
const CSV_PATH = path.join(process.cwd(), 'datos', 'decimo.csv');   // CSV con ';'
const TXT_EMOCIONAL = path.join(process.cwd(), 'emocional.txt');    // TXT en RAÍZ

const client = new OpenAI({ apiKey: OPENAI_KEY });

// ---------- Helpers de IO ----------
function readCsvSnapshot(maxChars = 80000) {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = (lines[0] || '').split(';').map(s => s.trim()); // separador ;
    return { ok: true, header, preview: raw.slice(0, maxChars) };
  } catch (e) {
    console.error('CSV READ ERROR:', e?.message || e);
    return { ok: false, header: [], preview: '' };
  }
}

function readTxt(filepath, maxChars = 80000) {
  try {
    if (fs.existsSync(filepath)) {
      const raw = fs.readFileSync(filepath, 'utf8');
      return raw.slice(0, maxChars);
    }
  } catch (e) {
    console.error('TXT READ ERROR:', filepath, e?.message || e);
  }
  return '';
}

// ---------- Parseo robusto del JSON de salida ----------
function safeParseToObj(s) {
  if (!s || typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch {}
  const fenced = s.match(/```json([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const braced = s.match(/\{[\s\S]*\}/);
  if (braced) { try { return JSON.parse(braced[0]); } catch {} }
  return null;
}

// Llamada al modelo con compatibilidad GPT-5 vs otros
async function callModel({ modelId, system, user }) {
  const isG5 = /^gpt-5/i.test(modelId);
  const base = {
    model: modelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user }
    ]
  };
  const opts = isG5
    ? { ...base, temperature: 1,   max_completion_tokens: 900 }
    : { ...base, temperature: 0.2, max_tokens: 900 };

  const resp = await client.chat.completions.create(opts);
  let raw = resp?.choices?.[0]?.message?.content || resp?.choices?.[0]?.message?.refusal || '';
  return raw;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
    }
    if (!OPENAI_KEY) {
      return res.status(200).json({
        texto: 'Falta la clave de OpenAI (open_ai_key / OPENAI_API_KEY). Configúrala en Vercel.',
        tablas_markdown: ''
      });
    }

    const { question } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(200).json({ texto: 'Por favor, escribe una pregunta.', tablas_markdown: '' });
    }
    const q = question.trim();

    // Lee CSV y TXT (recortados para velocidad)
    const { ok, header, preview } = readCsvSnapshot(80000);
    const emocionalTxt = readTxt(TXT_EMOCIONAL, 80000);

    const headerNote = ok
      ? `Encabezados reales del CSV (${header.length}): ${header.join(' | ')}`
      : `No pude leer el CSV.`;

    // ---------- Prompts ----------
    const system =
`Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas:
- El CSV usa ';' como delimitador.
- Si piden "todos los estudiantes", incluye TODOS (no omitas filas).
- Usa EXACTAMENTE las columnas solicitadas (Nombre, Empatía, etc.).
- Cuando la petición requiera listas/tablas, devuelve TABLA en Markdown (| Col | ... |).
- No uses asteriscos para formato.
- Si hay contenido en "emocional.txt", úsalo para responder preguntas relacionadas a evaluaciones emocionales/psicométricas.`;

    let user =
`PREGUNTA: "${q}"

${headerNote}

TROZO REPRESENTATIVO DEL CSV (recortado para rendimiento):
"""${preview}"""`;

    if (emocionalTxt) {
      user += `

CONTENIDO DEL ARCHIVO emocional.txt (recortado):
"""${emocionalTxt}"""`;
    }

    user += `

FORMATO DE SALIDA (OBLIGATORIO, SOLO JSON):
{
  "texto": "explicación clara en español (sin asteriscos)",
  "tablas_markdown": "si aplica, tabla Markdown con TODAS las filas/columnas exactas pedidas; si no aplica, string vacío"
}`;

    // ---------- 1º intento con el modelo configurado ----------
    let raw = await callModel({ modelId: MODEL, system, user });
    let parsed = safeParseToObj(raw);

    // ---------- Fallback a gpt-4o-mini si no vino JSON limpio ----------
    if (!parsed || typeof parsed !== 'object') {
      try {
        const fallback = 'gpt-4o-mini';
        raw = await callModel({ modelId: fallback, system, user });
        parsed = safeParseToObj(raw) || { texto: String(raw || 'Sin contenido.'), tablas_markdown: '' };
      } catch (e) {
        console.error('Fallback error:', e?.message || e);
      }
    }

    const texto = String(parsed?.texto || parsed?.text || '').replace(/\*/g, '').trim();
    const tablas_markdown = String(parsed?.tablas_markdown || parsed?.tables_markdown || '').trim();

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      texto: texto || 'No obtuve respuesta del modelo.',
      tablas_markdown: tablas_markdown || ''
    });

  } catch (err) {
    console.error('ASK ERROR:', err?.message || err);
    return res.status(200).json({
      texto: `Ocurrió un error interno: ${err?.message || 'Desconocido.'}`,
      tablas_markdown: ''
    });
  }
}
