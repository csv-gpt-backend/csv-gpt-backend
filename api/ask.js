// api/ask.js
// SOLO GPT-5, sin PDFs. Lee datos/decimo.csv (auto ; o ,). Respuesta JSON: {texto, tablas_markdown}

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;
const MODEL = 'gpt-5'; // Solo GPT-5 como pediste

// Ruta fija del CSV (no depende de variables de Vercel)
const CSV_PATH = path.join(process.cwd(), 'datos', 'decimo.csv');

const client = new OpenAI({ apiKey: OPENAI_KEY });

// Lee CSV (recorta para velocidad) y detecta delimitador ; o ,
function readCsvSnapshot(maxChars = 60000) {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const firstLine = raw.split(/\r?\n/)[0] || '';
    // Detectar separador predominante
    const semi = (firstLine.match(/;/g) || []).length;
    const comma = (firstLine.match(/,/g) || []).length;
    const sep = semi >= comma ? ';' : ',';

    const header = firstLine.split(sep).map(s => s.trim());
    return {
      ok: true,
      header,
      sep,
      preview: raw.slice(0, maxChars)
    };
  } catch (e) {
    console.error('CSV READ ERROR:', e.message);
    return { ok: false, header: [], sep: ';', preview: '' };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
    }
    if (!OPENAI_KEY) {
      return res.status(200).json({
        texto: 'Falta la clave de OpenAI (open_ai_key) en Vercel.',
        tablas_markdown: ''
      });
    }

    const { question } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(200).json({ texto: 'Por favor, escribe una pregunta.', tablas_markdown: '' });
    }
    const q = question.trim();

    const { ok, header, sep, preview } = readCsvSnapshot();
    const headerNote = ok
      ? `Encabezados reales (${header.length} columnas, sep="${sep}"): ${header.join(' | ')}`
      : `No pude leer el CSV en datos/decimo.csv.`;

    // Prompt sistema (reglas firmes)
    const system = `Eres una analista educativa rigurosa (voz femenina, español latino MX/EC).
Reglas:
- Responde SIEMPRE en español latino. Sin asteriscos.
- Si piden "todos los estudiantes", incluye a TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas solicitadas (si piden varias, inclúyelas todas).
- Cuando se pidan listas/ordenamientos/tablas, entrega TABLAS en Markdown (| Col1 | Col2 | ... |) con cabecera y filas completas.
- La UI agregará numeración; no generes una primera columna "#" (solo las columnas pedidas).
- Realiza cálculos estadísticos (promedios, varianzas, correlaciones, regresiones simples) usando los datos disponibles.
- Si falta información, explica brevemente y sugiere cómo proceder.
- Devuelve SOLO un JSON válido con las claves: {"texto": "...", "tablas_markdown": "..."}.`;

    // Prompt usuario con snapshot del CSV
    let user = `PREGUNTA: "${q}"

${headerNote}

Fragmento representativo del CSV (solo para contexto; puede estar recortado):
"""${preview}"""

Indicaciones de salida:
- "texto": Explicación clara en español (sin asteriscos).
- "tablas_markdown": Si el usuario solicitó listas/tablas, devuelve una tabla Markdown con las columnas EXACTAS que pidió y todas las filas solicitadas (sin columna de numeración). Si no aplica tabla, deja cadena vacía.
- SOLO devuelve el JSON pedido (sin texto adicional).`;

    // Llamada a GPT-5 (parámetros compatibles)
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      // Para GPT-5: temperatura fija en 1, y usar max_completion_tokens (no max_tokens)
      temperature: 1,
      max_completion_tokens: 1000,
      response_format: { type: 'json_object' }
    });

    const raw = completion?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = { texto: raw, tablas_markdown: '' }; }

    const texto = String(parsed.texto || parsed.text || '').replace(/\*/g, '').trim();
    const tablas_markdown = String(parsed.tablas_markdown || '').trim();

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ texto, tablas_markdown });
  } catch (err) {
    console.error('ASK ERROR:', err?.message || err);
    // Devolvemos 200 para que el front no caiga en catch y muestre el mensaje de error de forma amable
    return res.status(200).json({
      texto: `Error del servidor: ${err?.message || 'desconocido'}.`,
      tablas_markdown: ''
    });
  }
}
