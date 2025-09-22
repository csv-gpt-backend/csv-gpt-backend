// api/ask.js
export const config = {
  runtime: 'nodejs20.x',
};

import fs from 'fs';
import path from 'path';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY || process.env.OPEN_AI_KEY;
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

    // Lee CSV si existe (para que el modelo sepa que sí hay datos)
    let csvText = '';
    try {
      const csvPath = path.join(process.cwd(), CSV_RELATIVE);
      csvText = fs.readFileSync(csvPath, 'utf8');
    } catch {
      // si no existe, no rompemos — lo indicamos al modelo
    }

    // Llama a OpenAI completions (Responses API)
    const prompt = `
Eres un asistente experto en análisis educativo. Responde en español neutro.
Si el usuario pregunta por promedios o listas, usa los datos del CSV (si está disponible).
Devuelve además tablas en HTML cuando sea útil (dentro del campo "tablas_markdown").

Pregunta del usuario:
${question}

CSV disponible: ${csvText ? 'SÍ' : 'NO'}
${csvText ? `Contenido CSV (inicio):\n${csvText.slice(0, 3000)}` : ''}
`;

    // Llamada a OpenAI con fetch (evitamos SDK para mantener liviano)
    if (!OPENAI_KEY) {
      return res.status(200).json({
        texto: 'No tengo acceso a una clave de OpenAI (open_ai_key). Configúrala en Vercel → Project → Settings → Environment Variables.',
        tablas_markdown: ''
      });
    }

    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        input: prompt,
      })
    });

    const data = await r.json();
    const respuesta = data?.output_text?.trim?.() ||
                      data?.choices?.[0]?.message?.content?.trim?.() ||
                      'No obtuve respuesta.';

    // Heurística: si el modelo incluyó tablas en markdown, las dejamos en tablas_markdown.
    // Si la respuesta trae una tabla en HTML, la hacemos pasar por "tablas_markdown".
    let texto = respuesta;
    let tablas_markdown = '';

    // separa tabla si detecta <table> … </table>
    const tableMatch = respuesta.match(/<table[\s\S]*?<\/table>/i);
    if (tableMatch) {
      tablas_markdown = tableMatch[0];
      texto = respuesta.replace(tableMatch[0], '').trim();
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
