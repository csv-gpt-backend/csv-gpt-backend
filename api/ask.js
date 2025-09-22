// /api/ask.js — CSV + OpenAI (estable)
// Variables esperadas en Vercel (Production):
// - open_ai_key      (tu API Key)
// - OPENAI_MODEL     (sugerido: gpt-4o-mini; luego puedes usar gpt-5.1)
// - CSV_FILE         (por ej. datos/decimo.csv)

import OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';

const client = new OpenAI({ apiKey: process.env.open_ai_key });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CSV_PATH = process.env.CSV_FILE || 'datos/decimo.csv';

// ---------- Prompt del sistema (obliga tablas Markdown correctas) ----------
function buildSystemPrompt() {
  return `Eres una analista senior (voz femenina, español Ecuador/México).
Reglas duras:
- Responde SIEMPRE en español neutral latino (MX/EC). No uses asteriscos.
- Cuando entregues listas o tablas, usa formato Markdown con SALTOS DE LÍNEA.
Ejemplo:
| # | NOMBRE       | ASERTIVIDAD | LIDERAZGO |
|---|--------------|-------------|-----------|
| 1 | Juan Pérez   | 90          | 80        |
| 2 | María García | 85          | 70        |
- Cada fila va en su propia línea y todas las celdas separadas por | (pipes).
- Devuelve SOLO un JSON con forma exacta:
{
  "texto": "explicación en texto claro",
  "tablas_markdown": "tabla markdown con saltos de línea correctos (o cadena vacía)"
}`;
}

// ---------- Utilidades ----------
function safeJson(body) {
  try { return typeof body === 'string' ? JSON.parse(body || '{}') : (body || {}); }
  catch { return {}; }
}

// Lee el CSV desde el filesystem; si falla, intenta por HTTP al mismo dominio
async function readCsv(req) {
  const abs = path.join(process.cwd(), CSV_PATH);
  try {
    return await fs.readFile(abs, 'utf8');                       // 1) FS
  } catch {
    // 2) Fallback por HTTP (sirve cuando el FS no ve el archivo en runtime)
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const origin = host ? `${proto}://${host}` : '';
    const url = origin + (CSV_PATH.startsWith('/') ? CSV_PATH : `/${CSV_PATH}`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} al leer ${url}`);
    return await r.text();
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Método no permitido. Usa POST con JSON.' });
      return;
    }

    const body = safeJson(req.body);
    const question = String(body.question || '').replace(/\*/g, '').trim();
    if (!question) {
      res.status(200).json({ texto: 'Escribe una pregunta.', tablas_markdown: '' });
      return;
    }

    // Cargar CSV
    let csvRaw = '';
    try {
      csvRaw = await readCsv(req);
    } catch (e) {
      res.status(200).json({
        texto: `No pude leer el CSV en "${CSV_PATH}". Detalle: ${e.message}`,
        tablas_markdown: ''
      });
      return;
    }

    const system = buildSystemPrompt();

    const user = `PREGUNTA: ${question}

CONTEXTO CSV (${CSV_PATH}):
${csvRaw.slice(0, 200000)}

FORMATO ESTRICTO DE RESPUESTA:
{"texto":"explicación sin asteriscos","tablas_markdown":"tabla en markdown con SALTOS DE LÍNEA o cadena vacía"}`;

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || '{}';
    let parsed = {};
    try { parsed = JSON.parse(raw); }
    catch { parsed = { texto: raw, tablas_markdown: '' }; }

    // Sanitizar asteriscos por si acaso
    const texto = String(parsed.texto || parsed.text || '').replace(/\*/g, '');
    const tablas = String(parsed.tablas_markdown || '').replace(/\*/g, '');

    res.status(200).json({ texto, tablas_markdown: tablas });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || 'desconocido';
    res.status(200).json({ texto: 'Error backend: ' + msg, tablas_markdown: '' });
  }
}
