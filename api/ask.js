// /api/ask.js
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import pdfParse from 'pdf-parse';
import { parse as parseCsv } from 'csv-parse/sync';

// Soporta tu variable `open_ai_key` y también `OPENAI_API_KEY`
const client = new OpenAI({
  apiKey: process.env.open_ai_key || process.env.OPENAI_API_KEY
});

// Modelo por defecto (puedes definir OPENAI_MODEL en Vercel)
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.1';

// Cache simple (evita releer archivos en cada invocación)
let CACHE = null;

async function readMaybeLocal(file) {
  try {
    const p = path.join(process.cwd(), file);
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

async function fetchAsBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo descargar: ' + url);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function loadSources() {
  if (CACHE) return CACHE;

  const csvFile = process.env.CSV_FILE || 'decimo.csv';
  const csvURL  = process.env.CSV_URL  || '';

  const pdfFiles = (process.env.PDF_FILES || 'emocionales.pdf,lexium.pdf,evaluaciones.pdf')
    .split(',').map(s => s.trim()).filter(Boolean);

  const pdfURLs  = (process.env.PDF_URLS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  // CSV
  let csvBuf = await readMaybeLocal(csvFile);
  if (!csvBuf && csvURL) csvBuf = await fetchAsBuffer(csvURL);

  let csvRaw = '';
  if (csvBuf) csvRaw = csvBuf.toString('utf8');

  // PDFs
  const pdfTexts = [];

  // Locales
  for (const f of pdfFiles) {
    const buf = await readMaybeLocal(f);
    if (buf) {
      const data = await pdfParse(buf);
      pdfTexts.push(`# ${f}\n${data.text || ''}`);
    }
  }

  // URLs
  for (const url of pdfURLs) {
    if (!url) continue;
    const buf = await fetchAsBuffer(url);
    const data = await pdfParse(buf);
    pdfTexts.push(`# ${url}\n${data.text || ''}`);
  }

  CACHE = { csvRaw, pdfText: pdfTexts.join('\n\n---\n\n') };
  return CACHE;
}

function systemPrompt() {
  return `Eres una analista senior (voz femenina, español Ecuador/México). Reglas:
- Responde SIEMPRE en español latino. No uses asteriscos.
- No digas “Según el CSV…” ni “No puedo realizar…”. Si faltan datos, deduce y explica.
- Obedece filtros/ordenamientos exactamente.
- Realiza cálculos psicométricos, promedios, regresiones/progresiones y estadística cuando se pidan.
- Si el usuario pide listas/tablas, devuélvelas en Markdown.
- Devuelve SOLO un JSON válido con: { "texto": string, "tablas_markdown": string }.
`;
}

function userPrompt(question, csvRaw, pdfText) {
  // Para CSVs enormes: recorte de seguridad
  if (csvRaw && csvRaw.length > 250_000) csvRaw = csvRaw.slice(0, 250_000);

  return `PREGUNTA: ${question}

CONTEXTOS:
- CSV (decimo):
${csvRaw || '(sin CSV cargado)'}

- PDFs (emocionales/lexium/evaluaciones):
${pdfText || '(sin PDFs cargados)'}

FORMATO:
Responde SOLO con un JSON EXACTO:
{
  "texto": "explicación detallada en español, sin asteriscos",
  "tablas_markdown": "si hay tablas/listados, usa formato Markdown; si no, cadena vacía"
}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método no permitido' });
    return;
  }
  try {
    const body = await req.json?.() || req.body || {};
    const question = String(body.question || '').replace(/\*/g, '').trim();
    if (!question) return res.status(400).json({ error: 'Pregunta vacía' });

    const { csvRaw, pdfText } = await loadSources();

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userPrompt(question, csvRaw, pdfText) }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = { texto: raw, tablas_markdown: '' }; }

    const out = {
      texto: String(parsed.texto || parsed.text || '').replace(/\*/g, ''),
      tablas_markdown: String(parsed.tablas_markdown || parsed.tables_markdown || '').replace(/\*/g, '')
    };

    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(JSON.stringify(out));
  } catch (err) {
    res.status(200).json({
      texto: 'Error procesando la consulta. Revisa API Key y archivos (CSV/PDF) en la raíz o URLs.',
      tablas_markdown: ''
    });
  }
}
