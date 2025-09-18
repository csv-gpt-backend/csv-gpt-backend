// /api/inspect.js — Diagnóstico de columnas y mapeo (sin GPT)
// Lee /datos/<file>.csv por URL pública del mismo host, detecta delimitador,
// normaliza encabezados a canónicos, y calcula estadísticas por columna.

const CACHE_MS = 5 * 60 * 1000;
const csvCache = new Map(); // url -> { ts, text }

// ======= Esquema canónico (tu lista exacta) =======
const CANON = [
  "NOMBRE","EDAD","CURSO","PARALELO",
  "AUTOESTIMA","MANEJO DE LA TENSIÓN","BIENESTAR FÍSICO",
  "PROMEDIO DE HABILIDADES INTRAPERSONALES",
  "ASERTIVIDAD","CONCIENCIA DE LOS DEMÁS","EMPATÍA",
  "PROMEDIO DE HABILIDADES INTERPERSONALES",
  "MOTIVACIÓN","COMPROMISO","ADMINISTRACIÓN DEL TIEMPO",
  "TOMA DE DECISIONES","LIDERAZGO",
  "PROMEDIO DE HABILIDADES PARA LA VIDA",
  "PROMEDIO DE INTELIGENCIA EMOCIONAL",
  "AGRESIÓN","TIMIDEZ","PROPENSIÓN AL CAMBIO",
];

const ALIASES = {
  "NOMBRE": ["nombre","alumno","estudiante","apellidos y nombres","nombres y apellidos","nombre y apellido","nombres","apellidos"],
  "EDAD": ["edad","años","anos","edad (años)"],
  "CURSO": ["curso","grado","año","anio","nivel"],
  "PARALELO": ["paralelo","seccion","sección","grupo"],
  "AUTOESTIMA": ["autoestima","auto estima"],
  "MANEJO DE LA TENSIÓN": ["manejo de la tension","manejo del estres","manejo del estrés","estres","estrés","regulacion del estres","regulación del estrés","tension","tensión","control del estrés"],
  "BIENESTAR FÍSICO": ["bienestar fisico","salud fisica","salud física","bienestar físico"],
  "PROMEDIO DE HABILIDADES INTRAPERSONALES": ["promedio habilidades intrapersonales","promedio de habilidades intra personales","intrapersonales (promedio)","promedio intrapersonales"],
  "ASERTIVIDAD": ["asertividad","conducta asertiva"],
  "CONCIENCIA DE LOS DEMÁS": ["conciencia de los demas","conciencia social","percepcion social","percepción social","conciencia de los demás"],
  "EMPATÍA": ["empatia","empatía","empatia (habilidad)"],
  "PROMEDIO DE HABILIDADES INTERPERSONALES": ["promedio de  habilidades interpersonales","promedio habilidades interpersonales","interpersonales (promedio)","promedio interpersonal","promedio de habilidades  interpersonales"],
  "MOTIVACIÓN": ["motivacion","motivación"],
  "COMPROMISO": ["compromiso","engagement","compromiso escolar"],
  "ADMINISTRACIÓN DEL TIEMPO": ["administracion del tiempo","gestión del tiempo","gestion del tiempo","organizacion del tiempo","organización del tiempo","admin del tiempo","administración del tiempo"],
  "TOMA DE DECISIONES": ["toma de decisiones","decision making","decisiones","capacidad de decisión"],
  "LIDERAZGO": ["liderazgo","liderazgo escolar"],
  "PROMEDIO DE HABILIDADES PARA LA VIDA": ["habilidades para la vida (promedio)","promedio habilidades para la vida","promedio de habilidades para la vida"],
  "PROMEDIO DE INTELIGENCIA EMOCIONAL": ["promedio de inteligencia emocional","promedio ie","ie (promedio)","promedio de iinteligencia emocional","promedio inteligencia emocional"],
  "AGRESIÓN": ["agresion","conducta agresiva","agresividad"],
  "TIMIDEZ": ["timidez","inhibicion social","inhibición social","timidez social"],
  "PROPENSIÓN AL CAMBIO": ["propension al cambio","apertura al cambio","propensión al cambio"]
};

// ========= Utils =========
function stripBOM(s){ return String(s||"").replace(/^\uFEFF/, ""); }
function normalizeField(s){
  return stripBOM(String(s||""))
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ")
    .replace(/\s+/g," ").trim();
}
const ALIAS_INDEX = (() => {
  const idx = new Map();
  for (const canon of CANON) {
    idx.set(normalizeField(canon), canon);
    const list = ALIASES[canon] || [];
    for (const a of list) idx.set(normalizeField(a), canon);
  }
  return idx;
})();

function tokenSet(str){ return new Set(normalizeField(str).split(" ").filter(Boolean)); }
function jaccard(aSet, bSet){
  const inter = new Set([...aSet].filter(x => bSet.has(x)));
  const union = new Set([...aSet, ...bSet]);
  return union.size ? (inter.size / union.size) : 0;
}
function fuzzyResolve(header, threshold=0.6){
  const hSet = tokenSet(header);
  let best = {canon:null, score:0};
  for (const canon of CANON){
    const cSet = tokenSet(canon);
    const s = jaccard(hSet, cSet);
    if (s > best.score) best = {canon, score:s};
  }
  return best.score >= threshold ? best.canon : null;
}

