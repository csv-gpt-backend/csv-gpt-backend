// api/ask.js
// Si al activarlo te da problemas en Vercel, déjalo comentado.
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY =
  process.env.open_ai_key ||
  process.env.OPENAI_API_KEY ||
  process.env['CLAVE API DE OPENAI'];

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// CSV local: /datos/decimo.csv
const CSV_PATH = process.env.CSV_FILE || path.join(process.cwd(), 'datos', 'decimo.csv');

// Fuentes PDF publicadas (las que te interesan)
const PDF_URLS = [
  'https://csv-gpt-backend.vercel.app/lexium.pdf',
  'https://csv-gpt-backend.vercel.app/evaluaciones.pdf',
  'https://csv-gpt-backend.vercel.app/emocionales.pdf',
];

const client = new OpenAI({ apiKey: OPENAI_KEY });

// Lee encabezados y trozo representativo del CSV (delimitado por ;)
function readCsvSnapshot() {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = (lines[0] || '').split(';').map(s => s.trim()); // <-- ; delimitado
    // Con 4KB no hay problema, pero dejamos un límite alto por si crece
    const preview = raw.slice(0, 200000);
    return { ok: true, header, preview };
  } catch (e) {
    console.error('CSV READ ERROR:', e?.message || e);
    return { ok: false, header: [], preview: '' };
  }
}

function isGpt5Id(id = '') {
  // gpt-5 / gpt-5-mini / gpt-5-chat-latest...
  return /^gpt-5/i.test(id);
}

// Parser robusto: intenta JSON.parse y si falla, busca primer bloque {...}
function safeParseToObj(s) {
  if (!s || typeof s !== 'string') return null;
  try {
    return JSON.parse(s);
  } catch {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* ignore */ }
    }
    return null;
  }
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

    // CSV
    const { ok, header, preview } = readCsvSnapshot();
    const headerNote = header.length
      ? `Encabezados reales del CSV (${header.length} columnas): ${header.join(' | ')}`
      : `No pude leer el CSV.`;

    // Prompt
    const system = `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.

Reglas DURAS:
- El CSV está delimitado por punto y coma (;). Trata los encabezados tal cual (con acentos) y úsalo como fuente principal cuando se pidan datos de alumnos/puntuaciones.
- Si el usuario pide "todos los estudiantes", debes listar TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas y el orden solicitados por el usuario. Si pide varias columnas, inclúyelas todas.
- Presenta las LISTAS/TABLAS en formato Markdown (| Col | ... |) cuando aplique.
- Numera filas implícitamente (la UI agregará columna #).
- Nada de "no puedo realizar". Si falta dato, explica brevemente y ofrece alternativas.
- No uses asteriscos para resaltar (la UI los elimina).
- Si el usuario pregunta sobre temas cubiertos por los PDFs (ver URLs listadas), usa esa información de apoyo en tu explicación textual (no inventes citas).`;

    const pdfNote = `Fuentes PDF disponibles (si aplica):
${PDF_URLS.map(u => `- ${u}`).join('\n')}`;

    const user = ok
      ? `PREGUNTA: "${q}"

${headerNote}

TROZO DEL CSV (representativo, no todo):
"""${preview}"""

${pdfNote}

Instrucciones de salida:
1) "texto": explicación clara en español (sin asteriscos).
2) "tablas_markdown": si el usuario pidió listas/tablas, entrega TABLA en Markdown con TODAS las filas solicitadas y las columnas exactas; si pidió "todos", NO omitas ninguno. Si no aplica tabla, deja vacío.

Devuelve SOLO un JSON con {"texto": "...", "tablas_markdown": "..."}.`
      : `PREGUNTA: "${q}"

${headerNote}

No pude leer CSV. Explica o guía al usuario con lo que sepas, en texto claro.
${pdfNote}

Devuelve SOLO un JSON {"texto":"...","tablas_markdown":""}.`;

    // Llamada a OpenAI (parámetros según modelo)
    const isG5 = isGpt5Id(MODEL);

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      ...(isG5
        ? {
            // GPT-5: solo admite temperature=1 y NO response_format
            temperature: 1,
            max_completion_tokens: 1000,
          }
        : {
            // gpt-4o / mini: podemos usar JSON estricto y temperatura baja
            temperature: 0.2,
            max_completion_tokens: 1500,
            response_format: { type: 'json_object' }
          })
    });

    // Parseo robusto
    let raw = completion?.choices?.[0]?.message?.content || '';
    console.log('RAW COMPLETION >>>', raw?.slice(0, 800)); // Mira logs en Vercel

    let parsed = safeParseToObj(raw);
    if (!parsed || typeof parsed !== 'object') {
      // Si no hay JSON limpio, devolvemos el texto crudo para no caer en "No obtuve respuesta"
      parsed = { texto: String(raw || 'No pude formatear la respuesta.'), tablas_markdown: '' };
    }

    // Normaliza claves
    const texto = String(parsed.texto || parsed.text || '').replace(/\*/g, '').trim();
    const tablas_markdown = String(parsed.tablas_markdown || parsed.tables_markdown || '').trim();

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
