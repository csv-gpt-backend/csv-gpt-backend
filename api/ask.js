// api/ask.js
// export const config = { runtime: 'nodejs20.x' }; // descomenta si lo necesitas

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

// Rutas locales
const CSV_PATH = path.join(process.cwd(), 'datos', 'decimo.csv');
const PDF_EMOCIONALES = path.join(process.cwd(), 'datos', 'emocionales.pdf');

const client = new OpenAI({ apiKey: OPENAI_KEY });

// ---------- Utilidades ----------
function readCsvSnapshot(maxChars = 80000) { // <= recorte agresivo
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    // separador ; como comentaste
    const header = (lines[0] || '').split(';').map(s => s.trim());
    return { ok: true, header, preview: raw.slice(0, maxChars) };
  } catch (e) {
    console.error('Error leyendo CSV:', e);
    return { ok: false, header: [], preview: '' };
  }
}

// Solo leemos el PDF si la pregunta lo amerita
function readEmocionalesPdfBase64() {
  try {
    if (fs.existsSync(PDF_EMOCIONALES)) {
      const buf = fs.readFileSync(PDF_EMOCIONALES);
      return buf.toString('base64');
    }
  } catch (e) {
    console.error('Error leyendo PDF emocionales:', e);
  }
  return '';
}

// Decide si incluir PDFs según la pregunta
function shouldIncludePdf(q) {
  const t = q.toLowerCase();
  return (
    t.includes('pdf') ||
    t.includes('lexium') ||
    t.includes('evaluaciones') ||
    t.includes('emocionales') ||
    t.includes('anexo') ||
    t.includes('documento')
  );
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

    // CSV recortado (rápido)
    const { ok, header, preview } = readCsvSnapshot(80000);
    const headerNote = ok
      ? `Encabezados reales del CSV (${header.length}): ${header.join(' | ')}`
      : `No pude leer el CSV.`;

    // Adjuntamos PDF SOLO si hace falta
    let pdfNote = '';
    if (shouldIncludePdf(q)) {
      const emo64 = readEmocionalesPdfBase64();
      if (emo64) {
        // No enviamos todo: indicamos que hay PDF y dejamos ejemplo de uso
        // (Puedes pasar solo una parte si necesitas, pero evita 4–8 páginas completas en base64)
        pdfNote = `\nSe adjunta el PDF "emocionales.pdf" en base64 (contenido disponible para citas breves y específicas).`;
      } else {
        pdfNote = `\nNo pude abrir "emocionales.pdf".`;
      }
    }

    const system =
`Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas:
- Si piden "todos los estudiantes", NO omitas ninguno.
- Usa EXACTAMENTE las columnas solicitadas.
- Presenta tablas en Markdown (| Col | ... |) y sin asteriscos de formato.
- La UI numera filas; no agregues numeración en la primera columna.
- Si mencionan PDF, puedes citar su contenido de forma breve y precisa.`;

    let user =
`PREGUNTA: "${q}"

${headerNote}

TROZO REPRESENTATIVO DEL CSV (recortado para rendimiento):
"""${preview}"""${pdfNote}

SALIDA OBLIGATORIA (JSON):
{
  "texto": "explicación clara en español (sin asteriscos)",
  "tablas_markdown": "si aplica, tabla Markdown con TODAS las filas y columnas exactas pedidas; si no aplica, string vacío"
}`;

    // --- Config dinámica por modelo
    const isGpt5 = /^gpt-5/i.test(MODEL);
    const base = {
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ]
    };

    // Limitar tokens de salida para bajar latencia
    const opts = isGpt5
      ? { ...base, temperature: 1,   max_completion_tokens: 900 } // GPT-5 solo acepta 1 y este parámetro
      : { ...base, temperature: 0.2, max_tokens: 900 };           // GPT-4o y anteriores

    const completion = await client.chat.completions.create(opts);

    const raw = completion?.choices?.[0]?.message?.content || '{}';

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      console.error('No pude parsear JSON del modelo:', raw);
      return res.status(200).json({
        texto: 'No pude formatear la respuesta del modelo. Reformula la pregunta o pide menos columnas.',
        tablas_markdown: ''
      });
    }

    const texto = String(parsed.texto || parsed.text || '').replace(/\*/g,'').trim();
    const tablas_markdown = String(parsed.tablas_markdown || parsed.tables_markdown || '').trim();

    res.setHeader('Content-Type','application/json');
    return res.status(200).json({ texto, tablas_markdown });

  } catch (err) {
    console.error('ASK ERROR:', err);
    return res.status(200).json({
      texto: `Ocurrió un error interno: ${err?.message || 'Desconocido'}.`,
      tablas_markdown: ''
    });
  }
}
