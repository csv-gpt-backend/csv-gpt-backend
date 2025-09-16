// api/ask.js — Vercel Edge Function
export const config = { runtime: 'edge' };

let CACHE_ROWS = null; // cache por región Edge

// ===== utilidades =====
const norm = s => String(s || '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();

const toNumber = v => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

const detectDelimiter = first =>
  ((first.match(/;/g)||[]).length > (first.match(/,/g)||[]).length) ? ';' : ',';

const parseCSV = text => {
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
};

async function loadRows(origin) {
  if (CACHE_ROWS) return CACHE_ROWS;
  const r = await fetch(origin + '/data.csv', { redirect: 'follow' });
  if (!r.ok) throw new Error(`No pude leer data.csv (HTTP ${r.status})`);
  const text = await r.text();
  CACHE_ROWS = parseCSV(text);
  return CACHE_ROWS;
}

function withCORS(res, originHeader) {
  res.headers.set('Access-Control-Allow-Origin', originHeader || '*'); // pon tu dominio Wix si quieres
  res.headers.set('Vary', 'Origin');
  res.headers.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  // Para evitar caché mientras depuras:
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

const json = (obj, status, originHeader) =>
  withCORS(new Response(JSON.stringify(obj), {
    status, headers: { 'content-type':'application/json; charset=utf-8' }
  }), originHeader);

// intenta localizar la columna de nombre
function findNameKey(rows) {
  if (!rows.length) return 'NOMBRE';
  const keys = Object.keys(rows[0] || {});
  const candidates = ['NOMBRE','ESTUDIANTE','ALUMNO','NOMBRES','APELLIDOS'];
  for (const c of candidates) if (keys.includes(c)) return c;
  return keys[0] || 'NOMBRE';
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
  items.forEach((it, i) => it.posicion = i + 1);
  return items;
}

function alumnoVsGrupo(rows, nombreBuscado, campo, nameKey) {
  const KEY = norm(campo);
  const NB = norm(nombreBuscado);
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
    nombre: fila[nameKey],
    campo,
    valor: Number(v.toFixed(2)),
    grupo: { n: vals.length, media: Number(mean.toFixed(2)) },
    diferencia: Number(diff.toFixed(2)),
    posicion: rankDesc,
    percentil: Number(percentile.toFixed(1))
  };
}

// ===== handler =====
export default async function handler(req) {
  const originHdr = req.headers.get('origin') || '*';
  if (req.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }), originHdr);

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim();

    if (q.toLowerCase() === 'ping') return json({ ok: true }, 200, originHdr);

    const rows = await loadRows(url.origin);
    const nameKey = findNameKey(rows);

    // 1) Promedio de X
    const m1 = q.match(/promedio\s+de\s+(.+)/i);
    if (m1) {
      const campo = m1[1].trim();
      const st = promedioCol(rows, campo);
      if (st.n > 0 && st.mean != null) {
        return json({ respuesta: `Promedio de ${campo}: ${st.mean} (n=${st.n})`, stats: st }, 200, originHdr);
      }
      return json({ error: `No encontré valores numéricos para "${campo}".` }, 404, originHdr);
    }

    // 2) Ranking de X
    const m2 = q.match(/ranking\s+de\s+(.+)/i);
    if (m2) {
      const campo = m2[1].trim();
      const tabla = ranking(rows, campo, nameKey);
      if (!tabla.length) return json({ error: `No encontré valores numéricos para "${campo}".` }, 404, originHdr);
      return json(tabla, 200, originHdr);
    }

    // 3) ¿Cómo está NOMBRE en CAMPO frente al grupo?
    const m3 =
      q.match(/como\s+esta\s+(.+?)\s+en\s+(.+?)\s+(?:frente\s+al\s+grupo|vs\s+grupo|comparad[oa]\s+con\s+el\s+grupo)\??/i) ||
      q.match(/(.+?)\s+vs\s+grupo\s*\((.+?)\)/i);
    if (m3) {
      const nombre = m3[1].trim();
      const campo = m3[2].trim();
      const info = alumnoVsGrupo(rows, nombre, campo, nameKey);
      if (info.error) return json({ error: info.error }, 404, originHdr);

      const difTxt = (info.diferencia >= 0 ? '+' : '') + info.diferencia.toFixed(2);
      return json({
        respuesta: `${info.nombre} en ${info.campo}: ${info.valor}. Promedio del grupo: ${info.grupo.media} (n=${info.grupo.n}). ` +
                   `Diferencia: ${difTxt}. Posición: ${info.posicion}/${info.grupo.n} · Percentil: ${info.percentil}%`,
        detalle: info
      }, 200, originHdr);
    }

    return json({ respuesta: 'Prueba: "Promedio de TIMIDEZ", "Ranking de AUTOESTIMA" o "¿Cómo está Julia en EMPATÍA frente al grupo?"' }, 200, originHdr);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500, originHdr);
  }
}
