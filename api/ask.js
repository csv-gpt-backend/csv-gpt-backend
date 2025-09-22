// api/ask.js
// Función Serverless para Vercel (Node.js). Lee datos/datos/decimo.csv y consulta OpenAI.

import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';

function getApiKey() {
  return (
    process.env.OPENAI_API_KEY ||
    process.env.open_ai_key ||
    process.env.OPENAI_APIKEY ||
    ''
  );
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CSV_FILE = process.env.CSV_FILE || 'datos/decimo.csv';

export default async function handler(req, res) {
  // Permitir preflight si alguna vez llamas desde otro dominio
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ error: 'Método no permitido. Usa POST con JSON.' });
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('Falta OPENAI_API_KEY / open_ai_key en variables de entorno.');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      texto: 'Error: falta configurar la API key de OpenAI en Vercel.',
      tablas_markdown: ''
    });
  }

  // Parseo del body
  let question = '';
  try {
    question = (req.body && req.body.question) || '';
    if (!question && typeof req.body === 'string') {
      const parsed = JSON.parse(req.body || '{}');
      question = parsed.question || '';
    }
  } catch (e) {
    /* ignorar, manejo abajo */
  }

  if (!question || !String(question).trim()) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      texto: 'Por favor, escribe una pregunta.',
      tablas_markdown: ''
    });
  }

  // Leer CSV local del deploy
  let csvContent = '';
  try {
    const absPath = path.join(process.cwd(), CSV_FILE);
    console.log('[ASK] CSV ruta absoluta:', absPath);

    const fileBuffer = await fs.readFile(absPath);
    console.log('[ASK] CSV tamaño (bytes):', fileBuffer.length);

    csvContent = fileBuffer.toString('utf-8');
    console.log('[ASK] CSV primeras líneas:\n', csvContent.split('\n').slice(0, 5));
  } catch (err) {
    console.error('[ASK] Error leyendo CSV:', err);
    // No abortamos: igual el modelo puede responder algo útil
    csvContent = '';
  }

  // Construir prompt (en español) pidiendo JSON
  const systemPrompt = `
Eres una analista educativa senior. Reglas:
- Responde SIEMPRE en español latino neutral.
- No uses asteriscos ni texto decorativo.
- Si se piden listados/tabla, entrégalos en Markdown.
- Devuelve SIEMPRE un JSON válido con las claves: "texto" (string) y "tablas_markdown" (string).
- Si no hay datos suficientes en el CSV, explícalo y sugiere qué falta.
`;

  // Para no exceder tokens si el CSV fuera muy grande
  const CSV_MAX = 250_000;
  const csvSnippet = (csvContent || '').slice(0, CSV_MAX);

  const userPrompt = `
### DATOS CSV (trátalos como fuente)
${csvSnippet ? csvSnippet : '(No se pudo cargar el CSV en el servidor. Si esto afecta el cálculo, indícalo.)'}

### PREGUNTA DEL USUARIO
${question}

### INSTRUCCIONES DE FORMATO
Devuelve SOLO un JSON con esta forma exacta:
{
  "texto": "tu explicación o resultado en español, sin asteriscos",
  "tablas_markdown": "si corresponde, coloca aquí tabla(s) en Markdown; si no, deja cadena vacía"
}
`;

  try {
    const client = new OpenAI({ apiKey });

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      // Pedimos JSON, pero no todos los modelos lo acatan perfecto;
      // igual sanitizamos abajo.
      response_format: { type: 'json_object' }
    });

    const raw = completion?.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Si el modelo no devolvió JSON estricto, envolvemos como texto
      parsed = { texto: raw || 'No obtuve respuesta.', tablas_markdown: '' };
    }

    const respuesta = {
      texto: String(parsed.texto || parsed.text || 'No obtuve respuesta.'),
      tablas_markdown: String(parsed.tablas_markdown || parsed.tables_markdown || '')
    };

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(respuesta);
  } catch (err) {
    console.error('[ASK] ERROR OpenAI o procesamiento:', err);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      texto: `Ocurrió un problema procesando la consulta. Detalle: ${err?.message || ''}`,
      tablas_markdown: ''
    });
  }
}
