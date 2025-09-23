// api/ask.js
// (Si al activarlo te da problemas, puedes dejar comentado)
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

// === Config ===
const OPENAI_KEY =
  process.env.open_ai_key ||
  process.env.OPENAI_API_KEY ||
  process.env['CLAVE API DE OPENAI'] ||
  process.env.CLAVE_API_DE_OPENAI;

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CSV_PATH = process.env.CSV_FILE || path.join(process.cwd(), 'datos', 'decimo.csv');

const client = new OpenAI({ apiKey: OPENAI_KEY });

// === Utilidades ===

// Lee el CSV y devuelve encabezados + un preview recortado para no gastar tokens
function readCsvSnapshot() {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');

    // Detecta separador en la primera línea: ; o ,
    const firstLine = raw.split(/\r?\n/)[0] || '';
    const sep = firstLine.includes(';') ? ';' : ',';
    const header = firstLine.split(sep).map((s) => s.trim());

    // Preview razonable (recorta caracteres para no pasarse de tokens)
    const preview = raw.slice(0, 200000); // ~200k chars
    return { ok: true, header, preview, sep };
  } catch (e) {
    console.warn('[ASK][CSV_READ_ERROR]', e?.message || e);
    return { ok: false, header: [], preview: '', sep: ',' };
  }
}

// === Handler principal ===
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

    const { ok, header, preview } = readCsvSnapshot();
    const headerNote = header.length
      ? `Encabezados reales del CSV (${header.length} columnas): ${header.join(' | ')}`
      : `No pude leer el CSV o no hay encabezados.`;

    // Mensaje de sistema (reglas duras)
    const system = `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas DURAS:
- Si el usuario pide "todos los estudiantes", debes listar a TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas solicitadas por el usuario. Si pide varias columnas, inclúyelas todas.
- Presenta las LISTAS/TABLAS en formato Markdown (| Col | ... |) cuando aplique.
- Numera filas implícitamente (la UI agrega columna #).
- Nada de "no puedo realizar". Si falta dato, explica brevemente y ofrece alternativas.
- No uses asteriscos para resaltar (la UI los elimina).`;

    // Mensaje de usuario, con snapshot del CSV si se pudo leer
    const user = ok
      ? `PREGUNTA: "${q}"

${headerNote}

PARTE DEL CSV (representativo, no todo):
"""${preview}"""

Instrucciones de salida:
1) "texto": explicación clara en español (sin asteriscos).
2) "tablas_markdown": si el usuario pidió listas/tablas, entrega TABLA en Markdown con TODAS las filas solicitadas y las columnas exactas; si pidió "todos", no omitas ninguno. Si no aplica tabla, deja vacío.

Devuelve SOLO un JSON con {"texto": "...", "tablas_markdown": "..."}.`
      : `PREGUNTA: "${q}"

${headerNote}

No pude leer CSV. Explica o guía al usuario con lo que sepas, en texto claro.
Si requiere tabla pero no hay datos, indícalo.
Devuelve SOLO un JSON {"texto":"...","tablas_markdown":""}.`;

    // Logs de contexto
    console.log('[ASK][MODEL]', MODEL);
    console.log('[ASK][USER_LEN]', user?.length || 0);
    try {
      const prevLen = (user.match(/"""([\s\S]*?)"""/) || [,''])[1]?.length || 0;
      console.log('[ASK][PREVIEW_LEN]', prevLen);
    } catch (_) {}

    // Helper para ejecutar una llamada con/sin response_format
    async function askOnce({ system, user, useJsonFormat }) {
      const isGpt5 = /^gpt-5/i.test(MODEL);
      const params = {
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // GPT-5 solo acepta temperature = 1
        temperature: isGpt5 ? 1 : 0.2,
        max_completion_tokens: 1200,
      };
      if (useJsonFormat) {
        params.response_format = { type: 'json_object' };
      }

      const c = await client.chat.completions.create(params);
      console.log('[ASK][USAGE]', c?.usage);
      const raw = c?.choices?.[0]?.message?.content || '';
      console.log('[ASK][RAW]', raw ? `${raw.slice(0, 200)}…` : '(vacío)');
      return raw;
    }

    // 1) Primer intento: JSON estricto
    let raw = await askOnce({ system, user, useJsonFormat: true });

    // 2) Si vino vacío, reintenta sin response_format, reforzando indicación
    if (!raw || !raw.trim()) {
      console.warn(
        '[ASK][RETRY] contenido vacío; reintentando sin response_format…'
      );
      const user2 = `${user}

IMPORTANTE: Devuelve SOLO un JSON con esta forma exacta:
{"texto":"...","tablas_markdown":"..."}
No incluyas nada más antes ni después del JSON.`;
      raw = await askOnce({ system, user: user2, useJsonFormat: false });
    }

    // 3) Si sigue vacío, devolvemos un mensaje claro al frontend
    if (!raw || !raw.trim()) {
      return res.status(200).json({
        texto:
          'El modelo no devolvió contenido utilizable en este intento. Intenta con una pregunta más específica o vuelve a consultar en unos segundos.',
        tablas_markdown: '',
      });
    }

    // 4) Parseo robusto
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Si no es JSON, regresamos el texto tal cual (mejor eso que vacío)
      parsed = { texto: raw, tablas_markdown: '' };
    }

    // 5) Saneamos y respondemos
    const texto = String(parsed.texto || parsed.text || '')
      .replace(/\*/g, '')
      .trim();

    const tablas_markdown = String(
      parsed.tablas_markdown || parsed.tables_markdown || ''
    ).trim();

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
