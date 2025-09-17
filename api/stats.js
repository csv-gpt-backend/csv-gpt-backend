// api/stats.js  (Vercel Serverless - CommonJS)
const fs = require("fs").promises;
const path = require("path");

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
function basicStats(arr) {
  const a = arr.filter(v => v !== null && Number.isFinite(v)).sort((x, y) => x - y);
  const n = a.length;
  if (!n) return { n: 0, min: null, max: null, mean: null, p50: null, p90: null, p99: null };
  const min = a[0], max = a[n - 1];
  const mean = a.reduce((s, v) => s + v, 0) / n;
  const pct = (p) => {
    if (n === 1) return a[0];
    const pos = (n - 1) * p;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return a[lo];
    const w = pos - lo;
    return a[lo] * (1 - w) + a[hi] * w;
  };
  return { n, min, max, mean, p50: pct(0.5), p90: pct(0.9), p99: pct(0.99) };
}
function pearson(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (x !== null && y !== null) pairs.push([x, y]);
  }
  const n = pairs.length;
  if (n < 2) return { r: null, n_pairs: n };
  let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
  for (const [x, y] of pairs) {
    sumX += x; sumY += y;
    sumXX += x * x; sumYY += y * y; sumXY += x * y;
  }
  const cov = sumXY - (sumX * sumY) / n;
  const varX = sumXX - (sumX * sumX) / n;
  const varY = sumYY - (sumY * sumY) / n;
  if (varX <= 0 || varY <= 0) return { r: null, n_pairs: n };
  const r = cov / Math.sqrt(varX * varY);
  return { r, n_pairs: n };
}

module.exports = async (req, res) => {
  try {
    const { file = "decimo.csv", x = "AGRESIVIDAD", y = "EMPATIA", group_by } = req.query || {};
    const csvPath = path.join(process.cwd(), "public", "datos", file);
    const raw = await fs.readFile(csvPath, "utf8");
    const { headers, rows, delimiter } = parseCSV(raw);

    const keyMap = {}; headers.forEach(h => keyMap[h.toLowerCase()] = h);
    const kx = keyMap[String(x).toLowerCase()] ?? x;
    const ky = keyMap[String(y).toLowerCase()] ?? y;
    const kg = group_by ? (keyMap[String(group_by).toLowerCase()] ?? group_by) : null;

    const X = rows.map(r => toNum(r[kx]));
    const Y = rows.map(r => toNum(r[ky]));
    const overall = { x: basicStats(X), y: basicStats(Y), ...pearson(X, Y) };

    const groups = {};
    if (kg) {
      const by = {};
      for (let i = 0; i < rows.length; i++) {
        const g = (rows[i][kg] ?? "SinGrupo") || "SinGrupo";
        if (!by[g]) by[g] = { X: [], Y: [] };
        by[g].X.push(X[i]); by[g].Y.push(Y[i]);
      }
      for (const g of Object.keys(by)) {
        const xg = by[g].X, yg = by[g].Y;
        groups[g] = { x: basicStats(xg), y: basicStats(yg), ...pearson(xg, yg) };
      }
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json({
      file, delimiter_used: delimiter,
      columns_detected: headers,
      x: kx, y: ky, group_by: kg || null,
      n_total: rows.length,
      overall, groups
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo procesar el CSV o parámetros inválidos." });
  }
};
