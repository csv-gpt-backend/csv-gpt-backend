// api/ask.js
// Si da problemas con runtime, puedes descomentar esta línea
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;

// Aquí forzamos GPT-5 como modelo principal
const MODEL = process.env.OPENAI_MODEL || 'gpt-5';

// Rutas físicas a CSV y TXT (sin variables en Vercel, directo en la raíz del proyecto)
const CSV_PATH = path.join(process.cwd(), 'datos', 'decimo.csv');
const TXT_PATH = path.join(process.cwd(), 'emocionales.txt');

const client = new OpenAI({ apiKey: OPENAI_KEY });

// --- Utilidad: leer CSV
function readCsvSnapshot() {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = (lines[0] || '').split(';').map(s => s.trim()); // CSV usa punto y coma (;)
    return { ok: true, header, preview: raw };
  } catch (e) {
    return { ok: false, header: [], preview: '' };
  }
}

// --- Utilidad: leer TXT
function readTxtFile() {
  try {
    const raw = fs.readFileSync(TXT_PATH, 'utf8');
    return { ok: true, content: raw };
  } catch (e) {
    return { ok: false, content: '' };
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
      return res.status(200).json({
        texto: 'Por favor, escribe una pregunta.',
        tablas_markdown: ''
      });
    }

    const q = question.trim();

    // Leer CSV y TXT
    const csvData = readCsvSnapshot();
    const txtData = readTxtFile();

    // Información sobre CSV
    const headerNote = csvData.ok
      ? `Encabezados CSV (${csvData.header.length} columnas): ${csvData.header.join(' | ')}`
      : 'No se pudo leer el CSV.';

    // Instrucciones al modelo
    const system = `
Eres una analista educativa rigurosa. 
Responde SIEMPRE en español latino neutral.

Reglas estrictas:
- Usa datos del CSV y del archivo TXT para responder.
- Si el usuario pide "todos los estudiantes", lista absolutamente TODOS.
- Incluye exactamente las columnas que se soliciten.
- Presenta listas/tablas en Markdown con | para columnas.
- No uses asteriscos (*), negritas ni decoraciones.
- Si no puedes procesar algo complejo, explica el procedimiento en detalle.

Devuelve la respuesta en este JSON:
{
  "texto": "Explicación clara y coherente",
  "tablas_markdown": "Tabla en formato Markdown si aplica, si no, vacío"
}
`;

    // Contexto de usuario con datos reales
    const user = `
Pregunta del usuario: "${q}"

${headerNote}

Contenido TXT:
"""${txtData.content.slice(0, 8000)}"""

Contenido CSV (solo las primeras líneas para contexto):
"""${csvData.preview.slice(0, 20000)}"""
`;

    // --- Llamada a GPT-5
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 1, // GPT-5 requiere temperatura fija
      max_completion_tokens: 2000
    });

    const raw = completion?.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      parsed = JSON.parse(raw); // Intentar parsear como JSON
    } catch (err) {
      // Si no es JSON válido, enviamos el texto crudo
      parsed = { texto: raw, tablas_markdown: '' };
    }

    // Limpiar texto y tablas
    const texto = String(parsed.texto || '').replace(/\*/g, '').trim();
    const tablas_markdown = String(parsed.tablas_markdown || '').trim();

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ texto, tablas_markdown });
  } catch (err) {
    console.error('ASK ERROR:', err);
    return res.status(200).json({
      texto: `Error inesperado: ${err.message || 'Desconocido'}.`,
      tablas_markdown: ''
    });
  }
}
