// api/ask.js
export const config = {
  runtime: 'nodejs',
};

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';

function ok(v) { return v !== undefined && v !== null && String(v).trim() !== ''; }

async function loadCSVMaybe(fileRel) {
  try {
    const abs = path.join(process.cwd(), fileRel);
    const buf = await fs.readFile(abs);
    const text = buf.toString('utf8');
    let rows = [];
    try {
      rows = parseCsv(text, { columns: true, skip_empty_lines: true });
    } catch {
      rows = parseCsv(text, { columns: true, skip_empty_lines: true, delimiter: ';' });
    }
    return { text, rows };
  } catch {
    // Si no existe, no hacemos nada
    return { text: '', rows: [] };
  }
}

export default async function handler(req, res) {
  // Evita cache en proxies
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  // CORS simple (por si abres desde otro origen)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(200).json({ texto: 'Método no permitido. Usa POST con JSON.', tablas_markdown: '' });
  }

  try {
    // 1) Entrada
    let body = {};
    try {
      body = typeof req.body === 'object' && req.body !== null ? req.body : await req.json?.() || {};
    } catch {
      body = req.body || {};
    }
    const question = (body.question || body.q || '').toString().replace(/\*/g, '').trim();
    const sessionId = (body.sessionId || '').toString();

    if (!ok(question)) {
      return res.status(200).json({
        texto: 'Pregunta vacía. Escribe algo para analizar.',
        tablas_markdown: ''
      });
    }

    // 2) Config / OpenAI client
    const apiKey = process.env.open_ai_key || process.env.OPENAI_API_KEY;
    if (!ok(apiKey)) {
      return res.status(200).json({
        texto: 'Falta la API Key. Define la variable de entorno "open_ai_key" (o OPENAI_API_KEY) en Vercel.',
        tablas_markdown: ''
      });
    }
    const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const client = new OpenAI({ apiKey });

    // 3) Carga CSV opcional
    const csvFile = process.env.CSV_FILE || 'datos/decimo.csv';
    const { text: csvText } = await loadCSVMaybe(csvFile);
    const csvSnippet = csvText.length > 200_000 ? csvText.slice(0, 200_000) : csvText;

    // 4) Prompts
    const systemPrompt = `
Eres una analista senior (voz femenina, español MX/EC). Reglas duras:
- Contesta SIEMPRE en español latino (MX/EC). No uses asteriscos.
- No digas "Según el CSV..."; solo entrega la respuesta.
- Si faltan datos, deduce con lo disponible y explica brevemente.
- Cuando pidan listas/tablas, entrega tablas Markdown con encabezados y filas numeradas.
- Devuelve SIEMPRE una explicación clara (podrá convertirse a voz).
`;

    const userPrompt = `
PREGUNTA: ${question}

CONTEXTOS:
- CSV (${csvFile}): 
${csvSnippet || '(No disponible o vacío)'}

FORMATO DE SALIDA:
Responde en texto claro. Si corresponde, incluye tablas Markdown en tu explicación o a continuación.
`;

    // 5) Llamada al modelo
    let completion;
    try {
      completion = await client.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      });
    } catch (err) {
      console.error('OpenAI ERROR:', err);
      return res.status(200).json({
        texto: `ERROR (OpenAI): ${err?.message || JSON.stringify(err)}`,
        tablas_markdown: ''
      });
    }

    const respuesta =
      completion?.choices?.[0]?.message?.content?.trim() ||
      'No obtuve respuesta del modelo.';

    // 6) Entrega uniforme
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      texto: respuesta,
      tablas_markdown: '' // si luego extraes tablas, ponlas aquí
    });

  } catch (err) {
    console.error('ASK ERROR:', err);
    return res.status(200).json({
      texto: `ERROR DETECTADO: ${err?.message || JSON.stringify(err)}`,
      tablas_markdown: ''
    });
  }
}
