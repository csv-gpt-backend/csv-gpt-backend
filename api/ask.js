// /api/ask.js — Endpoint unificado: FAST (sin GPT) + LLM planner
// Objetivo: que el modelo "entienda" cualquier pregunta en español
// y si es computable con tus CSV, ejecute el cálculo exacto en el backend.
// Si la pregunta es abierta/teórica, responde con el propio LLM.
//
// Requisitos:
//  - Variables de entorno en Vercel: OPENAI_API_KEY (y opcional OPENAI_MODEL)
//  - Archivos: /data/import1.csv  (Décimo A)  y  /data/import2.csv (Décimo B)
//
// Notas:
//  - Mantiene CORS abierto para Wix.
//  - Soporta ?q=..., ?source=ambos|import1|import2, ?debug=1
//  - Intenta primero un "fast lane" para frases tipo: "promedio de AUTOESTIMA".
//  - Si no hay fast lane, usa LLM para generar un plan JSON y ejecuta el cálculo.

import fs from 'fs';
import path from 'path';

// ====== CONFIG ======
const DATA_DIR = path.join(process.cwd(), 'data');
const FILES = { import1: 'import1.csv', import2: 'import2.csv' };
const DEFAULT_SOURCE = 'ambos'; // import1 | import2 | ambos
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; // cambia a 'gpt-5' si lo tienes
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

// ====== CACHE simple ======
const mem = {
  csv: new Map(),      // key: import1/import2  -> { rows, headers, headersNorm, loadedAt }
  plan: new Map(),     // key: q+schema -> plan
  result: new Map()    // key: planHash -> payload
};

// ====== Utils base ======
const now = () => Date.now();
const hasFresh = (e, ttl=CACHE_TTL_MS) => e && (now() - e.createdAt) < ttl;
const stripBOM = (s='') => s.replace(/^\uFEFF/, '');
const detectSep = (line='') => {
  const commas=(line.match(/,/g)||[]).length, semis=(line.match(/;/g)||[]).length, tabs=(line.match(/\t/g)||[]).length;
  if (semis>=commas && semis>=tabs) return ';'; if (commas>=semis && commas>=tabs) return ','; return '\t';
};
const toAscii = (s='') => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const norm = (s='') => toAscii(String(s)).toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');
const normTight = (s='') => norm(s).replace(/\s+/g,'');
const toNumber = (v) => { const s=String(v??'').trim(); if(!s) return NaN; const n=parseFloat(s.replace(/,/g,'.')); return Number.isFinite(n)?n:NaN; };

