// /api/ask.js  — Planificador (GPT) + Ejecutador (JS puro)
// Lee /public/datos/<file>.csv, pide a GPT un PLAN JSON y lo ejecuta.
// Soporta: filtros, selección de columnas, order/limit, percentiles/quintiles,
// cómputo de índice global (media de columnas numéricas), y correlación Pearson.
// Devuelve: { text, formato: "json"|"texto", archivo, filas_aprox }

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"];

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

/* ==================== Utilidades CSV / estadística ==================== */
function pickDelimiter(sampleLines) {
  const cands = [",", ";", "\t", "|"];
  let best = ",",
    bestScore = -1;
  for (const d of cands) {
    let score = 0;
    for (const line of sampleLines) {
      const parts = line.split(d);
      if (parts.length > 1) score += parts.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return { headers: [], rows: [] };
  const d = pickDelimiter(lines.slice(0, 10));
  const rows = lines.map((l) => l.split(d).map((c) => c.trim()));
  const headers = rows[0];
  const body = rows.slice(1);
  // objetos
  const objects = body.map((r) => {
    const o = {};
    headers.forEach((h, i) => (o[h] = r[i] ?? ""));
    return o;
  });
  return { headers, rows: objects };
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]+/g, ""));
  return Number.isFinite(n) ? n : null;
}
function isMostlyNumeric(arr) {
  const nums = arr.map(toNum).filter((v) => v !== null);
  return nums.length / arr.length >= 0.6;
}
function percentile(arr, p) {
  const v = arr.map(toNum).filter((x) => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  if (p <= 0) return v[0];
  if (p >= 100) return v[v.length - 1];
  const rank = (p / 100) * (v.length - 1);
  const lo = Math.floor(rank),
    hi = Math.ceil(rank);
  const w = rank - lo;
  return v[lo] * (1 - w) + v[hi] * w;
}
function mean(arr) {
  const v = arr.map(toNum).filter((x) => x !== null);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}
function median(arr) {
  const v = arr.map(toNum).filter((x) => x !== null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function corrPearson(xArr, yArr) {
  const x = [],
    y = [];
  for (let i = 0; i < xArr.length; i++) {
    const a = toNum(xArr[i]),
      b = toNum(yArr[i]);
    if (a !== null && b !== null) {
      x.push(a);
      y.push(b);
    }
  }
  const n = x.length;
  if (n < 3) return { r: NaN, r2: NaN, n };
  const mx = mean(x),
    my = mean(y);
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = x[i] - mx,
      by = y[i] - my;
    num += ax * by;
    dx += ax * ax;
    dy += by * by;
  }
  const den = Math.sqrt(dx * dy);
  const r = den ? num / den : NaN;
  return { r, r2: r * r, n };
}

/* ==================== GPT Planner ==================== */
function buildSchema(headers, rows) {
  // tipo por columna y ejemplos
  const schema = headers.map((h) => {
    const col = rows.map((r) => r[h]);
    const numeric = isMostlyNumeric(col);
    const sample = Array.from(
      new Set(col.map((v) => (v ?? "")).slice(0, 30))
    ).slice(0, 6);
    return { name: h, type: numeric ? "number" : "string", sample };
  });
  return schema;
}

const SYSTEM_PLANNER = `
Eres un planificador de consultas sobre un CSV. Debes devolver SOLO JSON válido
que describe un plan de ejecución sobre la tabla. No calcules números, solo
propón el plan. Esquema permitido:

{
  "mode": "table" | "correlation" | "explanation",
  "select": ["colA","colB",...],         // opcional
  "filters": [{"col":"Col","op":"==|!=|>|>=|<|<=|contains|in","value":any}], // opcional
  "orderBy": [{"col":"Col","dir":"asc|desc"}],   // opcional
  "limit": 10,                                   // opcional
  "computed": [                                  // opcional: columnas calculadas
    {"as":"IndiceGlobal","op":"mean","cols":["lista de columnas numericas"]}
  ],
  "percentileFilters": [                         // opcional: filtros por percentil
    {"col":"Col","op":">=","p":80}               // ejemplo: >= P80
  ],
  "quintile": {"col":"Col","index": 1..5},       // opcional
  "correlation": {                               // opcional
    "autoTop": 10                                // calcula top correlaciones entre columnas numericas
    // ó "pairs":[{"x":"ColX","y":"ColY"}, ...]
  },
  "explanation": "texto breve para el usuario"
}

Reglas:
- Usa EXCLUSIVAMENTE los nombres de columna que te doy en "schema".
- Si el usuario pide "los mejores usando todas las habilidades", crea "computed"
  con "op":"mean" y "cols" = TODAS las columnas numéricas de habilidades (excluir Edad, Curso, Paralelo).
- Para "quintil más alto" usa "quintile":{"index":5} y "col" la métrica pedida.
- Si solo quiere dos alumnos, usa "limit":2 después del orden correcto.
- Si pide correlaciones globales, "mode":"correlation" y usa "autoTop": un número razonable (p.ej. 10).
- Añade "explanation" corta y útil siempre.
`;

async function callPlanner(prompt) {
  if (!API_KEY)
    throw new Error(
      "Falta configurar OPENAI_API_KEY / CLAVE_API_DE_OPENAI en Vercel."
    );

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: prompt,
    }),
  });
  const data = await r.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  return text;
}

