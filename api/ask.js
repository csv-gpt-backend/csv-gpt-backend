// api/ask.js
// Si te daba error con runtime edge, déjalo comentado.
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

// --- Configuración de claves/modelo ---
const OPENAI_KEY =
  process.env.open_ai_key ||
  process.env.OPENAI_API_KEY;

const MODEL = (process.env.OPENAI_MODEL || 'gpt-5-mini').trim();

// CSV local
const CSV_PATH = process.env.CSV_FILE || path.join(process.cwd(), 'datos', 'decimo.csv');

// PDFs (no los descargamos, se pasan como “fuentes” para evitar lentitud)
const PDF_SOURCES = [
  'https://csv-gpt-backend.vercel.app/lexium.pdf',
  'https://csv-gpt-backend.vercel.app/evaluaciones.pdf',
  'https://csv-gpt-backend.vercel.app/emocionales.pdf', // <- el que te interesa fijo
];

// Cliente OpenAI
const client = new OpenAI({ apiKey: OPENAI_KEY });

// Utilidad: obtener snapshot del CSV (primeras ~200k chars) y encabezados con “;”
function readCsvSnapshot() {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    // ⚠️ Tu CSV usa ';'
    const header = (lines[0] || '').split(';').map(s => s.trim());
    const preview = raw.slice(0, 200000);
    return { ok: true, header, preview };
  } catch (e) {
    console.error('CSV READ ERROR:', e?.message || e);
    return { ok: false, header: [], preview: '' };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res
        .status(405)
        .json({ error: 'Método no permitido. Usa POST con JSON.' });
    }
    if (!OPENAI_KEY) {
      return res.status(200).json({
        texto:
          'Falta la clave de OpenAI (open_ai_key / OPENAI_API_KEY). Configúrala en Vercel.',
        tablas_markdown: '',
      });
    }

    const { question } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      return res
        .status(200)
        .json({ texto: 'Por favor, escribe una pregunta.', tablas_markdown: '' });
    }
    const q = question.trim();

    // CSV snapshot
    const { ok, header, preview } = readCsvSnapshot();
    const headerNote = header.length
      ? `Encabezados reales del CSV (${header.length} columnas): ${header.join(' | ')}`
      : 'No pude leer el CSV en este momento.';

    // Instrucciones (forzamos “;” como delimitador y tablas Markdown)
    const system = `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas DURAS:
- El CSV usa punto y coma como delimitador: ";"
- Si el usuario pide listas/tablas o "puntuaciones", devuelve TABLA en Markdown (| Col | ... |).
- Usa EXACTAMENTE las columnas solicitadas (ej.: Nombre, Empatía, Motivación, etc.).
- Si pide "todos los estudiantes", incluye TODOS (no omitas filas).
- Si falta algún dato, explícalo brevemente y ofrece la mejor alternativa.
- Devuelve SIEMPRE un JSON final con las claves:
  {"texto": "<explicación breve y clara>", "tablas_markdown": "<tabla markdown o vacío>"}
- No uses asteriscos para resaltar (se eliminan en UI).`;

    // Fuentes PDF solo se listan (no se descargan para evitar latencia)
    const fuentes = PDF_SOURCES.map((u, i) => `  ${i + 1}. ${u}`).join('\n');

    const user = ok
      ? `PREGUNTA: "${q}"

${headerNote}
Delimitador del CSV: punto y coma ";"

TROZO REPRESENTATIVO DEL CSV (primeras ~200k chars):
"""${preview}"""

Fuentes PDF disponibles (no se cargan aquí, sirve como contexto):
${fuentes}

Instrucciones de salida:
1) "texto": explicación breve y clara (sin asteriscos).
2) "tablas_markdown": si el usuario pidió listas/tablas, entrega TABLA en Markdown con TODAS las filas/columnas solicitadas. Si no aplica, deja vacío.

Devuelve SOLO un JSON con {"texto": "...", "tablas_markdown": "..."}.`
      : `PREGUNTA: "${q}"

${headerNote}
Delimitador del CSV: punto y coma ";"

No pude leer CSV ahora mismo. Explica u orienta al usuario con lo que sepas (sin inventar).
Fuentes PDF disponibles (no se cargan aquí, sirve como contexto):
${fuentes}

Devuelve SOLO un JSON: {"texto":"...","tablas_markdown":""}.`;

    // ---------- Utilidades de parseo + fallback ----------
    function safeParseToObj(s) {
      if (!s || typeof s !== 'string') return null;
      try {
        return JSON.parse(s);
      } catch (_) {}
      // bloque ```json ... ```
      const fenced = s.match(/```json([\s\S]*?)```/i);
      if (fenced) {
        try {
          return JSON.parse(fenced[1]);
        } catch (_) {}
      }
      // primer {...}
      const braced = s.match(/\{[\s\S]*\}/);
      if (braced) {
        try {
          return JSON.parse(braced[0]);
        } catch (_) {}
      }
      return null;
    }

    async function callAndParse(modelId) {
      const isG5 = /^gpt-5/i.test(modelId);
      const resp = await client.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...(isG5
          ? { temperature: 1, max_completion_tokens: 1000 }
          : {
              temperature: 0.2,
              max_completion_tokens: 1500,
              response_format: { type: 'json_object' },
            }),
      });

      let raw =
        resp?.choices?.[0]?.message?.content ||
        resp?.choices?.[0]?.message?.refusal ||
        '';

      // Log de debug (corto)
      console.log(`[${modelId}] RAW >>>`, (raw || '').slice(0, 500));

      let parsed = safeParseToObj(raw);
      if (!parsed || typeof parsed !== 'object') {
        // Devolvemos texto crudo para no dejar sin respuesta.
        parsed = { texto: String(raw || 'No pude obtener contenido.'), tablas_markdown: '' };
      }
      // Normaliza claves
      const texto = String(parsed.texto || parsed.text || '').replace(/\*/g, '').trim();
      const tablas_markdown = String(parsed.tablas_markdown || parsed.tables_markdown || '').trim();
      return { texto, tablas_markdown, ok: Boolean(texto) };
    }

    // 1º intento con el modelo configurado (ej. gpt-5 o gpt-5-mini)
    let { texto, tablas_markdown, ok } = await callAndParse(MODEL);

    // Si vino vacío o mal formateado, reintenta con gpt-4o-mini (muy bueno para tablas)
    if (!ok || (!tablas_markdown && /tabla|puntuaci|lista|estudiante|promedio/i.test(q))) {
      try {
        const fallbackModel = 'gpt-4o-mini';
        console.log('Reintentando con', fallbackModel);
        ({ texto, tablas_markdown, ok } = await callAndParse(fallbackModel));
      } catch (e) {
        console.log('Fallback error:', e?.message || e);
      }
    }

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ texto, tablas_markdown });
  } catch (err) {
    console.error('ASK ERROR:', err?.message || err);
    return res.status(200).json({
      texto: `Error: ${err?.message || 'Desconocido'}.`,
      tablas_markdown: '',
    });
  }
}
