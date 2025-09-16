const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

/**
 * Endpoint: GET /api/ask?alumno=Julia&campos=AUTOESTIMA,EMPATIA&fuente=Ambos&formato=tabla
 * - alumno   (obligatorio): nombre exacto o parcial (case-insensitive)
 * - campos   (opcional): lista separada por comas. Si se omite, usa métricas por defecto.
 * - fuente   (opcional): "A", "B" o "Ambos" (si tu CSV no distingue, se ignora)
 * - formato  (opcional): "tabla" | "json" (por ahora ambos devuelven JSON con rows)
 */

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
  const candidates = ["Nombre", "NOMBRE", "Apellidos y Nombres", "APELLIDOS Y NOMBRES", "Estudiante", "ESTUDIANTE"];
  const lower = headers.map(h => h.toLowerCase());
  let key = null;

  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i >= 0) { key = headers[i]; break; }
  }
  return key || headers[0]; // fallback al primero
}

function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(",", "."));
  return isNaN(n) ? null : n;
}

function mean(arr) {
  const a = arr.filter(x => typeof x === "number" && !isNaN(x));
  if (a.length === 0) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 200; return res.end();
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const alumnoQ = (url.searchParams.get("alumno") || "").trim();
    const camposQ = (url.searchParams.get("campos") || "").trim();
    const fuente = (url.searchParams.get("fuente") || "Ambos").trim(); // "A" | "B" | "Ambos"
    const formato = (url.searchParams.get("formato") || "tabla").trim();

    if (!alumnoQ) {
      res.statusCode = 400;
      return res.json?.({ ok: false, error: "Falta el parámetro 'alumno'." }) || res.end('{"ok":false,"error":"Falta el parámetro alumno."}');
    }

    const csvPath = path.join(process.cwd(), "public", "datos.csv");
    let csv = tryRead(csvPath, "utf8");
    if (!csv) csv = tryRead(csvPath, "latin1");
    if (!csv) {
      res.statusCode = 500;
      return res.json?.({ ok: false, error: "No se pudo leer public/datos.csv" }) || res.end('{"ok":false,"error":"No se pudo leer CSV"}');
    }

    const firstChunk = csv.slice(0, 5000);
    const delimiter = guessDelimiter(firstChunk);

    const records = parse(csv, {
      delimiter,
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    if (!records.length) {
      res.statusCode = 400;
      return res.json?.({ ok: false, error: "CSV vacío o sin cabeceras." }) || res.end('{"ok":false,"error":"CSV vacío"}');
    }

    const headers = Object.keys(records[0]);
    const nameKey = findNameKey(headers);

    // Si existiera columna de grupo (A/B), intenta detectarla
    const groupKeyCandidates = ["Grupo", "GRUPO", "Paralelo", "PARALELO", "Curso", "CURSO", "Sección", "SECCIÓN"];
    const lowerHeaders = headers.map(h => h.toLowerCase());
    let groupKey = null;
    for (const c of groupKeyCandidates) {
      const i = lowerHeaders.indexOf(c.toLowerCase());
      if (i >= 0) { groupKey = headers[i]; break; }
    }

    // Filtrado por grupo si aplica
    let data = records;
    const wantA = fuente.toLowerCase() === "a";
    const wantB = fuente.toLowerCase() === "b";
    if (groupKey && (wantA || wantB)) {
      data = records.filter(r => {
        const g = (r[groupKey] || "").toString().toUpperCase();
        if (wantA) return g.includes("A");
        if (wantB) return g.includes("B");
        return true;
      });
    }

    // Buscar alumno (match parcial, case-insensitive)
    const alumno = data.find(r => (r[nameKey] || "").toLowerCase().includes(alumnoQ.toLowerCase()));
    if (!alumno) {
      res.statusCode = 404;
      return res.json?.({ ok: false, error: `No se encontró alumno que coincida con "${alumnoQ}".` }) ||
             res.end(JSON.stringify({ ok:false, error:`No se encontró alumno "${alumnoQ}"` }));
    }

    // Métricas objetivo
    const metricKeysDefault = ["AUTOESTIMA","EMPATIA","FISICO","TENSION","RESPONSABILIDAD","COOPERACION"];
    let metricKeys = metricKeysDefault.filter(k => headers.includes(k));
    if (camposQ) {
      const asked = camposQ.split(",").map(s => s.trim()).filter(Boolean);
      metricKeys = asked.filter(k => headers.includes(k));
      if (!metricKeys.length) {
        res.statusCode = 400;
        return res.json?.({ ok:false, error:`Ninguna columna coincide con 'campos'. Disponibles: ${headers.join(", ")}` }) ||
               res.end(`{"ok":false,"error":"Campos inválidos"}`);
      }
    }

    // Conjuntos para promedios A, B, total
    let dataA = data, dataB = data, dataTotal = data;
    if (groupKey) {
      dataA = data.filter(r => (r[groupKey] || "").toString().toUpperCase().includes("A"));
      dataB = data.filter(r => (r[groupKey] || "").toString().toUpperCase().includes("B"));
    }

    const rows = metricKeys.map(k => {
      const vAlumno = toNumberOrNull(alumno[k]);
      const meanA = mean(dataA.map(r => toNumberOrNull(r[k])));
      const meanB = mean(dataB.map(r => toNumberOrNull(r[k])));
      const meanT = mean(dataTotal.map(r => toNumberOrNull(r[k])));
      return {
        campo: k,
        alumno: vAlumno,
        grupo_A: meanA,
        grupo_B: meanB,
        grupo_total: meanT
      };
    });

    const payload = {
      ok: true,
      alumno: alumno[nameKey],
      fuente,
      nameKey,
      groupKey: groupKey || null,
      n_A: groupKey ? dataA.length : null,
      n_B: groupKey ? dataB.length : null,
      n_total: dataTotal.length,
      rows
    };

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.end(JSON.stringify(payload));
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok:false, error: "Error interno", details: String(err && err.message || err) }));
  }
};
