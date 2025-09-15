import fs from 'fs';
import path from 'path';

let CACHE = { mtimeMs: 0, rows: [] }; // persiste por instancia

export default function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = (req.query.q || '').toString().toLowerCase().trim();
  const filePath = path.join(process.cwd(), 'public', 'datos.csv');

  try {
    // Si el archivo cambió, recargando cache; si no, reusar
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs !== CACHE.mtimeMs || CACHE.rows.length === 0) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const text = raw.replace(/^\uFEFF/, '').replace(/\r/g, '');
      const lines = text.split('\n').filter(l => l.trim() !== '');
      if (lines.length <= 1) {
        CACHE = { mtimeMs: stat.mtimeMs, rows: [] };
      } else {
        const headers = lines[0].split(';').map(h => h.trim());
        const rows = lines.slice(1).map(line => {
          const cols = line.split(';').map(v => v.trim());
          const obj = {};
          headers.forEach((h, i) => { obj[h] = cols[i] ?? ''; });
          return obj;
        });
        CACHE = { mtimeMs: stat.mtimeMs, rows };
      }
    }

    const all = CACHE.rows;
    const resultados = q
      ? all.filter(r => JSON.stringify(r).toLowerCase().includes(q))
      : all;

    res.status(200).json({ file: 'datos.csv', total: resultados.length, resultados });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error leyendo CSV' });
  }
}
