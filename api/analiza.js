// api/analiza.js  (Vercel Serverless Function - ESM)

import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';

// ======== CONFIG ========
// Modelo por defecto (puedes cambiarlo por el que prefieras)
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; // o 'gpt-5' cuando esté disponible
// Ruta(s) posibles del CSV dentro del bundle
const CSV_CANDIDATES = [
  path.join(process.cwd(), 'public', 'datos.csv'),
  path.join(process.cwd(), 'datos.csv'),
];

// ======== CARGA CSV (cacheada) ========
let __csvCache = { rows: null, headers: null };

async function readCsvFile() {
  // prueba cada ruta candidata
  for (const p of CSV_CANDIDATES) {
    try {
      const txt = await fs.readFile(p, 'utf8');
      return txt;
    } catch { /* probar siguiente */ }
  }
  throw new Error('No encontré public/datos.csv ni ./datos.csv en el deployment.');
}

// Parser CSV básico que respeta comillas
function parseCsv(text) {
  const rows = [];
  let cur = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { // comilla escapada
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cur.push(cell);
        cell = '';
      } else if (ch === '\n') {
        cur.push(cell);
        rows.push(cur);
        cur = [];
        cell = '';
      } else if (ch === '\r') {
        // ignorar \r (windows)
      } else {
        cell += ch;
      }
    }
  }
  // última celda/fila
  if (cell.length > 0 || cur.length) {
    cur.push(cell);
    rows.push(cur);
  }
  return rows;
}

async function loadCsvOnce() {
  if (__csvCache.rows) return __csvCache;

  const raw = await readCsvFile();
  const rows = parseCsv(raw).filter(r => r.length && r.some(x => String(x).trim() !== ''));
  if (rows.length < 2) throw new Error('CSV vacío o sin datos suficientes.');

  const headers = rows[0].map(h => String(h).trim());
  const dataRows = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });
    return obj;
  });

  __csvCache = { rows: dataRows, headers };
  return __csvCache;
}

// ======== UTILIDADES ========
function detectNameColumn(headers) {
  // prioriza columnas comunes
  const lower = headers.map(h => h.toLowerCase());
  const candidates = ['alumno', 'alumna', 'nombre', 'nombres', 'estudiante'];
  for (const c of candidates) {
    const idx = lower.findIndex(h => h.includes(c));
    if (idx !== -1) return headers[idx];
  }
  // si no encuentra, intenta la primera que no sea claramente numérica
  return headers[0];
}

function isNumeric(v) {
  const x = typeof v === 'string' ? v.replace(',', '.').trim() : v;
  return x !== '' && Number.isFinite(Number(x));
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').replace(',', '.').trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function computeMetrics(rows, numericCols) {
  const metrics = {};
  for (const col of numericCols) {
    const arr = rows
      .map(r => toNumber(r[col]))
      .filter(v => v !== null)
      .sort((a, b) => a - b);

    if (!arr.length) continue;

    const sum = arr.reduce((a, b) => a + b, 0);
    metrics[col] = {
      n: arr.length,
      min: arr[0],
      max: arr[arr.length - 1],
      mean: sum / arr.length,
      p25: quantile(arr, 0.25),
      p50: quantile(arr, 0.50),
      p75: quantile(arr, 0.75),
      p90: quantile(arr, 0.90),
    };
  }
  return metrics;
}

function extractNameFromQuestion(q) {
  // busca texto entre comillas "Julia"
  const quoted = q.match(/"([^"]+)"/);
  if (quoted?.[1]) return quoted[1].trim();

  // si no hay comillas, intenta coger una palabra tipo nombre
  // (esto es heurístico; puedes cambiarlo por tu input "alumno=...")
  const m = q.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/);
  if (m?.[1]) return m[1].trim();
  return null;
}

// ======== OPENAI ========
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function askOpenAI({ model, system, input }) {
  const resp = await client.responses.create({
    model: model || DEFAULT_MODEL,
    // IMPORTANTE: no mandar temperature para evitar el error de modelos que no lo soportan
    input,
    system,
  });
  return resp.output_text || '';
}

// ======== HANDLER ========
export default async function handler(req, res) {
  // --- CORS ---
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  // ------------------------

  try {
    const q = (req.query?.q || req.body?.q || '').toString().trim();
    if (!q) {
      res.status(400).json({ ok: false, error: 'Falta el parámetro q.' });
      return;
    }

    // 1) Cargar CSV
    const { rows, headers } = await loadCsvOnce();
    const nameCol = detectNameColumn(headers);

    // 2) Columnas numéricas
    const numericCols = headers.filter(h => rows.some(r => isNumeric(r[h])));

    // 3) Detectar alumno (si viene ?alumno= usarlo; si no, extraer del texto)
    const alumnoQ = (req.query?.alumno || '').toString().trim();
    const alumnoName = alumnoQ || extractNameFromQuestion(q) || '';

    let alumnoRow = null;
    if (alumnoName) {
      const needle = alumnoName.toLowerCase();
      alumnoRow = rows.find(r => String(r[nameCol] || '').toLowerCase().includes(needle)) || null;
    }

    // 4) Métricas de grupo
    const groupMetrics = computeMetrics(rows, numericCols);

    // 5) Construir contexto para el modelo
    const payload = {
      alumno: alumnoRow ? String(alumnoRow[nameCol]) : '(no encontrado)',
      nameColumn: nameCol,
      question: q,
      columns_numeric: numericCols,
      student_values: alumnoRow
        ? Object.fromEntries(
            numericCols.map(c => [c, toNumber(alumnoRow[c])])
          )
        : null,
      groupMetrics, // medias y percentiles del grupo
    };

    const system = `
Eres un analista educativo. SOLO puedes responder usando el JSON que te doy.
No inventes datos que no estén en el JSON. Si falta información, dilo.
Responde en español claro, breve, y cita números (medias/percentiles) cuando aplique.
`;

    const prompt = `
JSON con datos:
${JSON.stringify(payload, null, 2)}

Instrucción:
- Contesta estrictamente a la pregunta del usuario usando únicamente los datos del JSON anterior.
- Si el alumno no se encontró, dilo y sugiere verificar el nombre.
- Si se pide "¿Cómo está <alumno> en AUTOESTIMA?" compara su valor con la media y percentiles del grupo.
- Formato: párrafo breve (máx 6-8 líneas).`;

    const respuesta = await askOpenAI({
      system,
      input: prompt,
      model: DEFAULT_MODEL,
    });

    res.status(200).json({
      ok: true,
      respuesta,
      alumno: payload.alumno,
      metrics: groupMetrics,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'Error interno' });
  }
}