function detectDelim(sample) {
  if (!sample) return ",";
  if (sample.includes(";")) return ";";
  if (sample.includes("\t")) return "\t";
  if (sample.includes("|")) return "|";
  return ",";
}

// parse “suave” (sin comillas escapadas). Si usas comillas en celdas, avísame y uso un parser completo.
function parseRows(csvText, delim) {
  const lines = csvText.split(/\r?\n/).filter(l => l.length);
  return lines.map(l => l.split(delim));
}

async function getCSVText(publicUrl) {
  const hit = csvCache.get(publicUrl);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_MS) return hit.text;
  const r = await fetch(publicUrl);
  if (!r.ok) throw new Error(`No pude leer CSV ${publicUrl} (HTTP ${r.status})`);
  const text = await r.text();
  csvCache.set(publicUrl, { ts: now, text });
  return text;
}

// número “inteligente” (maneja 10,5 o 10.5; tolera %)
function toNumberSmart(v) {
  if (v == null) return null;
  let s = String(v).trim().replace(/%/g,"");
  if (!s) return null;
  // si tiene coma y no punto → coma como decimal
  if (/,/.test(s) && !/\./.test(s)) s = s.replace(/\./g,"").replace(",",".");
  // si tiene ambos, intenta quitar miles comunes
  if (/\d\.\d{3}(?:\.|,)/.test(s)) s = s.replace(/\./g,"");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x,y) => x-y);
  const idx = Math.min(a.length-1, Math.max(0, Math.floor((p/100)*(a.length-1))));
  return a[idx];
}

// ======= Remap headers y stats =======
function remapAndStats(csvText, limit=1000) {
  const sample = csvText.slice(0, 2000);
  const delim = detectDelim(sample);
  const rows = parseRows(csvText, delim);
  if (!rows.length) return { delim, headers: [], mapped: {}, stats: {}, samples: [] };

  // encabezados
  const rawHeaders = rows[0].map(h => stripBOM(h.trim()));
  const usedCanon = new Map();
  const mapped = {};
  const headersCanon = rawHeaders.map(h => {
    const norm = normalizeField(h);
    let canon = ALIAS_INDEX.get(norm) || fuzzyResolve(h, 0.6);
    if (!canon) return h; // deja el original si no sabemos
    const n = (usedCanon.get(canon)||0) + 1;
    usedCanon.set(canon, n);
    const finalName = n===1 ? canon : `${canon} (${n})`;
    mapped[h] = finalName;
    return finalName;
  });

  // índice de columnas
  const idxOf = Object.fromEntries(headersCanon.map((h,i)=>[h,i]));

  // recolecta stats
  const stats = {};
  const numericSet = new Set(CANON.filter(c => c !== "NOMBRE" && c !== "CURSO" && c !== "PARALELO")); // EDAD incluida como num
  for (const h of headersCanon) {
    const col = idxOf[h];
    const nums = [], texts = [];
    const scan = Math.min(limit, rows.length-1);
    for (let r=1; r<=scan; r++){
      const v = rows[r][col] ?? "";
      const n = toNumberSmart(v);
      if (n!=null && (numericSet.has(h) || /[0-9]/.test(String(v)))) nums.push(n);
      else if (String(v).trim()) texts.push(String(v).trim());
    }
    if (nums.length >= texts.length) {
      const mean = nums.reduce((a,b)=>a+b,0)/ (nums.length||1);
      stats[h] = {
        type: "numeric",
        scanned: scan,
        count: nums.length,
        min: Math.min(...nums),
        max: Math.max(...nums),
        mean: +mean.toFixed(3),
        p50: percentile(nums,50),
        p90: percentile(nums,90),
        non_numeric: texts.length,
        examples: nums.slice(0,5)
      };
    } else {
      // top K valores de texto
      const freq = new Map();
      for (const t of texts){ freq.set(t, (freq.get(t)||0)+1); }
      const top = [...freq.entries()].sort((a,b)=> b[1]-a[1]).slice(0,5).map(([v,c])=>({v,c}));
      stats[h] = {
        type: "text",
        scanned: scan,
        count: texts.length,
        top_values: top,
        examples: texts.slice(0,5)
      };
    }
  }

  // muestras de filas (hasta 5)
  const samples = [];
  for (let r=1; r<Math.min(rows.length, 6); r++){
    const obj = {};
    headersCanon.forEach((h,i)=> obj[h] = rows[r][i] ?? "");
    samples.push(obj);
  }

  return {
    delim,
    headers_originales: rawHeaders,
    headers_canonicos: headersCanon,
    mapped,
    stats,
    samples
  };
}

// ======= handler =======
export default async function handler(req, res) {
  try {
    const file = (req.query.file || "decimo.csv").toString();
    const limit = Math.max(10, Math.min(100000, parseInt(req.query.limit||"1000",10)));

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const publicUrl = `${proto}://${host}/datos/${encodeURIComponent(file)}`;

    const csvText = await getCSVText(publicUrl);
    const diag = remapAndStats(csvText, limit);

    return res.status(200).json({
      archivo: file,
      filas_aprox: csvText.split(/\r?\n/).filter(Boolean).length,
      delimitador: diag.delim,
      columnas_mapeadas: diag.mapped,
      headers_originales: diag.headers_originales,
      headers_canonicos: diag.headers_canonicos,
      stats: diag.stats,
      samples: diag.samples
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Error interno", details: String(e) });
  }
}
