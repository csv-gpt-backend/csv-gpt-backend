// api/ask.js
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

/* 
  Soporta ambas variables: open_ai_key (como tú la definiste) u OPENAI_API_KEY.
  Revisa en Vercel → Project → Settings → Environment Variables, que exista `open_ai_key`
  con tu clave empezando por "sk-proj-..." o "sk-...".
*/
const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CSV_FILE = process.env.CSV_FILE || path.join(process.cwd(), 'datos', 'decimo.csv');

const client = new OpenAI({ apiKey: OPENAI_KEY });

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
    }

    if (!OPENAI_KEY) {
      console.error('FALTA API KEY: define open_ai_key o OPENAI_API_KEY en Vercel.');
      return res.status(500).json({
        texto: 'No tengo una API Key válida. Revisa la variable "open_ai_key" en Vercel.',
        tablas_markdown: ''
      });
    }

    let { question } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(200).json({
        texto: 'Por favor, escribe una pregunta.',
        tablas_markdown: ''
      });
    }
    question = question.trim();

    // Intentar leer el CSV si existe
    let csvText = '';
    try {
      csvText = fs.readFileSync(CSV_FILE, 'utf8');
    } catch (e) {
      // No es fatal, pero logueamos para diagnóstico
      console.warn('CSV no disponible en', CSV_FILE, e?.message || e);
    }

    const system = `Eres una asistente educativa clara y concisa. 
Tienes un CSV con datos de estudiantes (si se pudo leer). 
Si el usuario pide promedios o listados, y tienes CSV, cálculalos y genera, cuando aplique, una tabla en Markdown.
Si no puedes leer el CSV, explica cómo calcularlo manualmente o pide más datos.
Devuelve el texto principal en español y, si corresponde, una tabla Markdown breve.

Responde SIEMPRE en español.`;

    const user = csvText
      ? `Pregunta del usuario: """${question}"""
CSV (primeros 4000 caracteres):
"""${csvText.slice(0, 4000)}"""
Formato de salida:
- Texto explicativo breve.
- Si hay tablas/listas, una tabla Markdown separada del texto.`
      : `Pregunta del usuario: """${question}"""
No pude leer CSV. Da una respuesta útil en texto.`;

    // Llamada a OpenAI (chat.Completions)
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      temperature: 0.2
    });

    const raw = completion?.choices?.[0]?.message?.content?.trim() || '';
    if (!raw) {
      console.error('OpenAI devolvió contenido vacío:', JSON.stringify(completion || {}, null, 2));
      return res.status(200).json({
        texto: 'No obtuve respuesta del modelo. Revisa tu clave/billing o inténtalo de nuevo.',
        tablas_markdown: ''
      });
    }

    // Intento separar texto y markdown de tablas (si existe)
    let texto = raw;
    let tablas_markdown = '';

    // Heurística: si hay un bloque de Markdown con tabla, lo separamos
    const tableMatch = raw.match(/(\|.+\|\s*\n(\|[-:]+\|)+[\s\S]+)/); // tabla simple
    if (tableMatch) {
      tablas_markdown = tableMatch[0].trim();
      texto = raw.replace(tablas_markdown, '').trim();
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ texto, tablas_markdown });
  } catch (err) {
    console.error('ASK ERROR:', err?.message || err);
    return res.status(200).json({
      texto: `Error: ${err?.message || 'Desconocido'}. Revisa logs en Vercel.`,
      tablas_markdown: ''
    });
  }
}
