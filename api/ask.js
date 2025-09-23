// api/ask.js
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-5';

const CSV_URL = 'https://csv-gpt-backend.vercel.app/datos/decimo.csv';
const TXT_URL = 'https://csv-gpt-backend.vercel.app/emocionales.txt';

const client = new OpenAI({ apiKey: OPENAI_KEY });

// Función para leer archivo remoto
async function fetchRemoteFile(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`No se pudo leer archivo: ${url}`);
    return await res.text();
  } catch (err) {
    console.error('Error leyendo remoto:', url, err.message);
    return '';
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

    // Leer CSV y TXT
    const [csvData, txtData] = await Promise.all([
      fetchRemoteFile(CSV_URL),
      fetchRemoteFile(TXT_URL)
    ]);

    // Construir prompt
    const system = `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas:
- Si el usuario pide "todos los estudiantes", debes listar a TODOS sin omitir ninguno.
- Presenta listas y tablas en formato Markdown (| Columna | ... |).
- Numera las filas implícitamente.
- Si falta información, explícalo.
- No uses asteriscos (*).`;

    const user = `
PREGUNTA: "${q}"

CSV (decimo.csv, separado por ";"):
"""${csvData.slice(0, 20000)}"""

TXT (emocionales.txt):
"""${txtData.slice(0, 10000)}"""

Devuelve SOLO en formato JSON así:
{
  "texto": "explicación en español",
  "tablas_markdown": "tabla en Markdown si aplica"
}

Si no puedes devolver JSON válido, responde SOLO con texto plano sin ningún formato especial.
`;

    // Llamar a GPT-5
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 1,
      max_completion_tokens: 1000
    });

    const raw = completion?.choices?.[0]?.message?.content || '';

    let texto = '';
    let tablas_markdown = '';

    try {
      // Intentar parsear JSON
      const parsed = JSON.parse(raw);
      texto = String(parsed.texto || '').trim();
      tablas_markdown = String(parsed.tablas_markdown || '').trim();
      console.log('[ASK][OK] Respuesta JSON procesada');
    } catch (err) {
      // Si no es JSON, tratar como texto plano
      texto = raw.trim();
      tablas_markdown = '';
      console.warn('[ASK][WARN] Respuesta no era JSON, procesada como texto plano');
    }

    // Si sigue vacío, mandar mensaje de error
    if (!texto && !tablas_markdown) {
      texto = 'El modelo no devolvió contenido utilizable. Intenta con una pregunta más específica.';
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ texto, tablas_markdown });

  } catch (err) {
    console.error('[ASK][ERROR]', err.message || err);
    return res.status(200).json({
      texto: `Error procesando la consulta: ${err.message || 'desconocido'}`,
      tablas_markdown: ''
    });
  }
}
