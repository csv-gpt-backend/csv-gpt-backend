// /api/ask.js — Vercel Serverless Function (Node). "Fast lane" para preguntas de métricas
// Responde en ~30–80 ms para cosas como: "promedio de AUTOESTIMA",
// evitando llamar a GPT. Mantiene compatibilidad con ?q=… y agrega ?source=…
// Fuentes esperadas:
//  - data/import1.csv  (Décimo A)
//  - data/import2.csv  (Décimo B)
// Columna ejemplo: AUTOESTIMA (y otras). Números con coma o punto.

import fs from 'fs';
import path from 'path';

// ====== CONFIG ======
const DATA_DIR = path.join(process.cwd(), 'data');
const FILES = { import1: 'import1.csv', import2: 'import2.csv' };
const DEFAULT_SOURCE = 'ambos'; // import1 | import2 | ambos
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

// ====== CACHE simple en memoria ======
const mem = {
  csv: new Map(),      // key: import1/import2  -> { rows, headers, loadedAt }
  result: new Map()    // key: JSON({source, metric, op}) -> { value, createdAt }
};

// ====== Utilidades ======
function now(){ return Date.now(); }
function hasFresh(entry, ttl=CACHE_TTL_MS){ return entry && (now() - entry.createdAt) < ttl; }
function stripBOM(s=''){ return s.replace(/^\uFEFF/, ''); }
function detectSep(line=''){
  const commas = (line.match(/,/g)||[]).length;
  const semis  = (line.match(/;/g)||[]).length;
  const tabs   = (line.match(/\t/g)||[]).length;
  if (semis >= commas && semis >= tabs) return ';';
  if (commas >= semis && commas >= tabs) return ',';
  return '\t';
}
function toAsciiUpperNoAccents(s=''){
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}
function toNumber(v){
  if (v == null) return NaN;
  const s = String(v).trim().replace(/\s+/g,' ');
  if (!s) return NaN;
  // admitir decimales con coma
  const n = parseFloat(s.replace(/,/g,'.'));
  return Number.isFinite(n) ? n : NaN;
}
function quantile(sortedNums, q){
  if (!sortedNums.length) return NaN;
  const pos = (sortedNums.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedNums[base+1] !== undefined) {
    return sortedNums[base] + rest * (sortedNums[base+1] - sortedNums[base]);
  } else {
    return sortedNums[base];
  }
}

function readCSVOnce(key){
  const hit = mem.csv.get(key);
  if (hit && hasFresh(hit, CACHE_TTL_MS*6)) return hit; // datos raramente cambian

  const file = FILES[key];
  if (!file) throw new Error(`Fuente desconocida: ${key}`);
  const full = path.join(DATA_DIR, file);
  const raw = stripBOM(fs.readFileSync(full, 'utf8'));
  const [headerLine, ...lines] = raw.split(/\r?\n/).filter(Boolean);
  const sep = detectSep(headerLine);
  const headers = headerLine.split(sep).map(h => h.trim());
  const headersNorm = headers.map(h => toAsciiUpperNoAccents(h));

  const rows = lines.map(line => {
    const cols = line.split(sep);
    const obj = {};
    for (let i=0;i<headers.length;i++){
      obj[headers[i]] = (cols[i] ?? '').trim();
      obj[headersNorm[i]] = obj[headers[i]]; // duplicado normalizado
    }
    return obj;
  });

  const out = { rows, headers, headersNorm, loadedAt: now() };
  mem.csv.set(key, out);
  return out;
}

function pickSources(source){
  const s = String(source||DEFAULT_SOURCE).toLowerCase();
  if (s === 'import1' || s === 'a' || s === 'decimo a') return ['import1'];
  if (s === 'import2' || s === 'b' || s === 'decimo b') return ['import2'];
  // ambos por defecto
  return ['import1','import2'];
}

function collectColumnNumbers(sourceList, metric){
  const MET = toAsciiUpperNoAccents(metric);
  const numsBySource = {};
  let all = [];
  for (const key of sourceList){
    const { rows } = readCSVOnce(key);
    const arr = [];
    for (const r of rows){
      const v = r[MET];
      const n = toNumber(v);
      if (Number.isFinite(n)) arr.push(n);
    }
    arr.sort((a,b)=>a-b);
    numsBySource[key] = arr;
    all = all.concat(arr);
  }
  all.sort((a,b)=>a-b);
  return { all, numsBySource };
}

function statsFromArray(arr){
  const n = arr.length;
  if (!n) return { n:0, mean:NaN, min:NaN, max:NaN, p50:NaN, p90:NaN };
  let sum = 0; let min = arr[0]; let max = arr[arr.length-1];
  for (const x of arr) sum += x;
  const mean = sum / n;
  const p50 = quantile(arr, 0.5);
  const p90 = quantile(arr, 0.9);
  return { n, mean, min, max, p50, p90 };
}

