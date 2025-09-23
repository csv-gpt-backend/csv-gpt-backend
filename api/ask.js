// api/ask.js
// (Si al activarlo te da problemas, puedes dejar comentado)
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

// ===== Variables de entorno (robustas) =====
const API_KEY =
  (process.env.open_ai_key ||
   process.env.OPENAI_API_KEY ||
   '').trim();

const MODEL =
  (process.env.OPENAI_MODEL ||
   process.env.MODEL ||
   'gpt-5').trim();

const CSV_PATH = process.env.CSV_FILE || path.join(process.cwd(), 'datos', 'decimo.csv');

// PDFs: los leeremos una sola vez (o por URL si no están locales)
const PDF_URLS = [
  'https://csv-gpt-backend.vercel.app/lexium.pdf',
  'https://csv-gpt-backend.vercel.app/evaluaciones.pdf',
  'https://csv-gpt-backend.vercel.app/emocionales.pdf'
];

// ===== Cliente OpenAI =====
const client = new OpenAI({ apiKey: API_KEY });

// ===== Cache en caliente (dura mientras viva la función) =====
let HOT_CACHE = {
  csv: null,          // { header:[], preview:string }
  pdfText: null,      // texto concatenado de los PDFs (si logramos extraerlo)
  loadedAt: null
};

// ===== Utilidades de tiempo (diagnóstico) =====
function now() { return Date.now(); }
function ms(t0) { return `${Date.now() - t0}ms`; }

// ===== Lee CSV una sola vez (separador ;) =====
function loadCsvSnapshotOnce() {
  if (HOT_CACHE.csv) return HOT_CACHE.csv;

  try {
    const t0 = now();
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    // Encabezado con ; como separador
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const header = (lines[0] || '').split(';').map(s => s.trim());

    // Preview compacto (reduce latencia y tokens)
    const PREVIEW_LIMIT = 80_000; // ~80 KB
    const preview = raw.slice(0, PREVIEW_LIMIT);

    HOT_CACHE.csv = { header, preview };
    HOT_CACHE.loadedAt = new Date().toISOString();
    console.log('[ASK] CSV snapshot cargado en', ms(t0), `(${preview.length} chars)`);
  } catch (e) {
    console.warn('[ASK] No se pudo leer CSV:', e.message);
    HOT_CACHE.csv = { header: [], preview: '' };
  }
  return HOT_CACHE.csv;
}

// ===== Intenta cargar PDFs a texto UNA SOLA VEZ (opcional) =====
// NOTA: Para máxima velocidad, no parseamos PDF en cada request.
// Aquí solo intentamos leerlos si están en la raíz. Si no, dejamos el campo como URLs.
function tryLoadLocalPdfTextOnce() {
  if (HOT_CACHE.pdfText !== null) return HOT_CACHE.pdfText; // ya decidido

  const possibleLocal = ['lexium.pdf', 'evaluaciones.pdf', 'emocionales.pdf'];
  const found = [];
  for (const fname of possibleLocal) {
    try {
      const p = path.join(process.cwd(), fname);
      if (fs.existsSync(p)) {
        // Sin dependencias pesadas: no parseamos aquí.
        // Solo marcamos que existe para que el prompt lo mencione.
        found.push(`(local) ${fname}`);
      }
    } catch (_) {}
  }

  if (found.length) {
    HOT_CACHE.pdfText = `PDFs locales disponibles: ${found.join(', ')}.`;
  } else {
    // Si no hay locales, dejamos nota de URLs: el modelo tendrá referencias en el prompt.
    HOT_CACHE.pdfText = '';
  }
  return HOT_CACHE.pdfText;
}

// ===== Prompt =====
function buildSystemMessage() {
  return `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral (voz femenina).
Reglas DURAS:
- Si el usuario pide "todos los estudiantes", debes listar a TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas solicitadas por el usuario. Si pide varias columnas, inclúyelas todas.
- Presenta las LISTAS/TABLAS en formato Markdown (| Col | ... |) cuando aplique.
- No uses asteriscos para resaltar.
- No digas "no puedo realizar". Si falta dato, explica brevemente y ofrece alternativas.
- Cuando presentes tablas de estudiantes, no omitas filas y ordena exactamente como te pidan.`;
}

function buildUserMessage(question, csvHeader, csvPreview, pdfNote) {
  const headerNote = csvHeader.length
    ? `Encabezados reales del CSV (${csvHeader.length} columnas): ${csvHeader.join(' | ')}`
    : `No pude leer el encabezado del CSV.`;

  const sources = PDF_URLS.map((u, i) => `  ${i + 1}. ${u}`).join('\n');

  return `PREGUNTA: "${question}"

${headerNote}

CSV (fragmento representativo, separador punto y coma ";"):
"""${csvPreview}"""

FUENTES DE REFERENCIA (PDFs):
${sources}
${pdfNote ? `\nNota: ${pdfNote}\n` : ''}

INSTRUCCIONES DE SALIDA (JSON ESTRICTO):
- "texto": explicación clara en español (sin asteriscos).
- "tablas_markdown": SI y solo si se pidieron listas/tablas, entrega una TABLA Markdown con TODAS las filas solicitadas y las columnas exactas; si pidió "todos", no omitas ninguno. Si no aplica tabla, deja cadena vacía "".

Devuelve SOLO un JSON con la forma:
{"texto":"...","tablas_markdown":"..."}`;
}

// ===== Handler =====
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
    }
    if (!API_KEY) {
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

    // Cargas únicas (rápidas tras el primer request)
    const t0 = now();
    const { header, preview } = loadCsvSnapshotOnce();
    const pdfNote = tryLoadLocalPdfTextOnce();

    const system = buildSystemMessage();
    const user = buildUserMessage(q, header, preview, pdfNote);

    const options = {
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      response_format: { type: 'json_object' }
    };
    // GPT-5 no admite temperature; modelos anteriores sí
    if (!MODEL.startsWith('gpt-5')) options.temperature = 0.2;

    const t_api = now();
    const completion = await client.chat.completions.create(options);
    console.log('[ASK] OpenAI latency =', ms(t_api));

    const raw = completion?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = { texto: raw, tablas_markdown: '' }; }

    const texto = String(parsed.texto || parsed.text || '').replace(/\*/g,'').trim();
    const tablas_markdown = String(parsed.tablas_markdown || parsed.tables_markdown || '').trim();

    console.log('[ASK] Total duration =', ms(t0), '| model =', MODEL, '| loadedAt =', HOT_CACHE.loadedAt);

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
