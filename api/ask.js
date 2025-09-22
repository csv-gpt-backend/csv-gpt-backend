// /api/ask.js — versión estable sin PDFs
import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';

const client = new OpenAI({ apiKey: process.env.open_ai_key });
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.1';
const CSV_PATH = process.env.CSV_FILE || 'datos/decimo.csv';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
      return;
    }

    // Parseo robusto del body
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

    // Lee CSV desde la ruta configurada
    const csvAbs = path.join(process.cwd(), CSV_PATH);
    let csvRaw = '';
    try {
      csvRaw = await fs.readFile(csvAbs, 'utf8');
    } catch (e) {
      // Mensaje claro si no se encuentra
      res.status(200).json({
        texto: `No pude leer el CSV en "${CSV_PATH}". Verifica que exista en el deploy.`,
        tablas_markdown: ''
      });
      return;
    }

    // Intenta parsear (por si el modelo necesita columnas)
    let csvRows = [];
    try {
      csvRows = parseCsv(csvRaw, { columns: true, skip_empty_lines: true });
    } catch {
      // si falla el parseo, pasamos el texto plano
      csvRows = [];
    }

    const system = `Eres una analista senior (voz femenina, español MX/EC). Reglas:
- Responde siempre en español neutral, sin asteriscos.
- Si se piden listas/tablas, devuelve TABLAS en Markdown (cabeceras + filas numeradas).
- No digas "según el CSV". Cumple órdenes de ordenamiento/filtrado exactamente.
- Devuelve SOLO un JSON: { "texto": string, "tablas_markdown": string }.`;

    const user = `PREGUNTA: ${question}

CONTEXTO CSV (${CSV_PATH}):
${csvRaw.slice(0, 200000)}

Instrucciones de formato:
Devuelve SOLO un JSON con esta forma exacta:
{
  "texto": "explicación sin asteriscos",
  "tablas_markdown": "tablas en Markdown si aplica, o cadena vacía"
}`;

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
    res.status(200).json({
      texto: 'Ocurrió un problema procesando la consulta. Verifica CSV_FILE y la API key.',
      tablas_markdown: ''
    });
  }
}
