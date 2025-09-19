// /api/ask.js  (CommonJS - Vercel Node runtime)
// Reemplaza esta línea (si existe):
// const MODEL = process.env.OPENAI_MODEL || "gpt-5";

// Por esta (modelo único y obligatorio):
const MODEL = "gpt-5";

const pdfParse = require("pdf-parse");

exports.config = { runtime: "nodejs" };

const MODEL = process.env.OPENAI_MODEL || "gpt-5"; // Exclusivo GPT-5 por defecto
const API_KEY =
  process.env.OPENAI_API_KEY ||          // tu variable en Vercel
  process.env.CLAVE_API_DE_OPENAI ||     // compatibilidad vieja
  process.env["CLAVE API DE APERTURA"];  // compatibilidad vieja

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // url -> { ts, text }

function safePathParam(s, def = "datos/decimo.csv") {
  let x = (s || "").toString().trim();
  if (!x) return def;
  if (x.includes("..") || x.includes("\\") || x.startsWith("http")) return def;
  x = x.replace(/^\/+/, "");
  return x;
}
function extOf(p) { return (p.split(".").pop() || "").toLowerCase(); }

async function getTextFromPublicUrl(publicUrl) {
  const hit = cache.get(publicUrl);
  const now = Date.now();
  if (hit && now - hit.ts < CACHE_MS) return hit.text;

  const r = await fetch(publicUrl);
  if (!r.ok) throw new Error(`No pude leer ${publicUrl} (HTTP ${r.status})`);

  const isPDF = new URL(publicUrl).pathname.toLowerCase().endsWith(".pdf");
  let text = "";

  if (isPDF) {
    try {
      const ab = await r.arrayBuffer();
      const buf = Buffer.from(ab);
      const parsed = await pdfParse(buf).catch(() => ({ text: "" }));
      text = (parsed.text || "").trim();
      if (!text) text = "[No se pudo extraer texto del PDF (¿escaneado/imagen?).]";
    } catch (e) {
      text = `[Error leyendo PDF: ${String(e.message || e)}]`;
    }
  } else {
    text = await r.text(); // CSV/Texto
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

// Prompts
function systemPromptText() {
  return [
    "Eres una asesora educativa clara y ejecutiva (es-MX).",
    "Analiza CSV/PDF provistos; no inventes.",
    "Si piden ordenar/rankear, cumple exactamente (asc/desc, columna/métrica) y decláralo: 'Criterio de orden aplicado: ...'.",
    "Si la respuesta requiere listados/tablas/top-N, agrega un bloque CSV entre triple backticks al final. Primera columna '#'.",
    "No repitas la misma info en texto y tabla; si hay tabla, evita duplicación textual.",
    "Omite frases del tipo 'según el CSV'; responde directo.",
    "Si faltan datos, dilo y aproxima con lo disponible.",
    "Longitud objetivo: 150–180 palabras."
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

  return [
    `PREGUNTA: ${query}`,
    "Analiza TODAS las fuentes. Si hay conflicto, sé explícita.",
    "Cuando pida LISTAS/LISTADOS/TABLAS: arma columnas con títulos y datos solicitados; no repitas el texto arriba.",
    blocks,
  ].join("\n");
}

async function callOpenAI(messages) {
  if (!API_KEY) {
    return { ok: false, text: "Falta configurar OPENAI_API_KEY en Vercel." };
  }
  const body = {
    model: MODEL,
    messages,
    temperature: 0.15,
    // tokens altos: que no escatime
    max_tokens: 4096
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  const raw = await r.text().catch(() => "");
  let data = null; try { data = JSON.parse(raw); } catch {}

  if (!r.ok) {
    const msg = data?.error?.message || `OpenAI no-ok (${r.status})`;
    console.error("OpenAI error:", r.status, raw);
    return { ok: false, text: `Error de OpenAI: ${msg}` };
  }
  const text = data?.choices?.[0]?.message?.content?.trim() || "OpenAI no devolvió contenido.";
  return { ok: true, text };
}

module.exports = async function handler(req, res) {
  try {
    const q = (req.query.q || req.body?.q || "").toString().trim() || "ping";
    const dry = (req.query.dry || req.body?.dry || "").toString().trim() === "1";

    let srcs = req.query.src || req.body?.src;
    if (!srcs) {
      srcs = [
        "datos/decimo.csv",
        "documentos/lexium.pdf",
        "documentos/evaluaciones.pdf",
        "documentos/emocionales.pdf"
      ];
    }
    if (!Array.isArray(srcs)) srcs = [srcs];

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;

    const sourcesText = [];
    const used = [];

    for (const raw of srcs) {
      const p = safePathParam(raw);
      if (!p) continue;

      const publicUrl = `${proto}://${host}/${encodeURI(p)}`;
      const type = extOf(p) === "pdf" ? "pdf" : "csv";
      try {
        const text = await getTextFromPublicUrl(publicUrl);
        sourcesText.push({ label: p, type, text });
        used.push(p);
        console.log("[FUENTE OK]", p, "len:", text?.length || 0);
      } catch (e) {
        console.error("[FUENTE ERROR]", p, e);
        sourcesText.push({ label: p, type: "error", text: `[${String(e)}]` });
        used.push(p);
      }
    }

    // Diagnóstico: sin OpenAI
    if (dry) {
      return res.status(200).json({
        ok: true, modo: "dry", q, fuentes: used,
        previews: sourcesText.map(s => ({
          label: s.label, type: s.type,
          chars: (s.text || "").length,
          preview: (s.text || "").slice(0, 400)
        }))
      });
    }

    // Llamada real
    const messages = [
      { role: "system", content: systemPromptText() },
      { role: "user", content: userPromptText(q, sourcesText) },
    ];
    const ai = await callOpenAI(messages);

    // devolvemos 200 incluso con error de AI, para que el front lo vea
    return res.status(200).json({
      text: ai.text, fuentes: used, formato: "texto", model: MODEL, ok: ai.ok
    });
  } catch (e) {
    console.error("ASK handler error:", e);
    return res.status(200).json({ text: `Error interno: ${String(e.message || e)}` });
  }
};
