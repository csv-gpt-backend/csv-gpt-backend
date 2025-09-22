// /api/ask.js — CSV + OpenAI (sin PDFs)
// Usa tu variable open_ai_key y el CSV en datos/decimo.csv

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';

const client = new OpenAI({ apiKey: process.env.open_ai_key });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CSV_PATH = process.env.CSV_FILE || 'datos/decimo.csv';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
      return;
    }

    // Body robusto
    let body = {};
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    } catch {
      res.status(400).json({ error: 'JSON inválido' });
      return;
    }

    const question = String(body.question || '').replace(/\*/g,'').trim();
    if (!question) {
      res.status(200).json({ texto: 'Escribe una pregunta.', tablas_markdown: '' });
      return;
    }

    // Leer CSV
    const abs = path.join(process.cwd(), CSV_PATH);
    let csvRaw = '';
    try {
      csvRaw = await fs.readFile(abs, 'utf8');
    } catch (e) {
      res.status(200).json({
        texto: `No pude leer el CSV en "${CSV_PATH}". Verifica que el archivo exista en el deploy.`,
        tablas_markdown: ''
      });
      return;
    }

    // Intento de parseo (opcional, por si el modelo lo usa)
    let csvRows = [];
    try {
      csvRows = parseCsv(csvRaw, { columns: true, skip_empty_lines: true });
    } catch { /* si falla, seguimos con texto plano */ }

    const system = `Eres una analista senior (voz femenina, español MX/EC). Reglas duras:
- Responde siempre en español, sin asteriscos.
- Cumple órdenes de orden/filtrado exactamente.
- Realiza cálculos cuando aplique (promedios, rankings, etc.).
- Si se piden listas/tablas, entrégalas en Markdown (cabeceras + filas numeradas).
- Devuelve SOLO un JSON con forma exacta: {"texto": string, "tablas_markdown": string}.`;

    const user = `PREGUNTA: ${question}

CONTEXTO CSV (${CSV_PATH}):
${csvRaw.slice(0, 200000)}

FORMATO DE RESPUESTA (estricto):
{"texto":"explicación sin asteriscos","tablas_markdown":"tablas Markdown si aplica o cadena vacía"}`;

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = { texto: raw, tablas_markdown: '' }; }

    res.status(200).json({
      texto: String(parsed.texto || parsed.text || '').replace(/\*/g,''),
      tablas_markdown: String(parsed.tablas_markdown || '').replace(/\*/g,'')
    });
  } catch (err) {
    console.error('ASK_ERROR', err?.stack || err);
    const msg = (err?.response?.data?.error?.message) || err?.message || 'desconocido';
    res.status(200).json({ texto: 'Error backend: ' + msg, tablas_markdown: '' });
  }
}