function formatNumber(n){
  if (!Number.isFinite(n)) return 'NaN';
  return new Intl.NumberFormat('es-EC', { maximumFractionDigits: 2 }).format(n);
}

function humanSourceName(keys){
  const set = new Set(keys);
  if (set.size === 2) return 'Ambos';
  if (set.has('import1')) return 'Décimo A';
  if (set.has('import2')) return 'Décimo B';
  return 'Desconocido';
}

function buildAnswer({ metric, sourceKeys, globalStats, perSource }){
  const srcName = humanSourceName(sourceKeys);
  const lines = [];
  lines.push(`Promedio de ${metric.toUpperCase()} — ${srcName}: ${formatNumber(globalStats.mean)} (n=${globalStats.n}).`);
  lines.push(`Min=${formatNumber(globalStats.min)} · Mediana=${formatNumber(globalStats.p50)} · P90=${formatNumber(globalStats.p90)} · Max=${formatNumber(globalStats.max)}`);
  if (sourceKeys.length>1){
    const a = perSource['import1'];
    const b = perSource['import2'];
    if (a) lines.push(`Décimo A → n=${a.n}, promedio=${formatNumber(a.mean)}`);
    if (b) lines.push(`Décimo B → n=${b.n}, promedio=${formatNumber(b.mean)}`);
  }
  return lines.join('\n');
}

function tryParseFastNL(q){
  // Reconocer: "promedio de AUTOESTIMA" / "dime el promedio de autoestima" / "media autoestima"
  const s = (q||'').toString().toLowerCase();
  // op mean
  if (/(promedio|media|average)/i.test(s)){
    const m = s.match(/de\s+([a-záéíóúñ\s_]+)/i) || s.match(/\b([a-záéíóúñ_]+)\b\s*(?:\?)?$/i);
    if (m && m[1]){
      const metric = m[1].trim();
      return { op:'mean', metric };
    }
  }
  return null;
}

function ok(res, data){
  cors(res);
  res.statusCode = 200;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}
function bad(res, code, message){
  cors(res);
  res.statusCode = code;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
}
function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','*');
}

export default async function handler(req, res){
  if (req.method === 'OPTIONS'){ cors(res); res.statusCode=204; return res.end(); }
  if (req.method !== 'GET'){ return bad(res, 405, 'Use GET'); }

  try {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('q') || '';
    const metricParam = url.searchParams.get('metric');
    const opParam = url.searchParams.get('op'); // mean (por ahora)
    const source = url.searchParams.get('source') || DEFAULT_SOURCE;
    const sourceKeys = pickSources(source);

    let fast = null;
    if (metricParam && (opParam||'mean')==='mean') fast = { op:'mean', metric:metricParam };
    else fast = tryParseFastNL(q);

    if (fast && fast.metric){
      const cacheKey = JSON.stringify({ source: sourceKeys.join('+'), metric: toAsciiUpperNoAccents(fast.metric), op:'mean' });
      const hit = mem.result.get(cacheKey);
      if (hasFresh(hit)) return ok(res, { ...hit.value, _cache:true });

      const { all, numsBySource } = collectColumnNumbers(sourceKeys, fast.metric);
      const globalStats = statsFromArray(all);
      const perSource = {};
      for (const k of Object.keys(numsBySource)) perSource[k] = statsFromArray(numsBySource[k]);

      const answer = buildAnswer({ metric: fast.metric, sourceKeys, globalStats, perSource });
      const payload = { answer, metric: fast.metric, op:'mean', source: humanSourceName(sourceKeys), stats: { global: globalStats, porFuente: perSource }, _fast:true };
      mem.result.set(cacheKey, { value: payload, createdAt: now() });
      return ok(res, payload);
    }

    // ===== Fallback (tu lógica GPT existente) =====
    // Aquí puedes llamar a tu pipeline LLM sólo si no hay fast path.
    // Para mantener este snippet autocontenido, devolvemos guía.
    return ok(res, {
      answer: 'No reconocí una métrica directa. Intenta: "promedio de AUTOESTIMA" o usa ?metric=AUTOESTIMA&op=mean&source=ambos',
      _fast:false
    });

  } catch (err) {
    console.error(err);
    return bad(res, 500, 'Error interno: ' + (err.message||'desconocido'));
  }
}

// === vercel.json sugerido ===
// {
//   "functions": { "api/ask.js": { "maxDuration": 10, "memory": 256 } },
//   "regions": ["gru1", "iad1"]
// }
