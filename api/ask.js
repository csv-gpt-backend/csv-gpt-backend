// api/ask.js

// Fuerza Node.js (no Edge) para que funcionen fs, Buffer, pdf-parse, etc.
export const config = { runtime: 'nodejs20' };

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import pdfParse from 'pdf-parse';
import { parse as parseCsv } from 'csv-parse/sync';

// ======== CONFIG ========
const client = new OpenAI({
  apiKey: process.env.open_ai_key // <-- tu variable (minúsculas)
});

// Modelo (puedes cambiarlo desde Vercel con OPENAI_MODEL)
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.1';

// Rutas por defecto (puedes sobreescribir con variables de entorno en Vercel)
const CSV_FILE_DEFAULT = 'datos/decimo.csv'; // en raíz/datos/decimo.csv
const PDF_FILES_DEFAULT = 'emocionales.pdf,lexium.pdf,evaluaciones.pdf';

// Cache caliente en el runtime de la función (acelera llamadas subsecuentes)
let HOT_CACHE = null;

// ======== HELPERS ========
async function readMaybeLocal(file) {
  try {
    const p = path.join(process.cwd(), file);
    const buf = await fs.readFile(p);
    return buf;
  } catch {
    return null;
  }
}

async function fetchAsBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar: ${url} (${res.status})`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function loadSources() {
  // Devuelve { csvRaw, csvRows, pdfText } (usa cache si ya se cargó)
  if (HOT_CACHE) return HOT_CACHE;

  const CSV_FILE = process.env.CSV_FILE || CSV_FILE_DEFAULT;
  const CSV_URL  = process.env.CSV_URL  || '';

  const pdfFiles = (process.env.PDF_FILES || PDF_FILES_DEFAULT)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const pdfURLs = (process.env.PDF_URLS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // CSV
  let csvBuf = await readMaybeLocal(CSV_FILE);
  if (!csvBuf && CSV_URL) csvBuf = await fetchAsBuffer(CSV_URL);

  let csvRaw = '';
  let csvRows = [];
  if (csvBuf) {
    csvRaw = csvBuf.toString('utf8');
    try {
      csvRows = parseCsv(csvRaw, { columns: true, skip_empty_lines: true });
    } catch {
      // reintento con separador ';'
      csvRows = parseCsv(csvRaw, {
        columns: true,
        skip_empty_lines: true,
        delimiter: ';'
      });
    }
  }

  // PDFs: primero locales, luego URLs
  const pdfTexts = [];
  for (const f of pdfFiles) {
    const buf = await readMaybeLocal(f);
    if (buf) {
      const data = await pdfParse(buf);
      pdfTexts.push(`# ${f}\n${data.text || ''}`);
    }
  }
  for (const url of pdfURLs) {
    if (!url) continue;
    const buf = await fetchAsBuffer(url);
    const data = await pdfParse(buf);
    pdfTexts.push(`# ${url}\n${data.text || ''}`);
  }

  HOT_CACHE = {
    csvRaw,
    csvRows,
    pdfText: pdfTexts.join('\n\n---\n\n')
  };
  return HOT_CACHE;
}

function buildSystemPrompt() {
  return `Eres una analista senior con voz femenina (español México/Ecuador). Reglas estrictas:
- Responde SIEMPRE en español latino neutro (MX/EC). Sin asteriscos.
- NO digas "según el CSV/PDF..." ni "no puedo realizar...". Si falta algo, deduce y explica brevemente.
- Obedece exactamente ordenamientos/filtrados si se piden.
- Realiza cálculos psicométricos, medias/medianas, razonamientos numéricos/lógicos, regresiones/progresiones y estadísticas cuando aplique.
- Si el usuario pide listas/listados/tablas de estudiantes, entrega TABLAS Markdown (encabezados y filas numeradas). Nombres y puntuaciones en horizontal según columnas solicitadas.
- Tu salida DEBE ser JSON ESTRICTO con forma: {"texto": "...", "tablas_markdown": "..."} (nada de texto fuera del JSON).
`;
}

function buildUserPrompt(question, csvRaw, pdfText) {
  // Recorta CSV si es muy grande para no exceder tokens
  let csvSnippet = csvRaw || '';
  if (csvSnippet.length > 250_000) {
    csvSnippet = csvSnippet.slice(0, 250_000);
  }

  return `PREGUNTA DEL USUARIO:
${question}

CONTEXTOS:
- CSV (decimo):
${csvSnippet}

- PDFs (emocionales/lexium/evaluaciones):
${pdfText}

FORMATO DE RESPUESTA (JSON ESTRICTO):
{
  "texto": "explicación en español (sin asteriscos), cumpliendo filtros/órdenes y con cálculos cuando aplique",
  "tablas_markdown": "si se pidieron listas/tablas, entrega tablas Markdown; de lo contrario, cadena vacía"
}`;
}

// ======== HANDLER ========
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res
      .status(405)
      .json({ error: 'Método no permitido. Usa POST con JSON.' });
    return;
  }

  try {
    // Verifica API Key
    if (!process.env.open_ai_key) {
      throw new Error(
        'Falta la variable de entorno "open_ai_key". Configúrala en Vercel y redeploy.'
      );
    }

    // Cuerpo (Vercel Node te da req.body como objeto; si fuera string, lo parseamos)
    const body =
      typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const question = String(body.question || '').replace(/\*/g, '').trim();
    const sessionId = String(body.sessionId || '').trim();

    if (!question) {
      res.status(400).json({ error: 'Pregunta vacía.' });
      return;
    }

    const { csvRaw, csvRows, pdfText } = await loadSources();

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(question, csvRaw, pdfText) }
    ];

    // Llamada al modelo
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages,
      response_format: { type: 'json_object' }
    });

    const raw = completion?.choices?.[0]?.message?.content || '{}';
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { texto: raw, tablas_markdown: '' };
    }

    // Sanea asteriscos
    const safe = {
      texto: String(parsed.texto || parsed.text || '').replace(/\*/g, ''),
      tablas_markdown: String(parsed.tablas_markdown || parsed.tables_markdown || '').replace(/\*/g, '')
    };

    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(JSON.stringify(safe));
  } catch (err) {
    console.error('ASK ERROR:', err?.stack || err);
    res
      .status(500)
      .json({ error: String(err?.message || err || 'Error interno') });
  }
}
