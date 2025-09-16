// api/ask.js — Serverless Node (sin Edge), CORS, lee /api/data.csv y soporta 3 consultas
const fs = require('fs');
const path = require('path');

let CACHE = null; // { rows, nameKey }

const norm = s => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();
const toNumber = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const detectDelimiter = first => ((first.match(/;/g)||[]).length > (first.match(/,/g)||[]).length) ? ';' : ',';

function parseCSV(text){
  const lines = text.replace(/\r/g,'').trim().split('\n');
  if (!lines.length) return [];
  const delim = detectDelimiter(lines[0]||'');
  const headers = (lines[0]||'').split(delim).map(norm);
  const out = [];
  for (let i=1;i<lines.length;i++){
    const cols = lines[i].split(delim);
    const row = {};
    for (let j=0;j<headers.length;j++) row[headers[j]] = (cols[j] ?? '').trim();
    out.push(row);
  }
  return out;
}
function guessNameKey(rows){
  if (!rows.length) return 'NOMBRE';
  const keys = Object.keys(rows[0] || {});
  for (const c of ['NOMBRE','ESTUDIANTE','ALUMNO','NOMBRES','APELLIDOS']) if (keys.includes(c)) return c;
  return keys[0] || 'NOMBRE';
}
function loadOnce(){
  if (CACHE) return CACHE;
  const filePath = path.join(__dirname, 'data.csv'); // ⬅️ lee /api/data.csv
  if (!fs.existsSync(filePath)) return { rows: [], nameKey: 'NOMBRE', missing: true, filePath };
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCSV(text);
  CACHE = { rows, nameKey: guessNameKey(rows), missing: false, filePath };
  return CACHE;
}

function setCORS(res, origin='*'){
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function promedioCol(rows, campo){
  const KEY = norm(campo);
  const vals = rows.map(r => toNumber(r[KEY] ?? r[campo] ?? r[KEY.toLowerCase()])).filter(Number.isFinite);
  const mean = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : NaN;
  return { n: vals.length, mean: Number.isFinite(mean) ? Number(mean.toFixed(2)) : null };
}
function ranking(rows, campo, nameKey){
  const KEY = norm(campo);
  const items = rows.map(r => ({ [nameKey]: r[nameKey], valor: toNumber(r[KEY] ?? r[campo] ?? r[KEY.toLowerCase()]) }))
                    .filter(x => Number.isFinite(x.valor));
  items.sort((a,b)=> b.valor - a.valor); items.forEach((it,i)=> it.posicion = i+1);
  return items;
}
function alumnoVsGrupo(rows, nombre, campo, nameKey){
  const KEY = norm(campo), NB = norm(nombre);
  const fila = rows.find(r => norm(r[nameKey]) === NB);
  if (!fila) return { error: `No encontré a "${nombre}".` };
  const v = toNumber(fila[KEY] ?? fila[campo] ?? fila[KEY.toLowerCase()]);
  if (!Number.isFinite(v)) return { error: `El alumno no tiene valor numérico en "${campo}".` };
  const vals = rows.map(r => toNumber(r[KEY] ?? r[campo] ?? r[KEY.toLowerCase()])).filter(Number.isFinite);
  if (!vals.length) return { error: `No hay valores numéricos en "${campo}".` };
  const mean = vals.reduce((a,b)=>a+b,0)/vals.length, diff = v - mean;
  const asc=[...vals].sort((a,b)=>a-b), desc=[...vals].sort((a,b)=>b-a);
  const rank = desc.findIndex(x => x <= v) + 1, pct = (asc.filter(x=>x<=v).length/vals.length)*100;
  return { nombre: fila[nameKey], campo, valor: +v.toFixed(2), grupo:{n:vals.length, media:+mean.toFixed(2)}, diferencia:+diff.toFixed(2), posicion:rank, percentil:+pct.toFixed(1) };
}

module.exports = async (req, res) => {
  setCORS(res, req.headers.origin || '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = String(req.query.q || '').trim();
  if (q.toLowerCase() === 'ping') return res.status(200).json({ ok:true });

  const data = loadOnce();
  if (q.toLowerCase() === 'diag') {
    const headers = data.rows[0] ? Object.keys(data.rows[0]) : [];
    return res.status(200).json({ file: data.filePath, missing: data.missing, rows: data.rows.length, headers });
  }
  if (data.missing) return res.status(404).json({ error:'No encontré /api/data.csv dentro del deploy.' });
  if (!data.rows.length) return res.status(404).json({ error:'data.csv está vacío o sin filas válidas.' });

  const m1 = q.match(/promedio\s+de\s+(.+)/i);
  if (m1) {
    const campo = m1[1].trim();
    const st = promedioCol(data.rows, campo);
    if (st.n > 0 && st.mean != null) return res.status(200).json({ respuesta:`Promedio de ${campo}: ${st.mean} (n=${st.n})`, stats: st });
    return res.status(404).json({ error:`No encontré valores numéricos para "${campo}".` });
  }
  const m2 = q.match(/ranking\s+de\s+(.+)/i);
  if (m2) {
    const campo = m2[1].trim();
    const tabla = ranking(data.rows, campo, data.nameKey);
    if (!tabla.length) return res.status(404).json({ error:`No encontré valores numéricos para "${campo}".` });
    return res.status(200).json(tabla);
  }
  const m3 = q.match(/como\s+esta\s+(.+?)\s+en\s+(.+?)\s+(?:frente\s+al\s+grupo|vs\s+grupo|comparad[oa]\s+con\s+el\s+grupo)\??/i) || q.match(/(.+?)\s+vs\s+grupo\s*\((.+?)\)/i);
  if (m3) {
    const info = alumnoVsGrupo(data.rows, m3[1].trim(), m3[2].trim(), data.nameKey);
    if (info.error) return res.status(404).json({ error: info.error });
    const difTxt = (info.diferencia >= 0 ? '+' : '') + info.diferencia.toFixed(2);
    return res.status(200).json({ respuesta: `${info.nombre} en ${info.campo}: ${info.valor}. Promedio del grupo: ${info.grupo.media} (n=${info.grupo.n}). Diferencia: ${difTxt}. Posición: ${info.posicion}/${info.grupo.n} · Percentil: ${info.percentil}%`, detalle: info });
  }
  return res.status(200).json({ respuesta:'Prueba: "Promedio de TIMIDEZ", "Ranking de AUTOESTIMA" o "¿Cómo está Julia en EMPATÍA frente al grupo?"' });
};
