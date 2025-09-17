// api/ask.js
export const config = { runtime: 'edge' };

/* ---------- CORS - listo para Wix ---------- */
const CORS = {
  'Access-Control-Allow-Origin': '*', // ⇦ cámbialo por tu dominio https de Wix si quieres restringir
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400'
};

const VERSION = 'gpt5-csv-direct-main-edge-1';

/* ---------- Helpers de respuesta ---------- */
function respondJSON(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(init.headers || {}) }
  });
}

/* ---------- Parser CSV simple (comillas soportadas) ---------- */
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];

    if (inQ) {
      if (c === '"' && n === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (cur !== '' || row.length) { row.push(cur); rows.push(row); row = []; cur = ''; }
        // consumir \r\n
        if (c === '\r' && n === '\n') i++;
      } else cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map(h => h.trim());
  const data = rows.slice(1).filter(r => r.some(c => c !== ''));
  return { headers, rows: data };
}

/* ---------- Carga CSV desde el bundle (Edge-friendly) ---------- */
async function loadCSV() {
  const url = new URL('./data.csv', import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo leer data.csv (${res.status})`);
  const text = await res.text();
  return parseCSV(text);
}

/* ---------- Prompt para GPT: pide JSON uniforme ---------- */
function buildPrompt(q, headers, rows) {
  // convertimos a objetos para legibilidad del modelo
  const objs = rows.map(r => {
    const o = {};
    headers.forEach((h, i) => (o[h] = r[i] ?? ''));
    return o;
  });

  return `
Eres un analista de datos. Recibirás un conjunto pequeño (≤ 100 filas) de objetos JSON
convertidos desde un CSV escolar y una PREGUNTA del usuario en español (América Latina).
Debes responder SIEMPRE en formato JSON estricto con la siguiente forma:

{
  "respuesta": "texto breve y claro con el resultado o explicación",
  "tabla": {
    "headers": ["Columna1","Columna2", ...],
    "rows": [["c11","c12",...], ["c21","c22",...]]
  }
}

- "tabla" es OPCIONAL: inclúyela cuando el resultado sea una lista, ranking, agrupación, etc.
- No agregues texto fuera del JSON.
- No inventes columnas: usa exactamente los nombres presentes.
- Si el usuario pide “grupos/equipos de 5 usando AGRESION y EMPATIA”, arma equipos equilibrados
  y publica una tabla con columnas como ["RANGO","NOMBRE","PARALELO","AGRESION","EMPATIA","GRUPO"].
- Si la consulta es muy simple (p.ej., “PROMEDIO DE AGRESION”), devuelve "respuesta" con el número y,
  si tiene sentido, una tablita con los cálculos por grupo/paralelo.
- Si falta contexto, dilo en "respuesta" y no devuelvas "tabla".

DATOS (primeros ${Math.min(objs.length, 999)} registros):
${JSON.stringify(objs, null, 2)}

PREGUNTA:
${q}
`.trim();
}

/* ---------- Llamada a OpenAI Responses API ---------- */
async function askOpenAI({ prompt, apiKey, maxOut }) {
  const body = {
    model: 'gpt-5',
    // Responses API: no ponemos temperature ni max_tokens para evitar 400;
    // opcionalmente puedes usar: max_output_tokens o max_completion_tokens (si tu cuenta lo permite)
    ...(maxOut ? { max_completion_tokens: maxOut } : {}),
    input: prompt
  };

  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  // Si OpenAI está en cuota insuficiente/overloaded, devolvemos un error claro:
  if (r.status === 401) return { error: 'auth_error', message: 'OPENAI_API_KEY inválida o no autorizada.' };
  if (r.status === 429) return { error: 'insufficient_quota', message: 'Sin crédito o límite alcanzado.' };
  if (!r.ok) {
    const tx = await r.text().catch(()=>'');
    return { error: 'provider_error', message: `OpenAI ${r.status}`, detail: tx.slice(0, 4000) };
  }

  const data = await r.json();
  // Respuestas API suele incluir output_text
  const text =
    data.output_text ||
    (data.output?.[0]?.content?.[0]?.text) ||
    (data.content?.[0]?.text) ||
    '';

  return { text, raw: data };
}

/* ---------- Intenta parsear JSON del modelo ---------- */
function safeParseAssistantJSON(txt) {
  if (!txt) return null;
  // intenta extraer un bloque JSON si viene con ruido accidental
  const start = txt.indexOf('{');
  const end   = txt.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(txt.slice(start, end + 1)); } catch {}
  }
  // segundo intento: parse directo
  try { return JSON.parse(txt); } catch {}
  return null;
}

/* ---------- Handler principal ---------- */
export default async function handler(req) {
  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const searchQ = url.searchParams.get('q');
  const debug = url.searchParams.get('debug') === '1';
  const t = Number(url.searchParams.get('t') || '120000'); // timeout sugerido
  const max = Number(url.searchParams.get('max') || '0');  // max tokens (si tu plan lo permite)

  // Respuestas rápidas
  if (searchQ === 'ping') return respondJSON({ ok: true });
  if (searchQ === 'version') return respondJSON({ version: VERSION });
  if (searchQ === 'model') return respondJSON('gpt-5');

  // Lee body si viene por POST
  let q = searchQ;
  if (!q && (req.method === 'POST')) {
    try {
      const j = await req.json();
      q = j?.q || '';
    } catch { q = ''; }
  }
  q = (q || '').toString().trim();

  // Diagnóstico del CSV
  if (q === 'diag') {
    try {
      const { headers, rows } = await loadCSV();
      return respondJSON({ source: 'edge', filePath: '/api/data.csv', url: null, rows: rows.length, headers });
    } catch (e) {
      return respondJSON({ error: e.message || String(e) }, { status: 500 });
    }
  }

  // Necesitamos la clave de OpenAI
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  if (!apiKey) {
    return respondJSON({ error: 'Falta OPENAI_API_KEY en Producción.' }, { status: 500 });
  }

  // Carga datos
  let dataset;
  try {
    dataset = await loadCSV();
  } catch (e) {
    return respondJSON({ error: 'No se pudo leer data.csv', detail: e.message }, { status: 500 });
  }

  if (!q) {
    return respondJSON({
      respuesta:
        'Tu solicitud está incompleta. Indica qué necesitas que compute con el CSV (p.ej., "promedio de EMPATIA por PARALELO", "ranking por PROMEDIO HABILIDADES INTERPERSONALES", "grupos de 5 usando AGRESION y EMPATIA").',
      tabla: { headers: [], rows: [] }
    });
  }

  // Construye prompt y llama a OpenAI
  const prompt = buildPrompt(q, dataset.headers, dataset.rows);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t + 3000);
  let ai;
  try {
    ai = await askOpenAI({ prompt, apiKey, maxOut: max > 0 ? max : undefined });
  } catch (e) {
    clearTimeout(timer);
    return respondJSON({ error: 'network', message: 'Fallo de red hacia OpenAI', detail: e.message }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  // Manejo de errores de proveedor
  if (ai?.error) {
    const payload = { error: ai.error, message: ai.message };
    if (debug) payload.detail = ai.detail || ai.raw || null;
    return respondJSON(payload, { status: ai.error === 'auth_error' ? 401 : ai.error === 'insufficient_quota' ? 429 : 502 });
  }

  // Intentamos parsear JSON del asistente
  const parsed = safeParseAssistantJSON(ai.text);
  if (parsed && typeof parsed === 'object' && parsed.respuesta) {
    if (debug) parsed._debug = { took: 'openai', version: VERSION };
    return respondJSON(parsed);
  }

  // Si no vino JSON parseable, devolvemos texto en "respuesta"
  const fallback = {
    respuesta: ai.text || '(sin contenido del modelo)',
  };
  if (debug) fallback._debug = { rawOpenAI: (ai.raw || null), version: VERSION };
  return respondJSON(fallback);
}
