// api/analiza.js
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';

const MODEL = process.env.MODEL || 'gpt-5';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const isNumber = (v) => v !== null && v !== '' && !isNaN(Number(v));
const toNum = (v) => (isNumber(v) ? Number(v) : null);

function quantile(sortedArray, q) {
  if (!sortedArray.length) return null;
  const pos = (sortedArray.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedArray[base] === undefined) return null;
  if (sortedArray[base + 1] === undefined) return sortedArray[base];
  return sortedArray[base] + rest * (sortedArray[base + 1] - sortedArray[base]);
}

function stats(values) {
  const nums = values.map(toNum).filter((x) => x !== null).sort((a, b) => a - b);
  const n = nums.length;
  if (!n) {
    return { n: 0, min: null, max: null, mean: null, p25: null, p50: null, p75: null, p90: null };
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  return {
    n,
    min: nums[0],
    max: nums[n - 1],
    mean: Number(mean.toFixed(2)),
    p25: Number(quantile(nums, 0.25)?.toFixed(2)),
    p50: Number(quantile(nums, 0.50)?.toFixed(2)),
    p75: Number(quantile(nums, 0.75)?.toFixed(2)),
    p90: Number(quantile(nums, 0.90)?.toFixed(2)),
  };
}

async function loadCsvOnce() {
  if (globalThis.__CSV_CACHE) return globalThis.__CSV_CACHE;
  const filePath = path.join(process.cwd(), 'public', 'datos.csv');
  const csvText = fs.readFileSync(filePath, 'utf8');
  const parsed = Papa.parse(csvText, { header: true, dynamicTyping: false, skipEmptyLines: true });
  if (parsed.errors?.length) console.error('CSV parse errors:', parsed.errors.slice(0, 3));
  const rows = parsed.data.map((r) => {
    const out = {};
    for (const k of Object.keys(r)) out[k.trim()] = (r[k] ?? '').toString().trim();
    return out;
  });
  globalThis.__CSV_CACHE = rows;
  return rows;
}

function detectNumericCols(rows) {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0] || {});
  return cols.filter((c) => {
    const vals = rows.map((r) => r[c]).filter((v) => v !== undefined);
    const ok = vals.filter((v) => isNumber(v)).length;
    return ok / Math.max(vals.length, 1) >= 0.6;
  });
}

function groupBy(rows, col) {
  const map = new Map();
  for (const r of rows) {
    const key = (r[col] ?? '').toString();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

function computeGroupMetrics(rows, groupCol, numericCols) {
  const groups = groupBy(rows, groupCol);
  const result = [];
  for (const [g, arr] of groups.entries()) {
    const obj = { grupo: g || '(sin grupo)' };
    for (const c of numericCols) obj[c] = stats(arr.map((r) => r[c]));
    result.push(obj);
  }
  return result;
}

function pickStudentRows(rows, alumnoQuery, alumnoCol = 'ALUMNO') {
  if (!alumnoQuery) return [];
  const q = alumnoQuery.toLowerCase();
  return rows.filter((r) => (r[alumnoCol] || '').toLowerCase().includes(q));
}

function extractPossibleAlumno(q) {
  if (!q) return null;
  const mQuoted = q.match(/"([^"]+)"/);
  if (mQuoted) return mQuoted[1];
  const mName = q.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/);
  return mName ? mName[1] : null;
}

function buildSystemPrompt(groupCol, numericCols, detectedGroups) {
  return `
Eres un analista que responde en ESPAÑOL. Reglas:
- Usa SOLO los datos del contexto.
- Incluye TODOS los grupos detectados (${detectedGroups.join(', ')}) en comparaciones.
- Cuando compares grupos, usa "Formato: Tabla" y "Fuente: Ambos".
- Reporta métricas exactas calculadas (n, min, max, media, p25, p50, p75, p90).
- No inventes alumnos ni variables. Si faltan datos, dilo.

Variables numéricas detectadas: ${numericCols.join(', ')}
Columna de grupo: ${groupCol}
`;
}

function buildUserPrompt(question, studentRows, groupMetrics, alumnoCol = 'ALUMNO') {
  return `
[PREGUNTA DEL USUARIO]
${question}

[SELECCIÓN: FILAS DE ALUMNO]
${JSON.stringify(studentRows.slice(0, 24), null, 2)}

[MÉTRICAS POR GRUPO]
${JSON.stringify(groupMetrics, null, 2)}

Instrucción final: Responde en español, conciso y centrado en la pregunta. Si hay un alumno, compáralo con su grupo y con el total de grupos. Si la pregunta es por AUTOESTIMA o EMPATÍA, enfócate en esas; si pide "PH interpersonales", incluye todas las columnas relevantes detectadas. Si procede, usa una tabla con grupos en columnas y métricas en filas.
`;
}

async function callOpenAI({ system, user }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no está configurado.');
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const text =
    data.output_text ||
    data?.output?.[0]?.content?.[0]?.text ||
    data?.choices?.[0]?.message?.content ||
    JSON.stringify(data);
  return text;
}

export default async function handler(req, res) {
  try {
    const rows = await loadCsvOnce();
    if (!rows.length) return res.status(500).json({ ok: false, error: 'CSV vacío o no legible' });

    const q = (req.query.q || req.body?.q || '').toString();
    const alumnoParam = (req.query.alumno || req.body?.alumno || '').toString().trim();
    const groupCol = (req.query.groupCol || req.body?.groupCol || 'GRUPO').toString();
    const alumnoCol = (req.query.alumnoCol || req.body?.alumnoCol || 'ALUMNO').toString();

    const numericCols = detectNumericCols(rows).filter((c) => c !== groupCol && c !== alumnoCol);
    const groupsMap = groupBy(rows, groupCol);
    const detectedGroups = Array.from(groupsMap.keys()).filter((g) => g !== '');

    const alumnoFromQ = alumnoParam || extractPossibleAlumno(q || '');
    const studentRows = pickStudentRows(rows, alumnoFromQ, alumnoCol);
    const groupMetrics = computeGroupMetrics(rows, groupCol, numericCols);

    const system = buildSystemPrompt(groupCol, numericCols, detectedGroups);
    const userPrompt = buildUserPrompt(
      q || `Analiza diferencias entre grupos para ${numericCols.join(', ')}`,
      studentRows,
      groupMetrics,
      alumnoCol
    );

    const answerText = await callOpenAI({ system, user: userPrompt });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({
      ok: true,
      answer: answerText,
      selection: { alumno: alumnoFromQ || null, groups: detectedGroups },
      metrics: { numericCols, groupMetrics },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || 'Error inesperado' });
  }
}
