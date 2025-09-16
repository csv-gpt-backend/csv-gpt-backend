// /api/ask_gpt.js — Vercel Serverless (Node 18+)
// 1) Calcula métricas directamente (parsea CSV, convierte números, agrupa)
// 2) Si no detecta columnas, envía el CSV completo a GPT como respaldo
import fs from "fs";
import path from "path";

const VERSION = "gpt5-csv-hybrid-v1.1";
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.OPENAI_API;

function send(res, code, obj) {
  res.status(code).setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.end(JSON.stringify(obj));
}

function detectDelimiter(sample) {
  const head = sample.split(/\r?\n/).slice(0, 5).join("\n");
  const counts = [
    [",", (head.match(/,/g) || []).length],
    [";", (head.match(/;/g) || []).length],
    ["\t", (head.match(/\t/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  return counts[0][1] ? counts[0][0] : ",";
}

let cached = { csv: null, file: null, headers: [], rows: 0, delim: "," };

function loadCSV() {
  const candidates = [
    path.join(process.cwd(), "api", "data.csv"),
    path.join(process.cwd(), "data.csv"),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      const csv = fs.readFileSync(f, "utf8");
      const delim = detectDelimiter(csv);
      const lines = csv.split(/\r?\n/).filter((l) => l.trim().length);
      const headers = (lines[0] || "").split(delim).map((h) => h.trim());
      cached = { csv, file: f, headers, rows: Math.max(0, lines.length - 1), delim };
      return;
    }
  }
  throw new Error("CSV no encontrado (buscado en api/data.csv y data.csv).");
}

function parseCSVToObjects(csv, delim) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(delim).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      let v = (cols[j] ?? "").trim();
      // normalizar números: "3,8" -> 3.8 ; "1.234,56" -> 1234.56
      const maybeNum = v.replace(/\s/g, "");
      if (/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(maybeNum)) {
        v = maybeNum.replace(/\./g, "").replace(",", ".");
      }
      if (/^-?\d+(\.\d+)?$/.test(v)) obj[headers[j]] = Number(v);
      else obj[headers[j]] = cols[j] === undefined ? "" : (v || "");
    }
    rows.push(obj);
  }
  return { headers, rows };
}

function findHeader(headers, patterns) {
  // patterns: array de regex
  for (const re of patterns) {
    const hit = headers.find((h) => re.test(h));
    if (hit) return hit;
  }
  return null;
}

