// api/ask.js  (Vercel Serverless - CommonJS)
const fs = require("fs").promises;
const path = require("path");

// --- CSV helpers (delimitador + comillas) ---
function detectDelimiter(line) {
  const cands = [",", ";", "\t", "|"];
  let best = { d: ",", n: 0 };
  for (const d of cands) {
    const n = line.split(d).length;
    if (n > best.n) best = { d, n };
  }
  return best.d;
}
function splitCSVLine(line, d) {
  const out = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === d && !inQuotes) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
function parseCSV(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter(l => l.length > 0);
  if (!lines.length) return { headers: [], rows: [], delimiter: "," };
  const delimiter = detectDelimiter(lines[0]);
  const headers = splitCSVLine(lines[0], delimiter);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCSVLine(lines[i], delimiter);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] ?? ""; });
    rows.push(obj);
  }
  return { headers, rows, delimiter };
}
function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s === "" || s.toLowerCase() === "na" || s.toLowerCase() === "null") return null;
  let n = Number(s);
  if (Number.isNaN(n) && s.includes(",") && !s.includes(".")) n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function firstNumericKey(obj) {
  if (!obj) return null;
  for (const k of Object.keys(obj)) {
    if (toNum(obj[k]) !== null) return k;
  }
  return null;
}
function caseMap(headers){ const m = {}; headers.forEach(h => m[h.toLowerCase()] = h); return m; }

// --- Handler ---
module.exports = async (req, res) => {
  try {
    const {
      q = "",
      file = "decimo.csv",
      format = "json",
      limit,           // opcional: ?limit=50
      columns,         // opcional: ?columns=Nombre,Promedio,Paralelo (case-insensitive)
      sort_by,         // opcional: ?sort_by=Promedio (desc)
      filter_key,      // opcional: ?filter_key=Paralelo&filter_val=A
      filter_val
    } = req.query || {};

    const csvPath = path.join(process.cwd(), "public", "datos", file);
    const raw = await fs.readFile(csvPath, "utf8");
    const { headers, rows } = parseCSV(raw);
    const cmap = caseMap(headers);

    // Proyección de columnas (si se pidieron)
    let data = rows.map(r => ({ ...r }));
    if (columns) {
      const want = String(columns).split(",").map(s => s.trim()).filter(Boolean);
      const actual = want.map(k => cmap[k.toLowerCase()] ?? k);
      data = data.map(r => {
        const o = {};
        actual.forEach(k => { o[k] = r[k]; });
        return o;
      });
    }

    // Filtro simple (key=val)
    if (filter_key && filter_val !== undefined){
      const k = cmap[String(filter_key).toLowerCase()] ?? filter_key;
      data = data.filter(r => String(r[k]).toLowerCase() === String(filter_val).toLowerCase());
    }

    // Heurísticas por texto de la pregunta
    const qlow = q.toLowerCase();
    const wantsList = /lista|listado|mostrar|ver|despliega/.test(qlow);
    const wantsRanking = /ranking|mayor a menor|ordenar|top|rank/.test(qlow);
    const metricHints = ["calificación","calificacion","promedio","nota","puntaje","score","total"];
    let metric = null;

    // Si piden “timidez/agresividad/empatía/…” mostramos al menos esas columnas + nombre
    const featureMatch = qlow.match(/\b(agresividad|empat[ií]a|timidez|f[ií]sico|autoestima|tensi[oó]n|ansiedad)\b/);
    if (featureMatch){
      const feat = featureMatch[1];
      const kf = Object.keys(cmap).find(k => k.includes(feat)); // case-insensitive contain
      const kn = Object.keys(cmap).find(k => k.includes("nombre")||k.includes("alumno")||k.includes("estudiante"));
      if (kf){
        data = rows.map(r => {
          const o = {};
          if (kn) o[cmap[kn]] = r[cmap[kn]];
          o[cmap[kf]] = r[cmap[kf]];
          // Incluimos “Paralelo/Curso” si existen
          const kp = Object.keys(cmap).find(k => k.includes("paralelo"));
          if (kp) o[cmap[kp]] = r[cmap[kp]];
          const kc = Object.keys(cmap).find(k => k.includes("curso"));
          if (kc) o[cmap[kc]] = r[cmap[kc]];
          return o;
        });
      }
    }

    // Ranking si lo piden (detecta métrica probable)
    if (wantsRanking){
      const sample = data[0] || rows[0];
      // preferidas
      for (const h of headers){
        if (metricHints.some(w => h.toLowerCase().includes(w))) { metric = h; break; }
      }
      if (!metric) metric = firstNumericKey(sample);
      if (metric){
        data = [...data].sort((a,b)=>(toNum(b[metric])||-Infinity)-(toNum(a[metric])||-Infinity));
      }
    }

    // Orden personalizado (?sort_by=Promedio)
    if (sort_by){
      const key = cmap[String(sort_by).toLowerCase()] ?? sort_by;
      data = [...data].sort((a,b)=>(toNum(b[key])||-Infinity)-(toNum(a[key])||-Infinity));
    }

    // Límite de filas
    let n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) n = data.length;
    data = data.slice(0, n);

    // Regla: si pidieron lista/ranking/columna → devolvemos filas
    if (wantsList || wantsRanking || featureMatch || columns || filter_key || sort_by){
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(200).json({ rows: data });
    }

    // Si el front pide format=json devolvemos filas por defecto (seguro)
    if (String(format).toLowerCase() === "json"){
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(200).json({ rows: data });
    }

    // Texto plano (no recomendado). Devolvemos algo simple.
    const kn = Object.keys(cmap).find(k => k.includes("nombre")||k.includes("alumno")||k.includes("estudiante"));
    const kp = Object.keys(cmap).find(k => k.includes("paralelo"));
    const km = headers.find(h => metricHints.some(w => h.toLowerCase().includes(w))) || firstNumericKey(rows[0]);
    const lines = data.slice(0, 20).map((r,i)=>{
      const nombre = kn ? r[cmap[kn]] : `Fila ${i+1}`;
      const par = kp ? `, Paralelo: ${r[cmap[kp]]}` : "";
      const mv = km ? `, ${km}: ${r[km]}` : "";
      return `${i+1}. ${nombre}${par}${mv}`;
    });
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(lines.join("\n"));

  } catch (err) {
    console.error(err);
    res.status(200).json({ answer: "No se encontró respuesta, revisa el archivo CSV o el parámetro 'file'." });
  }
};
