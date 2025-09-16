// api/ask.js  — Vercel Edge Function
export const config = { runtime: 'edge' };

let CACHE_ROWS = null;

// ===== Utilidades =====
function normKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .trim();
}
function toNumber(v) {
  if (v == null) return NaN;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}
function promedio(rows, campo) {
  const KEY = normKey(campo);
  const vals = [];
  for (const r of rows) {
    const v = r[KEY] ?? r[campo] ?? r[KEY.toLowerCase()];
    const n = toNumber(v);
    if (Number.isFinite(n)) vals.push(n);
  }
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  return { n: vals.length, mean: Number.isFinite(mean) ? Number(mean.toFixed(2)) : null };
}
function detectDelimiter(firstLine) {
  const c = (firstLine.match(/,/g) || []).length;
  const s = (firstLine.match(/;/g) || []).length;
  return s > c ? ';' : ',';
}
function parseCSV(text) {
  const lines = text.replace(/\r/g, '').trim().split('\n');
  if (!lines.length) return [];
  const delim = detectDelimiter(lines[0] || '');
  const headers = (lines[0] || '').split(delim).map(normKey);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const cols = line.split(delim); // simple; evita comas dentro de campos
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = (cols[j] ?? '').trim();
    out.push(row);
  }
  return out;
}
async function loadRows(origin) {
  if (CACHE_ROWS) return CACHE_ROWS;
  const url = `${origin}/data.csv`;     // lee tu CSV estático del propio deploy
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`No pude leer data.csv (HTTP ${r.status})`);
  const text = await r.text();
  CACHE_ROWS = parseCSV(text);
  return CACHE_ROWS;
}
function withCORS(res, originHeader) {
  // Abierto para que funcione YA; cuando tengas tu dominio Wix cámbialo por ese dominio exacto
  res.headers.set('Access-Control-Allow-Origin', originHeader || '*'); 
  res.headers.set('Vary', 'Origin');
  res.headers.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  res.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=86400');
  return res;
}
function json(obj, status, originHeader) {
  return withCORS(
    new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }),
    originHeader
  );
}

// ===== Handler =====
export default async function handler(req) {
  const originHdr = req.headers.get('origin') || '*';
  if (req.method === 'OPTIONS') return withCORS(new Response(null, { status: 204 }), originHdr);

  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim();

    // carga CSV una sola vez por ubicación Edge (queda cacheado en memoria)
    const rows = await loadRows(url.origin);

    // Soporta: "Promedio de TIMIDEZ"
    const m = q.match(/promedio\s+de\s+(.+)/i);
    if (m) {
      const campo = m[1].trim();
      const st = promedio(rows, campo);
      if (st.n > 0 && st.mean != null) {
        return json({ respuesta: `Promedio de ${campo}: ${st.mean} (n=${st.n})`, stats: st }, 200, originHdr);
      }
      return json({ error: `No encontré valores numéricos para "${campo}".` }, 404, originHdr);
    }

    // Ping y fallback
    if (q.toLowerCase() === 'ping') return json({ ok: true }, 200, originHdr);
    return json({ respuesta: 'Prueba: "Promedio de TIMIDEZ"' }, 200, originHdr);
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500, originHdr);
  }
}
