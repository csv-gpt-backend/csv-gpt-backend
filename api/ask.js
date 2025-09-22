// api/ask.js – Vercel Serverless (Node.js 20)
// Lee datos/decimo.csv, usa tu variable 'open_ai_key' y responde JSON { respuesta: "..." }

//export const config = { runtime: 'nodejs20.x' };

import fs from 'fs/promises';
import path from 'path';
import { parse as parseCsv } from 'csv-parse/sync';
import OpenAI from 'openai';

// Usa tu variable tal como la registraste en Vercel
const apiKey = process.env.open_ai_key || process.env.OPENAI_API_KEY || '';
const client = apiKey ? new OpenAI({ apiKey }) : null;

// Carga CSV (intenta datos/decimo.csv y luego /decimo.csv)
async function loadCsvRows() {
  const roots = [process.cwd()];
  const candidates = [
    path.join(roots[0], 'datos', 'decimo.csv'),
    path.join(roots[0], 'decimo.csv')
  ];
  let buf = null;
  for (const p of candidates) {
    try {
      buf = await fs.readFile(p);
      break;
    } catch {}
  }
  if (!buf) return [];
  const raw = buf.toString('utf8');
  try {
    return parseCsv(raw, { columns: true, skip_empty_lines: true });
  } catch {
    return parseCsv(raw, { columns: true, skip_empty_lines: true, delimiter: ';' });
  }
}

function buildSystem() {
  return `Eres una analista senior (voz femenina, español MX/EC). Reglas:
- Responde SIEMPRE en español latino, sin asteriscos ni prefacios.
- No digas "según el CSV" ni "no puedo"; si falta algo, deduce con lo disponible y explica.
- Si piden promedios, listados, ordenamientos, cálculos: hazlos.
- Cuando incluyas listas/tablas en texto, usa formato Markdown si te resulta natural.
- Devuelve SOLO el texto final para el usuario.`;
}

function rowsToCompactText(rows) {
  if (!rows?.length) return '';
  const cols = Object.keys(rows[0]);
  const head = cols.join(' | ');
  const body = rows.slice(0, 120).map(r => cols.map(c => (r[c] ?? '')).join(' | ')).join('\n');
  return `${head}\n${'-'.repeat( head.length )}\n${body}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).end(JSON.stringify({ error: 'Método no permitido. Usa POST con JSON.' }));
    }

    const body = req.body || (await req.json?.()) || {};
    const q = String(body.q || body.question || '').trim();
    if (!q) return res.status(400).json({ error: 'Falta el campo q' });

    const rows = await loadCsvRows();
    const csvText = rowsToCompactText(rows);

    if (!client || !apiKey) {
      // Respuesta de emergencia si no hay API key
      const fallback = `Para calcular el promedio u otros análisis del CSV, necesito tu clave de OpenAI configurada como "open_ai_key".
Datos disponibles: ${rows.length} filas. Ejemplo de columnas: ${rows[0] ? Object.keys(rows[0]).slice(0,6).join(', ') : 'N/D'}.`;
      return res.status(200).json({ respuesta: fallback });
    }

    const system = buildSystem();
    const user = `PREGUNTA: ${q}

Contexto CSV (vista compacta, hasta ~120 filas):
${csvText || '[sin datos]'}

Responde en español latino y de forma directa para el usuario.`;

    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-5.1-mini', // ajusta si tienes 5.1 completo
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    const respuesta = completion.choices?.[0]?.message?.content?.trim() || 'No obtuve respuesta.';
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
  texto: respuesta,
  tablas_markdown: ''   // o lo que corresponda si generas tablas
});

    
  } 
} catch (err) {
  console.error('ASK ERROR:', err); // Esto saldrá también en logs de Vercel

  return res.status(200).json({
    texto: `ERROR DETECTADO: ${err?.message || JSON.stringify(err)}`,
    tablas_markdown: ''
  });
}
}
