// api/ask.js — Serverless Node (sin Edge) + CORS + diag + 3 consultas
const fs = require('fs');
const path = require('path');

let CACHE = null; // { rows, nameKey, source:'fs'|'http' }

const norm = s => String(s || '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();
const toNumber = v => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const detectDelimiter = first =>
  ((first.match(/;/g)||[]).length > (first.match(/,/g)||[]).length) ? ';' : ',';

function parseCSV(text) {
  const lines = text.replace(/\r/g,'').trim().split('\n');
  if (!lines.length) return [];
  const delim = detectDelimiter(lines[0] || '');
  const headers = (lines[0] || '').split(delim).map(norm);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const cols = line.split(delim);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (cols[j] ?? '').trim();
    out.push(row);
  }
  return out;
}

function guessNameKey(rows) {
  if (!rows.length) return 'NOMBRE';
  const keys = Object.keys(rows[0] || {});
  for (const c of ['NOMBRE','ESTUDIANTE','ALUMNO','NOMBRES','APELLIDOS']) {
    if (keys.includes(c)) return c;
  }
  return keys[0] || 'NOMBRE';
}

async function loadRows(req) {
  if (CACHE) return CACHE;

  // 1) Intenta por FS en varias rutas (según empaquetado)
  const fsCandidates = [
    path.join(__dirname, '..', 'data.csv'),
    path.join(__dirname, 'data.csv'),
    path.join(process.cwd(), 'data.csv')
  ];
  for (const p of fsCandidates) {
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8');
      const rows = parseCSV(text);
      CACHE = { rows, nameKey: guessNameKey(rows), source: 'fs', filePath: p };
      return CACHE;
    }
  }

  // 2) Fallback por HTTP público
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const base  = `${proto}://${host}`;
  const r = await fetch(base + '/data.csv', { redirect: 'follow' });
  if (r.ok) {
    const text = await r.text();
    const rows = parseCSV(text);
    CACHE = { rows, nameKey: guessNameKey(rows), source: 'http', url: base + '/data.csv' };
    return CACHE;
  }

  // 3) Nada encontrado
  return { rows: [], nameKey: 'NOMBRE', source: 'none' };
}

function setCORS(res, origin='*') {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function promedioCol(rows, campo) {
  const KEY = norm(campo);
  const vals = rows.map(r => toNumber(r[KEY] ?? r[campo] ?? r[KEY.toLowerCase()]))
                   .filter(Number.isFinite);
  const mean = vals.length ? vals.reduce((a,b)=>a+b,0) / vals.length : NaN;
  return { n: vals.length, mean: Number.isFinite(mean) ? Number(mean.toFixed(2)) : null };
}
function ranking(rows, campo, nameKey) {
  const KEY = norm(campo);
  const items = rows.map(r => ({
    [nameKey]: r[nameKey],
    valor: toNumber(r[KEY] ?? r[campo] ?? r[KEY.toLowerCase()])
  })).filter(x => Number.isFinite(x.valor));
  items.sort((a,b)=> b.valor - a.valor);
  items.forEach((it,i)=> it.posicion = i+1);
  return items;
}
function alumnoVsGrupo(rows, nombreBuscado, campo, nameKey) {
  const KEY = norm(campo), NB = norm(nombreBuscado);
  const fila = rows.find(r => norm(r[nameKey]) === NB);
  if (!fila) return { error: `No encontré a "${nombreBuscado}".` };
  const v = toNumber(fila[KEY] ?? fila[campo] ?? fila[KEY.toLowerCase()]);
  if (!Number.isFinite(v)) return { error: `El alumno no tiene valor numérico en "${campo}".` };

  const vals = rows.map(r => toNumber(r[KEY] ?? r[campo] ?? r[KEY.toLowerCase()]))
                   .filter(Number.isFinite);
  if (!vals.length) return { error: `No hay valores numéricos en "${campo}".` };

  const mean = vals.reduce((a,b)=>a+b,0) / vals.length;
  const diff = v - mean;
  const sortedAsc = [...vals].sort((a,b)=>a-b);
  const rankDesc = [...vals].sort((a,b)=>b-a).findIndex(x => x <= v) + 1;
  const percentile = (sortedAsc.filter(x => x <= v).length / vals.length) * 100;

  return {
    nombre: fila[nameKey], campo,
    valor: Number(v.toFixed(2)),
    grupo: { n: vals.length, media: Number(mean.toFixed(2)) },
    diferencia: Number(diff.toFixed(2)),
    posicion: rankDesc,
    percentil: Number(percentile.toFixed(1))
  };
}

module.exports = async (req, res) => {
  setCORS(res, req.headers.origin || '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = String(req.query.q || '').trim();
  if (q.toLowerCase() === 'ping') return res.status(200).json({ ok: true });

  const data = await loadRows(req);

  // Diagnóstico rápido
  if (q.toLowerCase() === 'diag') {
    const headers = data.rows[0] ? Object.keys(data.rows[0]) : [];
    return res.status(200).json({
      source: data.source,
      filePath: data.filePath || null,
      url: data.url || null,
      rows: data.rows.length,
      headers
    });
  }

  if (data.source === 'none') {
    return res.status(404).json({ error: 'No encontré el CSV (data.csv) ni por archivo ni por URL pública.' });
  }
  if (!data.rows.length) {
    return res.status(404).json({ error: 'data.csv está vacío o sin filas válidas.' });
  }

  // 1) Promedio de X
  const m1 = q.match(/promedio\s+de\s+(.+)/i);
  if (m1) {
    const campo = m1[1].trim();
    const st = promedioCol(data.rows, campo);
    if (st.n > 0 && st.mean != null) {
      return res.status(200).json({ respuesta: `Promedio de ${campo}: ${st.mean} (n=${st.n})`, stats: st });
    }
    return res.status(404).json({ error: `No encontré valores numéricos para "${campo}".` });
  }

  // 2) Ranking de X
  const m2 = q.match(/ranking\s+de\s+(.+)/i);
  if (m2) {
    const campo = m2[1].trim();
    const tabla = ranking(data.rows, campo, data.nameKey);
    if (!tabla.length) return res.status(404).json({ error: `No encontré valores numéricos para "${campo}".` });
    return res.status(200).json(tabla);
  }

  // 3) ¿Cómo está NOMBRE en CAMPO frente al grupo?
  const m3 =
    q.match(/como\s+esta\s+(.+?)\s+en\s+(.+?)\s+(?:frente\s+al\s+grupo|vs\s+grupo|comparad[oa]\s+con\s+el\s+grupo)\??/i) ||
    q.match(/(.+?)\s+vs\s+grupo\s*\((.+?)\)/i);
  if (m3) {
    const nombre = m3[1].trim(), campo = m3[2].trim();
    const info = alumnoVsGrupo(data.rows, nombre, campo, data.nameKey);
    if (info.error) return res.status(404).json({ error: info.error });
    const difTxt = (info.diferencia >= 0 ? '+' : '') + info.diferencia.toFixed(2);
    return res.status(200).json({
      respuesta: `${info.nombre} en ${info.campo}: ${info.valor}. Promedio del grupo: ${info.grupo.media} (n=${info.grupo.n}). ` +
                 `Diferencia: ${difTxt}. Posición: ${info.posicion}/${info.grupo.n} · Percentil: ${info.percentil}%`,
      detalle: info
    });
  }

  return res.status(200).json({ respuesta: 'Prueba: "Promedio de TIMIDEZ", "Ranking de AUTOESTIMA" o "¿Cómo está Julia en EMPATÍA frente al grupo?"' });
};
