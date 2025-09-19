// /api/ask.js
// Analiza CSV/PDF ubicados en /public. Responde texto o JSON (?format=json).
export const config = { runtime: "nodejs" };

// ===== Modelo y clave =====
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // cámbialo si usas otro
const API_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.CLAVE_API_DE_OPENAI ||
  process.env["CLAVE API DE OPENAI"] ||
  process.env["CLAVE API DE APERTURA"];

// ===== Cache simple de lecturas =====
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { ts, text }

let pdfParseModule = undefined;
async function loadPdfParse() {
  if (pdfParseModule !== undefined) return pdfParseModule;
  try {
    const mod = await import("pdf-parse");
    pdfParseModule = mod?.default || mod;
  } catch {
    pdfParseModule = null; // funciona sin pdf-parse
  }
  return pdfParseModule;
}

function extOf(path) { return (path.split(".").pop() || "").toLowerCase(); }

async function getTextFromPublicUrl(publicUrl) {
  const hit = cache.get(publicUrl);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_MS) return hit.text;

  const r = await fetch(publicUrl);
  if (!r.ok) throw new Error(`No pude leer ${publicUrl} (HTTP ${r.status})`);

  const isPDF = new URL(publicUrl).pathname.toLowerCase().endsWith(".pdf");
  let text = "";
  if (isPDF) {
    const mod = await loadPdfParse();
    if (!mod) {
      text = "[PDF encontrado, pero falta instalar 'pdf-parse'.]";
    } else {
      const ab = await r.arrayBuffer();
      const parsed = await mod(Buffer.from(ab)).catch(() => ({ text: "" }));
      text = (parsed.text || "").trim() || "[No se pudo extraer texto del PDF.]";
    }
  } else {
    text = await r.text();
  }
  cache.set(publicUrl, { ts: now, text });
  return text;
}

function detectDelim(firstLine) {
  if (!firstLine) return ",";
  if (firstLine.includes(";")) return ";";
  if (firstLine.includes("\t")) return "\t";
  if (firstLine.includes("|")) return "|";
  return ",";
}

// ===== Prompts =====
function systemPromptText() {
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Recibirás uno o varios documentos: CSV y/o PDFs.",
    "Reglas:",
    "1) CSV: detecta delimitador y analiza tal cual.",
    "2) PDF: usa definiciones/escalas/criterios útiles; no inventes.",
    "3) Si piden ORDENAR/RANQUEAR, aplica exactamente el criterio y dilo: 'Criterio de orden aplicado: ...'.",
    "4) Si la respuesta requiere listados/grupos/top-N, añade al final un bloque CSV entre triple backticks. Primera columna '#'.",
    "5) Si hay grupos A/B u otros, inclúyelos todos.",
    "6) Si faltan datos, dilo y aproxima con lo disponible.",
    "7) Extensión ~150–180 palabras."
  ].join(" ");
}
function userPromptText(query, sourcesText) {
  const blocks = sourcesText.map((s, i) => {
    if (s.type === "csv") {
      const first = (s.text.split(/\r?\n/)[0] || "").slice(0, 500);
      const delim = detectDelim(first);
      return [
        `=== FUENTE ${i + 1}: ${s.label} (CSV; DELIMITADOR_APROX=${JSON.stringify(delim)}) ===`,
        "```csv", s.text, "```",
      ].join("\n");
    } else {
      return [`=== FUENTE ${i + 1}: ${s.label} (PDF TEXTO) ===`, s.text].join("\n");
    }
  }).join("\n\n");

  return [`PREGUNTA: ${query}`, "Analiza TODAS las fuentes. Si hay conflicto, sé explícita.", blocks].join("\n");
}

function systemPromptJSON() {
  return [
    "Eres una asesora educativa clara y ejecutiva (español México).",
    "Devuelve SOLO un objeto JSON con claves:",
    "diagnostico, fortalezas, oportunidades, recomendaciones_corto_plazo, recomendaciones_mediano_plazo, riesgos.",
  ].join(" ");
}
function userPromptJSON(query, sourcesText) {
  const blocks = sourcesText.map((s, i) => {
    if (s.type === "csv") {
      return [`=== FUENTE ${i + 1}: ${s.label} (CSV) ===`, "```csv", s.text, "```"].join("\n");
    } else {
      return [`=== FUENTE ${i + 1}: ${s.label} (PDF TEXTO) ===`, s.text].join("\n");
    }
  }).join("\n\n");
  return [`PREGUNTA: ${query}`, "Analiza TODAS las fuentes:", blocks].join("\n");
}

async function callOpenAI(messages, forceJson = false) {
  if (!API_KEY) return { ok: false, text: "Falta configurar la clave de OpenAI en el servidor." };
  const body = { model: MODEL, messages, temperature: 0.35 };
  if (forceJson) body.response_format = { type: "json_object" };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  let data = null; try { data = await r.json(); } catch {}
  const text = data?.choices?.[0]?.message?.content?.trim() || `No pude consultar OpenAI (HTTP ${r.status}).`;
  return { ok: true, text };
}

// ===== Handler =====
export default async function handler(req, res) {
  try {
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";
    const format = (req.query.format || "").toString().toLowerCase();

    // ========== LISTA BLANCA (ignoramos ?src= de la query) ==========
    const srcs = [
      "datos/decimo.csv",
      "documentos/lexium.pdf",
      "documentos/evaluaciones.pdf",
      "documentos/emocionales.pdf",
    ];
    // ================================================================

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;

    // Carga tolerante a errores (salta 404 y continúa)
    const sourcesText = [];
    const skipped = [];
    for (const p of srcs) {
      const publicUrl = `${proto}://${host}/${encodeURI(p)}`;
      try {
        const t = await getTextFromPublicUrl(publicUrl);
        const type = extOf(p) === "pdf" ? "pdf" : "csv";
        sourcesText.push({ label: p, type, text: t });
      } catch (err) {
        skipped.push(`${p} (${String(err?.message || err)})`);
      }
    }

    if (!sourcesText.length) {
      return res.status(200).json({
        ok: false,
        text: `No encontré fuentes válidas: ${skipped.join(" | ")}`,
        fuentes: srcs,
        formato: format || "texto",
      });
    }

    // Ping rápido (sin gastar tokens)
    if (q.toLowerCase() === "ping") {
      return res.status(200).json({
        ok: true, text: "pong", fuentes: srcs, omitidas: skipped, formato: "texto"
      });
    }

    let messages, forceJson = false;
    if (format === "json") {
      messages = [
        { role: "system", content: systemPromptJSON() },
        { role: "user", content: userPromptJSON(q, sourcesText) },
      ];
      forceJson = true;
    } else {
      messages = [
        { role: "system", content: systemPromptText() },
        { role: "user", content: userPromptText(q, sourcesText) },
      ];
    }

    const ai = await callOpenAI(messages, forceJson);

    return res.status(200).json({
      ok: ai.ok !== false,
      text: ai.text,
      fuentes: srcs,
      omitidas: skipped,
      formato: format || "texto",
    });
  } catch (e) {
    console.error("Error interno en /api/ask:", e);
    return res.status(200).json({ ok: false, text: `Error interno: ${String(e)}` });
  }
}