/* ==================== Ejecutar PLAN ==================== */
function normalizeOp(op) {
  const m = String(op || "").toLowerCase();
  return m;
}
function applyFilters(rows, filters = []) {
  if (!filters || !filters.length) return rows;
  return rows.filter((row) =>
    filters.every((f) => {
      const v = row[f.col];
      const op = normalizeOp(f.op);
      const val = f.value;
      const n = toNum(v);
      const nv = toNum(val);

      if (op === "contains") {
        return String(v ?? "").toLowerCase().includes(String(val ?? "").toLowerCase());
      }
      if (op === "in") {
        return Array.isArray(val) ? val.map(String).includes(String(v)) : false;
      }

      // numéricos si aplican
      if (n !== null && nv !== null) {
        if (op === "==") return n === nv;
        if (op === "!=") return n !== nv;
        if (op === ">") return n > nv;
        if (op === ">=") return n >= nv;
        if (op === "<") return n < nv;
        if (op === "<=") return n <= nv;
      }

      // alfanumérico
      if (op === "==") return String(v) === String(val);
      if (op === "!=") return String(v) !== String(val);

      return true; // si no sabemos, no filtramos
    })
  );
}
function applyPercentileFilters(rows, pctFilters = []) {
  if (!pctFilters || !pctFilters.length) return rows;
  let out = rows;
  for (const pf of pctFilters) {
    const col = pf.col;
    const op = normalizeOp(pf.op);
    const arr = out.map((r) => r[col]);
    const cut = percentile(arr, pf.p);
    out = out.filter((r) => {
      const n = toNum(r[col]);
      if (n === null || cut === null) return false;
      if (op === ">=") return n >= cut;
      if (op === "<=") return n <= cut;
      if (op === ">") return n > cut;
      if (op === "<") return n < cut;
      if (op === "==") return n === cut;
      return true;
    });
  }
  return out;
}
function applyQuintile(rows, qSpec) {
  if (!qSpec || !qSpec.col || !qSpec.index) return rows;
  const col = qSpec.col;
  const q = Math.max(1, Math.min(5, qSpec.index));
  const pLo = (q - 1) * 20;
  const pHi = q * 20;
  const arr = rows.map((r) => r[col]);
  const cutLo = percentile(arr, pLo);
  const cutHi = percentile(arr, pHi);
  if (q === 5) {
    return rows.filter((r) => {
      const n = toNum(r[col]);
      return n !== null && n >= cutLo;
    });
  }
  return rows.filter((r) => {
    const n = toNum(r[col]);
    return n !== null && n >= cutLo && n <= cutHi;
  });
}
function addComputed(rows, computed = []) {
  if (!computed || !computed.length) return rows;
  return rows.map((r) => {
    const o = { ...r };
    for (const c of computed) {
      const as = c.as || "computed";
      const cols = Array.isArray(c.cols) ? c.cols : [];
      const values = cols.map((k) => toNum(r[k])).filter((x) => x !== null);
      if (!values.length) {
        o[as] = "";
        continue;
      }
      const op = String(c.op || "").toLowerCase();
      if (op === "mean" || op === "avg") o[as] = mean(values);
      else if (op === "sum") o[as] = values.reduce((a, b) => a + b, 0);
      else if (op === "min") o[as] = Math.min(...values);
      else if (op === "max") o[as] = Math.max(...values);
      else o[as] = mean(values);
    }
    return o;
  });
}
function applyOrderLimit(rows, orderBy = [], limit) {
  let arr = rows.slice();
  if (orderBy && orderBy.length) {
    arr.sort((a, b) => {
      for (const o of orderBy) {
        const col = o.col;
        const dir = String(o.dir || "asc").toLowerCase();
        const av = a[col],
          bv = b[col];
        const an = toNum(av),
          bn = toNum(bv);
        let cmp = 0;
        if (an !== null && bn !== null) cmp = an - bn;
        else cmp = String(av).localeCompare(String(bv));
        if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }
  if (typeof limit === "number" && limit >= 0) arr = arr.slice(0, limit);
  return arr;
}

function objectsToArray(headers, objs) {
  const rows = [headers];
  for (const o of objs) rows.push(headers.map((h) => (o[h] ?? "").toString()));
  return rows;
}

/* ========== Correlación: autoTop o pairs ========== */
function computeCorrelations(headers, rows, opt) {
  const numericCols = headers.filter((h) =>
    isMostlyNumeric(rows.map((r) => r[h]))
  );
  const out = [];
  if (opt?.pairs?.length) {
    for (const p of opt.pairs) {
      if (!numericCols.includes(p.x) || !numericCols.includes(p.y)) continue;
      const { r, r2, n } = corrPearson(
        rows.map((r) => r[p.x]),
        rows.map((r) => r[p.y])
      );
      if (Number.isFinite(r)) out.push({ X: p.x, Y: p.y, r, R2: r2, n });
    }
  } else {
    // autoTop
    const top = Math.max(1, Math.min(50, opt?.autoTop ?? 10));
    for (let i = 0; i < numericCols.length; i++) {
      for (let j = i + 1; j < numericCols.length; j++) {
        const a = numericCols[i],
          b = numericCols[j];
        const { r, r2, n } = corrPearson(
          rows.map((r) => r[a]),
          rows.map((r) => r[b])
        );
        if (Number.isFinite(r)) out.push({ X: a, Y: b, r, R2: r2, n });
      }
    }
    out.sort((u, v) => Math.abs(v.r) - Math.abs(u.r));
    out.splice(top);
  }
  const tabHeaders = ["#", "X", "Y", "r", "R² (%)", "n"];
  const arr = out.map((o, i) => [
    i + 1,
    o.X,
    o.Y,
    o.r.toFixed(3),
    (o.R2 * 100).toFixed(1),
    o.n,
  ]);
  return [tabHeaders, ...arr];
}

/* ==================== Handler ==================== */
export default async function handler(req, res) {
  try {
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";
    const file = safeFileParam(req.query.file || req.query.f || "decimo.csv");

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const publicUrl = `${proto}://${host}/datos/${encodeURIComponent(file)}`;

    // 1) CSV
    const csvText = await getCSVText(publicUrl);
    const { headers, rows } = parseCSV(csvText);
    if (!headers.length) {
      return res
        .status(200)
        .json({ text: "CSV vacío o ilegible.", archivo: file, formato: "texto" });
    }

    // 2) Esquema para el plan
    const schema = buildSchema(headers, rows);

    // 3) Llamada al planificador (con autocorrección si viene mal)
    const baseMessages = [
      { role: "system", content: SYSTEM_PLANNER },
      {
        role: "user",
        content:
          "Pregunta del usuario:\n" +
          q +
          "\n\n" +
          "schema:\n" +
          JSON.stringify(schema, null, 2),
      },
    ];

    let planText = await callPlanner(baseMessages);
    let plan;
    try {
      plan = JSON.parse(planText);
    } catch (e) {
      // un reintento pidiéndole que devuelva JSON válido
      const retry = await callPlanner([
        ...baseMessages,
        {
          role: "assistant",
          content: planText,
        },
        {
          role: "user",
          content:
            "Tu respuesta NO fue JSON válido. Devuelve únicamente JSON válido según el esquema indicado.",
        },
      ]);
      planText = retry;
      try {
        plan = JSON.parse(planText);
      } catch (e2) {
        // Modo fallback: texto a secas (evita quedarnos sin respuesta)
        return res.status(200).json({
          text:
            "No pude estructurar un plan para ejecutar la consulta. Respuesta del planificador:\n\n" +
            planText,
          archivo: file,
          formato: "texto",
        });
      }
    }

    const mode = (plan?.mode || "table").toLowerCase();
    const explanation = plan?.explanation || "";

    // 4) Ejecutar el plan
    let working = rows.slice();

    // computed (p.ej. índice global)
    if (Array.isArray(plan?.computed) && plan.computed.length) {
      working = addComputed(working, plan.computed);
    }

    // filtros directos
    if (Array.isArray(plan?.filters) && plan.filters.length) {
      working = applyFilters(working, plan.filters);
    }

    // filtros por percentil (>= P80, etc.)
    if (Array.isArray(plan?.percentileFilters) && plan.percentileFilters.length) {
      working = applyPercentileFilters(working, plan.percentileFilters);
    }

    // quintil
    if (plan?.quintile) {
      working = applyQuintile(working, plan.quintile);
    }

    if (mode === "correlation") {
      const table = computeCorrelations(headers, working, plan.correlation || {});
      return res.status(200).json({
        text: JSON.stringify(table),
        archivo: file,
        filas_aprox: working.length + 1,
        formato: "json",
        nota: explanation,
      });
    }

    // selección de columnas
    let selectCols = Array.isArray(plan?.select) && plan.select.length
      ? plan.select
      : headers;

    // ordenar / limitar
    working = applyOrderLimit(working, plan?.orderBy || [], plan?.limit);

    // 5) Formatear tabla
    const table = objectsToArray(selectCols, working);

    // Si la tabla está vacía, devolvemos "No existe información"
    if (table.length <= 1) {
      return res.status(200).json({
        text: "No existe información.",
        archivo: file,
        filas_aprox: 0,
        formato: "texto",
      });
    }

    // Empaquetar explicación + tabla para tu front (formato json)
    // (El front ya muestra la tabla y lee 'nota' si quieres usarla)
    return res.status(200).json({
      text: JSON.stringify(table),
      archivo: file,
      filas_aprox: table.length - 1,
      formato: "json",
      nota: explanation,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "Error interno.", details: String(e) });
  }
}
