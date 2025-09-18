// /pages/api/ask.js
// Serverless API para Vercel/Next. Analiza CSV, corre clustering (Agresión+Empatía),
// calcula compatibilidad, y también soporta tablas/correlación si el planner lo pide.

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { ts, text }

function safeFileParam(s, def = "decimo.csv") {
  const x = (s || "").toString().trim();
  if (!x) return def;
  if (x.includes("..") || x.includes("/") || x.includes("\\")) return def;
  return x;
}

async function getCSVText(publicUrl) {
  const hit = cache.get(publicUrl);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_MS) return hit.text;
  const r = await fetch(publicUrl);
  if (!r.ok) throw new Error(`No pude leer CSV ${publicUrl} (HTTP ${r.status})`);
  const text = await r.text();
  cache.set(publicUrl, { ts: now, text });
  return text;
}

// ---------- CSV ----------
function detectDelim(line) {
  if (!line) return ",";
  if (line.includes(";")) return ";";
  if (line.includes("\t")) return "\t";
  if (line.includes("|")) return "|";
  return ",";
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { rows: [], headers: [] };
  const delim = detectDelim(lines[0]);
  const headers = lines[0].split(delim).map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const parts = line.split(delim);
    const obj = {};
    headers.forEach((h, i) => (obj[h] = parts[i] !== undefined ? parts[i].trim() : ""));
    return obj;
  });
  return { rows, headers };
}

// ---------- helpers ----------
const norm = s =>
  (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\w]+/g, " ")
    .trim();

function findHeader(headers, targets) {
  const H = headers.map(h => [h, norm(h)]);
  for (const t of targets) {
    const tn = norm(t);
    const hit = H.find(([orig, nn]) => nn === tn);
    if (hit) return hit[0];
  }
  // aproximado
  for (const t of targets) {
    const tn = norm(t);
    const hit = H.find(([orig, nn]) => nn.includes(tn));
    if (hit) return hit[0];
  }
  return null;
}

function toNumber(x) {
  if (x == null) return null;
  const s = String(x).replace(",", ".").replace(/[^\d.-]/g, "");
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function zscore(values) {
  const n = values.length;
  const m = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (n || 1));
  return { mean: m, sd: sd || 1 };
}

function euclid2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// ---------- planner muy simple ----------
function inferRequestedCount(q) {
  if (!q) return null;
  const s = String(q).toLowerCase();

  const m = s.match(
    /\btop\s*(\d+)\b|\bprimer(?:os|as)?\s*(\d+)\b|\b(?:dame|muestrame|muéstrame|lista(?:r)?|solo)\s*(\d+)\b|\b(\d+)\s*(estudiantes|alumnos|filas|pares)\b/
  );
  if (m) {
    const n = [m[1], m[2], m[3], m[4]].filter(Boolean)[0];
    const v = parseInt(n, 10);
    if (Number.isFinite(v) && v > 0) return v;
  }
  const mapa = {
    uno: 1,
    una: 1,
    primer: 1,
    primero: 1,
    primera: 1,
    dos: 2,
    segundo: 2,
    segundos: 2,
    segundas: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10,
  };
  for (const [w, n] of Object.entries(mapa)) if (new RegExp(`\\b${w}\\b`, "i").test(s)) return n;
  return null;
}

function inferMode(query) {
  const s = (query || "").toLowerCase();
  const wantsCluster =
    /(grupo|agrup|k-?means|homogene)/.test(s) && /(agresi|empat)/.test(s);
  const wantsCorr = /correlaci/.test(s) && /(agresi|empat)/.test(s);
  if (wantsCluster) return "cluster";
  if (wantsCorr) return "correlation";
  return "table";
}

