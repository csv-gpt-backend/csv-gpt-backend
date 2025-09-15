import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  // CORS para poder llamar desde Wix
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = (req.query.q || '').toString().toLowerCase().trim();
  const filePath = path.join(process.cwd(), 'public', 'datos.csv');

  try {
    const raw = fs.readFileSync(filePath, 'utf8');

    // Normalizamos BOM y saltos de línea (Windows/Mac)
    const text = raw.replace(/^\uFEFF/, '').replace(/\r/g, '');
    const lines = text.split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) {
      return res.status(200).json({ file: 'datos.csv', total: 0, resultados: [] });
    }

    // CSV con punto y coma ;
    const headers = lines[0].split(';').map(h => h.trim());
    const rows = lines.slice(1).map(line => {
      const cols = line.split(';').map(v => v.trim());
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cols[i] ?? ''; });
      return obj;
    });

    const resultados = q
      ? rows.filter(r => JSON.stringify(r).toLowerCase().includes(q))
      : rows;

    res.status(200).json({ file: 'datos.csv', total: resultados.length, resultados });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error leyendo CSV' });
  }
}
