// api/ask.js  (Vercel Edge Function)
export const config = { runtime: 'edge' }; // fuerza Edge

// CORS rápido (solo Wix / tu dominio)
const ORIGIN = 'https://*.wixsite.com'; // cambia por tu dominio si tienes uno

// 👉 Reemplaza estos imports por tus JSON ya “empaquetados” en el repo (cero I/O en runtime)
import ambos from '../data/ambos.json' assert { type: 'json' };
import a from '../data/import1.json' assert { type: 'json' };
import b from '../data/import2.json' assert { type: 'json' };

// Normaliza columnas a MAYÚSCULAS para búsquedas tipo “TIMIDEZ”
const byFuente = { 'Ambos': ambos, 'import1': a, 'import2': b };

function mean(arr){ return arr.length ? arr.reduce((s,x)=>s+Number(x||0),0)/arr.length : 0; }

function queryPromedio(dataset, campo){
  const key = campo.toUpperCase();
  const nums = dataset.map(r => Number(r[key] ?? r[campo] ?? r[key.toLowerCase()] ?? 0)).filter(n => Number.isFinite(n));
  return { n: nums.length, mean: Number(mean(nums).toFixed(2)) };
}

function json(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Cache en CDN por 60s + SWR 1 día (ajusta a tu necesidad)
      'cache-control': 'public, s-maxage=60, stale-while-revalidate=86400',
      // CORS mínimo
      'access-control-allow-origin': ORIGIN,
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return json({}, 204);
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim();
  const fuente = searchParams.get('fuente') || 'Ambos';

  const data = byFuente[fuente] || byFuente['Ambos'];

  // Caso simple: "Promedio de TIMIDEZ"
  const m = q.match(/promedio\\s+de\\s+(.+)/i);
  if (m) {
    const campo = m[1].trim();
    const stats = queryPromedio(data, campo);
    return json({ 
      respuesta: `Promedio de ${campo} (${fuente}): ${stats.mean} (n=${stats.n})`,
      stats 
    });
  }

  // Fallback
  return json({ respuesta: 'Consulta no reconocida. Prueba: "Promedio de TIMIDEZ".' }, 200);
}
