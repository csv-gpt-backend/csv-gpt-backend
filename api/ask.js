// api/ask.js
// Si activarlo te daba problema en Vercel, puedes dejar comentado:
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;
const MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const CSV_PATH = process.env.CSV_FILE || path.join(process.cwd(), 'datos', 'decimo.csv');

// --- utils
function readCsvSnapshot() {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = (lines[0] || '').split(';').map(s => s.trim()); // tu CSV usa ;
    const preview = raw.slice(0, 200000);
    return { ok: true, header, preview };
  } catch (e) {
    return { ok: false, header: [], preview: '' };
  }
}

function extractJson(text) {
  if (!text) return null;
  // 1) ¿texto ya es JSON?
  try { return JSON.parse(text); } catch {}
  // 2) ¿hay bloque ```json ... ```?
  const m = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (m?.[1]) {
    try { return JSON.parse(m[1]); } catch {}
  }
  // 3) ¿hay algo que parezca { ... } ?
  const m2 = text.match(/\{[\s\S]*\}/);
  if (m2) {
    try { return JSON.parse(m2[0]); } catch {}
  }
  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
    }
    if (!OPENAI_KEY) {
      return res.status(200).json({
        texto: 'Falta la clave de OpenAI (open_ai_key). Configúrala en Vercel.',
        tablas_markdown: ''
      });
    }

    const { question } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(200).json({ texto: 'Por favor, escribe una pregunta.', tablas_markdown: '' });
    }
    const q = question.trim();

    const { ok, header, preview } = readCsvSnapshot();
    const headerNote = header.length
      ? `Encabezados reales del CSV (${header.length} columnas; separador ";"): ${header.join(' | ')}`
      : `No pude leer el CSV.`;

    const system = `Eres una analista educativa rigurosa, responde SIEMPRE en español latino neutral.
Reglas DURAS:
- Si el usuario pide "todos los estudiantes", debes listar a TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas solicitadas por el usuario (el CSV usa ; como separador).
- Presenta LISTAS/TABLAS en formato Markdown (| Col | ... |). Nada de asteriscos.
- Devuelve SOLO un JSON con estas claves: {"texto": "...", "tablas_markdown": "..."}.
- Si no corresponde tabla, "tablas_markdown" debe ser cadena vacía.
- Si no puedes calcular algo, explica por qué y ofrece alternativas (siempre en "texto").`;

    const user = ok
      ? `PREGUNTA: "${q}"

${headerNote}

TROZO DEL CSV (representativo):
"""${preview}"""

Formatea la salida EXCLUSIVAMENTE así:
{"texto":"...","tablas_markdown":"..."}`
      : `PREGUNTA: "${q}"

${headerNote}

No pude leer el CSV. Responde igual con explicación o guía en "texto".
Formatea la salida EXCLUSIVAMENTE así:
{"texto":"...","tablas_markdown":""}`;

    const client = new OpenAI({ apiKey: OPENAI_KEY });

    // GPT-5 no admite temperature distinto de 1. Armamos payload según modelo.
    const isGpt5 = /^gpt-5\b/i.test(MODEL);
    const payload = {
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
    };
    if (isGpt5) {
      payload.temperature = 1;
      payload.max_completion_tokens = 900; // margen suficiente
    } else {
      payload.temperature = 0.2;
      // NO forzamos response_format para permitir fallback con texto crudo
    }

    const completion = await client.chat.completions.create(payload);

    const raw = completion?.choices?.[0]?.message?.content || '';
    // Log útil en Vercel para depurar si vuelve a pasar:
    console.log('[ASK][MODEL]', MODEL);
    console.log('[ASK][RAW]', raw.slice(0, 4000));

    // Intentamos extraer JSON; si no, usamos texto crudo
    let parsed = extractJson(raw);
    let texto = '';
    let tablas_markdown = '';

    if (parsed && (typeof parsed.texto === 'string' || typeof parsed.tablas_markdown === 'string')) {
      texto = String(parsed.texto || '').replace(/\*/g,'').trim();
      tablas_markdown = String(parsed.tablas_markdown || '').trim();
    } else {
      // No hubo JSON utilizable: devolvemos el texto crudo
      texto = (raw && raw.trim()) ? raw.trim() : '';
      tablas_markdown = '';
    }

    // Último seguro: nunca mandar vacío
    if (!texto) {
      texto = 'El modelo no devolvió contenido utilizable en este intento. Intenta con una pregunta más específica, o vuelve a consultar en unos segundos.';
      tablas_markdown = '';
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ texto, tablas_markdown });

  } catch (err) {
    console.error('ASK ERROR:', err?.message || err);
    return res.status(200).json({
      texto: `Error: ${err?.message || 'Desconocido'}.`,
      tablas_markdown: ''
    });
  }
}
