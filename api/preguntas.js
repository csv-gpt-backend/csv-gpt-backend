// Utilidades de ranking y emparejamientos (diadas) por una métrica
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function tryRead(file, enc) {
  try { return fs.readFileSync(file, enc); } catch { return null; }
}
function guessDelimiter(sample) {
  const s = sample || "";
  const sc = (s.match(/;/g) || []).length;
  const cc = (s.match(/,/g) || []).length;
  return sc > cc ? ";" : ",";
}
function findNameKey(headers) {
  const candidates = ["Nombre","NOMBRE","Apellidos y Nombres","APELLIDOS Y NOMBRES","Estudiante","ESTUDIANTE"];
  const lower = headers.map(h => h.toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i >= 0) return headers[i];
  }
  return headers[0];
}
function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function loadCSV() {
  const csvPath = path.join(process.cwd(), "public", "datos.csv");
  let csv = tryRead(csvPath, "utf8");
  if (!csv) csv = tryRead(csvPath, "latin1");
  if (!csv) throw new Error("No se pudo leer public/datos.csv");
  const delimiter = guessDelimiter(csv.slice(0, 5000));
  const records = parse(csv, { delimiter, columns:true, skip_empty_lines:true, trim:true });
  if (!records.length) throw new Error("CSV vacío o sin cabeceras.");
  const headers = Object.keys(records[0]);
  const nameKey = findNameKey(headers);

  const groupKeyCandidates = ["Grupo","GRUPO","Paralelo","PARALELO","Curso","CURSO","Sección","SECCIÓN"];
  const lowerHeaders = headers.map(h => h.toLowerCase());
  let groupKey = null;
  for (const c of groupKeyCandidates) {
    const i = lowerHeaders.indexOf(c.toLowerCase());
    if (i >= 0) { groupKey = headers[i]; break; }
  }
  return { records, headers, nameKey, groupKey };
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") { res.statusCode = 200; return res.end(); }

  try {
    const url = new URL(req.url, "http://localhost");
    const accion = (url.searchParams.get("accion") || "ranking").trim(); // "ranking" | "diadas"
    const campo  = (url.searchParams.get("campo")  || "EMPATIA").trim();
    const fuente = (url.searchParams.get("fuente") || "Ambos").trim();     // A | B | Ambos
    const limite = Number(url.searchParams.get("limite") || "0");          // 0 = sin límite

    const { records, headers, nameKey, groupKey } = loadCSV();

    if (!headers.includes(campo)) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({
        ok:false,
        error:`El campo '${campo}' no existe. Disponibles: ${headers.join(", ")}`
      }));
    }

    // Filtrado por grupo si procede
    let data = records;
    const wantA = fuente.toLowerCase() === "a";
    const wantB = fuente.toLowerCase() === "b";
    if (groupKey && (wantA || wantB)) {
      data = data.filter(r => {
        const g = (r[groupKey] || "").toString().toUpperCase();
        return wantA ? g.includes("A") : g.includes("B");
      });
    }

    if (accion.toLowerCase() === "ranking") {
      // Construir ranking descendente por 'campo'
      const rows = data.map(r => ({
        nombre: r[nameKey],
        grupo: groupKey ? (r[groupKey] || "") : null,
        valor: toNumberOrNull(r[campo])
      })).filter(x => x.valor !== null)
        .sort((a,b) => b.valor - a.valor)
        .map((x, i) => ({ rank: i + 1, ...x }));

      const out = limite > 0 ? rows.slice(0, limite) : rows;
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({
        ok: true,
        accion: "ranking",
        campo,
        fuente,
        groupKey: groupKey || null,
        n: rows.length,
        rows: out
      }));
    }

    // ----- DIADAS: emparejar por proximidad en 'campo' -----
    // Estrategia: ordenar por valor y emparejar adyacentes (greedy).
    const arr = data.map(r => ({
      nombre: r[nameKey],
      grupo: groupKey ? (r[groupKey] || "") : null,
      valor: toNumberOrNull(r[campo])
    })).filter(x => x.valor !== null)
      .sort((a,b) => a.valor - b.valor);

    const pairs = [];
    for (let i = 0; i < arr.length - 1; i += 2) {
      const a = arr[i], b = arr[i+1];
      pairs.push({
        nombre1: a.nombre, valor1: a.valor,
        nombre2: b.nombre, valor2: b.valor,
        diferencia: Math.abs(a.valor - b.valor),
        grupo1: a.grupo || null,
        grupo2: b.grupo || null
      });
    }
    // Si hay impar, el último queda sin pareja; lo ignoramos.

    const out = limite > 0 ? pairs.slice(0, limite) : pairs;

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({
      ok: true,
      accion: "diadas",
      campo,
      fuente,
      groupKey: groupKey || null,
      n: pairs.length,
      pairs: out
    }));
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok:false, error:"Error interno", details:String(err && err.message || err) }));
  }
};
