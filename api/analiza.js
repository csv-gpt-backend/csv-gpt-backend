// api/analiza.js
import fs from "fs";
import path from "path";
import OpenAI from "openai";

// Cliente con clave desde variable de entorno (seguro en Vercel)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Cache en memoria por instancia (rápido y barato)
let CACHE = { mtimeMs: 0, headers: [], rows: [], numericCols: [] };

export default async function handler(req, res) {
  // CORS para Wix / frontends
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    // 1) Leer pregunta
    const question =
      (req.method === "POST" ? req.body?.question : req.query?.q) || "";
    const q = question.toString().trim();
    if (!q) return res.status(400).json({ error: "Falta 'question' (o 'q')." });

    // 2) Cargar y cachear CSV
    const filePath = path.join(process.cwd(), "public", "datos.csv");
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs !== CACHE.mtimeMs || CACHE.rows.length === 0) {
      const raw = fs.readFileSync(filePath, "utf8")
        .replace(/^\uFEFF/, "")
        .replace(/\r/g, "");
      const lines = raw.split("\n").filter((l) => l.trim() !== "");
      if (lines.length <= 1) {
        return res.status(200).json({ answer: "No hay datos en el CSV." });
      }

      const headers = lines[0].split(";").map((h) => h.trim());
      const rows = lines.slice(1).map((line) => {
        const cols = line.split(";").map((v) => v.trim());
        const o = {};
        headers.forEach((h, i) => (o[h] = cols[i] ?? ""));
        return o;
      });

      // Columnas numéricas (para promedios)
      const numericCols = headers.filter((h) =>
        rows.some((r) => r[h] !== "" && !isNaN(Number(String(r[h]).replace(",", "."))))
      );

      CACHE = { mtimeMs: stat.mtimeMs, headers, rows, numericCols };
    }

    const { headers, rows, numericCols } = CACHE;

    // 3) Contexto relevante
    const qLower = q.toLowerCase();
    const hasNombre = headers.some((h) => h.toLowerCase() === "nombre");

    // Si la pregunta parece mencionar un nombre, filtramos por la col "NOMBRE", si existe
    const filtered =
      hasNombre && /[a-záéíóúñ]/i.test(q)
        ? rows.filter((r) => String(r["NOMBRE"] || "").toLowerCase().includes(qLower))
        : rows;

    // Promedios por columna numérica (grupo)
    const means = {};
    for (const h of numericCols) {
      const vals = rows
        .map((r) => Number(String(r[h]).replace(",", ".")))
        .filter((v) => !isNaN(v));
      const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      means[h] = mean !== null ? Number(mean.toFixed(2)) : null;
    }

    // Reducir el tamaño del contexto (máx 20 filas relevantes)
    const contextRows = filtered.slice(0, 20);

    // 4) Prompt para GPT-5
    const system = `
Eres un asesor pedagógico. Responde SIEMPRE en español.
Usa EXCLUSIVAMENTE la evidencia del CSV (calificaciones/indicadores).
Si mencionan a un/a estudiante, compáralo con los promedios del grupo.
No inventes datos: si falta información, dilo.
Devuelve una explicación breve en viñetas y una conclusión accionable.`;

    const userInput = `
PREGUNTA: ${q}

COLUMNAS: ${JSON.stringify(headers)}
PROMEDIOS_DEL_GRUPO: ${JSON.stringify(means)}

FILAS_RELEVANTES (máximo 20):
${JSON.stringify(contextRows)}
`;

    // 5) Llamada a Responses API (Node SDK)
    // Docs: https://platform.openai.com/docs/api-reference/responses
    const ai = await openai.responses.create({
      model: "gpt-5",          // o "gpt-5-mini" para menos costo/latencia
      input: [
        { role: "system", content: system },
        { role: "user", content: userInput }
      ],
      temperature: 0.2
    });

    const answer = ai.output_text ?? "No se obtuvo respuesta del modelo.";
    return res.status(200).json({ answer });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Error interno" });
  }
}