function mean(arr) {
  const nums = arr.filter((x) => typeof x === "number" && !Number.isNaN(x));
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function groupBy(arr, key) {
  return arr.reduce((m, r) => {
    const k = (r[key] ?? "").toString().trim() || "(vacío)";
    (m[k] ||= []).push(r);
    return m;
  }, {});
}

async function chatJSON({ system, user }) {
  const payload = {
    model: "gpt-5",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(text); } catch { return { respuesta: text }; }
}

function tryAnswerDeterministic(q, dataset) {
  const H = dataset.headers;
  const rows = dataset.rows;

  // Aliases de columnas
  const nameHeader =
    findHeader(H, [/^nombre\b/i, /^estudiante\b/i, /^alumno\b/i]) || H[0];

  const paraleloHeader =
    findHeader(H, [/^paral/i, /^secci(ó|o)n/i, /^curso\b/i]) || null;

  const asertHeader = findHeader(H, [/asertiv/i, /^asert/i]);
  const phiHeader = findHeader(H, [
    /promedio.*interpersonal/i,
    /\bph.?inter/i,
    /habilidades.*interpersonales.*prom/i,
  ]);

  const wantsRanking =
    /ranking|ordenar|mayor\s*a\s*menor|de mayor a menor/i.test(q) &&
    /interpersonal/i.test(q);

  const wantsAsert =
    /asertiv/i.test(q);

  const wantsSplit =
    /por\s*separado|por\s*paralelo|a\s*y\s*b|a\s*y\s*b|A y B/i.test(q);

  // 1) Ranking de PHI
  if (wantsRanking && phiHeader && nameHeader) {
    const map = rows.map((r) => ({
      NOMBRE: (r[nameHeader] ?? "").toString(),
      valor: typeof r[phiHeader] === "number" ? r[phiHeader] : null,
    }));
    const filtered = map.filter((x) => typeof x.valor === "number");
    if (filtered.length) {
      filtered.sort((a, b) => (b.valor ?? -Infinity) - (a.valor ?? -Infinity));
      const out = filtered.map((x, i) => ({
        NOMBRE: x.NOMBRE,
        valor: x.valor,
        posicion: i + 1,
      }));
      return {
        ok: true,
        respuesta: `Ranking de ${phiHeader} (desc)`,
        tabla: { headers: ["NOMBRE", "valor", "posición"], rows: out.map(o => [o.NOMBRE, o.valor, o.posicion]) },
        stats: { n: out.length, columna: phiHeader, nombre: nameHeader, modo: "deterministico" },
        data: out,
      };
    }
  }

  // 2) Promedio de ASERTIVIDAD por paralelo
  if (wantsAsert && wantsSplit && asertHeader && paraleloHeader) {
    const g = groupBy(rows, paraleloHeader);
    const out = Object.entries(g).map(([k, arr]) => {
      const m = mean(arr.map((r) => r[asertHeader]));
      return { paralelo: k, n: arr.length, promedio: Number(m.toFixed(3)) };
    });
    return {
      ok: true,
      respuesta: `Promedio de ${asertHeader} por ${paraleloHeader}`,
      tabla: { headers: ["paralelo", "n", "promedio"], rows: out.map(o => [o.paralelo, o.n, o.promedio]) },
      stats: { grupos: out.length, columna: asertHeader, grupo: paraleloHeader, modo: "deterministico" },
      data: out,
    };
  }

  // Si no se detectó nada sólido, devolver null para que usemos GPT
  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return res.status(204).end();
    }
    if (!OPENAI_API_KEY) return send(res, 500, { error: "Falta OPENAI_API_KEY" });
    if (!cached.csv) loadCSV();

    const q = (req.method === "GET" ? req.query.q : req.body?.q)?.toString().trim() || "";

    // Rutas rápidas
    if (!q || q.toLowerCase() === "ping") return send(res, 200, { ok: true });
    if (q.toLowerCase() === "version") return send(res, 200, { version: VERSION });
    if (q.toLowerCase() === "diag")
      return send(res, 200, {
        file: cached.file,
        rows: cached.rows,
        headers: cached.headers,
        delimiter: cached.delim === "\t" ? "TAB" : cached.delim,
      });

    // Parsear CSV y tratar de responder determinísticamente
    const dataset = parseCSVToObjects(cached.csv, cached.delim);
    const deterministic = tryAnswerDeterministic(q, dataset);
    if (deterministic) return send(res, 200, deterministic);

    // ——— Respado GPT con CSV completo + JSON estructurado ———
    const system = `
Eres un analista. Recibirás un CSV completo (entre <CSV>...</CSV>) y también el mismo dataset en JSON (entre <JSON>...</JSON>).
Si puedes, calcula a partir del JSON (más fiable), y responde **solo JSON válido** con:
{
  "respuesta": "texto corto",
  "tabla": { "headers": [...], "rows": [[...], ...] },
  "stats": { "n": <int>, "extra": {...} }
}
Reglas:
- "por separado"/"por paralelo" => agrupa por la columna de paralelo/sección.
- Si piden ranking (mayor→menor) usa orden descendente.
- Acepta alias de "PROMEDIO HABILIDADES INTERPERSONALES": incluye "PHINTERPERSONALES".
- Acepta alias de "ASERTIVIDAD": cualquier variante "asertiv".
- Incluye todos los grupos (A y B).
- Nada de Markdown; sin inventar columnas. Si no encuentras, dilo en "respuesta".
`.trim();

    const user = `
<CSV>
${cached.csv}
</CSV>

<JSON>
${JSON.stringify(dataset)}
</JSON>

Pregunta:
${q}
`.trim();

    const out = await chatJSON({ system, user });
    return send(res, 200, out);
  } catch (err) {
    return send(res, 500, { error: String(err.message || err) });
  }
}

export const config = { runtime: "nodejs" };
