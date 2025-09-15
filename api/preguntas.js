import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';

export default function handler(req, res) {
  // Permitir que Wix consuma la API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const filePath = path.join(process.cwd(), 'public', 'datos.csv');
  const results = [];
  const q = (req.query.q || '').toLowerCase();

  fs.createReadStream(filePath)
    .pipe(csv({ separator: ';' })) // <- ¡Aquí se especifica el separador correcto!
    .on('data', (row) => results.push(row))
    .on('end', () => {
      const filtrado = q
        ? results.filter(r => JSON.stringify(r).toLowerCase().includes(q))
        : results;

      res.status(200).json({
        total: filtrado.length,
        resultados: filtrado
      });
    })
    .on('error', (err) => res.status(500).json({ error: err.message }));
}
