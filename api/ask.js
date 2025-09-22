// api/ask.js
// (Si al activarlo te da problemas, puedes dejar comentado)
// export const config = { runtime: 'nodejs20.x' };

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

// ====== ENV ======
const OPENAI_KEY  = process.env.open_ai_key || process.env.OPENAI_API_KEY || '';
const MODEL       = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CSV_PATH    = process.env.CSV_FILE || path.join(process.cwd(), 'datos', 'decimo.csv');

// PDFs: locales o por URL (GitHub RAW)
const PDF_FILES = (process.env.PDF_FILES || '').split(',').map(s => s.trim()).filter(Boolean);
const PDF_URLS  = (process.env.PDF_URLS  || '').split(',').map(s => s.trim()).filter(Boolean);

const client = new OpenAI({ apiKey: OPENAI_KEY });

// ====== UTIL: CSV parser sin dependencias (comillas y comas) ======
function parseCSV(raw) {
  const lines = raw.split(/\r?\n/);
  const rows = [];
  for (let line of lines) {
    if (line === '') continue;
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { // escape ""
          cur += '"'; i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    rows.push(out.map(c => c.trim()));
  }
  return rows;
}

// Normaliza texto para “match” de columnas
const norm = (s) => (s ?? '').toString()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ').trim().toLowerCase();

// Mapa robusto de 18 columnas (añade alias comunes)
const COLMAP = {
  nombre: ['nombre','estudiante','alumno'],
  promedio_hab_interpersonales: [
    'promedio de habilidades interpersonales','promedio habilidades interpersonales','habilidades interpersonales','interpersonales'
  ],
  motivacion: ['motivación','motivacion'],
  compromiso: ['compromiso'],
  administracion_tiempo: ['administración del tiempo','administracion del tiempo','tiempo'],
  toma_decisiones: ['toma de decisiones','decisiones'],
  liderazgo: ['liderazgo'],
  promedio_hab_vida: ['promedio de habilidades para la vida','habilidades para la vida','vida'],
  promedio_inteligencia_emocional: ['promedio de inteligencia emocional','inteligencia emocional','emocional'],
  agresion: ['agresión','agresion'],
  timidez: ['timidez'],
  propension_cambio: ['propensión al cambio','propension al cambio','cambio'],
  empatia: ['empatía','empatia'],
  asertividad: ['asertividad'],
  manejo_estres: ['manejo de estrés','manejo de estres','estres','estrés'],
  resiliencia: ['resiliencia'],
  autocontrol: ['autocontrol'],
  comunicacion: ['comunicación','comunicacion']
};

// Encabezado CSV → índices usando COLMAP
function mapHeaders(csvHeaders) {
  const mapped = {};
  csvHeaders.forEach((h, idx) => {
    const H = norm(h);
    for (const key of Object.keys(COLMAP)) {
      const aliases = COLMAP[key].map(norm);
      if (aliases.some(a => H.includes(a))) {
        if (mapped[key] == null) mapped[key] = idx;
      }
    }
    if (mapped.nombre == null && /nombre/i.test(h)) mapped.nombre = idx;
  });
  return mapped;
}

// Detecta columnas pedidas en la pregunta
function detectRequestedColumns(question) {
  const q = norm(question);
  if (/todos? los estudiantes|todas? las columnas|todos los datos|muestrame todo|lista completa/.test(q)) {
    return []; // => todas
  }
  const wanted = [];
  for (const key of Object.keys(COLMAP)) {
    const aliases = COLMAP[key].map(norm);
    if (aliases.some(a => q.includes(a))) wanted.push(key);
  }
  if (wanted.length && !wanted.includes('nombre')) wanted.unshift('nombre');
  return wanted;
}

// Construye tabla a partir de matriz + headerMap + columnas pedidas
function buildTable(matrix, csvHeaders, headerMap, requestedKeys = null) {
  const allOrder = Object.keys(COLMAP);
  const keys = (requestedKeys && requestedKeys.length)
    ? requestedKeys.filter(k => headerMap[k] != null)
    : allOrder.filter(k => headerMap[k] != null);

  const headers = keys.map(k => {
    const base = COLMAP[k]?.[0] || k;
    return base.replace(/\b\w/g, c => c.toUpperCase());
  });

  const rows = matrix.map(row => keys.map(k => row[headerMap[k]] ?? ''));
  return { headers, rows };
}

// Convierte tabla a Markdown (para el front actual)
function tableToMarkdown(headers, rows) {
  if (!headers?.length) return '';
  const headerRow = '| ' + headers.join(' | ') + ' |';
  const sepRow = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const bodyRows = rows.map(r => '| ' + r.map(v => String(v ?? '')).join(' | ') + ' |');
  return [headerRow, sepRow, ...bodyRows].join('\n');
}

// ====== PDF SUPPORT ======
async function dynamicImportPdfParse() {
  try {
    const m = await import('pdf-parse'); // requiere "pdf-parse" en package.json
    return m.default || m;
  } catch {
    return null; // si no está instalada, seguimos sin PDF
  }
}

async function fetchAsBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar: ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function loadPdfTexts() {
  const pdfParse = await dynamicImportPdfParse();
  if (!pdfParse) return ''; // sin dependencia, devolvemos vacío

  const texts = [];

  // 1) Locales (si existen)
  for (const rel of PDF_FILES) {
    try {
      const full = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
      const buf = fs.readFileSync(full);
      const data = await pdfParse(buf);
      if (data?.text) texts.push(`# ${rel}\n${data.text}`);
    } catch {}
  }

  // 2) URLs (GitHub RAW)
  for (const url of PDF_URLS) {
    if (!url) continue;
    try {
      const buf = await fetchAsBuffer(url);
      const data = await pdfParse(buf);
      if (data?.text) texts.push(`# ${url}\n${data.text}`);
    } catch {}
  }

  // Limitar contexto (para no exceder tokens)
  let joined = texts.join('\n\n---\n\n');
  const MAX = 200_000; // 200k chars
  if (joined.length > MAX) joined = joined.slice(0, MAX);
  return joined;
}

// ====== HANDLER ======
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

    // ====== LECTURA COMPLETA DEL CSV (todas las filas) ======
    let raw;
    try {
      raw = fs.readFileSync(CSV_PATH, 'utf8');
    } catch (e) {
      return res.status(200).json({
        texto: `No encontré el CSV en "${CSV_PATH}". Verifica la ruta (datos/decimo.csv).`,
        tablas_markdown: ''
      });
    }
    const arr = parseCSV(raw);
    if (arr.length < 2) {
      return res.status(200).json({
        texto: 'El CSV no tiene datos suficientes (encabezado o filas).',
        tablas_markdown: ''
      });
    }

    const csvHeaders = arr[0];
    const dataRows = arr.slice(1);
    const headerMap = mapHeaders(csvHeaders);
    const requested = detectRequestedColumns(q);
    const tabla = buildTable(dataRows, csvHeaders, headerMap, requested);

    // ====== CARGA PDFs (locales/URLs) ======
    const pdfText = await loadPdfTexts();

    // ====== TEXTO con OpenAI (usa CSV+PDFs) ======
    let texto = '';
    try {
      const system = `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas DURAS:
- La tabla con datos tabulares ya fue construida en el servidor; NO inventes filas/columnas.
- Puedes usar el CONTEXTO DE PDFs (si existe) para sustentar explicaciones y referencias conceptuales.
- No inventes citas ni páginas; si algo no está, dilo de forma breve y sugiere cómo pedirlo.`;

      const user = `PREGUNTA: "${q}"

RESUMEN TABLA CSV:
- Filas: ${tabla.rows.length}
- Columnas: ${tabla.headers.join(', ')}

CONTEXTO DE PDFs (texto extraído, puede estar truncado):
${pdfText ? '"""' + pdfText + '"""' : '(No hay PDFs cargados o no fue posible extraer texto).'}

TAREA:
Redacta una explicación breve y clara. Si el usuario pidió listas/tablas, no repitas la tabla (ya se envía aparte); solo explica hallazgos, cálculos o interpretación con apoyo del contexto de los PDFs.`;

      const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user }
        ],
        temperature: 0.2
      });
      texto = (completion?.choices?.[0]?.message?.content || '').replace(/\*/g, '').trim();
    } catch (e) {
      texto = 'Aquí tienes la información solicitada a partir del CSV y, si aplica, de los PDFs.';
    }

    // ====== Markdown (para tu front actual) ======
    const tablas_markdown = tableToMarkdown(tabla.headers, tabla.rows);

    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      texto,
      tablas_markdown,
      tabla // extra opcional por si luego lo aprovechas
    });

  } catch (err) {
    console.error('ASK ERROR:', err?.message || err);
    return res.status(200).json({
      texto: `Error: ${err?.message || 'Desconocido'}.`,
      tablas_markdown: ''
    });
  }
}
