// api/ask.js — Vercel Edge Function (ultra-rápida)
export const config = { runtime: 'edge' };

let CACHE_ROWS = null;

// ----- utilidades -----
const norm = s => String(s || '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase().trim();
const toNumber = v => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
const promedio = (rows, campo) => {
  const KEY = norm(campo);
  const vals = rows.map(r => toNumber(r[KEY] ?? r[campo] ?? r[KEY.toLowerCase()]))
                   .filter(Number.isFinite);
  const mean = vals.length ? vals.reduce((a,b)=>a+b,0) / vals.length : NaN;
  return { n: vals.length, mean: Number.isFinite(mean) ? Number(mean.toFixed(2)) : null };
};
const detectDelimiter = first =>
  ((first.match(/;/g)||[]).length > (first.match(/,/g)||[]).length) ? ';' : ',';
const parseCSV = text => {
  const lines = text.replace(/\r/g,'').trim().split('\n');
  if (!lines.length) return [];
  const delim = detectDelimiter(lines[0] || '');
  const headers = (lines[0] || '').split(delim).map(norm);
  const out = [];
  for (let i=1;i<lines.length;i++) {
    const cols = lines[i].split(delim);
    const row = {};
    for (let j=0;j<headers.length;j++) row[headers[j]] = (cols[j] ?? '').trim();
    out.push(row);
  }
  return out;
};
async function loadRows(origin) {
  if (CACHE_ROWS) return CACHE_ROWS;
  const r = await fetch(origin + '/data.csv', { redirect: 'follow' });
  if (!r.ok) throw new Error('No pude leer data.csv (HTTP ' + r.status + ')');
  const text = await r.text();
  CACHE_ROWS = parseCSV(text);
  return CACHE_ROWS;
}
function withCORS(res, originHeader) {
  // abierto para que funcione ya; cuando tengas tu dominio Wix, ponlo fijo aquí
  res.headers.set('Access-Control-Allow-Origin', originHeader || '*');
  res.headers.set('Vary', 'Origin');
  res.headers.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  res.headers.set('Cache-Control','public, s-maxage=60, stale-while-revalidate=86400');
  return res;
}
const json = (obj, status, originHeader) =>
  withCORS(new Response(JSON.stringify(obj), {
    status, headers: { 'content-type':'application/json; charset=utf-8' }
  }), originHeader);

// ----- handler -----
export default async function handler(req) {
  const originHdr = req.headers.get('origin') || '*';
  if (req.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }), originHdr);

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim();

    // ping para probar CORS/URL
    if (q.toLowerCase() === 'ping') return json({ ok: true }, 200, originHdr);

    // calcula: “Promedio de TIMIDEZ”
    const m = q.match(/promedio\s+de\s+(.+)/i);
    if (m) {
      const campo = m[1].trim();
      const rows = await loadRows(url.origin);  // lee /data.csv del deploy
      const st = promedio(rows, campo);
      if (st.n > 0 && st.mean != null) {
        return json({ respuesta: `Promedio de ${campo}: ${st.mean} (n=${st.n})`, stats: st }, 200, originHdr);
      }
      return json({ error: `No encontré valores numéricos para "${campo}".` }, 404, originHdr);
    }

    // fallback
    return json({ respuesta: 'Prueba: "Promedio de TIMIDEZ" o "ping"' }, 200, originHdr);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500, originHdr);
  }
}
