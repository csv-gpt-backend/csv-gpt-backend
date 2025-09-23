// api/ask.js
// Backend optimizado para GPT-5 y CSV+TXT
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;

// Modelo por defecto GPT-5, con fallback a GPT-4o-mini
const MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const FALLBACK_MODEL = 'gpt-4o-mini';

// Rutas absolutas
const CSV_PATH = path.join(process.cwd(), 'datos', 'decimo.csv');
const TXT_EMOCIONAL = path.join(process.cwd(), 'emocional.txt');

const client = new OpenAI({ apiKey: OPENAI_KEY });

// ==== Funciones auxiliares ====

// Lee CSV con recorte para evitar tokens excesivos
function readCsvSnapshot(maxChars = 30000) {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = (lines[0] || '').split(/[,;]/).map(s => s.trim());
    return {
      ok: true,
      header,
      preview: raw.slice(0, maxChars)
    };
  } catch (e) {
    console.error('Error leyendo CSV:', e.message);
    return { ok: false, header: [], preview: '' };
  }
}

// Lee archivo TXT (emocional.txt)
function readTxtFile(filepath, maxChars = 50000) {
  try {
    if (fs.existsSync(filepath)) {
      const raw = fs.readFileSync(filepath, 'utf8');
      return raw.slice(0, maxChars);
    }
  } catch (e) {
    console.error('Error leyendo TXT:', e.message);
  }
  return '';
}

// ==== Handler principal ====
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

    // === Cargar datos ===
    const { ok, header, preview } = readCsvSnapshot();
    const txtEmocional = readTxtFile(TXT_EMOCIONAL);

    const headerNote = ok
      ? `Encabezados del CSV (${header.length} columnas): ${header.join(' | ')}`
      : `No se pudo leer el CSV.`;

    // === Prompt del sistema ===
    const system = `Eres una analista educativa rigurosa.
Responde SIEMPRE en español latino neutral.
Reglas:
- Si el usuario pide "todos los estudiantes", debes listar a TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas solicitadas por el usuario. Si pide varias columnas, inclúyelas todas.
- Presenta las LISTAS/TABLAS en formato Markdown (| Col | ... |) cuando aplique.
- Numera filas implícitamente (la UI agregará columna #).
- Nada de "no puedo realizar". Si falta dato, explica brevemente y ofrece alternativas.
- No uses asteriscos (*).
- Si se menciona PDF o texto emocional, analiza también el contenido proporcionado.`;

    // === Prompt del usuario ===
    let userContent = `PREGUNTA: "${q}"\n\n${headerNote}\n\n`;

    if (ok) {
      userContent += `Fragmento del CSV:\n"""${preview}"""\n\n`;
    }

    if (txtEmocional && /emocional/i.test(q)) {
      userContent += `Contenido emocional relevante:\n"""${txtEmocional}"""\n\n`;
    }

    userContent += `Instrucciones de salida:
1) "texto": explicación clara en español (sin asteriscos).
2) "tablas_markdown": si el usuario pidió listas/tablas, entrega TABLA en Markdown con TODAS las filas y columnas solicitadas.
3) Devuelve SOLO un JSON válido con {"texto": "...", "tablas_markdown": "..."}.`;

    // === Llamada a GPT ===
    const isGpt5 = /^gpt-5/i.test(MODEL);
    const base = {
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ]
    };

    const opts = isGpt5
      ? { ...base, temperature: 1, max_completion_tokens: 600 }
      : { ...base, temperature: 0.2, max_tokens: 600 };

    let completion;

    try {
      completion = await client.chat.completions.create(opts);
    } catch (err) {
      console.warn('Fallo con GPT-5, usando fallback:', err.message);
      completion = await client.chat.completions.create({
        ...base,
        model: FALLBACK_MODEL,
        temperature: 0.2,
        max_tokens: 600
      });
    }

    // === Parseo de respuesta ===
    const raw = completion?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = { texto: raw, tablas_markdown: '' };
    }

    const texto = String(parsed.texto || parsed.text || '').replace(/\*/g, '').trim();
    const tablas_markdown = String(parsed.tablas_markdown || '').trim();

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ texto, tablas_markdown });

  } catch (err) {
    console.error('ASK ERROR:', err);
    return res.status(200).json({
      texto: `Error: ${err?.message || 'Desconocido'}.`,
      tablas_markdown: ''
    });
  }
}
