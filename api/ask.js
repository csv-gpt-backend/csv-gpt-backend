// /api/ask.js
import { TEXTO_BASE } from '../data/texto_base.js';
import fs from 'fs';
import path from 'path';

function normaliza(s = '') {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function obtenerTexto(source = 'embed') {
  if (source === 'file') {
    try {
      const filePath = path.join(process.cwd(), 'datos', 'emocionales.txt');
      return fs.readFileSync(filePath, 'utf-8');
    } catch (_e) {
      return TEXTO_BASE ?? '';
    }
  }
  return TEXTO_BASE ?? '';
}

function contexto(lines, i, k = 0) {
  if (!k) return null;
  const ini = Math.max(0, i - k);
  const fin = Math.min(lines.length, i + k + 1);
  return { desde: ini + 1, hasta: fin, fragmento: lines.slice(ini, fin) };
}

export default function handler(req, res) {
  try {
    const {
      q = '',
      limit = '50',
      source = 'embed', // 'embed' | 'file'
      context = '0',
    } = req.query;

    const texto = obtenerTexto(String(source));
    const lineas = texto.split(/\r?\n/);

    if (!q.trim()) {
      return res.status(200).json({
        ok: true,
        mode: 'txt-full',
        source,
        n_lineas: lineas.length,
        texto,
      });
    }

    const qn = normaliza(q);
    const maxRes = Math.max(1, Number(limit) || 50);
    const ctx = Math.max(0, Number(context) || 0);

    const resultados = [];
    for (let i = 0; i < lineas.length; i++) {
      const ln = lineas[i];
      if (normaliza(ln).includes(qn)) {
        resultados.push({
          linea: i + 1,
          texto: ln,
          ...(ctx ? { contexto: contexto(lineas, i, ctx) } : {}),
        });
        if (resultados.length >= maxRes) break;
      }
    }

    return res.status(200).json({
      ok: true,
      mode: 'txt-search',
      query: q,
      source,
      total_encontrados: resultados.length,
      n_lineas: lineas.length,
      resultados,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      error: 'Error procesando el TXT',
      detalle: String(err?.message || err),
    });
  }
}
