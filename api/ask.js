// api/ask.js

// (Si al activarlo te da problemas, puedes dejar comentado)
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-5'; // GPT-5 por defecto
const CSV_PATH = process.env.CSV_FILE || path.join(process.cwd(), 'datos', 'decimo.csv');

const client = new OpenAI({ apiKey: OPENAI_KEY });

// ================== FUNCIONES AUXILIARES ==================

// Lee una porción del CSV para mostrar al modelo sin exceder tokens
function readCsvSnapshot() {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = (lines[0] || '').split(';').map(s => s.trim()); // CSV con ;
    const preview = raw.slice(0, 200000); // 200k chars aprox
    return { ok: true, header, preview };
  } catch (e) {
    console.error('Error leyendo CSV:', e.message);
    return { ok: false, header: [], preview: '' };
  }
}

// ================== HANDLER ==================
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

    // --- Leer CSV ---
    const { ok, header, preview } = readCsvSnapshot();
    const headerNote = header.length
      ? `Encabezados reales del CSV (${header.length} columnas): ${header.join(' | ')}`
      : `No pude leer el CSV.`;


    // --- Mensaje del sistema para guiar la respuesta ---
    const system = `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas DURAS:
- Si el usuario pide "todos los estudiantes", debes listar a TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas solicitadas por el usuario. Si pide varias columnas, inclúyelas todas.
- Presenta las LISTAS/TABLAS en formato Markdown (| Col | ... |) cuando aplique.
- Numera filas implícitamente (la UI agregará columna #).
- Nada de "no puedo realizar". Si falta dato, explica brevemente y ofrece alternativas.
- No uses asteriscos para resaltar (la UI los elimina).`;

    const user = ok
      ? `PREGUNTA: "${q}"

${headerNote}

TROZO DEL CSV (representativo, no todo):
"""${preview}"""

Instrucciones de salida:
1) "texto": explicación clara en español (sin asteriscos).
2) "tablas_markdown": si el usuario pidió listas/tablas, entrega TABLA en Markdown con TODAS las filas solicitadas y las columnas exactas; si pidió "todos", no omitas ninguno. Si no aplica tabla, deja vacío.

Devuelve SOLO un JSON con {"texto": "...", "tablas_markdown": "..."}.`
      : `PREGUNTA: "${q}"

${headerNote}

No pude leer CSV. Explica o guía al usuario con lo que sepas, en texto claro. 
Si requiere tabla pero no hay datos, indícalo.
Devuelve SOLO un JSON {"texto":"...","tablas_markdown":""}.`;

    // --- Construcción de opciones dinámicas para GPT ---
    const options = {
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      response_format: { type: 'json_object' }
    };

    // Solo agrega temperature si el modelo NO es GPT-5
    if (!MODEL.startsWith('gpt-5')) {
      options.temperature = 0.2;
    }

    // --- Llamada a la API ---
    const completion = await client.chat.completions.create(options);

    const raw = completion?.choices?.[0]?.message?.content || '{}';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { texto: raw, tablas_markdown: '' };
    }

    // Saneamos el texto y la tabla
    const texto = String(parsed.texto || parsed.text || '').replace(/\*/g, '').trim();
    const tablas_markdown = String(parsed.tablas_markdown || parsed.tables_markdown || '').trim();

    // Respuesta final al frontend
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
