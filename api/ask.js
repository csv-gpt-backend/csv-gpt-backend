// api/ask.js — Serverless Node (sin Edge) + CORS + promedios
const fs = require('fs');
const path = require('path');

let CACHE = null; // { rows, headers, filePath }

const norm = s => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();
const toNumber = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const detectDelimiter = first => ((first.match(/;/g)||[]).length > (first.match(/,/g)||[]).length) ? ';' : ',';

function parseCSV(text){
  const lines = text.replace(/\r/g,'').trim().split('\n');
  if (!lines.length) return { rows: [], headers: [] };
  const delim = detectDelimiter(lines[0] || '');
  const headers = (lines[0] || '').split(delim).map(norm);
  const rows = [];
  for (let i=1;i<lines.length;i++){
    const line = lines[i];
    if (!line?.trim()) continue;
    const cols = line.split(delim);
    const row = {};
    for (let j=0;j<headers.length;j++) row[headers[j]] = (cols[j] ?? '').trim();
    rows.push(row);
  }
  return { rows, headers };
}

function loadOnce(){
  if (CACHE) return CACHE;
  const candidates = [
    path.join(__dirname, 'data.csv'),      // /api/data.csv
    path.join(__dirname, '..', 'data.csv') // /data.csv (raíz)
  ];
  for (const fp of candidates){
    if (fs.existsSync(fp)){
      const txt = fs.readFileSync(fp, 'utf8');
      const { rows, headers } = parseCSV(txt);
      CACHE = { rows, headers, filePath: fp };
      return CACHE;
    }
  }
  CACHE = { rows: [], headers: [], filePath: null };
  return CACHE;
}

function setCORS(res, origin='*'){
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store'); // cambia a s-maxage si quieres CDN
}

function promedioDe(rows, campo){
  const KEY = norm(campo);
  const nums = rows.map(r => toNumber(r[KEY] ?? r[campo] ?? r[KEY.toLowerCase()]))
                   .filter(Number.isFinite);
  if (!nums.length) return { n: 0, mean: null };
  const mean = nums.reduce((a,b)=>a+b,0) / nums.length;
  return { n: nums.length, mean: Number(mean.toFixed(2)) };
}

function promediosDeTodas(rows, headers){
  const out = [];
  for (const h of headers){
    const st = promedioDe(rows, h);
    if (st.n > 0 && st.mean != null) out.push({ columna: h, n: st.n, mean: st.mean });
  }
  // Opcional: ordena por nombre de columna
  out.sort((a,b)=> a.columna.localeCompare(b.columna));
  return out;
}

module.exports = async (req, res) => {
  setCORS(res, req.headers.origin || '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = String(req.query.q || '').trim();
  if (!q) return res.status(200).json({ respuesta: 'Usa: "Promedio de TIMIDEZ" · Pruebas: ping, diag, promedios' });
  if (q.toLowerCase() === 'ping') return res.status(200).json({ ok: true });

  const data = loadOnce();
  if (!data.filePath) return res.status(404).json({ error: 'No encontré data.csv (colócalo en /api/data.csv o en /data.csv).' });
  if (!data.rows.length) return res.status(404).json({ error: 'data.csv está vacío o sin filas válidas.' });

  if (q.toLowerCase() === 'diag') {
    return res.status(200).json({ file: data.filePath, rows: data.rows.length, headers: data.headers });
  }

  // "promedios" -> todos los promedios numéricos
  if (/^promedios?$/i.test(q)) {
    const lista = promediosDeTodas(data.rows, data.headers);
    if (!lista.length) return res.status(404).json({ error: 'No hay columnas numéricas.' });
    return res.status(200).json({ respuesta: 'Promedios por columna', promedios: lista });
  }

  // "Promedio de X"  o  "Promedio X"
  const m = q.match(/promedio(?:\s+de)?\s+(.+)/i);
  if (m) {
    const campo = m[1].trim();
    const st = promedioDe(data.rows, campo);
    if (st.n > 0 && st.mean != null) {
      return res.status(200).json({ respuesta: `Promedio de ${campo}: ${st.mean} (n=${st.n})`, stats: st });
    }
    return res.status(404).json({ error: `No encontré valores numéricos para "${campo}". Usa uno de: ${JSON.stringify(data.headers)}.` });
  }

  return res.status(200).json({ respuesta: 'Solo acepto: "Promedio de <COLUMNA>" o "promedios"' });
};
