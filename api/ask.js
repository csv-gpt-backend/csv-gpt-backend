// api/ask.js
// (Si al activarlo te da problemas, puedes dejar comentado)
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// 🔒 Fuentes fijas (solo estas)
const CSV_PATH = process.env.CSV_FILE || path.join(process.cwd(), 'datos', 'decimo.csv');
const PDF_URLS = [
  'https://csv-gpt-backend.vercel.app/emocionales.pdf'
];

// Utilidad: lee CSV y produce encabezados + preview corto
function readCsvSnapshot() {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const headerLine = lines[0] || '';
    // Autodetección del separador: ; tiene prioridad si hay más ;
    const semi = (headerLine.match(/;/g) || []).length;
    const comma = (headerLine.match(/,/g) || []).length;
    const sep = semi > comma ? ';' : ',';
    const header = headerLine.split(sep).map(s => s.trim());

    // Preview limitado: suficiente para orientar al modelo sin volver lenta la petición
    const preview = raw.slice(0, 20000); // 20k chars
    return { ok: true, header, preview, sep };
  } catch (e) {
    return { ok: false, header: [], preview: '', sep: ',' };
  }
}

const client = new OpenAI({ apiKey: OPENAI_KEY });

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
    }
    if (!OPENAI_KEY) {
      return res.status(200).json({
        texto: 'Falta la clave de OpenAI (open_ai_key). Configúrala en Vercel.',
        tablas_markdown: ''
      });
    }

    const { question } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(200).json({ texto: 'Por favor, escribe una pregunta.', tablas_markdown: '' });
    }
    const q = question.trim();

    const { ok, header, preview, sep } = readCsvSnapshot();
    const headerNote = ok
      ? `Encabezados del CSV (${header.length} columnas, sep="${sep}"): ${header.join(' | ')}`
      : `No pude leer el CSV (verifica ruta y permisos en el deploy).`;

    // Instrucciones compactas y estrictas
    const system = `Eres analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas:
- Prioriza datos del CSV "decimo.csv". Si el usuario lo solicita, puedes complementar con "emocionales.pdf".
- Si piden "todos los estudiantes", no omitas ninguno.
- Usa EXACTAMENTE las columnas pedidas. Si piden varias, inclúyelas todas.
- Devuelve tablas en Markdown (| Col | ... |) y sin asteriscos decorativos.
- No inventes datos. Si falta algo, dilo con claridad y sugiere alternativas.
- El CSV puede estar separado por ";" o "," (ya detectado). Interprétalo correctamente.`;

    const user = ok
      ? `PREGUNTA: "${q}"

${headerNote}

FUENTES:
- CSV local: decimo.csv
- PDF: ${PDF_URLS.join(', ')}

TROZO DEL CSV (representativo):
"""${preview}"""

SALIDA:
Devuelve SOLO un JSON: {"texto": "...", "tablas_markdown": "..."}.
- "texto": explicación clara en español.
- "tablas_markdown": tabla en Markdown si corresponde (todas las filas pedidas, columnas exactas, encabezados claros).
Si no aplica tabla, deja "tablas_markdown" vacío.`
      : `PREGUNTA: "${q}"

${headerNote}

FUENTES:
- PDF: ${PDF_URLS.join(', ')}

No pude leer CSV. Explica con lo que sepas y sugiere cómo ubicar/adjuntar el CSV correcto.
SALIDA JSON {"texto":"...","tablas_markdown":""}.`;

    // Para modelos GPT-5 chat se omite temperature (solo default 1)
    const isGpt5 = /^gpt-5/i.test(MODEL) || /gpt-5-chat/i.test(MODEL);
    const common = {
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      response_format: { type: 'json_object' },
      // seguridad
      max_tokens: 1200
    };

 const completion = await client.chat.completions.create({
  model: MODEL,
  messages: [
    { role: 'system', content: system },
    { role: 'user',   content: user }
  ],
  temperature: 1,                // GPT-5 solo acepta 1
  max_completion_tokens: 1000    // ✅ Parámetro correcto
});

    const raw = completion?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = { texto: raw, tablas_markdown: '' }; }

    const texto = String(parsed.texto || parsed.text || '').replace(/\*/g,'').trim();
    const tablas_markdown = String(parsed.tablas_markdown || parsed.tables_markdown || '').trim();

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ texto, tablas_markdown });
  } catch (err) {
    console.error('ASK ERROR:', err?.message || err);
    return res.status(200).json({
      texto: `Error: ${err?.message || 'Desconocido'}.`,
      tablas_markdown: ''
    });
  }
}
