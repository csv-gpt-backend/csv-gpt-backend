// api/ask.js

import OpenAI from "openai";

// ====== CONFIG ======
const OPENAI_KEY =
  process.env.open_ai_key ||
  process.env.OPENAI_API_KEY;

const CSV_URL = "https://csv-gpt-backend.vercel.app/datos/decimo.csv";
const TXT_URL = "https://csv-gpt-backend.vercel.app/emocionales.txt";

// Modelo objetivo principal y fallback:
const PRIMARY_MODEL = process.env.OPENAI_MODEL || "gpt-5";
const FALLBACK_MODEL = "gpt-4o-mini";

// Tamaños para recorte (evitar prompts gigantes)
const MAX_CHARS_CSV = 180_000;
const MAX_CHARS_TXT = 80_000;

// Timeout de inferencia (ms)
const PRIMARY_TIMEOUT_MS = 25_000;   // GPT-5 puede tardar más
const FALLBACK_TIMEOUT_MS = 18_000;  // 4o-mini rápido

// ====================

const client = new OpenAI({ apiKey: OPENAI_KEY });

function okJson(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    typeof obj.texto === "string" &&
    typeof obj.tablas_markdown === "string"
  );
}

function extractJsonLoose(s) {
  if (!s || typeof s !== "string") return null;
  // intenta extraer el primer {...} grande
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }
  return null;
}

async function fetchText(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const r = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const t = await r.text();
    console.log(`[ASK][FETCH] ${label}: ${t.length} chars`);
    return t;
  } finally {
    clearTimeout(timer);
  }
}

function buildSystemPrompt(headerCsv) {
  return `Eres una analista educativa rigurosa. Responde SIEMPRE en español latino neutral.

Reglas duras:
- Si el usuario pide "todos los estudiantes", debes listar a TODOS sin omitir ninguno.
- Usa EXACTAMENTE las columnas solicitadas. Si pide varias columnas, inclúyelas todas.
- Presenta las listas/tablas en formato Markdown (| Col | ... |) con encabezados.
- No pongas asteriscos para resaltar. Evita adornos.
- El CSV puede estar separado por punto y coma (;). Interprétalo correctamente.

Si se piden análisis estadísticos (promedios, correlaciones, varianzas, regresiones, etc.), explícalos y realiza los cálculos con los datos del CSV que se te proveen (dentro de lo posible). Si el cálculo supera lo disponible en el contexto, devuelve el método paso a paso y una estimación razonable, pero intenta calcular con los datos visibles.
${headerCsv ? `\nColumnas detectadas/nota: ${headerCsv}\n` : ""}`;
}

function buildUserPrompt(question, csvSlice, txtSlice) {
  return `PREGUNTA: "${question}"

TROZO DEL CSV (representativo, puede estar separado por ";"):
«««
${csvSlice}
»»»

TEXTO DE APOYO (emocionales):
«««
${txtSlice}
»»»

Instrucciones de salida (devuelve SOLO JSON):
{
  "texto": "<explicación clara en español, sin asteriscos. No escribas código salvo que se pida explícitamente>",
  "tablas_markdown": "<si procede una lista/tabla, inclúyela en formato Markdown con todas las filas requeridas y columnas exactas; si no aplica, deja cadena vacía>"
}`;
}

async function callOpenAI(model, messages, timeoutMs, forJson = false) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Nota: GPT-5 no soporta response_format json_object ni temperature ≠ 1.
    //       gpt-4o-mini sí admite response_format json_object y temperature 0.2.
    const opts = {
      model,
      messages,
    };

    if (model.startsWith("gpt-5")) {
      // Ajustes compatibles con GPT-5 (según errores anteriores reportados).
      opts.temperature = 1; // único valor aceptado
      opts.max_completion_tokens = 1000;
    } else {
      // Modelos 4o/4o-mini
      opts.temperature = 0.2;
      if (forJson) {
        opts.response_format = { type: "json_object" };
      }
    }

    const resp = await client.chat.completions.create(opts, { signal: controller.signal });
    const content = resp?.choices?.[0]?.message?.content || "";
    console.log(`[ASK][RAW][${model}]`, content ? "ok" : "vacío");
    return content;
  } finally {
    clearTimeout(to);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Método no permitido. Usa POST con JSON." });
    }
    if (!OPENAI_KEY) {
      return res.status(200).json({
        texto: "Falta la clave de OpenAI (open_ai_key). Configúrala en Vercel.",
        tablas_markdown: "",
      });
    }

    const { question } = req.body || {};
    if (!question || typeof question !== "string" || !question.trim()) {
      return res.status(200).json({ texto: "Por favor, escribe una pregunta.", tablas_markdown: "" });
    }
    const q = question.trim();

    // 1) Traer fuentes
    const [csvFull, txtFull] = await Promise.all([
      fetchText(CSV_URL, "CSV"),
      fetchText(TXT_URL, "TXT"),
    ]);

    const csvSlice = (csvFull || "").slice(0, MAX_CHARS_CSV);
    const txtSlice = (txtFull || "").slice(0, MAX_CHARS_TXT);

    // Intento rudimentario de extraer "encabezado visible"
    const firstLine = (csvFull || "").split(/\r?\n/)[0] || "";
    const headerCsv = firstLine.slice(0, 500);

    // 2) Prompts
    const system = buildSystemPrompt(headerCsv);
    const user = buildUserPrompt(q, csvSlice, txtSlice);

    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];

    // 3) Llamar primero a GPT-5
    let content = "";
    let parsed = null;

    try {
      console.log(`[ASK][TRY] ${PRIMARY_MODEL}`);
      content = await callOpenAI(PRIMARY_MODEL, messages, PRIMARY_TIMEOUT_MS, false);
      parsed = extractJsonLoose(content);
      if (!okJson(parsed)) {
        console.warn("[ASK][WARN] GPT-5 no devolvió JSON usable. Intentando fallback…");
        // Fallback automático a 4o-mini con response_format json_object
        console.log(`[ASK][TRY] ${FALLBACK_MODEL}`);
        content = await callOpenAI(FALLBACK_MODEL, messages, FALLBACK_TIMEOUT_MS, true);
        try {
          parsed = JSON.parse(content);
        } catch {
          parsed = extractJsonLoose(content);
        }
      }
    } catch (err) {
      console.warn("[ASK][ERR] GPT-5 falló, usando fallback:", err?.message || err);
      content = await callOpenAI(FALLBACK_MODEL, messages, FALLBACK_TIMEOUT_MS, true);
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = extractJsonLoose(content);
      }
    }

    // 4) Validar resultado
    if (!okJson(parsed)) {
      console.warn("[ASK][WARN] No se pudo parsear JSON. Enviando texto crudo.");
      const texto =
        content?.trim() ||
        "El modelo no devolvió contenido utilizable en este intento. Intenta con una pregunta más específica o vuelve a consultar en unos segundos.";
      return res.status(200).json({ texto, tablas_markdown: "" });
    }

    // 5) Saneado por si acaso
    const texto = String(parsed.texto || "").replace(/\*/g, "").trim();
    const tablas_markdown = String(parsed.tablas_markdown || "").trim();

    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ texto, tablas_markdown });
  } catch (err) {
    console.error("[ASK][FATAL]", err?.message || err);
    return res.status(200).json({
      texto: `Ocurrió un problema procesando la consulta. Intenta nuevamente. Detalle: ${err?.message || "desconocido"}.`,
      tablas_markdown: "",
    });
  }
}