function getRequestedGroupSize(q) {
  const m = (q || "").toLowerCase().match(/grupos?\s+de\s+(\d+)/) || (q || "").toLowerCase().match(/de\s+(\d+)\s+estudiantes/);
  if (m) {
    const v = parseInt(m[1], 10);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 5;
}

// ---------- k-means en (zAg, zEmp) ----------
function kmeans(points, k, { maxIter = 60, restarts = 20, seed = 7 } = {}) {
  // points: [{id, x:[zAg,zEmp]}]
  let best = null;

  function rng() {
    // LCG simple reproducible
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }

  function runOnce() {
    // init aleatoria de centroides
    const cents = [];
    const used = new Set();
    while (cents.length < k) {
      const idx = Math.floor(rng() * points.length);
      if (!used.has(idx)) {
        used.add(idx);
        cents.push(points[idx].x.slice());
      }
    }
    let labels = new Array(points.length).fill(0);
    let changed = true;
    let it = 0;

    while (changed && it++ < maxIter) {
      changed = false;
      // asignar
      for (let i = 0; i < points.length; i++) {
        let bestJ = 0,
          bestD = Infinity;
        for (let j = 0; j < k; j++) {
          const d = euclid2(points[i].x, cents[j]);
          if (d < bestD) {
            bestD = d;
            bestJ = j;
          }
        }
        if (labels[i] !== bestJ) {
          labels[i] = bestJ;
          changed = true;
        }
      }
      // recomputar centroides
      const sums = Array.from({ length: k }, () => [0, 0]);
      const cnts = new Array(k).fill(0);
      for (let i = 0; i < points.length; i++) {
        const g = labels[i];
        sums[g][0] += points[i].x[0];
        sums[g][1] += points[i].x[1];
        cnts[g]++;
      }
      for (let j = 0; j < k; j++) {
        if (cnts[j] > 0) {
          cents[j][0] = sums[j][0] / cnts[j];
          cents[j][1] = sums[j][1] / cnts[j];
        }
      }
    }

    // SSE
    let sse = 0;
    for (let i = 0; i < points.length; i++) {
      sse += euclid2(points[i].x, cents[labels[i]]) ** 2;
    }
    return { cents, labels, sse };
  }

  for (let r = 0; r < restarts; r++) {
    const out = runOnce();
    if (!best || out.sse < best.sse) best = out;
  }
  return best;
}

function balanceClusters(assign, cents, targetSize, points) {
  // targetSize=5: mueve los casos más cercanos al centro de clusters deficitarios
  const k = cents.length;
  const groups = Array.from({ length: k }, () => []);
  assign.forEach((g, i) => groups[g].push(i));
  const deficit = [];
  const surplus = [];
  for (let j = 0; j < k; j++) {
    if (groups[j].length < targetSize) deficit.push(j);
    if (groups[j].length > targetSize) surplus.push(j);
  }
  function pullFrom(sur, def) {
    // del cluster "sur" movemos el más cercano al centro de "def"
    let bestI = -1,
      bestD = Infinity,
      bestIdx = -1;
    for (const idx of groups[sur]) {
      const d = euclid2(points[idx].x, cents[def]);
      if (d < bestD) {
        bestD = d;
        bestI = idx;
        bestIdx = idx;
      }
    }
    if (bestIdx >= 0) {
      // mover
      groups[sur] = groups[sur].filter(i => i !== bestIdx);
      groups[def].push(bestIdx);
      assign[bestIdx] = def;
    }
  }
  // mientras haya déficit y superávit
  let guard = 1000;
  while (deficit.length && surplus.length && guard--) {
    const d = deficit.shift();
    // busca un surplus con algo de margen
    let s = surplus.find(sj => groups[sj].length > targetSize);
    if (s == null) break;
    pullFrom(s, d);
    if (groups[s].length <= targetSize) {
      surplus.splice(surplus.indexOf(s), 1);
    }
    if (groups[d].length < targetSize) deficit.push(d); // aún le falta
  }
  return assign;
}

// ---------- modos ----------
function applyOrderLimit(rows, orderBy, limit) {
  let arr = rows.slice();
  if (orderBy && orderBy.length) {
    arr.sort((a, b) => {
      for (const ob of orderBy) {
        const dir = (ob.dir || "desc").toLowerCase() === "asc" ? 1 : -1;
        const av = a[ob.col],
          bv = b[ob.col];
        if (av == null && bv == null) continue;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
      }
      return 0;
    });
  }
  if (Number.isFinite(limit)) arr = arr.slice(0, limit);
  return arr;
}

function buildClusterOutput(rawRows, headers, query) {
  // localizar columnas
  const colNombre =
    findHeader(headers, ["NOMBRE", "ESTUDIANTE", "ALUMNO"]) || headers[0];
  const colAgre = findHeader(headers, ["AGRESION", "AGRESIÓN", "AGRESIVIDAD"]);
  const colEmp = findHeader(headers, ["EMPATIA", "EMPATÍA"]);
  if (!colAgre || !colEmp)
    throw new Error("No encontré columnas de AGRESIÓN y/o EMPATÍA en el CSV.");

  const rows = rawRows
    .map(r => ({
      nombre: r[colNombre] || "",
      agre: toNumber(r[colAgre]),
      emp: toNumber(r[colEmp]),
      raw: r,
    }))
    .filter(r => r.nombre && r.agre != null && r.emp != null);

  if (!rows.length) throw new Error("No hay filas válidas con Agresión y Empatía.");

  // z-score
  const ZAg = zscore(rows.map(r => r.agre));
  const ZEm = zscore(rows.map(r => r.emp));
  const points = rows.map((r, i) => ({
    id: i,
    x: [(r.agre - ZAg.mean) / ZAg.sd, (r.emp - ZEm.mean) / ZEm.sd],
  }));

  const groupSize = getRequestedGroupSize(query) || 5;
  const k = Math.max(1, Math.ceil(rows.length / groupSize));

  const { labels, cents } = kmeans(points, k, { maxIter: 60, restarts: 20, seed: 13 });
  const finalLabels = balanceClusters(labels.slice(), cents, groupSize, points);

  // armar grupos
  const grupos = Array.from({ length: k }, () => []);
  finalLabels.forEach((g, i) => grupos[g].push(i));

  const outGroups = grupos.map((gIdxs, gi) => {
    const lis = gIdxs.map((i, ord) => {
      const p = points[i].x;
      const dist = euclid2(p, cents[gi]);
      return {
        "#": ord + 1,
        NOMBRE: rows[i].nombre,
        AGRESION: rows[i].agre,
        EMPATIA: rows[i].emp,
        zAg: +p[0].toFixed(3),
        zEmp: +p[1].toFixed(3),
        dist_al_centro: +dist.toFixed(3),
      };
    });
    // medias crudas
    const mAg = lis.reduce((a, b) => a + b.AGRESION, 0) / lis.length;
    const mEm = lis.reduce((a, b) => a + b.EMPATIA, 0) / lis.length;
    return {
      titulo: `Grupo ${gi + 1} (n=${lis.length}) — medias: Agresión=${mAg.toFixed(
        1
      )}, Empatía=${mEm.toFixed(1)} — centróide z=(${cents[gi][0].toFixed(
        2
      )}, ${cents[gi][1].toFixed(2)})`,
      rows: lis.sort((a, b) => a.dist_al_centro - b.dist_al_centro),
    };
  });

  // compatibilidad global (top 5)
  const pairs = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      pairs.push({
        A: rows[i].nombre,
        B: rows[j].nombre,
        dist_z: +euclid2(points[i].x, points[j].x).toFixed(3),
      });
    }
  }
  pairs.sort((a, b) => a.dist_z - b.dist_z);
  const topPairs = pairs.slice(0, 5);

  // par más compatible dentro de cada grupo
  const within = outGroups.map((g, gi) => {
    const rr = g.rows;
    let best = null;
    for (let i = 0; i < rr.length; i++) {
      for (let j = i + 1; j < rr.length; j++) {
        const d = euclid2([rr[i].zAg, rr[i].zEmp], [rr[j].zAg, rr[j].zEmp]);
        if (!best || d < best.dist_z) best = { grupo: gi + 1, A: rr[i].NOMBRE, B: rr[j].NOMBRE, dist_z: +d.toFixed(3) };
      }
    }
    return best;
  });

  const nota = [
    `Se formaron ${k} grupos homogéneos de ${groupSize} estudiantes usando k-means en el plano (Agresión, Empatía) tras normalizar con z-score.`,
    `La compatibilidad se definió como la menor distancia euclidiana en z; se reportan los 5 pares más similares en todo el conjunto y el par más compatible de cada grupo.`,
  ].join(" ");

  return { mode: "cluster", nota, grupos: outGroups, topPairs, pairsWithin: within, n: rows.length, k, groupSize };
}

// (modo corr y modo tabla los dejamos simples por ahora)
function buildCorrelationOutput() {
  return {
    mode: "corr-info",
    nota:
      "La petición está configurada para correlaciones globales. Si quieres sólo Agresión↔Empatía, pide explícito: 'Correlación Agresión y Empatía (Pearson y Spearman) con p, n y varianzas; sólo esa pareja'.",
  };
}

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";
    const file = safeFileParam(req.query.file || req.query.f || "decimo.csv");

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const publicUrl = `${proto}://${host}/datos/${encodeURIComponent(file)}`;

    const csvText = await getCSVText(publicUrl);
    const { rows, headers } = parseCSV(csvText);
    const mode = inferMode(q);

    let data;
    if (mode === "cluster") {
      data = buildClusterOutput(rows, headers, q);
    } else if (mode === "correlation") {
      data = buildCorrelationOutput();
    } else {
      data = { mode: "table-info", nota: "Modo tabla básico. Pide 'cluster' para grupos homogéneos o 'correlación' para correlaciones." };
    }

    res.status(200).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ text: "Error interno.", details: String(e) });
  }
}
