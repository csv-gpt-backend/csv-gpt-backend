// /api/ask.js  — Función serverless Vercel (Node 20+)
// Lee CSV local (datos/decimo.csv) y conversa con OpenAI.
// Devuelve SIEMPRE JSON: { texto: string, tablas_markdown: string }

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// CORS básico (útil para pruebas directas)
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function loadCsvRows() {
  try {
    const csvPath = path.join(process.cwd(), 'datos', 'decimo.csv');
    const buf = await fs.readFile(csvPath);
    const raw = buf.toString('utf8');
    const rows = parseCsv(raw, { columns: true, skip_empty_lines: true });
    return { raw, rows };
  } catch (e) {
    // Si no existe o falla, retornamos vacío (el modelo sabrá responder)
    return { raw: '', rows: [] };
  }
}

function buildSystemPrompt() {
  return `Eres una analista senior (voz femenina, español MX/EC). Reglas duras:
- Responde SIEMPRE en español neutral (MX/EC). No uses asteriscos.
- Si el usuario pide listas/tablas, devuelve TABLAS en Markdown con encabezados.
- Obedece filtros/ordenamientos si se piden.
- Si faltan datos del CSV para una operación, explícalo y sugiere qué se necesita.
- Tu salida debe poder dividirse en: texto (explicación) y tablas_markdown (tablas/ listas Markdown).`;
}

function buildUserPrompt(question, csvRaw) {
  return `PREGUNTA: ${question}

Si necesitas datos, aquí está el CSV (si existe). No describas el CSV, úsalo para calcular/filtrar/ listar:
CSV (datos/decimo.csv):
${csvRaw.slice(0, 250000)}

FORMATO DE RESPUESTA (estricto, JSON):
{
  "texto": "explicación clara en español",
  "tablas_markdown": "tablas/listas en Markdown si aplica; de lo contrario, cadena vacía"
}`;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (req.method !== 'POST') {
    res.status(200).json({ error: 'Método no permitido. Usa POST con JSON.' });
    return;
  }

  try {
    // Intentar body como JSON (compatibilidad con fetch/axios)
    const body = req.body && typeof req.body === 'object'
      ? req.body
      : (typeof req.json === 'function' ? await req.json() : {});

    const question = String((body && body.question) || '').trim();
    if (!question) {
      res.status(200).json({ texto: 'Escribe una pregunta.', tablas_markdown: '' });
      return;
    }

    const { raw: csvRaw } = await loadCsvRows();

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user',   content: buildUserPrompt(question, csvRaw) }
    ];

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });

    const content = completion.choices?.[0]?.message?.content || '{}';
    let parsed = {};
    try { parsed = JSON.parse(content); } catch { parsed = {}; }

    const texto = String(parsed.texto || parsed.text || '').replace(/\*/g,'').trim();
    const tablas = String(parsed.tablas_markdown || parsed.tables_markdown || '').replace(/\*/g,'');

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({
      texto: texto || 'No obtuve respuesta.',
      tablas_markdown: tablas || ''
    });
  } catch (err) {
    console.error('ASK ERROR:', err);
    res.status(200).json({
      texto: `ERROR DETECTADO: ${err?.message || JSON.stringify(err)}`,
      tablas_markdown: ''
    });
  }
}
