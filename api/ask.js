// api/ask.js
// export const config = { runtime: 'nodejs20.x' }; // descomenta si necesitas forzar runtime

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

// Archivos principales
const CSV_PATH = path.join(process.cwd(), 'datos', 'decimo.csv');
const PDFS = [
  path.join(process.cwd(), 'datos', 'emocionales.pdf')
];

const client = new OpenAI({ apiKey: OPENAI_KEY });

// --------- Lectura CSV ---------
function readCsvSnapshot() {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = (lines[0] || '').split(';').map(s => s.trim()); // separador ;
    return { ok: true, header, raw };
  } catch (e) {
    console.error('Error leyendo CSV:', e);
    return { ok: false, header: [], raw: '' };
  }
}

// --------- Lectura PDFs ---------
function readPdfs() {
  try {
    return PDFS.filter(p => fs.existsSync(p)).map(p => {
      const data = fs.readFileSync(p);
      return `PDF: ${path.basename(p)} contenido en base64:\n${data.toString('base64')}`;
    });
  } catch (e) {
    console.error('Error leyendo PDFs:', e);
    return [];
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

    // Datos CSV y PDFs
    const { ok, header, raw } = readCsvSnapshot();
    const pdfData = readPdfs();

    const headerNote = ok
      ? `Encabezados reales del CSV (${header.length} columnas): ${header.join(' | ')}`
      : `No pude leer el CSV.`

    // Prompt del sistema
    const system = `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas estrictas:
- Si el usuario pide "todos los estudiantes", debes listar a TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas solicitadas por el usuario. Si pide varias columnas, inclúyelas todas.
- Presenta las listas/tablas en formato Markdown (| Col | ... |) con separadores claros.
- Numera filas implícitamente (la UI agregará columna #).
- No uses asteriscos para resaltar.
- Si el usuario pregunta por PDFs, utiliza la información incluida a continuación para responder con exactitud.`;

    // Prompt del usuario
    let user = `PREGUNTA: "${q}"\n\n${headerNote}\n\n`;
    if (ok) {
      user += `Contenido CSV (fragmento representativo):\n"""\n${raw.slice(0, 200000)}\n"""\n\n`;
    }
    if (pdfData.length > 0) {
      user += `Información contenida en PDFs:\n${pdfData.join('\n\n')}\n\n`;
    }
    user += `\nFormato de salida:\nDevuelve SOLO un JSON como este:
{
  "texto": "respuesta en español latino clara, sin asteriscos",
  "tablas_markdown": "si aplica, tabla en Markdown con TODAS las filas y columnas exactas solicitadas; si no aplica, deja vacío"
}`;

    // --- Configuración dinámica GPT-5 vs GPT-4o ---
    const isGpt5 = /^gpt-5/i.test(MODEL);
    const base = {
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ]
    };

    const opts = isGpt5
      ? { ...base, temperature: 1, max_completion_tokens: 2000 } // GPT-5 requiere esto
      : { ...base, temperature: 0.2, max_tokens: 2000 };          // GPT-4o y otros

    // --- Llamada a la API ---
    const completion = await client.chat.completions.create(opts);

    const rawResponse = completion?.choices?.[0]?.message?.content || '{}';

    let parsed;
    try {
      parsed = JSON.parse(rawResponse);
    } catch (err) {
      console.error('Error parseando respuesta GPT:', err, rawResponse);
      return res.status(200).json({
        texto: 'No pude formatear la respuesta del modelo. Revisa la pregunta o el formato.',
        tablas_markdown: ''
      });
    }

    // Sanitizar
    const texto = String(parsed.texto || parsed.text || '').replace(/\*/g, '').trim();
    const tablas_markdown = String(parsed.tablas_markdown || parsed.tables_markdown || '').trim();

    return res.status(200).json({ texto, tablas_markdown });

  } catch (err) {
    console.error('ASK ERROR:', err);
    return res.status(200).json({
      texto: `Error: ${err?.message || 'Desconocido.'}`,
      tablas_markdown: ''
    });
  }
}
