// api/ask.js
import fs from "fs/promises";
import path from "path";

// ---------- util: CORS ----------
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ---------- parse CSV simple (sin comillas complejas) ----------
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0].split(",").map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const cols = line.split(",");
    const obj = {};
    headers.forEach((h, i) => {
      const raw = (cols[i] ?? "").trim();
      const num = Number(raw.replace(",", "."));
      obj[h] = Number.isFinite(num) && raw !== "" ? num : raw;
    });
    return obj;
  });
  return { headers, rows };
}

// ---------- detectar columna probable de nombre ----------
function detectNameColumn(headers, rows) {
  const lower = headers.map(h => h.toLowerCase());
  let idx = lower.findIndex(h => h.includes("nombre"));
  if (idx === -1) idx = lower.findIndex(h => h.includes("alumno"));
  if (idx !== -1) return headers[idx];

  // fallback: columna con más strings no numéricos
  let best = { header: null, score: -1 };
  for (const h of headers) {
    let score = 0;
    for (const r of rows) {
      const v = r[h];
      if (typeof v === "string" && v.trim() !== "" && isNaN(Number(v))) score++;
    }
    if (score > best.score) best = { header: h, score };
  }
  return best.header || headers[0];
}

// ---------- helpers estadísticos ----------
function mean(nums) {
  if (!nums.length) return NaN;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function getNumeric(rows, col) {
  return rows
    .map(r => r[col])
    .filter(v => typeof v === "number" && Number.isFinite(v));
}
function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "N/A";
}

// ---------- parser simple de consulta ----------
function normalize(s) {
  return s
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quita tildes
    .toLowerCase();
}

function parseQuery(qRaw) {
  // Soporta expresiones básicas:
  // - "promedio de AUTOESTIMA"
  // - "promedio en AUTOESTIMA"
  // - "nota de "Julia" en AUTOESTIMA"
  // - "calificacion de Julia en AUTOESTIMA"
  // - "top 5 en AUTOESTIMA"
  // - "peor 3 en AUTOESTIMA" | "bottom 3 de AUTOESTIMA"
  // - "resumen de AUTOESTIMA"
  // - "fila de Julia" | "datos de "Julia""
  const q = normalize(qRaw);

  // alumno entre comillas (si viene)
  const quoted = qRaw.match(/"([^"]+)"/);
  const studentQuoted = quoted ? quoted[1].trim() : null;

  // alumno suelto (sin comillas)
  let studentPlain = null;
  const mAlumno = q.match(/\bde\s+([a-záéíóúñ\.\- ]+)\s+(?:en|de)\b/);
  if (mAlumno && !studentQuoted) {
    studentPlain = mAlumno[1].trim();
  }

  // columna
  let mCol = q.match(/\b(?:en|de)\s+([a-záéíóúñ0-9\.\- _]+)$/i);
  let column = mCol ? mCol[1].trim() : null;

  // tipos
  if (/^ping$/.test(q)) return { type: "ping" };
  if (/^fila de\b|^datos de\b/.test(q) && (studentQuoted || studentPlain)) {
    return { type: "fila", alumno: studentQuoted || studentPlain };
  }
  if (/^resumen de\b|^resumen en\b/.test(q) && column) {
    return { type: "resumen", columna: column };
  }
  if (/^promedio de\b|^promedio en\b/.test(q) && column) {
    return { type: "promedio", columna: column };
  }
  if (/\b(?:nota|calificacion|valor)\s+de\b/.test(q) && (studentQuoted || studentPlain) && column) {
    return { type: "valor", alumno: studentQuoted || studentPlain, columna: column };
  }
  // top N
  let mTop = q.match(/\btop\s+(\d+)\s+(?:en|de)\s+([a-z0-9\.\- _]+)/i);
  if (mTop) return { type: "top", n: parseInt(mTop[1],10), columna: mTop[2].trim() };
  // bottom/peor N
  let mBottom = q.match(/\b(?:bottom|peor)\s+(\d+)\s+(?:en|de)\s+([a-z0-9\.\- _]+)/i);
  if (mBottom) return { type: "bottom", n: parseInt(mBottom[1],10), columna: mBottom[2].trim() };

  return { type: "unknown" };
}

