// api/ask.js
// (Si al activarlo te da problemas, puedes dejar comentado)
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OPENAI_KEY = process.env.open_ai_key || process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CSV_PATH = process.env.CSV_FILE || path.join(process.cwd(), 'datos', 'decimo.csv');

// PDFs: define en Vercel "PDF_FILES" como lista separada por comas (ej. "emocionales.pdf,evaluaciones.pdf")
const PDF_FILES_ENV = (process.env.PDF_FILES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const client = new OpenAI({ apiKey: OPENAI_KEY });

/* ---------------- CSV helpers ---------------- */

function detectDelimiter(firstLine = '') {
  const candidates = [';', ',', '\t', '|'];
  let best = ',', max = -1;
  for (const d of candidates) {
    const c = (firstLine.match(new RegExp(`\\${d}`, 'g')) || []).length;
    if (c > max) { max = c; best = d; }
  }
  return best;
}

function readCsvSnapshot() {
  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const first = lines[0] || '';
    const delimiter = detectDelimiter(first);
    const header = first
      .split(delimiter)
      .map(s => s.trim().replace(/^"|"$/g, ''));

    // Enviamos un trozo representativo (para no explotar tokens)
    const preview = raw.slice(0, 200000); // 200k chars aprox
    return { ok: true, header, preview, delimiter };
  } catch (e) {
    return { ok: false, header: [], preview: '', delimiter: ',' };
  }
}

/* ---------------- PDF helpers (opcional) ---------------- */

// Intentamos cargar pdf-parse si está instalado
let pdfParse = null;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  pdfParse = (await import('pdf-parse')).default;
} catch (_) {
  // Si no está, continuamos sin PDFs
  pdfParse = null;
}

function findFileInProject(filename) {
  const roots = [
    process.cwd(),
    path.join(process.cwd(), 'datos'),
  ];
  for (const r of roots) {
    const p = path.join(r, filename);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function readPdfsText() {
  if (!PDF_FILES_ENV.length) {
    return { note: 'No hay PDFs definidos en PDF_FILES.', combinedText: '' };
  }
  if (!pdfParse) {
    return { note: 'No se encontró pdf-parse; instala "pdf-parse" para analizar PDFs.', combinedText: '' };
  }

  const results = [];
  for (const name of PDF_FILES_ENV) {
    const filePath = findFileInProject(name);
    if (!filePath) {
      results.push(`(No encontrado: ${name})`);
      continue;
    }
    try {
      const buf = fs.readFileSync(filePath);
      const parsed = await pdfParse(buf);
      const text = (parsed?.text || '').replace(/\s+/g, ' ').trim();
      results.push(`### ${path.basename(filePath)}\n${text.substring(0, 100000)}`); // máx 100k por PDF
    } catch (e) {
      results.push(`(Error leyendo ${name}: ${e?.message || e})`);
    }
  }

  const combinedText = results.join('\n\n');
  return { note: 'PDFs analizados.', combinedText };
}

/* ---------------- Handler ---------------- */

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

    // CSV
    const { ok, header, preview, delimiter } = readCsvSnapshot();
    const headerNote = ok && header.length
      ? `Encabezados reales del CSV (${header.length} columnas): ${header.join(' | ')}`
      : `No pude leer el CSV.`;

    // PDFs (opcional)
    const { note: pdfNote, combinedText: pdfsText } = await readPdfsText();

    const system = `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas DURAS:
- Si el usuario pide "todos los estudiantes", debes listar a TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas solicitadas por el usuario. Si pide varias columnas, inclúyelas todas.
- Presenta las LISTAS/TABLAS en formato Markdown (| Col | ... |) cuando aplique, sin asteriscos decorativos.
- Numera filas implícitamente (la UI agrega una columna #).
- No inventes columnas; usa el delimitador indicado para interpretar el CSV.
- Si se solicita información de los PDFs, apóyate en el texto proporcionado (si existe).`;

    const user = ok
      ? `PREGUNTA: "${q}"

${headerNote}
DELIMITADOR_CSV: "${delimiter}"  <-- Usa SIEMPRE este delimitador para separar columnas.

TROZO DEL CSV (representativo, no todo):
"""${preview}"""

${pdfsText
  ? `FRAGMENTOS RELEVANTES DESDE PDFs (si aplican a la pregunta):
"""${pdfsText}"""`

  : `(Sin texto de PDFs disponible) ${pdfNote || ''}`
}

Instrucciones de salida:
1) "texto": explicación clara en español (sin asteriscos).
2) "tablas_markdown": si el usuario pidió listas/tablas, entrega TABLA en Markdown con TODAS las filas solicitadas y las columnas exactas; si pidió "todos", no omitas ninguno. Si no aplica tabla, deja vacío.

Devuelve SOLO un JSON con {"texto": "...", "tablas_markdown": "..."}.`
      : `PREGUNTA: "${q}"

${headerNote}

${pdfsText
  ? `FRAGMENTOS RELEVANTES DESDE PDFs:
"""${pdfsText}"""`

  : `(Sin texto de PDFs disponible) ${pdfNote || ''}`
}

No pude leer el CSV. Explica o guía al usuario en texto claro.
Si requiere tabla pero no hay datos, indícalo.
Devuelve SOLO un JSON {"texto":"...","tablas_markdown":""}.`;

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
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
