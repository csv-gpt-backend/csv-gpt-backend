import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';

const client = new OpenAI({ apiKey: process.env.open_ai_key });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CSV_PATH = process.env.CSV_FILE || 'datos/decimo.csv';

// ⬇️ Pega la función aquí, justo después de las variables globales
function buildSystemPrompt() {
  return `Eres una analista senior (voz femenina, español Ecuador/México). Reglas duras:
- Responde SIEMPRE en español neutral latino (MX/EC). No uses asteriscos ni formato extraño.
- Cuando entregues listas o tablas, usa **Markdown con columnas claras**:
  | # | NOMBRE | PROMEDIO |
  |---|--------|----------|
  | 1 | Juan   | 90       |
- Todas las filas deben estar separadas por saltos de línea y contener | (pipes) correctamente.
- Devuelve SIEMPRE la respuesta en un JSON con esta estructura exacta:
{
  "texto": "explicación en texto claro",
  "tablas_markdown": "tablas en formato markdown correctamente formateadas"
}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
      return;
    }

    // Cargar el CSV (como lo tienes ahora)
    const abs = path.join(process.cwd(), CSV_PATH);
    let csvRaw = '';
    try {
      csvRaw = await fs.readFile(abs, 'utf8');
    } catch {
      // fallback HTTP si falla FS
      const host = req.headers['x-forwarded-host'] || req.headers.host || '';
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const origin = host ? `${proto}://${host}` : '';
      const url = origin + (CSV_PATH.startsWith('/') ? CSV_PATH : `/${CSV_PATH}`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} al leer ${url}`);
      csvRaw = await r.text();
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const question = (body.question || '').replace(/\*/g, '').trim();

    if (!question) {
      return res.status(200).json({ texto: 'Escribe una pregunta.', tablas_markdown: '' });
    }

    // Usar la función buildSystemPrompt()
    const system = buildSystemPrompt();

    const user = `PREGUNTA: ${question}

CONTEXTO CSV (${CSV_PATH}):
${csvRaw.slice(0, 200000)}

FORMATO ESTRICTO DE RESPUESTA:
{"texto":"explicación sin asteriscos","tablas_markdown":"tabla en markdown o cadena vacía"}`;

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
    const parsed = JSON.parse(raw);

    res.status(200).json({
      texto: parsed.texto || '',
      tablas_markdown: parsed.tablas_markdown || ''
    });
  } catch (err) {
    res.status(200).json({ texto: `Error backend: ${err.message}`, tablas_markdown: '' });
  }
}
