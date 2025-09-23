// /api/ask.js
// Fallback robusto: responde aunque el modelo no devuelva JSON.
// Lee CSV y TXT desde URL; soporta GPT-5 y GPT-4o/mini.

import OpenAI from "openai";

// ⚠️ Ajusta si tu clave tiene otro nombre; este orden cubre casos comunes:
const OPENAI_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.open_ai_key ||
  process.env["CLAVE API DE OPENAI"] ||
  process.env.CLAVE_API_DE_OPENAI;

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Rutas directas (sin variable) como pediste
const CSV_URL  = "https://csv-gpt-backend.vercel.app/datos/decimo.csv";
const TXT_URL  = "https://csv-gpt-backend.vercel.app/emocionales.txt";

// ------- utilidades -------
const client = new OpenAI({ apiKey: OPENAI_KEY });

function isGpt5(id = "") {
  return /^gpt-5/i.test(id.trim());
}

function withTimeout(ms, promise) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function safeFetchText(url, label, ms = 6000) {
  try {
    const r = await withTimeout(ms, fetch(url, { cache: "no-store" }));
    if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
    const t = await r.text();
    return t;
  } catch (e) {
    console.warn(`[ASK][WARN] ${label} fallo:`, e?.message || e);
    return "";
  }
}

function buildSystem() {
  return `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.
Reglas:
- Si se piden listas/tablas, produce TABLA en Markdown (| Col | … |) sin asteriscos y sin explicaciones dentro de la tabla.
- Si el usuario pide "todos", no OMITAS filas.
- Usa exactamente las columnas solicitadas. Si no existen en el CSV, dilo y sugiere alternativas.
- Si piden métricas (promedios, correlaciones, etc.), explica el método y entrega los resultados con claridad.`;
}

function buildUser(question, csv, txt) {
  const hasCsv = csv && csv.trim().length > 0;
  const hasTxt = txt && txt.trim().length > 0;

  const pieces = [`PREGUNTA: "${question}"`];

  if (hasCsv) {
    // enviamos CSV tal cual (recortado si es enorme, para no exceder tokens)
    const preview = csv.length > 200_000 ? csv.slice(0, 200_000) : csv;
    pieces.push(`\nDATOS_CSV (separador ; o , según aparezca, crudo):\n"""${preview}"""`);
  } else {
    pieces.push(`\nNo pude leer el CSV.`);
  }

  if (hasTxt) {
    const txtPrev = txt.length > 120_000 ? txt.slice(0, 120_000) : txt;
    pieces.push(`\nAPOYO_TXT (emocionales):\n"""${txtPrev}"""`);
  }

  pieces.push(`\nFormato de salida OBLIGATORIO (JSON plano):
{
  "texto": "explicación clara en español (sin asteriscos).",
  "tablas_markdown": "si aplica, UNA tabla en Markdown; si no aplica, deja cadena vacía"
}`);

  return pieces.join("\n");
}

function normalizeModelParams(modelId) {
  // GPT-5 solo acepta temperature = 1 y usa max_completion_tokens
  if (isGpt5(modelId)) {
    return { temperature: 1, max_completion_tokens: 1000 };
  }
  // otros modelos (4o/mini) pueden usar temperature < 1
  return { temperature: 0.2 };
}

function toSafeResponse(rawContent) {
  // Si el modelo ignoró response_format y devolvió texto suelto,
  // aseguramos un JSON con 'texto' y 'tablas_markdown'.
  let texto = "";
  let tablas = "";

  // Intentar JSON
  try {
    const parsed = JSON.parse(rawContent);
    texto  = String(parsed.texto || parsed.text || "").trim();
    tablas = String(parsed.tablas_markdown || parsed.tables_markdown || "").trim();
  } catch {
    // No es JSON → usamos crudo como 'texto'
    texto = String(rawContent || "").trim();
    tablas = "";
  }

  // Limpieza mínima: quitar asteriscos
  texto = texto.replace(/\*/g, "");

  return { texto, tablas_markdown: tablas };
}

// ------- handler -------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Método no permitido. Usa POST con JSON." });
    }
    if (!OPENAI_KEY) {
      return res.status(200).json({
        texto: "Falta la clave de OpenAI. Configura OPENAI_API_KEY en Vercel.",
        tablas_markdown: ""
      });
    }

    const { question } = req.body || {};
    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(200).json({ texto: "Por favor, escribe una pregunta.", tablas_markdown: "" });
    }
    const q = question.trim();

    // Traemos CSV y TXT en paralelo con timeout
    const [csvText, txtText] = await Promise.all([
      safeFetchText(CSV_URL, "CSV", 6000),
      safeFetchText(TXT_URL, "TXT", 6000),
    ]);

    const system = buildSystem();
    const user   = buildUser(q, csvText, txtText);

    // Parámetros según el modelo
    const extra = normalizeModelParams(MODEL);

    // 1) Intento con response_format JSON
    let raw = "";
    try {
      const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: user }
        ],
        response_format: { type: "json_object" },
        ...extra
      });
      raw = completion?.choices?.[0]?.message?.content || "";
    } catch (e) {
      console.warn("[ASK][WARN] JSON formatting falló, reintento como texto:", e?.message || e);
      // 2) Reintento sin response_format
      const completion2 = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: user }
        ],
        ...extra
      });
      raw = completion2?.choices?.[0]?.message?.content || "";
    }

    const { texto, tablas_markdown } = toSafeResponse(raw);

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ texto, tablas_markdown });
  } catch (err) {
    console.error("[ASK][ERROR]", err);
    return res.status(200).json({
      texto: `Ocurrió un error al procesar la consulta: ${err?.message || "desconocido"}.`,
      tablas_markdown: ""
    });
  }
}

// (opcional) también puedes exportar para Vercel edge/node si ya lo tenías
// export const config = { runtime: 'nodejs20.x' };
