// /api/answer.js
// Analiza TXT embebido (/data/texto_base.js), CSV (/datos/decimo.csv),
// y PDFs/TXT opcionales en /datos/pdfs/*
// Requiere: open_ai_key (o OPENAI_API_KEY)

import fs from "fs";
import path from "path";

export const config = { runtime: "nodejs" };

/* ===== Helpers ===== */
const clip = (s, max=70000) => String(s||"").slice(0, max);
const safeRead = p => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const statMtime = p => { try { return fs.statSync(p).mtimeMs || 0; } catch { return 0; } };

/* ===== Cache en memoria ===== */
let CACHE = { key: "", corpus: null };

async function readPDFsOrTxt() {
  const base = path.join(process.cwd(), "datos", "pdfs");
  try {
    if (!fs.existsSync(base)) return { text: "", files: [], mtimes: [] };
    const all = fs.readdirSync(base);
    const pdfs = all.filter(f=>f.toLowerCase().endsWith(".pdf"));
    const txts = all.filter(f=>f.toLowerCase().endsWith(".txt"));

    const mtimes = all.map(f => statMtime(path.join(base, f)));

    if (pdfs.length) {
      try {
        const pdfParse = (await import("pdf-parse")).default;
        const chunks = [];
        for (const f of pdfs) {
          const buff = fs.readFileSync(path.join(base, f));
          const data = await pdfParse(buff).catch(() => null);
          if (data?.text) chunks.push(data.text);
        }
        return { text: chunks.join("\n\n"), files: pdfs, mtimes };
      } catch {
        return { text: "", files: pdfs, mtimes };
      }
    } else if (txts.length) {
      const text = txts.map(f => safeRead(path.join(base, f))).join("\n\n");
      return { text, files: txts, mtimes };
    }
    return { text: "", files: [], mtimes };
  } catch {
    return { text: "", files: [], mtimes: [] };
  }
}

async function gatherLocalCorpusCached() {
  // claves para invalidar cache cuando cambian archivos
  const textoBasePath = path.join(process.cwd(), "data", "texto_base.js");
  const csvPath = path.join(process.cwd(), "datos", "decimo.csv");
  const k =
    `tb:${statMtime(textoBasePath)}|csv:${statMtime(csvPath)}`;

  // PDFs/TXT
  const pdfs = await readPDFsOrTxt();
  const pdfKey = `pdf:${pdfs.mtimes.join(",")}`;
  const cacheKey = `${k}|${pdfKey}`;

  if (CACHE.key === cacheKey && CACHE.corpus) {
    return CACHE.corpus;
  }

  // 1) Texto embebido
  let textoBase = "";
  try {
    const mod = await import("../data/texto_base.js");
    textoBase = String(mod?.TEXTO_BASE ?? "");
  } catch { textoBase = ""; }

  // 2) CSV
  const csv = safeRead(csvPath);

  // 3) PDFs/TXT
  const pdfText = pdfs.text;

  const corpus = {
    textoBase: clip(textoBase, 120000),
    csv: clip(csv, 120000),
    pdfText: clip(pdfText, 150000),
    meta: { csvPath, pdfFiles: pdfs.files }
  };

  CACHE = { key: cacheKey, corpus };
  return corpus;
}

/* ===== OpenAI ===== */
async function callOpenAI({ question, corpus, model, apiKey }) {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey });

  const system = `
Eres una analista experta. Responde en ESPAÑOL (MX/EC).
Reglas:
- Ignora asteriscos (*).
- No digas "según el archivo CSV" ni "no puedo realizar".
- Puedes hacer cálculos psicométricos, promedios, regresiones simples y estadística.
- Si el usuario pide listas/tablas, entrégalos como tablas.
- Devuelve EXCLUSIVAMENTE JSON con:
{
  "general": "<texto>",
  "tables": [
    {"title":"...", "columns":["Col1","Col2"], "rows":[["v1","v2"]]}
  ],
  "lists": [
    {"title":"...", "items":["item1","item2"]}
  ]
}
`.trim();

  const { textoBase, csv, pdfText } = corpus;

  const user = `
PREGUNTA: ${String(question||"").replaceAll("*","")}

FUENTES:
[TXT embebido]
${textoBase || "(vacío)"}

[CSV decimo.csv]
${csv || "(vacío)"}

[PDF/TXT]
${pdfText || "(vacío)"}
`.trim();

  const response = await client.chat.completions.create({
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    // quita temperature para compatibilidad
    response_format: { type: "json_object" }
  });

  const content = response.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(content); }
  catch { return { general: content, tables: [], lists: [] }; }
}

/* ===== Handler ===== */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const body = req.method === "POST" ? (req.body || {}) : (req.query || {});
    const question = String(body.question || body.q || "");
    const model = String(body.model || "");
    const apiKey = process.env.open_ai_key || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok:false, error:"Falta open_ai_key/OPENAI_API_KEY" });
    }
    if (!question.trim()) {
      return res.status(400).json({ ok:false, error:"Falta la pregunta (question|q)" });
    }

    const corpus = await gatherLocalCorpusCached();
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
    return res.status(200).json({ ok:false, error:String(err?.message || err) });
  }
}
