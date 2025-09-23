// api/ask.js
// (Si al activarlo te da problemas, puedes dejar comentado)
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

// ------------ ENV / RUTAS
const OPENAI_KEY =
  process.env.open_ai_key ||
  process.env.OPENAI_API_KEY;

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CSV_PATH = process.env.CSV_FILE || path.join(process.cwd(), 'datos', 'decimo.csv');
// (Opcional) TXT auxiliar de notas si lo tienes en la raíz:
const TXT_PATH = path.join(process.cwd(), 'emocionales.txt');

// ------------ CLIENTE
const client = new OpenAI({ apiKey: OPENAI_KEY });

// ------------ UTILIDADES
const PREVIEW_CHARS = 30000; // ~30k chars para no saturar y bajar latencia

function readCsvSnapshot() {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = (lines[0] || '').split(/[;,]/).map(s => s.trim()); // soporta ; y ,
    const preview = raw.slice(0, PREVIEW_CHARS);
    return { ok: true, header, preview };
  } catch {
    return { ok: false, header: [], preview: '' };
  }
}

function readTxtSnapshot() {
  try {
    const raw = fs.readFileSync(TXT_PATH, 'utf8');
    return { ok: true, preview: raw.slice(0, PREVIEW_CHARS) };
  } catch {
    return { ok: false, preview: '' };
  }
}

function isGpt5Model(m) {
  return /^gpt-5/i.test(m) || /^gpt-5/.test(m);
}

function hasMarkdownTable(s) {
  if (!s) return false;
  return /\|.+\|/.test(s) && /\n\|[:\- ]+\|/.test(s);
}

// Reintento simple (1 vez) si hay fallo transitorio
async function callModelWithRetry(params, isGpt5) {
  try {
    return await client.chat.completions.create(params);
  } catch (e) {
    // 1 reintento
    return await client.chat.completions.create(params);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res
        .status(405)
        .json({ error: 'Método no permitido. Usa POST con JSON.' });
    }

    if (!OPENAI_KEY) {
      return res.status(200).json({
        texto:
          'Falta la clave de OpenAI (open_ai_key). Configúrala en Vercel.',
        tablas_markdown: ''
      });
    }

    const { question } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res
        .status(200)
        .json({ texto: 'Por favor, escribe una pregunta.', tablas_markdown: '' });
    }
    const q = question.trim();

    const { ok: csvOk, header, preview: csvPreview } = readCsvSnapshot();
    const { ok: txtOk, preview: txtPreview } = readTxtSnapshot();

    const headerNote = csvOk
      ? `Encabezados reales del CSV (${header.length} columnas): ${header.join(' | ')}`
      : `No pude leer el CSV.`;

    // ------------ PROMPTS
    const system = `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas DURAS:
- Si el usuario pide "todos los estudiantes", debes listar a TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas solicitadas por el usuario. Si pide varias columnas, inclúyelas todas.
- Presenta las LISTAS/TABLAS en formato Markdown (| Col | ... |) cuando aplique.
- Numera filas implícitamente (la UI agregará la columna #).
- Si no puedes cumplir con JSON válido, responde exactamente: {"texto":"<explicación en español>","tablas_markdown":""}
- No uses asteriscos para resaltar (la UI los elimina).`;

    const user = csvOk
      ? `PREGUNTA: "${q}"

${headerNote}

TROZO DEL CSV (representativo, no todo):
"""${csvPreview}"""

${txtOk ? `Notas/Texto adicional:
"""${txtPreview}"""` : ''}

Instrucciones de salida:
1) "texto": explicación clara en español (sin asteriscos).
2) "tablas_markdown": si el usuario pidió listas/tablas, entrega TABLA en Markdown con TODAS las filas solicitadas y las columnas exactas; si pidió "todos", no omitas ninguno. Si no aplica tabla, deja vacío.

Devuelve SOLO un JSON con {"texto": "...", "tablas_markdown": "..."}.`
      : `PREGUNTA: "${q}"

${headerNote}

No pude leer CSV. Explica o guía al usuario con lo que sepas, en texto claro. 
Si requiere tabla pero no hay datos, indícalo.
Devuelve SOLO un JSON {"texto":"...","tablas_markdown":""}.`;

    // ------------ LLAMADA AL MODELO
    const g5 = isGpt5Model(MODEL);

    const params = g5
      ? {
          model: MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          temperature: 1,             // GPT-5 solo 1
          max_completion_tokens: 1000 // GPT-5 usa este campo
        }
      : {
          model: MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' }
        };

    const completion = await callModelWithRetry(params, g5);

    let raw = completion?.choices?.[0]?.message?.content ?? '';
    console.log('[ASK][RAW]', (raw || '').slice(0, 500)); // log parcial para debug

    // ------------ PARSEO ROBUSTO
    let texto = '';
    let tablas_markdown = '';

    try {
      const parsed = JSON.parse(raw);
      texto = String(parsed.texto || parsed.text || '').replace(/\*/g, '').trim();
      tablas_markdown = String(
        parsed.tablas_markdown || parsed.tables_markdown || ''
      ).trim();
    } catch {
      // Si no vino JSON, intenta rescatar tabla Markdown del texto crudo
      const t = String(raw || '').trim();
      if (hasMarkdownTable(t)) {
        // texto previo sin la tabla (simple)
        const tableMatch = t.match(/\|.*\n\|[:\- ]+\|.*\n[\s\S]+/);
        tablas_markdown = tableMatch ? tableMatch[0].trim() : '';
        texto = t.replace(tablas_markdown, '').trim();
      } else {
        texto = t;
      }
    }

    if (!texto && !tablas_markdown) {
      texto =
        'El modelo no devolvió contenido utilizable en este intento. Intenta con una pregunta más específica o vuelve a consultar en unos segundos.';
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ texto, tablas_markdown });
  } catch (err) {
    console.error('ASK ERROR:', err?.message || err);
    return res.status(200).json({
      texto: `Ocurrió un error al procesar: ${err?.message || 'Desconocido'}.`,
      tablas_markdown: ''
    });
  }
}
