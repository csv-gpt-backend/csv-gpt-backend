// api/ask.js
// (Si al activarlo te da problemas, puedes dejar comentado)
// export const config = { runtime: 'nodejs20.x' };

import OpenAI from 'openai';

// =============== CONFIG ===============
const OPENAI_KEY =
  process.env.open_ai_key ||
  process.env.OPENAI_API_KEY ||
  process.env['CLAVE API DE OPENAI'] ||
  process.env.CLAVE_API_DE_OPENAI;

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Fallbacks por si no hay variables; se sobreescriben usando el host del request
const CSV_URL_FALLBACK = 'https://csv-gpt-backend.vercel.app/datos/decimo.csv';
const TXT_URL_FALLBACK = 'https://csv-gpt-backend.vercel.app/emocionales.txt';

// Recortes para no enviar prompts enormes (mejor latencia/fiabilidad)
const CSV_PREVIEW_LIMIT = 30000;   // ~30k chars
const TXT_PREVIEW_LIMIT = 20000;   // ~20k chars

const client = new OpenAI({ apiKey: OPENAI_KEY });

// =============== HELPERS ===============
function buildSelfURL(req, path) {
  const proto =
    req.headers['x-forwarded-proto']?.toString() ||
    (req.headers.host?.startsWith('localhost') ? 'http' : 'https');
  const host = req.headers.host || 'csv-gpt-backend.vercel.app';
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${proto}://${host}${clean}`;
}

async function fetchText(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} al descargar ${url}`);
    const txt = await r.text();
    return txt;
  } finally {
    clearTimeout(t);
  }
}

function detectSeparator(firstLine = '') {
  return firstLine.includes(';') ? ';' : ',';
}

function csvHeaderFromRaw(raw) {
  const firstLine = (raw.split(/\r?\n/)[0] || '').trim();
  if (!firstLine) return { sep: ',', header: [] };
  const sep = detectSeparator(firstLine);
  const header = firstLine.split(sep).map((s) => s.trim());
  return { sep, header };
}

// =============== HANDLER ===============
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

    // Construir URLs físicas basadas en el host actual
    const csvUrl =
      process.env.CSV_URL ||
      buildSelfURL(req, '/datos/decimo.csv') ||
      CSV_URL_FALLBACK;

    const txtUrl =
      process.env.TXT_URL ||
      buildSelfURL(req, '/emocionales.txt') ||
      TXT_URL_FALLBACK;

    // Descargar fuentes (rápido, con timeout)
    let csvRaw = '';
    let txtRaw = '';
    try {
      csvRaw = await fetchText(csvUrl);
    } catch (e) {
      console.warn('[ASK][CSV_DOWNLOAD_WARN]', e?.message || e);
    }
    try {
      txtRaw = await fetchText(txtUrl);
    } catch (e) {
      console.warn('[ASK][TXT_DOWNLOAD_WARN]', e?.message || e);
    }

    // Preparar previews
    const csvPreview = (csvRaw || '').slice(0, CSV_PREVIEW_LIMIT);
    const txtPreview = (txtRaw || '').slice(0, TXT_PREVIEW_LIMIT);

    const { header } = csvHeaderFromRaw(csvRaw || '');
    const headerNote = header.length
      ? `Encabezados reales del CSV (${header.length} columnas): ${header.join(' | ')}`
      : `No se detectaron encabezados en el CSV (o no se pudo descargar).`;

    // ===== Mensajes =====
    const system = `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral (voz femenina).
Reglas DURAS:
- Si el usuario pide "todos los estudiantes", listalos TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas solicitadas por el usuario.
- Presenta LISTAS/TABLAS en formato Markdown (| Col | ... |).
- Numera filas implícitamente (la UI agrega columna #).
- Nada de "no puedo realizar". Si falta dato, explica brevemente y ofrece alternativas.
- NO uses asteriscos para resaltar.`;

    const user = `PREGUNTA: "${q}"

${headerNote}

FUENTE CSV (preview):
"""${csvPreview}"""

FUENTE TEXTO (emocionales.txt, preview):
"""${txtPreview}"""

Instrucciones de salida:
1) "texto": explicación clara en español (sin asteriscos).
2) "tablas_markdown": si el usuario pidió listas/tablas, entrega TABLA en Markdown con TODAS las filas solicitadas y las columnas exactas; si pidió "todos", no omitas ninguno. Si no aplica tabla, deja vacío.

Devuelve SOLO un JSON con {"texto": "...", "tablas_markdown": "..."}.`;

    console.log('[ASK][MODEL]', MODEL);
    console.log('[ASK][CSV_URL]', csvUrl);
    console.log('[ASK][TXT_URL]', txtUrl);
    console.log('[ASK][USER_LEN]', user.length);

    // Helper para llamada al modelo
    async function askOnce({ useJsonFormat }) {
      const isGpt5 = /^gpt-5/i.test(MODEL);
      const params = {
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: isGpt5 ? 1 : 0.2,
        max_completion_tokens: isGpt5 ? 1200 : 800,
      };
      if (useJsonFormat) {
        params.response_format = { type: 'json_object' };
      }
      const c = await client.chat.completions.create(params);
      console.log('[ASK][USAGE]', c?.usage);
      const raw = c?.choices?.[0]?.message?.content || '';
      console.log('[ASK][RAW]', raw ? raw.slice(0, 220) + '…' : '(vacío)');
      return raw;
    }

    // 1) Primer intento: SIN response_format
    let raw = await askOnce({ useJsonFormat: false });

    // 2) Si vino vacío, reintenta con JSON estricto
    if (!raw || !raw.trim()) {
      console.warn('[ASK][RETRY] vacío; reintentando con response_format json_object…');
      raw = await askOnce({ useJsonFormat: true });
    }

    // 3) Si sigue vacío, mensaje claro
    if (!raw || !raw.trim()) {
      return res.status(200).json({
        texto:
          'El modelo no devolvió contenido utilizable en este intento. Intenta con una pregunta más específica, o vuelve a consultar en unos segundos.',
        tablas_markdown: '',
      });
    }

    // 4) Parseo robusto
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { texto: raw, tablas_markdown: '' };
    }

    // 5) Sanitizar y responder
    const texto = String(parsed.texto || parsed.text || '').replace(/\*/g, '').trim();
    const tablas_markdown = String(parsed.tablas_markdown || parsed.tables_markdown || '').trim();

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
