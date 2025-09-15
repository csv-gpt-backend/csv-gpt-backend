import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';

export default function handler(req, res) {
  // CORS para poder llamar desde tu sitio en Wix
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const file = (req.query.file || 'datos.csv').toString();
  const q = (req.query.q || '').toString().toLowerCase();
  const limit = parseInt((req.query.limit || '0').toString(), 10);

  const filePath = path.join(process.cwd(), 'public', file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `Archivo no encontrado: ${file}` });
  }

  const rows = [];
  fs.createReadStream(filePath)
     .pipe(csv({ separator: ';' }))
    .on('data', (row) => rows.push(row))
    .on('end', () => {
      let out = q
        ? rows.filter(r => JSON.stringify(r).toLowerCase().includes(q))
        : rows;
      if (limit > 0) out = out.slice(0, limit);
      res.status(200).json({ file, total: out.length, resultados: out });
    })
    .on('error', (err) => res.status(500).json({ error: err.message }));
}
