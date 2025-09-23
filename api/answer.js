// /api/answer.js
// Analiza TXT embebido, CSV y PDFs opcionales
import fs from "fs";
import path from "path";

export const config = { runtime: "nodejs" };

// Limitar longitud para evitar que OpenAI se sature
function clip(s, max = 80000) {
  s = String(s || "");
  return s.length > max ? s.slice(0, max) + `\n[... recortado ...]` : s;
}

function safeRead(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

// Lectura básica de PDFs como texto (si tienes pdf-parse instalado)
async function readPDFsOrTxt() {
  const base = path.join(process.cwd(), "datos", "pdfs");
  try {
    if (!fs.existsSync(base)) return { text: "", files: [] };
    const files = fs.readdirSync(base).filter(f => f.toLowerCase().endsWith(".pdf"));
    if (files.length === 0) {
      // Si no hay PDFs, admite .txt
      const txts = fs.readdirSync(base).filter(f => f.toLowerCase().endsWith(".txt"));
      const text = txts.map(f => safeRead(path.join(base, f))).join("\n\n");
      return { text, files: txts };
    }
    try {
      const pdfParse = (await import("pdf-parse")).default;
      const out = [];
      for (const f of files) {
        const buff = fs.readFileSync(path.join(base, f));
        const data = await pdfParse(buff).catch(() => null);
        if (data?.text) out.push(data.text);
      }
      return { text: out.join("\n\n"), files };
    } catch {
      return { text: "", files };
    }
  } catch {
    return { text: "", files: [] };
  }
}

// Recolecta todas las fuentes locales
async function gatherLocalCorpus() {
  let textoBase = "";
  try {
    const mod = await import("../data/texto_base.js");
    textoBase = String(mod?.TEXTO_BASE ?? "");
  } catch {
    textoBase = "";
  }

  const csvPath = path.join(process.cwd(), "datos", "decimo.csv");
  const csv = safeRead(csvPath);
  const pdfs = await readPDFsOrTxt();

  return {
    textoBase: clip(textoBase, 120000),
    csv: clip(csv, 120000),
    pdfText: clip(pdfs.text, 180000),
    meta: { csvPath, pdfFiles: pdfs.files }
  };
}

// Llama a OpenAI usando tu API Key
async function callOpenAI({ question, corpus, model, apiKey }) {
  const { textoBase, csv, pdfText } = corpus;
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });

  const system = `
Eres una analista experta. Responde en ESPAÑOL neutro.
REGLAS:
- Ignora cualquier * (asteriscos).
- No digas "según el archivo CSV".
- Puedes hacer cálculos psicométricos, promedios, regresiones simples y estadística.
- Cuando haya listas o tablas, entrégalos como tablas JSON.
- Devuelve EXCLUSIVAMENTE JSON con:
{
  "general": "texto explicación",
  "tables": [
    {"title":"...","columns":["Col1","Col2"],"rows":[["v1","v2"]]}
  ]
}
`;

  const user = `
PREGUNTA: ${question.replaceAll("*","")}

FUENTES DISPONIBLES:
[TXT embebido]
${textoBase || "(vacío)"}

[CSV decimo.csv]
${csv || "(vacío)"}

[PDF/TXT]
${pdfText || "(vacío)"}
`;

  const resp = await client.chat.completions.create({
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    response_format: { type: "json_object" }
  });

  const content = resp.choices?.[0]?.message?.content || "{}";
  return JSON.parse(content);
}

// Endpoint
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const body = req.method === "POST" ? (req.body || {}) : (req.query || {});
    const question = String(body.question || body.q || "");
    const model = String(body.model || "");
    const apiKey = process.env.open_ai_key || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "Falta la variable open_ai_key en Vercel" });
    }

    const corpus = await gatherLocalCorpus();
    const answer = await callOpenAI({ question, corpus, model, apiKey });

    return res.status(200).json({
      ok: true,
      source: { hasTXT: !!corpus.textoBase, hasCSV: !!corpus.csv, hasPDF: !!corpus.pdfText, pdfFiles: corpus.meta.pdfFiles },
      answer
    });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}