// ---------- endpoint principal ----------
export default async function handler(req, res) {
  setCORS(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const q = (req.method === "POST" ? req.body?.q : req.query?.q) ?? "";
    const qStr = String(q || "").trim();
    if (!qStr) return res.status(400).json({ ok: false, error: "Falta parámetro q" });

    if (normalize(qStr) === "ping") {
      return res.status(200).json({ ok: true, respuesta: "pong" });
    }

    // lee CSV
    const csvPath = path.join(process.cwd(), "public", "datos.csv");
    const csvText = await fs.readFile(csvPath, "utf8");
    const { headers, rows } = parseCSV(csvText);
    if (headers.length === 0 || rows.length === 0) {
      return res.status(200).json({ ok: true, respuesta: "No hay datos en el CSV." });
    }

    const nameCol = detectNameColumn(headers, rows);
    const parsed = parseQuery(qStr);
    const lowerHeaders = headers.map(h => ({ raw: h, norm: normalize(h) }));

    // helper para mapear nombre de columna escrito por el usuario a header real
    function resolveColumn(colUser) {
      const n = normalize(colUser);
      const hit = lowerHeaders.find(h => h.norm === n || h.norm.includes(n) || n.includes(h.norm));
      return hit?.raw || null;
    }

    // --------- casos ----------
    if (parsed.type === "fila") {
      const alumno = (parsed.alumno || "").toLowerCase();
      const row = rows.find(r => String(r[nameCol] ?? "").toLowerCase().includes(alumno));
      const out = row ? JSON.stringify(row, null, 2) : `No se encontró el alumno "${parsed.alumno}".`;
      return res.status(200).json({ ok: true, respuesta: out });
    }

    if (parsed.type === "resumen") {
      const col = resolveColumn(parsed.columna);
      if (!col) return res.status(200).json({ ok: true, respuesta: `Columna no encontrada: ${parsed.columna}` });

      const nums = getNumeric(rows, col);
      if (!nums.length) return res.status(200).json({ ok: true, respuesta: `La columna "${col}" no es numérica o no tiene datos.` });

      const min = Math.min(...nums), max = Math.max(...nums), prom = mean(nums);
      const txt = `Resumen de "${col}" (n=${nums.length}): min=${fmt(min)}, max=${fmt(max)}, promedio=${fmt(prom)}.`;
      return res.status(200).json({ ok: true, respuesta: txt });
    }

    if (parsed.type === "promedio") {
      const col = resolveColumn(parsed.columna);
      if (!col) return res.status(200).json({ ok: true, respuesta: `Columna no encontrada: ${parsed.columna}` });

      const nums = getNumeric(rows, col);
      if (!nums.length) return res.status(200).json({ ok: true, respuesta: `La columna "${col}" no es numérica o no tiene datos.` });

      const prom = mean(nums);
      return res.status(200).json({ ok: true, respuesta: `Promedio de "${col}": ${fmt(prom)} (n=${nums.length}).` });
    }

    if (parsed.type === "valor") {
      const col = resolveColumn(parsed.columna);
      if (!col) return res.status(200).json({ ok: true, respuesta: `Columna no encontrada: ${parsed.columna}` });

      const alumno = (parsed.alumno || "").toLowerCase();
      const row = rows.find(r => String(r[nameCol] ?? "").toLowerCase().includes(alumno));
      if (!row) return res.status(200).json({ ok: true, respuesta: `No se encontró el alumno "${parsed.alumno}".` });

      const v = row[col];
      const isNum = typeof v === "number" && Number.isFinite(v);
      return res.status(200).json({
        ok: true,
        respuesta: `Valor de "${col}" para ${row[nameCol]}: ${isNum ? fmt(v) : (v ?? "N/A")}.`
      });
    }

    if (parsed.type === "top" || parsed.type === "bottom") {
      const n = Math.max(1, Math.min(50, parsed.n || 5));
      const col = resolveColumn(parsed.columna);
      if (!col) return res.status(200).json({ ok: true, respuesta: `Columna no encontrada: ${parsed.columna}` });

      const arr = rows
        .map(r => ({ nombre: r[nameCol], val: r[col] }))
        .filter(x => typeof x.val === "number" && Number.isFinite(x.val));

      if (!arr.length) return res.status(200).json({ ok: true, respuesta: `La columna "${col}" no es numérica o no tiene datos.` });

      arr.sort((a, b) => (parsed.type === "top" ? b.val - a.val : a.val - b.val));
      const take = arr.slice(0, n);
      const lines = take.map((x, i) => `${i + 1}. ${x.nombre}: ${fmt(x.val)}`).join("\n");
      return res.status(200).json({ ok: true, respuesta: `${parsed.type.toUpperCase()} ${n} en "${col}":\n${lines}` });
    }

    // fallback
    const ayuda =
`No pude interpretar la consulta.
Pruebas útiles:
- "promedio de AUTOESTIMA"
- "resumen de AUTOESTIMA"
- "valor de "Julia" en AUTOESTIMA"
- "top 5 en MATEMATICAS"
- "bottom 3 de LECTURA"
- "fila de "Julia""`;

    return res.status(200).json({ ok: true, respuesta: ayuda });

  } catch (e) {
    console.error("ASK ERROR:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
