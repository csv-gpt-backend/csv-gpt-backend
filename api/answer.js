// /api/answer.js
// Analiza TXT embebido (/data/texto_base.js), CSV (/datos/decimo.csv)
// y PDFs o TXT opcionales en /datos/pdfs/*
// Requiere variable de entorno: open_ai_key (o OPENAI_API_KEY)

import fs from "fs";
import path from "path";

export const config = { runtime: "nodejs" };

/* ============ Utilidades ============ */
function clip(s, max = 80000) {
  s = String(s || "");
  return s.length > max ? s.slice(0, max) + "\n[... recortado ...]" : s;
}
function safeRead(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

/* ============ PDFs/TXT en /datos/pdfs ============ */
// Si tienes "pdf-parse" instalado en package.json, extrae texto de PDF.
// Si no, puedes colocar archivos .txt en /datos/pdfs y se concatenan.
async function readPDFsOrTxt() {
  const base = path.join(process.cwd(), "datos", "pdfs");
  try {
    if (!fs.existsSync(base)) return { text: "", files: [] };

    const pdfFiles = fs.readdirSync(base).filter(f => f.toLowerCase().endsWith(".pdf"));
    if (pdfFiles.length > 0) {
      try {
        const pdfParse = (await import("pdf-parse")).default;
        const chunks = [];
        for (const f of pdfFiles) {
          const buff = fs.readFileSync(path.join(base, f));
          const data = await pdfParse(buff).catch(() => null);
          if (data?.text) chunks.push(data.text);
        }
        return { text: chunks.join("\n\n"), files: pdfFiles };
      } catch {
        // pdf-parse no está instalado: no rompas
        return { text: "", files: pdfFiles };
      }
    }

    // fallback a .txt
    const txtFiles = fs.readdirSync(base).filter(f => f.toLowerCase().endsWith(".txt"));
    const text = txtFiles.map(f => safeRead(path.join(base, f))).join("\n\n");
    return { text, files: txtFiles };
  } catch {
    return { text: "", files: [] };
  }
}

/* ============ Recolectar el corpus local ============ */
async function gatherLocalCorpus() {
  // 1) Texto embebido
  let textoBase = "";
  try {
    const mod = await import("../data/texto_base.js");
    textoBase = String(mod?.TEXTO_BASE ?? "");
  } catch { textoBase = ""; }

  // 2) CSV
  const csvPath = path.join(process.cwd(), "datos", "decimo.csv");
  const csv = safeRead(csvPath);

  // 3) PDFs/TXT en /datos/pdfs
  const pdfs = await readPDFsOrTxt();

  return {
    textoBase: clip(textoBase, 120000),
    csv: clip(csv, 120000),
    pdfText: clip(pdfs.text, 180000),
    meta: { csvPath, pdfFiles: pdfs.files }
  };
}

/* ============ Llamada a OpenAI ============ */
async function callOpenAI({ question, corpus, model, apiKey }) {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });

  const { textoBase, csv, pdfText } = corpus;

  const system = `
Eres una analista experta. Responde en ESPAÑOL (MX/EC) con precisión y calma.
REGLAS:
- Ignora asteriscos (*).
- No digas "según el archivo CSV" ni "no puedo realizar".
- Puedes hacer cálculos psicométricos, promedios, regresiones simples, progresiones y estadística básica.
- Si el usuario pide listas/tablas, entrégalos como tablas.
- Devuelve EXCLUSIVAMENTE JSON válido con esta forma:
{
  "general": "<texto con explicación y cálculos si aplica>",
  "tables": [
    { "title":"...", "columns":["Col1","Col2",...], "rows":[["v1","v2"],["..."]] }
  ]
}
No incluyas backticks ni texto fuera del JSON.
`.trim();

  const user = `
PREGUNTA: ${String(question || "").replaceAll("*","")}

FUENTES LOCALES (combínalas si sirve):
[TXT embebido]
${textoBase || "(vacío)"}

[CSV decimo.csv]
${csv || "(vacío)"}

[PDF/TXT]
${pdfText || "(vacío)"}
`.trim();

  // IMPORTANTE: NO usar temperature != 1 (algunos modelos dan 400).
  // De hecho la omitimos para que use el valor permitido por el modelo.
  const response = await client.chat.completions.create({
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    // Si tu modelo no soporta response_format, comenta la siguiente línea:
    response_format: { type: "json_object" }
  });

  const content = response.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(content);
  } catch {
    // Si por algún motivo devuelve texto no-JSON, lo envolvemos
    return { general: content, tables: [] };
  }
}

/* ============ Handler ============ */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const body = req.method === "POST" ? (req.body || {}) : (req.query || {});
    const question = String(body.question || body.q || "");
    const model = String(body.model || "");
    const apiKey = process.env.open_ai_key || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "Falta la variable de entorno open_ai_key (u OPENAI_API_KEY) en Vercel."
      });
    }
    if (!question.trim()) {
      return res.status(400).json({ ok: false, error: "Falta la pregunta (question|q)." });
    }

    const corpus = await gatherLocalCorpus();
    const answer = await callOpenAI({ question, corpus, model, apiKey });

    return res.status(200).json({
      ok: true,
      source: {
        hasTXT: !!corpus.textoBase,
        hasCSV: !!corpus.csv,
        hasPDF: !!corpus.pdfText,
        pdfFiles: corpus.meta.pdfFiles
      },
      answer
    });
  } catch (err) {
    console.error("answer.js error:", err);
    return res.status(200).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
}
