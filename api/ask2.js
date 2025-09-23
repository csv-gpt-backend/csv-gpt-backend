// /api/ask2.js
import { TEXTO_BASE } from '../data/texto_base.js';
import fs from 'fs';
import path from 'path';

function normaliza(s = '') {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function obtenerTexto(source = 'embed') {
  if (source === 'file') {
    try {
      const filePath = path.join(process.cwd(), 'datos', 'emocionales.txt');
      return fs.readFileSync(filePath, 'utf-8');
    } catch { /* fallback al embed */ }
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
    const method = req.method?.toUpperCase?.() || 'GET'; // ✅ GET y POST
    if (method !== 'GET' && method !== 'POST') {
      return res.status(405).json({ error: 'Método no permitido. Usa GET o POST.' });
    }
    const params = method === 'POST' ? (req.body || {}) : (req.query || {});
    const { q = '', limit = '50', source = 'embed', context = '0' } = params;

    const texto = obtenerTexto(String(source));
    const lineas = texto.split(/\r?\n/);

    if (!q.trim()) {
      return res.status(200).json({
        ok: true, endpoint: 'ask2', method, mode: 'txt-full',
        source, n_lineas: lineas.length_
