// /api/ask.js
import fs from "fs/promises";
import path from "path";

let CACHE_ROWS = null;

// ---------- CSV ----------
async function loadCSV() {
  if (CACHE_ROWS) return CACHE_ROWS;
  const file = path.join(process.cwd(), "datos", "decimo.csv"); // <- tu ruta
  const raw = await fs.readFile(file, "utf8");
  const delim = raw.split("\n")[0].includes(";") ? ";" : ",";
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const headers = (lines.shift() || "")
    .split(delim)
    .map((h) => h.trim());

  const rows = lines.map((l) => {
    const cols = l.split(delim).map((c) => c.trim());
    const o = {};
    headers.forEach((h, i) => (o[h] = cols[i] ?? ""));
    return o;
  });

  CACHE_ROWS = rows;
  return rows;
}

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

function scoreName(query, name) {
  const q = norm(query).split(" ").filter(Boolean);
  const n = norm(name).split(" ").filter(Boolean);
  if (!q.length || !n.length) return 0;
  let hit = 0;
  for (const t of q) if (n.includes(t)) hit++;
  return hit / Math.max(q.length, 1);
}

function bestMatch(rows, query) {
  let best = null;
  let bestScore = 0;
  for (const r of rows) {
    const name =
      r["NOMBRE"] || r["Nombre"] || r["ALUMNO"] || r["Alumno"] || "";
    const s = scoreName(query, name);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  return bestScore >= 0.4 ? best : null; // puedes ajustar el umbral
}

function buildSummary(row) {
  const name =
    row["NOMBRE"] || row["Nombre"] || row["ALUMNO"] || row["Alumno"] || "";
  const edad = row["EDAD"] || row["Edad"] || "";
  const curso = row["CURSO"] || row["Curso"] || "";
  const paralelo = row["PARALELO"] || row["Paralelo"] || "";

  // arma pares clave:valor legibles excluyendo algunos ya usados
  const skip = new Set([
    "NOMBRE",
    "Nombre",
    "ALUMNO",
    "Alumno",
    "EDAD",
    "Edad",
    "CURSO",
    "Curso",
    "PARALELO",
    "Paralelo",
  ]);

  const extras = Object.entries(row)
    .filter(([k, v]) => !skip.has(k) && String(v || "").trim() !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");

  let header = `Resumen de ${name}`;
  if (edad || curso || paralelo) {
    const chips = [];
    if (edad) chips.push(`Edad ${edad}`);
    if (curso) chips.push(`Curso ${curso}`);
    if (paralelo) chips.push(`Paralelo ${paralelo}`);
    header += ` (${chips.join(", ")})`;
  }

  return `${header}.\n${extras}`;
}

// ---------- OpenAI fallback ----------
async function askOpenAI(q) {
  const apiKey =
    process.env.OPENAI_API_KEY ||
    process.env.CLAVE_API_DE_OPENAI ||
    process.env["CLAVE API DE OPENAI"];

  if (!apiKey) {
    return {
      text:
        "No tengo la API Key configurada en OPENAI_API_KEY. Pídale al admin que la agregue en Vercel.",
    };
  }

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Eres una asistente educativa clara y ejecutiva. Responde en español (México).",
        },
        { role: "user", content: q },
      ],
      temperature: 0.7,
    }),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    return { text: `No pude consultar OpenAI (HTTP ${r.status}). ${errText}` };
  }
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || "Sin respuesta.";
  return { text };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  try {
    const q =
      (req.query?.q || req.body?.q || "").toString().trim() || "ping";

    // 1) intentamos con CSV (si la pregunta trae un nombre o pista)
    try {
      const rows = await loadCSV();
      const found = bestMatch(rows, q);
      if (found) {
        const text = buildSummary(found);
        return res.status(200).json({ text });
      }
    } catch (e) {
      // si falla el CSV, seguimos con OpenAI sin tumbar la API
      console.error("CSV error:", e);
    }

    // 2) fallback a OpenAI
    const ai = await askOpenAI(q);
    return res.status(200).json({ text: ai.text });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "Error interno." });
  }
}