function quantile(sortedNums, q){
  if (!sortedNums.length) return NaN;
  const pos = (sortedNums.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sortedNums[base+1]!==undefined ? (sortedNums[base] + rest*(sortedNums[base+1]-sortedNums[base])) : sortedNums[base];
}

// ====== CSV loader ======
function readCSVOnce(key){
  const hit = mem.csv.get(key);
  if (hit && hasFresh(hit, CACHE_TTL_MS*6)) return hit;
  const file = FILES[key]; if (!file) throw new Error(`Fuente desconocida: ${key}`);
  const full = path.join(DATA_DIR, file);
  const raw = stripBOM(fs.readFileSync(full, 'utf8'));
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const sep = detectSep(lines[0]||',');
  const headers = (lines[0]||'').split(sep).map(h=>h.trim());
  const headersNorm = headers.map(h=>norm(h));
  const rows = lines.slice(1).map(line=>{
    const cols = line.split(sep);
    const o = {}; for(let i=0;i<headers.length;i++){ const val=(cols[i]??'').trim(); o[headers[i]]=val; o[headersNorm[i]]=val; }
    return o;
  });
  const out = { rows, headers, headersNorm, loadedAt: now() };
  mem.csv.set(key, out); return out;
}

function pickSources(source){
  const s = String(source||DEFAULT_SOURCE).toLowerCase();
  if (s==='import1' || s==='a' || s==='decimo a') return ['import1'];
  if (s==='import2' || s==='b' || s==='decimo b') return ['import2'];
  return ['import1','import2'];
}

// ====== Estadística ======
function collectColumnNumbers(sourceKeys, metric){
  const MET = norm(metric);
  const numsBySource = {}; let all = [];
  for (const key of sourceKeys){
    const { rows } = readCSVOnce(key);
    const arr = [];
    for (const r of rows){ const n = toNumber(r[MET]); if(Number.isFinite(n)) arr.push(n); }
    arr.sort((a,b)=>a-b); numsBySource[key]=arr; all = all.concat(arr);
  }
  all.sort((a,b)=>a-b); return { all, numsBySource };
}

function statsFromArray(arr){
  const n = arr.length; if(!n) return { n:0, mean:NaN, min:NaN, max:NaN, p50:NaN, p90:NaN };
  let sum=0; for(const x of arr) sum+=x; const mean=sum/n;
  const min=arr[0], max=arr[arr.length-1]; const p50=quantile(arr,.5), p90=quantile(arr,.9);
  return { n, mean, min, max, p50, p90 };
}

function statApply(arr, stat, percentile){
  const n=arr.length; if(!n) return NaN; if(stat==='mean') return statsFromArray(arr).mean;
  if(stat==='sum'){ let s=0; for(const x of arr) s+=x; return s; }
  if(stat==='min') return arr[0]; if(stat==='max') return arr[arr.length-1]; if(stat==='count') return n;
  if(stat==='p') return quantile(arr, (percentile??50)/100);
  return NaN;
}

const nf = new Intl.NumberFormat('es-EC',{ maximumFractionDigits:2 });
const fmt = (n)=> Number.isFinite(n)? nf.format(n) : 'NaN';

function humanSourceName(keys){ const s=new Set(keys); if(s.size===2) return 'Ambos'; if(s.has('import1')) return 'Décimo A'; if(s.has('import2')) return 'Décimo B'; return 'Desconocido'; }

// ====== Mapeo de columnas (robusto) ======
function schema(){
  // Construir el inventario de columnas disponibles (normalizadas)
  const all = ['import1','import2'].flatMap(k=>{ const {headers,headersNorm}=readCSVOnce(k); return headersNorm.map((hn,i)=>({ key:k, name:headers[i], norm:hn })); });
  // Quedarnos con únicas por nombre normalizado (preferimos la de import1)
  const seen=new Set(); const uniq=[]; for(const it of all){ if(!seen.has(it.norm)){ seen.add(it.norm); uniq.push({name:it.name, norm:it.norm}); } }
  return { columns: uniq };
}

function pickColumnNormFromUserText(metric){
  const target = norm(metric); const tight=normTight(metric);
  const { columns } = schema();
  // 1) Igual exacto
  let found = columns.find(c=>c.norm===target);
  if(found) return found.norm;
  // 2) Contiene (ajustado)
  found = columns.find(c=> c.norm.includes(target) || target.includes(c.norm) || normTight(c.norm)===tight );
  if(found) return found.norm;
  // 3) Emparejar por tokens (muy básico)
  const tks = new Set(target.split(' '));
  let best=null, score=-1;
  for(const c of columns){ const set=new Set(c.norm.split(' ')); let s=0; for(const t of tks){ if(set.has(t)) s++; } if(s>score){ score=s; best=c; } }
  return best?best.norm:target; // si no, devolvemos el target (por si coincide en CSV)
}

// ====== FAST LANE ======
function tryParseFastNL(q){
  const s = (q||'').toLowerCase();
  if (/(promedio|media|average)\s+de\s+/i.test(s)){
    const m = s.match(/promedio\s+de\s+([a-záéíóúñ_\s-]+)/i);
    if (m && m[1]) return { op:'mean', metric:m[1].trim() };
  }
  return null;
}

// ====== LLM Planner ======
async function llmPlan(question, sch){
  if (!OPENAI_API_KEY) throw new Error('Falta OPENAI_API_KEY');
  const sys = `Eres un planificador de consultas sobre un dataset escolar.\n`+
  `Tu tarea: traducir la pregunta del usuario a un JSON estrictamente valido.\n`+
  `Columnas disponibles (usa sus nombres tal cual, o sin acentos/espacios):\n- ${sch.columns.map(c=>c.name).join('\n- ')}\n\n`+
  `Responde **solo** con JSON, sin texto adicional, siguiendo este esquema:\n`+
  `{"action":"compute"|"chat", "source":"ambos|import1|import2", `+
  `"computations":[{"metric":"<nombre columna>", "stat":"mean|min|max|sum|count|p", "percentile":0-100|null}], `+
  `"answer":"(si action=chat, texto conciso en español; si compute, opcional resumen)"}`;

  const user = `Pregunta: ${question}`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions',{
    method:'POST',
    headers:{ 'Authorization':`Bearer ${OPENAI_API_KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages:[ {role:'system', content: sys}, {role:'user', content: user} ],
      temperature: 0
    })
  });
  const data = await resp.json();
  const txt = data?.choices?.[0]?.message?.content || '';
  const json = safeParseJSON(txt);
  return json || { action:'chat', answer: 'No pude interpretar la consulta.' };
}

function safeParseJSON(txt){
  try { return JSON.parse(txt); } catch(_){ /* try to extract first {...} */ }
  const i = txt.indexOf('{'); const j = txt.lastIndexOf('}');
  if (i>=0 && j>i){ try { return JSON.parse(txt.slice(i,j+1)); } catch(_){} }
  return null;
}

// ====== HTTP helpers ======
function ok(res, data){ cors(res); res.statusCode=200; res.setHeader('Content-Type','application/json; charset=utf-8'); res.end(JSON.stringify(data)); }
function bad(res, code, message){ cors(res); res.statusCode=code; res.setHeader('Content-Type','application/json; charset=utf-8'); res.end(JSON.stringify({ error: message })); }
function cors(res){ res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','*'); }

export default async function handler(req, res){
  if (req.method==='OPTIONS'){ cors(res); res.statusCode=204; return res.end(); }
  if (req.method!=='GET'){ return bad(res,405,'Use GET'); }
  try {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('q') || '';
    const source = url.searchParams.get('source') || DEFAULT_SOURCE;
    const debug = url.searchParams.has('debug');

    // 0) Inventario columnas
    const sch = schema();

    // 1) Fast lane
    let fast = tryParseFastNL(q);
    if (fast){
      const sourceKeys = pickSources(source);
      const colNorm = pickColumnNormFromUserText(fast.metric);
      const { all, numsBySource } = collectColumnNumbers(sourceKeys, colNorm);
      const global = statsFromArray(all);
      const perSource = Object.fromEntries(Object.entries(numsBySource).map(([k,arr])=>[k, statsFromArray(arr)]));
      const answer = [
        `Promedio de ${fast.metric.toUpperCase()} — ${humanSourceName(sourceKeys)}: ${fmt(global.mean)} (n=${global.n}).`,
        `Min=${fmt(global.min)} · Mediana=${fmt(global.p50)} · P90=${fmt(global.p90)} · Max=${fmt(global.max)}`,
        ...(sourceKeys.length>1?[`Décimo A → n=${perSource.import1?.n??0}, promedio=${fmt(perSource.import1?.mean)}`]:[]),
        ...(sourceKeys.length>1?[`Décimo B → n=${perSource.import2?.n??0}, promedio=${fmt(perSource.import2?.mean)}`]:[])
      ].join('\n');
      return ok(res, { answer, _fast:true, metric: fast.metric, source: humanSourceName(sourceKeys), stats:{ global, porFuente: perSource }, debug: debug?{ colNorm } : undefined });
    }

    // 2) Planner LLM
    const plan = await llmPlan(q, sch);

    if (plan.action === 'compute' && Array.isArray(plan.computations) && plan.computations.length){
      const sourceKeys = pickSources(plan.source||source);
      const results=[]; const details=[];
      for (const c of plan.computations){
        const colNorm = pickColumnNormFromUserText(c.metric);
        const { all, numsBySource } = collectColumnNumbers(sourceKeys, colNorm);
        const value = statApply(all, c.stat, c.percentile);
        results.push({ metric:c.metric, stat:c.stat, percentile:c.percentile??null, value });
        details.push({ metric:c.metric, norm:colNorm, by:{ import1: statApply(numsBySource.import1||[], c.stat, c.percentile), import2: statApply(numsBySource.import2||[], c.stat, c.percentile) } });
      }
      // Mensaje legible
      const lines = results.map(r=>{
        const label = r.stat==='p' ? `P${r.percentile}` : r.stat;
        return `${label}(${r.metric.toUpperCase()}) = ${fmt(r.value)}`;
      });
      const answer = (plan.answer? plan.answer+"\n" : "") + lines.join('\n');
      return ok(res, { answer, _fast:false, plan, results, details: debug?details:undefined });
    }

    // 3) Chat libre
    if (plan.action==='chat'){
      return ok(res, { answer: plan.answer || 'Puedo calcular promedios, mínimos, máximos, percentiles y conteos. Pregunta por una columna específica.', _fast:false, plan });
    }

    return ok(res, { answer: 'No pude interpretar la consulta. Prueba: "promedio de AUTOESTIMA".', _fast:false, plan });

  } catch (err) {
    console.error(err);
    return bad(res, 500, 'Error interno: ' + (err.message||'desconocido'));
  }
}
