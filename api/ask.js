// api/ask.js
export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';

const OPENAI_KEY =
  process.env.open_ai_key ||
  process.env.OPENAI_API_KEY ||
  process.env.OPEN_AI_KEY;

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CSV_RELATIVE = process.env.CSV_FILE || 'datos/decimo.csv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
  }

  try {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(200).json({ texto: 'Por favor, escribe una pregunta.', tablas_markdown: '' });
    }

    let csvText = '';
    try {
      const p = path.join(process.cwd(), CSV_RELATIVE);
      csvText = fs.readFileSync(p, 'utf8');
    } catch {
      // CSV no disponible -> no rompemos
    }

    if (!OPENAI_KEY) {
      return res.status(200).json({
        texto: 'No tengo acceso a una clave de OpenAI (open_ai_key). Configúrala en Vercel → Project → Settings → Environment Variables.',
        tablas_markdown: ''
      });
    }

    const prompt = `
Eres un asistente pedagógico. Responde en español neutro y claro.
Si el usuario pide promedios/tablas/listas, y el CSV está disponible, úsalo.
Devuelve tablas en **HTML** cuando corresponda (dentro de "tablas_markdown").
Primero, explica el resultado en texto breve y luego, si aplica, genera la tabla.

Pregunta:
${question}

¿CSV disponible? ${csvText ? 'SÍ' : 'NO'}
${csvText ? `CSV (inicio, máx 3000 chars):\n${csvText.slice(0,3000)}` : ''}
`.trim();

    // Llamada a OpenAI Responses API
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: MODEL, input: prompt })
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || `Error OpenAI ${r.status}`;
      throw new Error(msg);
    }

    const respuesta =
      data?.output_text?.trim?.() ||
      data?.choices?.[0]?.message?.content?.trim?.() ||
      'No obtuve respuesta.';

    // Si viene una <table> la separamos para colocarla en tablas_markdown
    let texto = respuesta;
    let tablas_markdown = '';
    const tmatch = respuesta.match(/<table[\s\S]*?<\/table>/i);
    if (tmatch) {
      tablas_markdown = tmatch[0];
      texto = respuesta.replace(tmatch[0], '').trim();
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ texto, tablas_markdown });

  } catch (err) {
    console.error('ASK ERROR:', err);
    return res.status(200).json({
      texto: `ERROR DETECTADO: ${err?.message || JSON.stringify(err)}`,
      tablas_markdown: ''
    });
  }
}
