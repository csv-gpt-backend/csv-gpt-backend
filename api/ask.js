// /api/ask.js — Vercel Serverless (Node 20+)
// Usa GPT-5 si está disponible, acepta tu variable `open_ai_key`,
// y carga CSV/PDF locales (o por URL si defines variables).

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import pdfParse from 'pdf-parse';
import { parse as parseCsv } from 'csv-parse/sync';

const API_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;
const client = new OpenAI({ apiKey: API_KEY });

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.1'; // cámbialo en Vercel si tu cuenta lo soporta

// Cache simple en caliente
let CACHE = null;

// Helpers
async function readMaybeLocal(file) {
  try {
    const p = path.join(process.cwd(), file);
    const buf = await fs.readFile(p);
    return buf;
  } catch { return null; }
}
async function fetchAsBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo descargar: ' + url);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function loadSources() {
  if (CACHE) return CACHE;

  // Config por variables o defaults
  const csvFile = process.env.CSV_FILE || 'datos/decimo.csv';   // ← tu CSV en /datos
  const csvURL  = process.env.CSV_URL  || '';
  const pdfFiles = (process.env.PDF_FILES || 'emocionales.pdf,lexium.pdf,evaluaciones.pdf')
    .split(',').map(s => s.trim()).filter(Boolean);
  const pdfURLs  = (process.env.PDF_URLS  || '').split(',').map(s => s.trim()).filter(Boolean);

  // CSV
  let csvBuf = await readMaybeLocal(csvFile);
  if (!csvBuf && csvURL) csvBuf = await fetchAsBuffer(csvURL);
  let csvRaw = '', csvRows = [];
  if (csvBuf) {
    csvRaw = csvBuf.toString('utf8');
    try {
      csvRows = parseCsv(csvRaw, { columns: true, skip_empty_lines: true });
    } catch {
      csvRows = parseCsv(csvRaw, { columns: true, skip_empty_lines: true, delimiter: ';' });
    }
  }

  // PDFs
  const pdfTexts = [];
  for (const f of pdfFiles) {
    const buf = await readMaybeLocal(f);
    if (buf) {
      const data = await pdfParse(buf);
      pdfTexts.push(`# ${f}\n` + (data.text || ''));
    }
  }
  for (const url of pdfURLs) {
    if (!url) continue;
    const buf = await fetchAsBuffer(url);
    const data = await pdfParse(buf);
    pdfTexts.push(`# ${url}\n` + (data.text || ''));
  }

  CACHE = { csvRaw, csvRows, pdfText: pdfTexts.join('\n\n---\n\n') };
  return CACHE;
}

function buildSystemPrompt() {
  return `Eres una analista senior (voz femenina latina). Reglas duras:
- Responde SIEMPRE en español neutral latino (MX/EC). No uses asteriscos.
- NO digas "Según el CSV..." ni "No puedo realizar...". Si falta dato, deduce y explica brevemente.
- Obedece ordenamientos/filtrados exactamente.
- Realiza cálculos psicométricos, promedios, razonamientos, regresiones y estadísticas cuando se pidan.
- Cuando el usuario pida listas/tablas de estudiantes, entrega TABLAS Markdown (cabeceras y filas numeradas, horizontal).
- Separa SIEMPRE tu salida en JSON: { "texto": string, "tablas_markdown": string }.
- Nada de prefacios; SOLO devuelve JSON válido.`;
}

function buildUserPrompt(question, csvRaw, csvRows, pdfText) {
  // Recorte para evitar excesos de tokens
  let csvSnippet = csvRaw;
  if (csvRaw && csvRaw.length > 250_000) csvSnippet = csvRaw.slice(0, 250_000);

  return `PREGUNTA: ${question}

CONTEXTOS DISPONIBLES:
- CSV (decimo):
${csvSnippet}

- PDFs (emocionales/lexium/evaluaciones):
${pdfText}

FORMATO DE RESPUESTA (estricto):
{
  "texto": "explicación en español sin asteriscos; cumple filtros/ordenes; incluye cálculos cuando aplique",
  "tablas_markdown": "si se pidieron listas/tablas, entrega una o varias tablas Markdown; de lo contrario, cadena vacía"
}`;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).end(JSON.stringify({ error: 'Método no permitido. Usa POST con JSON.' }));
  }

  try {
    if (!API_KEY) throw new Error('Falta API key (open_ai_key).');

    const body = req.body && typeof req.body === 'object' ? req.body : await req.json?.();
    const { question = '', sessionId = '' } = body || {};
    const q = String(question || '').replace(/\*/g, '').trim();
    if (!q) return res.status(400).json({ error: 'Pregunta vacía' });

    const { csvRaw, csvRows, pdfText } = await loadSources();

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user',   content: buildUserPrompt(q, csvRaw, csvRows, pdfText) }
    ];

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });

    const raw = completion.choices?.[0]?.message?.content || '{}';
    let parsed = {};
    try { parsed = JSON.parse(raw); }
    catch { parsed = { texto: raw, tablas_markdown: '' }; }

    const safe = {
      texto: String(parsed.texto || parsed.text || '').replace(/\*/g, ''),
      tablas_markdown: String(parsed.tablas_markdown || parsed.tables_markdown || '').replace(/\*/g, '')
    };

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).end(JSON.stringify(safe));
  } catch (err) {
    console.error('ASK ERROR:', err);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      texto: 'Ocurrió un problema procesando la consulta. Revisa que existan /datos/decimo.csv y los PDF.',
      tablas_markdown: ''
    });
  }
}
